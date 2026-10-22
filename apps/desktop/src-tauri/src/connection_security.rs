//! Local TLS configuration and an operation-scoped OpenSSH tunnel.
//! Unix socket forwarding preserves the database hostname for TLS verification.
use schema_model::{ConnectionSecurity, DatabaseType, SshAuthentication, SslMode};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri_plugin_dialog::DialogExt;

fn local_file(value: &Option<String>, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        let path = Path::new(value);
        if !path.is_absolute() || !path.is_file() || std::fs::File::open(path).is_err() {
            return Err(format!("Choose a readable local file for {label}."));
        }
    }
    Ok(())
}

pub fn validate(security: &ConnectionSecurity, mode: SslMode) -> Result<(), String> {
    if mode != SslMode::Disable {
        let tls = &security.tls;
        if tls.client_certificate.is_some() != tls.client_key.is_some() {
            return Err("Client certificate and private key must be provided together.".into());
        }
        local_file(&tls.ca_certificate, "the CA certificate")?;
        local_file(&tls.client_certificate, "the client certificate")?;
        local_file(&tls.client_key, "the TLS private key")?;
    }
    if let Some(ssh) = &security.ssh {
        if !valid_host(&ssh.host)
            || ssh.port == 0
            || ssh.username.is_empty()
            || !ssh
                .username
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err("Enter a valid SSH host, port, and username.".into());
        }
        if ssh.authentication == SshAuthentication::PrivateKey {
            if ssh.private_key.is_none() {
                return Err("Choose an SSH private key.".into());
            }
            local_file(&ssh.private_key, "the SSH private key")?;
        }
        local_file(&ssh.known_hosts, "the SSH known hosts file")?;
    }
    Ok(())
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c))
}

// SSH_ASKPASS launches this same signed executable in a small, non-GUI mode.
// The environment contains a socket and single-use token, never the password.
fn askpass_executable() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("NODAL_TEST_ASKPASS_EXECUTABLE") {
        return Ok(path.into());
    }
    std::env::current_exe().map_err(|_| "Unable to locate the SSH authentication helper.".into())
}
struct Askpass {
    socket: PathBuf,
    token: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Askpass {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Askpass {
    #[cfg(unix)]
    async fn start(directory: &Path, password: &str) -> Result<Self, String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if password.len() > 16_384 || password.contains(['\n', '\r', '\0']) {
            return Err("Unsupported SSH password length or characters.".into());
        }
        let socket = directory.join("askpass.sock");
        let listener = tokio::net::UnixListener::bind(&socket)
            .map_err(|_| "Unable to prepare SSH password authentication.")?;
        let token = uuid::Uuid::new_v4().to_string();
        let expected = token.clone();
        let password = password.to_owned();
        let task = tokio::spawn(async move {
            let serve = async {
                while let Ok((mut stream, _)) = listener.accept().await {
                    let mut received = [0u8; 36];
                    if !matches!(
                        tokio::time::timeout(
                            Duration::from_secs(1),
                            stream.read_exact(&mut received)
                        )
                        .await,
                        Ok(Ok(_))
                    ) {
                        continue;
                    }
                    if received != expected.as_bytes() {
                        continue;
                    }
                    let _ = stream
                        .write_all(&(password.len() as u32).to_be_bytes())
                        .await;
                    let _ = stream.write_all(password.as_bytes()).await;
                    break;
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(15), serve).await;
        });
        Ok(Self {
            socket,
            token,
            task,
        })
    }
    #[cfg(not(unix))]
    async fn start(_: &Path, _: &str) -> Result<Self, String> {
        Err("SSH requires macOS or Linux.".into())
    }
}

/// Returns before Tauri initializes when launched by OpenSSH for password input.
pub fn run_askpass_helper() -> bool {
    if std::env::var("NODAL_SSH_ASKPASS").as_deref() != Ok("1") {
        return false;
    }
    #[cfg(unix)]
    {
        use std::io::{Read, Write};
        let result = (|| -> std::io::Result<()> {
            let socket = std::env::var_os("NODAL_SSH_ASKPASS_SOCKET")
                .ok_or(std::io::ErrorKind::InvalidInput)?;
            let token = std::env::var("NODAL_SSH_ASKPASS_TOKEN")
                .map_err(|_| std::io::ErrorKind::InvalidInput)?;
            if token.len() != 36 {
                return Err(std::io::ErrorKind::InvalidInput.into());
            }
            let mut stream = std::os::unix::net::UnixStream::connect(socket)?;
            stream.set_read_timeout(Some(Duration::from_secs(3)))?;
            stream.set_write_timeout(Some(Duration::from_secs(3)))?;
            stream.write_all(token.as_bytes())?;
            let mut length = [0u8; 4];
            stream.read_exact(&mut length)?;
            let size = u32::from_be_bytes(length) as usize;
            if size == 0 || size > 16_384 {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            let mut password = vec![0; size];
            stream.read_exact(&mut password)?;
            std::io::stdout().write_all(&password)?;
            std::io::stdout().write_all(b"\n")?;
            Ok(())
        })();
        if result.is_err() {
            std::process::exit(1);
        }
        true
    }
    #[cfg(not(unix))]
    {
        std::process::exit(1);
    }
}

pub struct Tunnel {
    // kill_on_drop also covers cancellation and early error returns.
    _child: Option<tokio::process::Child>,
    _askpass: Option<Askpass>,
    directory: Option<tempfile::TempDir>,
    socket: Option<PathBuf>,
}
impl Tunnel {
    pub async fn open(
        security: &ConnectionSecurity,
        host: &str,
        port: u16,
        dialect: DatabaseType,
        password: Option<&str>,
    ) -> Result<Self, String> {
        let Some(ssh) = &security.ssh else {
            return Ok(Self {
                _child: None,
                _askpass: None,
                directory: None,
                socket: None,
            });
        };
        if !cfg!(unix) {
            return Err("SSH tunneling currently requires macOS or Linux.".into());
        }
        if !valid_host(host) || port == 0 {
            return Err("Enter a valid database host and port for SSH forwarding.".into());
        }
        // Keep paths short enough for sockaddr_un on macOS. tempfile creates a private 0700 directory.
        let directory = tempfile::Builder::new()
            .prefix("nodal-ssh-")
            .tempdir_in("/tmp")
            .map_err(|_| "Unable to create the private SSH socket directory.")?;
        let socket = directory.path().join(match dialect {
            DatabaseType::PostgreSql => format!(".s.PGSQL.{port}"),
            DatabaseType::MySql => "mysql.sock".into(),
        });
        let destination = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let forward = format!("{}:{destination}:{port}", socket.display());
        let mut command = tokio::process::Command::new("/usr/bin/ssh");
        // Ignore arbitrary local config commands/proxies. Never disable host-key validation.
        command.args([
            "-F",
            "/dev/null",
            "-N",
            "-T",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "-o",
            "ForwardAgent=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "LogLevel=ERROR",
        ]);
        if let Some(path) = &ssh.known_hosts {
            command.arg("-o").arg(format!(
                "UserKnownHostsFile=\"{}\"",
                path.replace('\\', "\\\\").replace('"', "\\\"")
            ));
        }
        let askpass = if ssh.authentication == SshAuthentication::Password {
            let password = password
                .filter(|p| !p.is_empty())
                .ok_or("Enter an SSH password.")?;
            let askpass = Askpass::start(directory.path(), password).await?;
            command.args([
                "-o",
                "BatchMode=no",
                "-o",
                "PasswordAuthentication=yes",
                "-o",
                "PreferredAuthentications=password",
                "-o",
                "PubkeyAuthentication=no",
                "-o",
                "NumberOfPasswordPrompts=1",
            ]);
            command
                .env("SSH_ASKPASS", askpass_executable()?)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env("DISPLAY", "nodal:0")
                .env("NODAL_SSH_ASKPASS", "1")
                .env("NODAL_SSH_ASKPASS_SOCKET", &askpass.socket)
                .env("NODAL_SSH_ASKPASS_TOKEN", &askpass.token);
            Some(askpass)
        } else {
            command.args(["-o", "BatchMode=yes", "-o", "PasswordAuthentication=no"]);
            if ssh.authentication == SshAuthentication::PrivateKey {
                command.args(["-o", "IdentitiesOnly=yes", "-i"]).arg(
                    ssh.private_key
                        .as_ref()
                        .ok_or("Choose an SSH private key.")?,
                );
            } else {
                command.args(["-o", "IdentityFile=none"]);
            }
            None
        };
        command
            .arg("-p")
            .arg(ssh.port.to_string())
            .arg("-l")
            .arg(&ssh.username)
            .arg("-L")
            .arg(forward)
            .arg("--")
            .arg(&ssh.host);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|_| "Unable to start OpenSSH. Install the system SSH client.")?;
        let mut tunnel = Self {
            _child: Some(child),
            _askpass: askpass,
            directory: Some(directory),
            socket: Some(socket),
        };
        let started = std::time::Instant::now();
        loop {
            let child = tunnel._child.as_mut().expect("SSH child");
            if child
                .try_wait()
                .map_err(|_| "Unable to check the SSH connection.")?
                .is_some()
            {
                use tokio::io::AsyncReadExt;
                let mut message = String::new();
                if let Some(stderr) = child.stderr.take() {
                    let _ = stderr.take(4096).read_to_string(&mut message).await;
                }
                return Err(ssh_error(&message).into());
            }
            if tunnel.socket.as_ref().is_some_and(|path| path.exists()) {
                return Ok(tunnel);
            }
            if started.elapsed() > Duration::from_secs(15) {
                return Err(
                    "SSH connection timed out. Check the jump host, port, and network.".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    pub fn postgres_socket(&self) -> Option<&Path> {
        self.directory.as_ref().map(tempfile::TempDir::path)
    }
    pub fn mysql_socket(&self) -> Option<&Path> {
        self.socket.as_deref()
    }
}
fn ssh_error(message: &str) -> &'static str {
    if message.contains("Host key verification failed")
        || message.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        "SSH server identity is not trusted or has changed. Verify its fingerprint with your administrator, then add it to your known_hosts file using Terminal or choose a trusted known_hosts file."
    } else if message.contains("Permission denied")
        || message.contains("Load key")
        || message.contains("UNPROTECTED PRIVATE KEY")
    {
        "SSH authentication failed. Check the username and password or private key. Unlock encrypted keys in your SSH Agent before connecting."
    } else {
        "Unable to establish the SSH tunnel. Check the jump host, authentication, and forwarding permissions."
    }
}

#[tauri::command]
pub async fn pick_connection_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a certificate, private key, or known_hosts file")
            .blocking_pick_file()
            .map(|file| {
                file.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|_| "Choose a local file.".to_owned())
            })
            .transpose()
    })
    .await
    .map_err(|_| "Unable to open the file picker.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_incomplete_tls_identity_and_missing_files() {
        let mut security = ConnectionSecurity::default();
        security.tls.client_certificate = Some("/missing/client.pem".into());
        assert!(validate(&security, SslMode::VerifyFull)
            .unwrap_err()
            .contains("together"));
        security.tls.client_key = Some("/missing/client.key".into());
        assert!(validate(&security, SslMode::VerifyFull)
            .unwrap_err()
            .contains("readable"));
        assert!(validate(&security, SslMode::Disable).is_ok());
    }
    #[test]
    fn validates_ssh_fields_without_command_or_forward_injection() {
        for host in [
            "-oProxyCommand=bad",
            "host\nother",
            "a:b/c",
            "user@host",
            "host space",
        ] {
            assert!(!valid_host(host));
        }
        for host in ["bastion.example.com", "127.0.0.1", "2001:db8::1"] {
            assert!(valid_host(host));
        }
        assert!(ssh_error("Host key verification failed").contains("fingerprint"));
    }
    #[tokio::test]
    async fn direct_connections_do_not_start_a_tunnel() {
        let tunnel = Tunnel::open(
            &ConnectionSecurity::default(),
            "db",
            5432,
            DatabaseType::PostgreSql,
            None,
        )
        .await
        .unwrap();
        assert!(tunnel.postgres_socket().is_none());
        assert!(tunnel.mysql_socket().is_none());
    }
    #[test]
    fn old_profiles_load_without_security_migration() {
        let profile: schema_model::DataSourceProfile = serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::new_v4(), "displayName": "Existing", "host": "localhost", "port": 5432,
            "database": "postgres", "username": "postgres", "databaseType": "postgreSql", "sslMode": "prefer",
            "createdAt": "2026-10-22T00:00:00Z", "updatedAt": "2026-10-22T00:00:00Z"
        })).unwrap();
        assert_eq!(profile.security, ConnectionSecurity::default());
    }

    /// Run only against the isolated local TLS/SSH fixture, never a saved data source.
    #[tokio::test]
    #[ignore = "requires the local nodal-security-acceptance fixture"]
    async fn tls_and_ssh_acceptance() {
        use schema_model::{SshConfig, TlsConfig};
        let directory = std::env::var("NODAL_SECURITY_FIXTURE").expect("fixture path");
        assert!(directory.starts_with("/tmp/nodal-security-acceptance"));
        let file = |name: &str| Some(format!("{directory}/{name}"));
        let mut input = crate::SaveDataSourceInput {
            id: None,
            display_name: "Security acceptance".into(),
            host: "localhost".into(),
            port: 55439,
            database: "postgres".into(),
            username: "postgres".into(),
            password: "nodal-local-test-only".into(),
            ssh_password: None,
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::VerifyFull,
            security: ConnectionSecurity {
                tls: TlsConfig {
                    ca_certificate: file("ca.pem"),
                    client_certificate: file("client-tls.pem"),
                    client_key: file("client-tls.key"),
                },
                ssh: None,
            },
        };
        validate(&input.security, input.ssl_mode).unwrap();
        assert_eq!(
            crate::test_database_connection(&input)
                .await
                .unwrap()
                .ssl_active,
            Some(true)
        );
        // A trusted CA does not bypass the original database hostname check.
        input.host = "127.0.0.1".into();
        assert!(crate::test_database_connection(&input).await.is_err());
        input.host = "localhost".into();
        let certificate = input.security.tls.client_certificate.take();
        let key = input.security.tls.client_key.take();
        assert!(crate::test_database_connection(&input).await.is_err());
        input.security.tls.client_certificate = certificate;
        input.security.tls.client_key = key;
        input.security.ssh = Some(SshConfig {
            host: "127.0.0.1".into(),
            port: 55440,
            username: std::env::var("USER").unwrap(),
            authentication: SshAuthentication::PrivateKey,
            private_key: file("client"),
            known_hosts: file("known hosts"),
        });
        assert_eq!(
            crate::test_database_connection(&input)
                .await
                .unwrap()
                .ssl_active,
            Some(true)
        );
        let tunnel = Tunnel::open(
            &input.security,
            &input.host,
            input.port,
            input.database_type,
            input.ssh_password.as_deref(),
        )
        .await
        .unwrap();
        let socket = tunnel.mysql_socket().unwrap().to_owned();
        let pool = postgres_adapter::connect(
            &crate::connection_options_from_input(&input).with_socket(tunnel.postgres_socket()),
        )
        .await
        .unwrap();
        assert!(
            postgres_adapter::inspect_schema(&pool, uuid::Uuid::new_v4())
                .await
                .is_ok()
        );
        let request = query_engine::ExecuteQueryRequest {
            query_id: uuid::Uuid::new_v4(),
            sql: "SELECT 42 AS answer".into(),
            row_limit: 100,
            timeout_ms: 5_000,
            max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
            max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
        };
        let result = query_engine::execute_postgres_query(
            &pool,
            &request,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.row_count, 1);
        pool.close().await;
        drop(tunnel);
        assert!(!socket.exists());
        // Agent authentication uses the isolated test agent, never the user's agent.
        let agent = std::env::var("SSH_AUTH_SOCK").expect("isolated fixture agent");
        assert_eq!(agent, format!("{directory}/agent.sock"));
        input.security.ssh.as_mut().unwrap().authentication = SshAuthentication::Agent;
        assert_eq!(
            crate::test_database_connection(&input)
                .await
                .unwrap()
                .ssl_active,
            Some(true)
        );
        // Unknown server identity must fail instead of silently accepting the key.
        let empty = tempfile::NamedTempFile::new().unwrap();
        input.security.ssh.as_mut().unwrap().known_hosts =
            Some(empty.path().to_string_lossy().into_owned());
        let failure = crate::test_database_connection(&input).await.err().unwrap();
        assert!(failure.to_string().contains("fingerprint"), "{failure}");
    }
}
