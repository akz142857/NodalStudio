//! Operation-scoped cancellation and truthful driver-level connection progress.
use crate::connection_diagnostics::ConnectionFailure;
use serde::Serialize;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct ConnectionTests(Arc<Mutex<HashMap<Uuid, CancellationToken>>>);
pub struct RunningTest {
    id: Uuid,
    tests: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    token: CancellationToken,
}
impl Drop for RunningTest {
    fn drop(&mut self) {
        self.token.cancel();
        if let Ok(mut tests) = self.tests.lock() {
            tests.remove(&self.id);
        }
    }
}
impl ConnectionTests {
    pub fn start(&self, id: Uuid) -> Result<RunningTest, ConnectionFailure> {
        let mut tests = self.0.lock().map_err(|_| {
            ConnectionFailure::new("configuration", "Connection tests are unavailable.")
        })?;
        if tests.contains_key(&id) || tests.len() >= 8 {
            return Err(ConnectionFailure::new(
                "configuration",
                "A connection test is already running. Wait for it to finish.",
            ));
        }
        let token = CancellationToken::new();
        tests.insert(id, token.clone());
        Ok(RunningTest {
            id,
            tests: self.0.clone(),
            token,
        })
    }
    pub fn cancel(&self, id: Uuid) -> bool {
        if let Ok(tests) = self.0.lock() {
            if let Some(token) = tests.get(&id) {
                token.cancel();
                return true;
            }
        }
        false
    }
}
impl RunningTest {
    pub async fn run<T>(
        &self,
        work: impl Future<Output = Result<T, ConnectionFailure>>,
    ) -> Result<T, ConnectionFailure> {
        tokio::select! {
            biased;
            _ = self.token.cancelled() => Err(ConnectionFailure::new("cancelled", "Connection test cancelled. Nothing was saved.")),
            result = tokio::time::timeout(Duration::from_secs(40), work) => result.unwrap_or_else(|_| Err(ConnectionFailure::new("timeout", "Connection test timed out. Check the network and server, then try again."))),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestProgress {
    pub phase: &'static str,
    pub ssh_connected: bool,
}
pub fn progress(
    channel: Option<&tauri::ipc::Channel<ConnectionTestProgress>>,
    phase: &'static str,
    ssh_connected: bool,
) {
    if let Some(channel) = channel {
        let _ = channel.send(ConnectionTestProgress {
            phase,
            ssh_connected,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancel_drops_inflight_work_and_registry_without_affecting_other_tests() {
        let tests = ConnectionTests::default();
        let id = Uuid::new_v4();
        let operation = tests.start(id).unwrap();
        let other_id = Uuid::new_v4();
        let other = tests.start(other_id).unwrap();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Guard(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let observed = dropped.clone();
        let work = async move {
            let _guard = Guard(observed);
            std::future::pending::<()>().await;
            Ok::<_, ConnectionFailure>(())
        };
        let cancellation = async {
            tokio::task::yield_now().await;
            assert!(tests.cancel(id));
        };
        let (result, _) = tokio::join!(operation.run(work), cancellation);
        assert_eq!(result.unwrap_err().stage, "cancelled");
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert!(other
            .run(async { Ok::<_, ConnectionFailure>(()) })
            .await
            .is_ok());
        drop(operation);
        assert!(!tests.cancel(id));
        drop(other);
        assert!(tests.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn cancellation_before_work_starts_never_polls_the_connection() {
        let tests = ConnectionTests::default();
        let id = Uuid::new_v4();
        let operation = tests.start(id).unwrap();
        assert!(tests.start(id).is_err());
        tests.cancel(id);
        let result = operation
            .run(async {
                panic!("cancelled work must not start");
                #[allow(unreachable_code)]
                Ok::<_, ConnectionFailure>(())
            })
            .await;
        assert_eq!(result.unwrap_err().stage, "cancelled");
    }
    #[tokio::test]
    async fn cancelling_a_pending_database_handshake_closes_its_socket() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let tests = ConnectionTests::default();
        let id = Uuid::new_v4();
        let operation = tests.start(id).unwrap();
        let input = serde_json::from_value(serde_json::json!({
            "displayName": "Cancellation fixture", "host": "127.0.0.1", "port": port,
            "database": "postgres", "username": "fixture", "password": "fixture-only",
            "databaseType": "postgreSql", "sslMode": "require"
        }))
        .unwrap();
        let server = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 8];
            socket.read_exact(&mut request).await.unwrap();
            assert!(tests.cancel(id));
            let mut remaining = Vec::new();
            tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut remaining))
                .await
                .unwrap()
                .unwrap();
        };
        let (result, _) = tokio::join!(
            operation.run(crate::test_database_connection(&input)),
            server
        );
        assert_eq!(result.err().unwrap().stage, "cancelled");
    }
}
