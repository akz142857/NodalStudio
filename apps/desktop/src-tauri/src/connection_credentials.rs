//! Database and SSH secrets share the OS credential store, never profile JSON.
use schema_model::{ConnectionSecurity, SshAuthentication, SshConfig};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SSH_SERVICE: &str = "com.claycosmos.nodalstudio.ssh";
#[derive(Serialize, Deserialize)]
struct SshSecret {
    host: String,
    port: u16,
    username: String,
    password: String,
}
fn entry(service: &str, id: Uuid) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, &id.to_string())
        .map_err(|_| "Unable to access the system credential store.".into())
}
fn read(service: &str, id: Uuid) -> Result<Option<String>, String> {
    match entry(service, id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(
            "Unable to read the system credential store. Unlock your keychain and try again."
                .into(),
        ),
    }
}
fn write(service: &str, id: Uuid, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        entry(service, id)?.set_password(value).map_err(|_| {
            "Unable to save the connection password in the system credential store.".into()
        })
    } else {
        crate::delete_secret(service, id)
    }
}
fn bound_password(value: &str, ssh: &SshConfig) -> Result<String, String> {
    let secret: SshSecret = serde_json::from_str(value)
        .map_err(|_| "Saved SSH password is unreadable. Enter it again.")?;
    if secret.host != ssh.host || secret.port != ssh.port || secret.username != ssh.username {
        return Err(
            "The SSH host or account changed. Enter its password before connecting.".into(),
        );
    }
    Ok(secret.password)
}
pub fn resolve_ssh(
    id: Option<Uuid>,
    security: &ConnectionSecurity,
    supplied: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(ssh) = security
        .ssh
        .as_ref()
        .filter(|ssh| ssh.authentication == SshAuthentication::Password)
    else {
        return Ok(None);
    };
    if let Some(password) = supplied.filter(|value| !value.is_empty()) {
        if password.contains(['\n', '\r', '\0']) {
            return Err("SSH passwords cannot contain line breaks or NUL characters.".into());
        }
        return Ok(Some(password.to_owned()));
    }
    let stored = id
        .map(|id| read(SSH_SERVICE, id))
        .transpose()?
        .flatten()
        .ok_or("Enter an SSH password. It will be saved in the system credential store.")?;
    bound_password(&stored, ssh).map(Some)
}

pub struct SavedSecrets {
    id: Uuid,
    database: Option<String>,
    ssh: Option<String>,
}
impl SavedSecrets {
    pub fn rollback(&self) -> Result<(), String> {
        // Attempt both restores even if one fails.
        let database = write(crate::KEYRING_SERVICE, self.id, self.database.as_deref());
        let ssh = write(SSH_SERVICE, self.id, self.ssh.as_deref());
        database.and(ssh)
    }
}
/// Called only after verification, with rollback if profile persistence fails.
pub fn save(id: Uuid, input: &crate::SaveDataSourceInput) -> Result<SavedSecrets, String> {
    let ssh_password = resolve_ssh(input.id, &input.security, input.ssh_password.as_deref())?;
    let previous = SavedSecrets {
        id,
        database: read(crate::KEYRING_SERVICE, id)?,
        ssh: read(SSH_SERVICE, id)?,
    };
    let result = (|| {
        if !input.password.is_empty() {
            write(crate::KEYRING_SERVICE, id, Some(&input.password))?;
        }
        if let (Some(ssh), Some(password)) = (&input.security.ssh, ssh_password) {
            let value = serde_json::to_string(&SshSecret {
                host: ssh.host.clone(),
                port: ssh.port,
                username: ssh.username.clone(),
                password,
            })
            .map_err(|_| "Unable to encode SSH credential.")?;
            write(SSH_SERVICE, id, Some(&value))?;
        } else if previous.ssh.is_some() {
            write(SSH_SERVICE, id, None)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        previous.rollback()?;
        return Err(error);
    }
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ssh() -> SshConfig {
        SshConfig {
            host: "jump.example".into(),
            port: 22,
            username: "alice".into(),
            authentication: SshAuthentication::Password,
            private_key: None,
            known_hosts: None,
        }
    }
    #[test]
    fn saved_password_is_bound_to_the_ssh_endpoint() {
        let value = serde_json::to_string(&SshSecret {
            host: "jump.example".into(),
            port: 22,
            username: "alice".into(),
            password: "test-secret".into(),
        })
        .unwrap();
        assert_eq!(bound_password(&value, &ssh()).unwrap(), "test-secret");
        let mut other = ssh();
        other.host = "other.example".into();
        assert!(bound_password(&value, &other).is_err());
        other = ssh();
        other.username = "bob".into();
        assert!(bound_password(&value, &other).is_err());
        other = ssh();
        other.port = 2222;
        assert!(bound_password(&value, &other).is_err());
    }
    #[test]
    fn only_password_authentication_resolves_a_password() {
        assert!(
            resolve_ssh(None, &ConnectionSecurity::default(), Some("ignored"))
                .unwrap()
                .is_none()
        );
        let security = ConnectionSecurity {
            tls: Default::default(),
            ssh: Some(ssh()),
        };
        assert!(resolve_ssh(None, &security, None).is_err());
        assert_eq!(
            resolve_ssh(None, &security, Some(" supplied "))
                .unwrap()
                .as_deref(),
            Some(" supplied ")
        );
        assert!(resolve_ssh(None, &security, Some("bad\nsecret")).is_err());
    }
    #[tokio::test]
    #[ignore = "requires isolated SSH password fixture and unlocked OS keychain"]
    async fn password_keychain_and_tunnel_acceptance() {
        use schema_model::{DatabaseType, SslMode, TlsConfig};
        let directory = std::env::var("NODAL_SECURITY_FIXTURE").expect("fixture path");
        assert_eq!(directory, "/tmp/nodal-security-acceptance");
        let id = Uuid::new_v4();
        struct Cleanup(Uuid);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = write(SSH_SERVICE, self.0, None);
                let _ = write(crate::KEYRING_SERVICE, self.0, None);
            }
        }
        let _cleanup = Cleanup(id);
        let file = |name: &str| Some(format!("{directory}/{name}"));
        let mut input = crate::SaveDataSourceInput {
            id: Some(id),
            display_name: "Isolated password test".into(),
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            password: "nodal-local-test-only".into(),
            ssh_password: Some("NodalTestPassword42".into()),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::VerifyFull,
            security: ConnectionSecurity {
                tls: TlsConfig {
                    ca_certificate: file("ca.pem"),
                    client_certificate: file("client-tls.pem"),
                    client_key: file("client-tls.key"),
                },
                ssh: Some(SshConfig {
                    host: "127.0.0.1".into(),
                    port: 55440,
                    username: "nodaltest".into(),
                    authentication: SshAuthentication::Password,
                    private_key: None,
                    known_hosts: file("password_known_hosts"),
                }),
            },
        };
        assert_eq!(
            crate::test_database_connection(&input)
                .await
                .unwrap()
                .ssl_active,
            Some(true)
        );
        save(id, &input).unwrap();
        input.ssh_password = None;
        let password = resolve_ssh(Some(id), &input.security, None).unwrap();
        assert_eq!(password.as_deref(), Some("NodalTestPassword42"));
        let tunnel = crate::connection_security::Tunnel::open(
            &input.security,
            &input.host,
            input.port,
            input.database_type,
            password.as_deref(),
        )
        .await
        .unwrap();
        let pool = postgres_adapter::connect(
            &crate::connection_options_from_input(&input).with_socket(tunnel.postgres_socket()),
        )
        .await
        .unwrap();
        assert!(postgres_adapter::inspect_schema(&pool, id).await.is_ok());
        assert_eq!(
            sqlx::query_scalar::<_, i32>("SELECT 42")
                .fetch_one(&pool)
                .await
                .unwrap(),
            42
        );
        pool.close().await;
        drop(tunnel);
        input.ssh_password = Some("incorrect-test-password".into());
        assert!(crate::test_database_connection(&input).await.is_err());
        assert_eq!(
            resolve_ssh(Some(id), &input.security, None).unwrap(),
            password
        );
        let previous = save(id, &input).unwrap();
        previous.rollback().unwrap();
        assert_eq!(
            resolve_ssh(Some(id), &input.security, None).unwrap(),
            password
        );
        input.security.ssh = None;
        save(id, &input).unwrap();
        assert!(read(SSH_SERVICE, id).unwrap().is_none());
    }
}
