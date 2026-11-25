//! Server-scoped `MySQL` and `PostgreSQL` catalogs and database creation.
use crate::connection_diagnostics::{self, ConnectionFailure};
use crate::{
    AppState, CaptureSnapshotInput, CaptureSnapshotResult, SaveDataSourceInput, SourceInput,
    acquire_cloud_operation, capture_snapshot_using, connection_credentials,
    connection_sessions::{DatabasePool, Session},
    credential_entry, safe_store_error,
};
use chrono::{DateTime, Utc};
use mysql_adapter::MySqlAdapterError;
use postgres_adapter::{PostgresAdapterError, PostgresConnectionOptions};
use schema_model::{DataSourceProfile, DatabaseInfo, DatabaseType, SshAuthentication};
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, MySqlPool, PgPool};
use std::time::Duration;
use tauri::State;
use uuid::Uuid;

const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn parent_for_edit(
    updated: &DataSourceProfile,
    previous: Option<&DataSourceProfile>,
) -> Option<Uuid> {
    previous
        .filter(|previous| {
            updated.database_type == previous.database_type
                && updated.database == previous.database
                && updated.host == previous.host
                && updated.port == previous.port
                && updated.username == previous.username
                && updated.ssl_mode == previous.ssl_mode
                && updated.security == previous.security
        })
        .and_then(|previous| previous.server_source_id)
}

pub(super) async fn test_mysql_server(pool: &MySqlPool) -> Result<DatabaseInfo, MySqlAdapterError> {
    let version = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(pool)
        .await?;
    Ok(DatabaseInfo {
        name: String::new(),
        database_type: DatabaseType::MySql,
        version,
    })
}

fn maintenance_unavailable(error: &PostgresAdapterError) -> bool {
    matches!(error, PostgresAdapterError::Database(sqlx::Error::Database(error))
        if matches!(error.code().as_deref(), Some("3D000" | "42501" | "55000")))
}

pub(super) async fn connect_postgres_maintenance(
    options: &PostgresConnectionOptions,
) -> Result<PgPool, ConnectionFailure> {
    let mut primary = options.clone().with_database("postgres");
    // A single session is also sufficient when creating from template1.
    primary.max_connections = 1;
    match postgres_adapter::connect_reusable(&primary).await {
        Err(error) if maintenance_unavailable(&error) => {
            postgres_adapter::connect_reusable(&primary.with_database("template1"))
                .await
                .map_err(|error| {
                    if maintenance_unavailable(&error) {
                        ConnectionFailure::new("database", "This account cannot connect to the PostgreSQL maintenance databases. Enter an accessible database name or ask your administrator for access.")
                            .with_code("postgresMaintenanceUnavailable")
                    } else {
                        connection_diagnostics::postgres(error)
                    }
                })
        }
        result => result.map_err(connection_diagnostics::postgres),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DatabaseInput {
    source_id: Uuid,
    database: String,
    server_updated_at: DateTime<Utc>,
    #[serde(default)]
    refresh: bool,
}

impl DatabaseInput {
    async fn load_server(&self, state: &AppState) -> Result<DataSourceProfile, ConnectionFailure> {
        let server = load_server(state, self.source_id).await?;
        if server.updated_at != self.server_updated_at {
            return Err(
                configuration("The server connection changed. Close and reopen it.")
                    .with_code("serverConnectionChanged"),
            );
        }
        Ok(server)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenDatabaseResult {
    profile: DataSourceProfile,
    capture: CaptureSnapshotResult,
}

fn configuration(message: impl Into<String>) -> ConnectionFailure {
    ConnectionFailure::new("configuration", message)
}

async fn load_server(
    state: &AppState,
    source_id: Uuid,
) -> Result<DataSourceProfile, ConnectionFailure> {
    let server = state
        .store
        .get_data_source(source_id)
        .await
        .map_err(safe_store_error)
        .map_err(configuration)?
        .filter(DataSourceProfile::is_server_connection)
        .ok_or_else(|| configuration("Choose a saved server connection."))?;
    connection_credentials::require_binding(&server).map_err(configuration)?;
    Ok(server)
}

async fn credentials(
    server: &DataSourceProfile,
) -> Result<(String, Option<String>), ConnectionFailure> {
    let id = server.id;
    let security = server.security.clone();
    tokio::task::spawn_blocking(move || {
        let password = credential_entry(id)
            .and_then(|entry| {
                entry
                    .get_password()
                    .map_err(|_| "Enter and save the server password.".to_owned())
            })
            .map_err(configuration)?;
        let ssh = connection_credentials::resolve_ssh(Some(id), &security, None)
            .map_err(|message| ConnectionFailure::new("ssh", message))?;
        Ok((password, ssh))
    })
    .await
    .map_err(|_| configuration("Unable to load the local server credentials."))?
}

async fn connect(
    server: &DataSourceProfile,
    state: &AppState,
) -> Result<Session, ConnectionFailure> {
    let (password, ssh_secret) = credentials(server).await?;
    state
        .sessions
        .open(
            server,
            &password,
            ssh_secret.as_deref(),
            CATALOG_TIMEOUT,
            || {},
        )
        .await
}

#[tauri::command]
pub(super) async fn list_server_databases(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<String>, ConnectionFailure> {
    list_databases(input.source_id, &state).await
}

async fn list_databases(
    source_id: Uuid,
    state: &AppState,
) -> Result<Vec<String>, ConnectionFailure> {
    let server = load_server(state, source_id).await?;
    let session = connect(&server, state).await?;
    let rows = catalog_query(async {
        match &session.pool {
            DatabasePool::MySql(pool) => sqlx::query_scalar("SHOW DATABASES").fetch_all(pool).await,
            DatabasePool::Postgres(pool) => sqlx::query_scalar(
                "SELECT datname::text FROM pg_catalog.pg_database
                 WHERE datallowconn AND NOT datistemplate AND pg_catalog.has_database_privilege(oid, 'CONNECT')
                 ORDER BY datname",
            ).fetch_all(pool).await,
        }
    }, "Listing databases timed out. Refresh to try again.").await
    .map_err(|error| error.after_ssh(server.security.ssh.is_some()))?;
    Ok(rows)
}

async fn catalog_query<T>(
    query: impl Future<Output = Result<T, sqlx::Error>>,
    timeout_message: &'static str,
) -> Result<T, ConnectionFailure> {
    tokio::time::timeout(CATALOG_TIMEOUT, query)
        .await
        .map_err(|_| ConnectionFailure::new("timeout", timeout_message))?
        .map_err(|error| connection_diagnostics::database(&error))
}

fn quoted_mysql_database(name: &str) -> Result<String, ConnectionFailure> {
    if name.trim().is_empty()
        || name.ends_with(' ')
        || name.contains(['.', '/', '\\', '\0'])
        || name.chars().count() > 64
        || name.chars().any(|character| character as u32 > 0xffff)
    {
        return Err(
            configuration("Enter a valid MySQL database name of 1 to 64 characters.")
                .with_code("mysqlDatabaseNameInvalid"),
        );
    }
    Ok(format!("`{}`", name.replace('`', "``")))
}

fn invalid_postgres_name() -> ConnectionFailure {
    configuration(
        "The PostgreSQL database name is invalid or exceeds this server’s identifier length limit.",
    )
    .with_code("postgresDatabaseNameInvalid")
}

fn quoted_postgres_database(name: &str) -> Result<String, ConnectionFailure> {
    if name.is_empty() || name.contains('\0') {
        return Err(invalid_postgres_name());
    }
    Ok(format!("\"{}\"", name.replace('"', "\"\"")))
}

#[tauri::command]
pub(super) async fn create_server_database(
    input: DatabaseInput,
    state: State<'_, AppState>,
) -> Result<String, ConnectionFailure> {
    create_database(input, &state).await
}

async fn create_database(
    input: DatabaseInput,
    state: &AppState,
) -> Result<String, ConnectionFailure> {
    let database = input.database.trim();
    let _operation = acquire_cloud_operation(state, input.source_id)
        .await
        .map_err(configuration)?;
    let server = input.load_server(state).await?;
    let quoted = match server.database_type {
        DatabaseType::MySql => quoted_mysql_database(database),
        DatabaseType::PostgreSql => quoted_postgres_database(database),
        DatabaseType::Sqlite => unreachable!("Only network database names are supported"),
    }?;
    let ssh_connected = server.security.ssh.is_some();
    let session = connect(&server, state).await?;
    let normalize_name = match &session.pool {
        DatabasePool::MySql(pool) => {
            let lower_case: i64 = catalog_query(
                sqlx::query_scalar("SELECT CAST(@@lower_case_table_names AS SIGNED)")
                    .fetch_one(pool),
                "Reading MySQL server settings timed out.",
            )
            .await
            .map_err(|error| error.after_ssh(ssh_connected))?;
            lower_case == 1
        }
        DatabasePool::Postgres(pool) => {
            let fits: bool = catalog_query(
                sqlx::query_scalar("SELECT pg_catalog.octet_length($1::text) <= pg_catalog.current_setting('max_identifier_length')::integer")
                    .bind(database).fetch_one(pool),
                "Reading PostgreSQL server settings timed out.",
            ).await.map_err(|error| error.after_ssh(ssh_connected))?;
            if !fits {
                return Err(invalid_postgres_name().after_ssh(ssh_connected));
            }
            false
        }
    };
    // The only dynamic SQL is a validated and quoted identifier.
    let statement = AssertSqlSafe(format!("CREATE DATABASE {quoted}"));
    tokio::time::timeout(CATALOG_TIMEOUT, async {
        match &session.pool {
            DatabasePool::MySql(pool) => sqlx::query(statement).execute(pool).await.map(|_| ()),
            DatabasePool::Postgres(pool) => sqlx::query(statement).execute(pool).await.map(|_| ()),
        }
    })
    .await
    .map_err(|_| {
        ConnectionFailure::new(
            "timeout",
            "Creation timed out. Refresh the list to check whether the database was created.",
        )
        .with_code("serverDatabaseCreateTimeout")
        .after_ssh(ssh_connected)
    })?
    .map_err(|error| creation_failure(&error).after_ssh(ssh_connected))?;
    Ok(if normalize_name {
        database.to_lowercase()
    } else {
        database.to_owned()
    })
}

fn creation_failure(error: &sqlx::Error) -> ConnectionFailure {
    let database_error = error.as_database_error();
    let number = database_error
        .and_then(|error| error.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>())
        .map(sqlx::mysql::MySqlDatabaseError::number);
    let sql_state = database_error.and_then(sqlx::error::DatabaseError::code);
    let (code, message) = match (number, sql_state.as_deref()) {
        (Some(1007), _) | (_, Some("42P04")) => {
            ("serverDatabaseExists", "This database already exists.")
        }
        (Some(1044 | 1142 | 1227), _) | (_, Some("42501")) => (
            "serverDatabaseCreateDenied",
            "This account cannot create the database.",
        ),
        (Some(1290 | 1792), _) | (_, Some("25006")) => (
            "serverDatabaseReadOnly",
            "The server rejected database creation because it is read-only.",
        ),
        _ => return connection_diagnostics::database(error),
    };
    ConnectionFailure::new("database", message).with_code(code)
}

#[tauri::command]
pub(super) async fn open_server_database(
    input: DatabaseInput,
    state: State<'_, AppState>,
) -> Result<OpenDatabaseResult, ConnectionFailure> {
    open_database(input, &state).await
}

#[allow(clippy::too_many_lines)]
async fn open_database(
    input: DatabaseInput,
    state: &AppState,
) -> Result<OpenDatabaseResult, ConnectionFailure> {
    let _operation = acquire_cloud_operation(state, input.source_id)
        .await
        .map_err(configuration)?;
    let server = input.load_server(state).await?;
    match server.database_type {
        DatabaseType::MySql => quoted_mysql_database(&input.database),
        DatabaseType::PostgreSql => quoted_postgres_database(&input.database),
        DatabaseType::Sqlite => unreachable!("Only network database names are supported"),
    }?;
    let previous = state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)
        .map_err(configuration)?
        .into_iter()
        .find(|profile| {
            profile.server_source_id == Some(server.id) && profile.database == input.database
        });
    let now = Utc::now();
    let profile = DataSourceProfile {
        id: previous
            .as_ref()
            .map_or_else(Uuid::new_v4, |profile| profile.id),
        display_name: previous.as_ref().map_or_else(
            || format!("{} · {}", server.display_name, input.database),
            |profile| profile.display_name.clone(),
        ),
        database: input.database,
        server_source_id: Some(server.id),
        connection_sync: previous
            .as_ref()
            .and_then(|profile| profile.connection_sync),
        created_at: previous.as_ref().map_or(now, |profile| profile.created_at),
        updated_at: now,
        ..server.clone()
    };
    let _database_operation = acquire_cloud_operation(state, profile.id)
        .await
        .map_err(configuration)?;
    if state
        .store
        .get_data_source(profile.id)
        .await
        .map_err(safe_store_error)
        .map_err(configuration)?
        != previous
    {
        return Err(configuration(
            "This database connection changed. Open it again.",
        ));
    }
    if !input.refresh
        && let Some(saved) = &previous
        && saved.updated_at >= server.updated_at
        && saved.host == profile.host
        && saved.port == profile.port
        && saved.username == profile.username
        && saved.database_type == profile.database_type
        && saved.ssl_mode == profile.ssl_mode
        && saved.security == profile.security
        && connection_credentials::require_binding(saved).is_ok()
        && let Some(snapshot) = state
            .store
            .latest_snapshot(saved.id)
            .await
            .map_err(safe_store_error)
            .map_err(configuration)?
    {
        return Ok(OpenDatabaseResult {
            profile: saved.clone(),
            capture: CaptureSnapshotResult {
                snapshot,
                stored: false,
                change_set: None,
            },
        });
    }
    let (password, ssh_secret) = credentials(&server).await?;
    let (ssh_password, ssh_key_passphrase) =
        match profile.security.ssh.as_ref().map(|ssh| ssh.authentication) {
            Some(SshAuthentication::Password) => (ssh_secret, None),
            Some(SshAuthentication::PrivateKey) => (None, ssh_secret),
            _ => (None, None),
        };
    let resolved = SaveDataSourceInput {
        id: None,
        sqlite: None,
        display_name: profile.display_name.clone(),
        host: profile.host.clone(),
        port: profile.port,
        database: profile.database.clone(),
        username: profile.username.clone(),
        password,
        ssh_password,
        ssh_key_passphrase,
        database_type: profile.database_type,
        ssl_mode: profile.ssl_mode,
        security: profile.security.clone(),
    };
    let capture = capture_snapshot_using(
        CaptureSnapshotInput {
            source_id: profile.id,
            trigger: None,
        },
        state,
        Some((&profile, &resolved)),
    )
    .await
    .map_err(|message| ConnectionFailure::new("database", message))?;
    Ok(OpenDatabaseResult { profile, capture })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_one_database_identifier() {
        assert_eq!(
            quoted_mysql_database("sales`east").unwrap(),
            "`sales``east`"
        );
        assert_eq!(quoted_mysql_database("订单").unwrap(), "`订单`");
        for invalid in ["", "foo.bar", "x/y", "trailing ", "a\0b", "😀"] {
            assert!(quoted_mysql_database(invalid).is_err(), "{invalid:?}");
        }
        assert!(quoted_mysql_database(&"a".repeat(65)).is_err());
        assert_eq!(
            quoted_postgres_database("Sales.\"East\"").unwrap(),
            "\"Sales.\"\"East\"\"\""
        );
        assert!(quoted_postgres_database("a\0b").is_err());
    }

    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    #[tokio::test]
    #[ignore = "requires an isolated SSH/MySQL fixture and the local keychain"]
    async fn mysql_server_loopback_flow() {
        exercise_server_loopback(DatabaseType::MySql).await;
    }

    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    #[tokio::test]
    #[ignore = "requires an isolated SSH/PostgreSQL fixture and the local keychain"]
    async fn postgres_server_loopback_flow() {
        exercise_server_loopback(DatabaseType::PostgreSql).await;
    }

    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    #[allow(clippy::items_after_statements, clippy::too_many_lines)]
    async fn exercise_server_loopback(engine: DatabaseType) {
        use crate::{
            KEYRING_SERVICE, LocalSnapshotStore, delete_secret, prepare_connection_test,
            save_data_source_using, test_database_connection,
        };
        use serde_json::json;
        use std::sync::Arc;
        use tokio::sync::Semaphore;

        let mysql = engine == DatabaseType::MySql;
        let fixture_env = if mysql { "MYSQL" } else { "POSTGRES" };
        let fixture = std::path::PathBuf::from(
            std::env::var_os(format!("NODAL_{fixture_env}_FIXTURE")).unwrap(),
        );
        assert!(fixture.starts_with("/private/tmp"));
        assert!(
            fixture
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("nodal-database-server.")
        );
        let port = std::env::var(format!("NODAL_{fixture_env}_FIXTURE_SSH_PORT"))
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let state = AppState {
            sessions: crate::connection_sessions::ConnectionSessions::default(),
            store: LocalSnapshotStore::open("sqlite::memory:").await.unwrap(),
            ai_limiter: Arc::new(Semaphore::new(1)),
            snapshot_captures: Arc::default(),
            cloud_operations: Arc::default(),
            active_queries: Arc::default(),
        };
        struct FixtureCredentials(Vec<Uuid>);
        impl Drop for FixtureCredentials {
            fn drop(&mut self) {
                for id in &self.0 {
                    let _ = delete_secret(KEYRING_SERVICE, *id);
                    let _ = delete_secret(connection_credentials::SSH_SERVICE, *id);
                }
            }
        }
        let server_id = Uuid::new_v4();
        let reader_id = Uuid::new_v4();
        let mut cleanup = FixtureCredentials(vec![server_id, reader_id]);
        let input = |id, username, password| {
            serde_json::from_value::<SaveDataSourceInput>(json!({
                "id": id,
                "displayName": "Isolated database fixture",
                "host": if mysql { "mysql" } else { "pg.fixture.test" },
                "port": if mysql { 3306 } else { 5432 },
                "database": "",
                "databaseType": engine,
                "username": username,
                "password": password,
                "sslMode": if mysql { "require" } else { "verifyFull" },
                "sshKeyPassphrase": if mysql { "nodal-mysql-key-only" } else { "nodal-postgres-key-only" },
                "security": { "tls": {
                    "caCertificate": (!mysql).then(|| fixture.join("pg-ca.crt")),
                }, "ssh": {
                    "host": "127.0.0.1",
                    "port": port,
                    "username": "nodaltest",
                    "authentication": "privateKey",
                    "privateKey": fixture.join("client"),
                    "knownHosts": fixture.join("known_hosts"),
                } },
            }))
            .unwrap()
        };
        let creator = || {
            if mysql {
                input(server_id, "root", "nodal-mysql-fixture-only")
            } else {
                input(server_id, "nodal_creator", "nodal-postgres-creator-only")
            }
        };
        let mut plaintext = creator();
        plaintext.ssl_mode = schema_model::SslMode::Disable;
        let failure = test_database_connection(&prepare_connection_test(plaintext).unwrap())
            .await
            .err()
            .unwrap();
        assert_eq!(failure.code, Some("unencryptedConnectionRejected"));
        assert_eq!(failure.stage, "tls");
        assert!(failure.ssh_connected);

        if !mysql {
            let mut wrong_password = creator();
            wrong_password.password = "invalid-fixture-password".into();
            let failure =
                test_database_connection(&prepare_connection_test(wrong_password).unwrap())
                    .await
                    .err()
                    .unwrap();
            assert_eq!(failure.code, Some("authenticationRejected"));
            assert_eq!(failure.stage, "database");
        }
        let prepared = prepare_connection_test(creator()).unwrap();
        let tested = test_database_connection(&prepared).await.unwrap();
        assert_eq!(tested.database.name, "");
        assert!(
            tested
                .database
                .version
                .starts_with(if mysql { "8.4" } else { "17" })
        );
        assert_eq!(tested.ssl_active, Some(true));
        let server = save_data_source_using(creator(), &state).await.unwrap();
        assert!(server.is_server_connection());
        assert!(
            state
                .store
                .latest_snapshot(server.id)
                .await
                .unwrap()
                .is_none()
        );
        let before = list_databases(server.id, &state).await.unwrap();
        if mysql {
            assert!(before.iter().all(|name| {
                ["information_schema", "mysql", "performance_schema", "sys"]
                    .contains(&name.as_str())
            }));
        } else {
            // The creator cannot CONNECT to postgres, and catalog templates are excluded.
            assert!(before.is_empty());
        }

        let name = if mysql {
            "first_business_db"
        } else {
            "业务库 \"East\""
        };
        let database = |profile: &DataSourceProfile| DatabaseInput {
            source_id: profile.id,
            database: name.into(),
            server_updated_at: profile.updated_at,
            refresh: false,
        };
        let reader = save_data_source_using(
            input(
                reader_id,
                "nodal_reader",
                if mysql {
                    "nodal-mysql-reader-only"
                } else {
                    "nodal-postgres-reader-only"
                },
            ),
            &state,
        )
        .await
        .unwrap();
        assert_eq!(
            create_database(database(&reader), &state)
                .await
                .unwrap_err()
                .code,
            Some("serverDatabaseCreateDenied")
        );
        if !mysql {
            let mut too_long = database(&server);
            too_long.database = "业".repeat(22);
            assert_eq!(
                create_database(too_long, &state).await.unwrap_err().code,
                Some("postgresDatabaseNameInvalid")
            );
        }
        assert_eq!(
            create_database(database(&server), &state).await.unwrap(),
            name
        );
        assert!(
            list_databases(server.id, &state)
                .await
                .unwrap()
                .iter()
                .any(|database| database == name)
        );
        assert_eq!(
            create_database(database(&server), &state)
                .await
                .unwrap_err()
                .code,
            Some("serverDatabaseExists")
        );
        let opened = open_database(database(&server), &state).await.unwrap();
        cleanup.0.push(opened.profile.id);
        assert_eq!(opened.profile.server_source_id, Some(server.id));
        assert_eq!(opened.capture.snapshot.database.name, name);
        let schema = opened
            .capture
            .snapshot
            .schemas
            .iter()
            .find(|schema| schema.name == if mysql { name } else { "public" })
            .unwrap();
        assert!(schema.tables.is_empty());
        let reopened = open_database(database(&server), &state).await.unwrap();
        assert_eq!(opened.profile.id, reopened.profile.id);
    }
}
