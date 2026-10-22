//! Safe connection-test diagnostics: never echo driver messages or credentials.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFailure {
    pub stage: &'static str,
    pub message: String,
    pub ssh_connected: bool,
}
impl ConnectionFailure {
    pub fn new(stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
            ssh_connected: false,
        }
    }
    pub fn after_ssh(mut self, connected: bool) -> Self {
        self.ssh_connected = connected;
        self
    }
}
impl std::fmt::Display for ConnectionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.stage, self.message)
    }
}
pub fn database(error: &sqlx::Error) -> ConnectionFailure {
    use sqlx::Error;
    let (stage, message) = match error {
        Error::Tls(_) => (
            "tls",
            "TLS handshake or certificate verification failed. Check the CA certificate, database hostname, and client certificate/key.",
        ),
        Error::Database(error) => match error.code().as_deref() {
            Some("28P01" | "28000" | "1045" | "1698") => (
                "database",
                "Database authentication was rejected. Check the database username, password, and server access rules.",
            ),
            Some("3D000" | "1049") => ("database", "The database does not exist. Check its name."),
            Some("42501" | "1044" | "1142") => (
                "database",
                "The account does not have permission to access this database or read its metadata.",
            ),
            _ => (
                "database",
                "The database rejected the connection or metadata request. Check database access rules and permissions.",
            ),
        },
        Error::Io(_) | Error::PoolTimedOut => (
            "database",
            "Could not reach the database or complete its handshake. Check its host, port, network, and server availability. With SSH enabled, the database must be reachable from the jump host.",
        ),
        _ => (
            "database",
            "Could not read database identity. Check server compatibility and metadata permissions.",
        ),
    };
    ConnectionFailure::new(stage, message)
}
pub fn postgres(error: postgres_adapter::PostgresAdapterError) -> ConnectionFailure {
    match error {
        postgres_adapter::PostgresAdapterError::Database(error) => database(&error),
        _ => ConnectionFailure::new("database", "Could not read PostgreSQL metadata."),
    }
}
pub fn mysql(error: mysql_adapter::MySqlAdapterError) -> ConnectionFailure {
    match error {
        mysql_adapter::MySqlAdapterError::Database(error)
        | mysql_adapter::MySqlAdapterError::Metadata { source: error, .. } => database(&error),
        _ => ConnectionFailure::new("database", "Could not read MySQL metadata."),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifies_tls_without_exposing_driver_secrets() {
        let failure = database(&sqlx::Error::Tls(
            std::io::Error::other("private-key-material").into(),
        ));
        assert_eq!(failure.stage, "tls");
        assert!(!failure.message.contains("private-key-material"));
        assert!(!failure.ssh_connected);
    }
    #[test]
    fn database_timeout_does_not_claim_tls_or_ssh_failed() {
        let failure = database(&sqlx::Error::PoolTimedOut).after_ssh(true);
        assert_eq!(failure.stage, "database");
        assert!(failure.ssh_connected);
        assert!(failure.message.contains("jump host"));
    }
    #[tokio::test]
    async fn preflight_reports_tls_and_ssh_configuration_separately() {
        let base = serde_json::json!({
            "displayName": "Test", "host": "localhost", "port": 5432,
            "database": "postgres", "username": "postgres", "password": "test-only",
            "databaseType": "postgreSql", "sslMode": "verifyFull",
            "security": { "tls": { "caCertificate": "/nonexistent/nodal-test-ca.pem" } }
        });
        let error = crate::prepare_connection_test(serde_json::from_value(base.clone()).unwrap())
            .err()
            .unwrap();
        assert_eq!(error.stage, "tls");
        assert!(!error.ssh_connected);
        let mut ssh = base;
        ssh["security"] = serde_json::json!({ "tls": {}, "ssh": {
            "host": "jump.example", "port": 22, "username": "test", "authentication": "password"
        }});
        let error = crate::prepare_connection_test(serde_json::from_value(ssh).unwrap())
            .err()
            .unwrap();
        assert_eq!(error.stage, "ssh");
        assert!(error.message.contains("password"));
        assert!(!error.ssh_connected);
    }
}
