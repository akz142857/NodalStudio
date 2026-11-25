//! Short-lived pools and SSH tunnels for one authenticated connection route.
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use ring::hmac;
use schema_model::{DataSourceProfile, DatabaseType};
use sqlx::{MySqlPool, PgPool};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    ConnectionFailure, connection_diagnostics, connection_options_from_profile,
    connection_security, database_server::connect_postgres_maintenance,
    mysql_connection_options_from_profile,
};

const IDLE: Duration = Duration::from_secs(90);
const MAX_ROUTES: usize = 8;
const MAX_POOLS: usize = 4;
type Digest = [u8; 32];

#[derive(Clone)]
pub(super) enum DatabasePool {
    MySql(MySqlPool),
    Postgres(PgPool),
}

pub(super) struct Session {
    pub pool: DatabasePool,
    _tunnel: Arc<connection_security::Tunnel>,
}

struct PoolEntry {
    pool: DatabasePool,
    last_used: Instant,
}

struct Route {
    tunnel: Arc<connection_security::Tunnel>,
    opened_at: Instant,
    pools: HashMap<Digest, PoolEntry>,
}

struct RouteEntry {
    value: Arc<Mutex<Option<Route>>>,
    last_used: Instant,
}

#[derive(Clone)]
pub(super) struct ConnectionSessions {
    routes: Arc<Mutex<HashMap<Digest, RouteEntry>>>,
    salt: Arc<hmac::Key>,
}

impl Default for ConnectionSessions {
    fn default() -> Self {
        Self {
            routes: Arc::default(),
            salt: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, Uuid::new_v4().as_bytes())),
        }
    }
}

impl ConnectionSessions {
    pub fn start_reaper(&self) {
        let routes = Arc::downgrade(&self.routes);
        tauri::async_runtime::spawn(async move {
            reap(routes).await;
        });
    }

    pub fn provisional(&self) -> Self {
        Self {
            routes: Arc::default(),
            salt: Arc::clone(&self.salt),
        }
    }

    pub async fn retain_verified(&self, verified: &Self) {
        let mut incoming = verified.routes.lock().await;
        let mut routes = self.routes.lock().await;
        routes.extend(incoming.drain());
        while routes.len() > MAX_ROUTES {
            let oldest = routes
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| *key)
                .expect("nonempty cache");
            routes.remove(&oldest);
        }
    }

    fn key(&self, public: &impl serde::Serialize, secret: Option<&str>) -> Digest {
        let mut context = hmac::Context::with_key(&self.salt);
        context.update(&serde_json::to_vec(public).expect("connection fields serialize"));
        context.update(&[0]);
        if let Some(secret) = secret {
            context.update(secret.as_bytes());
        }
        context.sign().as_ref().try_into().expect("SHA-256 digest")
    }

    #[allow(clippy::too_many_lines)]
    pub async fn open(
        &self,
        profile: &DataSourceProfile,
        password: &str,
        ssh_secret: Option<&str>,
        timeout: Duration,
        on_transport_ready: impl FnOnce(),
    ) -> Result<Session, ConnectionFailure> {
        connection_security::validate(&profile.security, profile.ssl_mode)
            .map_err(|message| ConnectionFailure::new("configuration", message))?;
        let files = [
            profile.security.tls.ca_certificate.as_deref(),
            profile.security.tls.client_certificate.as_deref(),
            profile.security.tls.client_key.as_deref(),
            profile
                .security
                .ssh
                .as_ref()
                .and_then(|ssh| ssh.private_key.as_deref()),
            profile
                .security
                .ssh
                .as_ref()
                .and_then(|ssh| ssh.known_hosts.as_deref()),
        ]
        .map(|path| path.and_then(file_version));
        let route_key = self.key(
            &(
                &profile.host,
                profile.port,
                profile.database_type,
                profile.ssl_mode,
                &profile.security,
                files,
            ),
            ssh_secret,
        );
        let pool_key = self.key(
            &(&profile.database, &profile.username, timeout),
            Some(password),
        );
        let slot = {
            let mut routes = self.routes.lock().await;
            routes.retain(|_, entry| {
                entry.last_used.elapsed() < IDLE || Arc::strong_count(&entry.value) > 1
            });
            if !routes.contains_key(&route_key)
                && routes.len() >= MAX_ROUTES
                && let Some(oldest) = routes
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| *key)
            {
                routes.remove(&oldest);
            }
            let entry = routes.entry(route_key).or_insert_with(|| RouteEntry {
                value: Arc::default(),
                last_used: Instant::now(),
            });
            entry.last_used = Instant::now();
            Arc::clone(&entry.value)
        };
        let mut route = slot.lock().await;
        if route
            .as_ref()
            .is_none_or(|route| route.opened_at.elapsed() >= IDLE * 3 || !route.tunnel.is_live())
        {
            let tunnel = connection_security::Tunnel::open(
                &profile.security,
                &profile.host,
                profile.port,
                profile.database_type,
                ssh_secret,
            )
            .await
            .map_err(|message| ConnectionFailure::new("ssh", message))?;
            *route = Some(Route {
                tunnel: Arc::new(tunnel),
                opened_at: Instant::now(),
                pools: HashMap::new(),
            });
        }
        let route = route.as_mut().expect("initialized connection route");
        on_transport_ready();
        route
            .pools
            .retain(|_, entry| entry.last_used.elapsed() < IDLE);
        if let Some(entry) = route.pools.get_mut(&pool_key) {
            entry.last_used = Instant::now();
            return Ok(Session {
                pool: entry.pool.clone(),
                _tunnel: Arc::clone(&route.tunnel),
            });
        }
        let pool = match profile.database_type {
            DatabaseType::MySql => {
                let options = mysql_connection_options_from_profile(profile, password)
                    .with_socket(route.tunnel.mysql_socket())
                    .with_connect_timeout(timeout);
                mysql_adapter::connect_reusable(&options)
                    .await
                    .map(DatabasePool::MySql)
                    .map_err(connection_diagnostics::mysql)
            }
            DatabaseType::PostgreSql => {
                let options = connection_options_from_profile(profile, password)
                    .with_socket(route.tunnel.postgres_socket())
                    .with_connect_timeout(timeout);
                let result = if profile.is_server_connection() {
                    connect_postgres_maintenance(&options).await
                } else {
                    postgres_adapter::connect_reusable(&options)
                        .await
                        .map_err(connection_diagnostics::postgres)
                };
                result.map(DatabasePool::Postgres)
            }
            DatabaseType::Sqlite => unreachable!("SQLite has no network sessions"),
        }
        .map_err(|error| error.after_ssh(profile.security.ssh.is_some()))?;
        if route.pools.len() >= MAX_POOLS
            && let Some(oldest) = route
                .pools
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| *key)
        {
            route.pools.remove(&oldest);
        }
        route.pools.insert(
            pool_key,
            PoolEntry {
                pool: pool.clone(),
                last_used: Instant::now(),
            },
        );
        Ok(Session {
            pool,
            _tunnel: Arc::clone(&route.tunnel),
        })
    }
}

fn file_version(path: &str) -> Option<(std::time::SystemTime, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

async fn reap(routes: Weak<Mutex<HashMap<Digest, RouteEntry>>>) {
    loop {
        tokio::time::sleep(IDLE / 3).await;
        let Some(routes) = routes.upgrade() else {
            break;
        };
        routes.lock().await.retain(|_, entry| {
            entry.last_used.elapsed() < IDLE || Arc::strong_count(&entry.value) > 1
        });
    }
}
