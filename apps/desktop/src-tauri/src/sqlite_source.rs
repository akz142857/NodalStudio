//! `SQLite` operations own the file grant until the driver worker has stopped.
use crate::{AppState, ExecuteReadonlyQueryInput, QueryCommandError, query_command_error};
use query_engine::{ExecuteQueryRequest, QueryError, QueryExecutionResult};
use schema_model::{DataSourceProfile, DatabaseInfo, DatabaseSnapshot, SqliteFile};
use sqlx::Connection;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

enum Operation {
    Test,
    Capture,
    Query(ExecuteQueryRequest),
}
enum Output {
    Test(DatabaseInfo),
    Capture(DatabaseSnapshot),
    Query(QueryExecutionResult),
}

fn access(file: &SqliteFile) -> Result<crate::file_access::Access, String> {
    let path = Path::new(&file.path);
    if !path.is_absolute() {
        return Err("Choose a local SQLite database file.".into());
    }
    if let Some(directory) = &file.access_directory {
        let root = Path::new(directory);
        let grant = crate::file_access::access(root)?;
        let canonical = root
            .canonicalize()
            .map_err(|_| "The selected SQLite folder is unavailable.")?;
        let target = path
            .canonicalize()
            .map_err(|_| "The SQLite database file is unavailable. Select it again.")?;
        if target.parent() != Some(canonical.as_path()) {
            return Err("Select the folder containing this SQLite database.".into());
        }
        return Ok(grant);
    }
    crate::file_access::access(path)
}

async fn run(
    profile: DataSourceProfile,
    operation: Operation,
    timeout: Duration,
    token: CancellationToken,
) -> Result<Output, QueryError> {
    let _cancel = token.clone().drop_guard();
    // An outer cancellation drops only the join handle. This task keeps its grant,
    // signals SQLite through its callback, closes the worker, then releases access.
    tokio::spawn(async move {
        let file = profile.sqlite.as_ref().ok_or_else(|| {
            QueryError::Validation(
                "Select the SQLite file again; imported models do not carry file permissions."
                    .into(),
            )
        })?;
        let _access = access(file).map_err(QueryError::Validation)?;
        let mut connection = sqlite_adapter::connect(Path::new(&file.path))
            .await
            .map_err(|e| QueryError::Validation(e.to_string()))?;
        let deadline = Instant::now() + timeout;
        sqlite_adapter::set_deadline(&mut connection, token.clone(), deadline)
            .await
            .map_err(|_| QueryError::Connection)?;
        let name = Path::new(&file.path)
            .file_name()
            .and_then(|p| p.to_str())
            .unwrap_or("SQLite");
        let result = match operation {
            Operation::Test => sqlite_adapter::test_connection(&mut connection, name)
                .await
                .map(Output::Test)
                .map_err(|e| QueryError::Validation(e.to_string())),
            Operation::Capture => sqlite_adapter::inspect_schema(&mut connection, profile.id, name)
                .await
                .map(Output::Capture)
                .map_err(|e| QueryError::Validation(e.to_string())),
            Operation::Query(request) => {
                query_engine::execute_sqlite_query(&mut connection, &request, &token)
                    .await
                    .map(Output::Query)
            }
        };
        // Idle-handle acquisition is a worker barrier before releasing the grant.
        if let Ok(mut handle) = connection.lock_handle().await {
            handle.remove_progress_handler();
        }
        let closed = connection.close().await;
        if token.is_cancelled() {
            return Err(QueryError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(QueryError::Timeout);
        }
        closed.map_err(|_| QueryError::Connection)?;
        result
    })
    .await
    .map_err(|_| QueryError::Internal)?
}

pub async fn test(profile: DataSourceProfile) -> Result<DatabaseInfo, String> {
    match run(
        profile,
        Operation::Test,
        Duration::from_secs(15),
        CancellationToken::new(),
    )
    .await
    .map_err(|e| e.public_message())?
    {
        Output::Test(database) => Ok(database),
        _ => Err("Invalid SQLite test result.".into()),
    }
}
pub async fn capture(
    profile: DataSourceProfile,
    timeout: Duration,
) -> Result<DatabaseSnapshot, String> {
    match run(
        profile,
        Operation::Capture,
        timeout,
        CancellationToken::new(),
    )
    .await
    .map_err(|e| e.public_message())?
    {
        Output::Capture(snapshot) => Ok(snapshot),
        _ => Err("Invalid SQLite capture result.".into()),
    }
}
pub async fn query(
    state: &AppState,
    profile: DataSourceProfile,
    input: ExecuteReadonlyQueryInput,
    request: ExecuteQueryRequest,
) -> Result<QueryExecutionResult, QueryCommandError> {
    let id = request.query_id;
    request
        .validate_sqlite()
        .map_err(|e| query_command_error(id, e))?;
    let token = CancellationToken::new();
    let _cancel_on_drop = token.clone().drop_guard();
    {
        let mut active = state.active_queries.lock().await;
        if active.contains_key(&id) || active.values().any(|(source, _)| *source == profile.id) {
            return Err(query_command_error(
                id,
                QueryError::Validation("A query is already running for this data source.".into()),
            ));
        }
        active.insert(id, (profile.id, token.clone()));
    }
    let state = state.clone();
    // No await separates registration from spawning the owner. A Stop received
    // after registration finds the token, and caller drop cannot skip cleanup.
    tokio::spawn(async move { query_owned(&state, profile, input, request, token).await })
        .await
        .map_err(|_| query_command_error(id, QueryError::Internal))?
}

async fn query_owned(
    state: &AppState,
    profile: DataSourceProfile,
    input: ExecuteReadonlyQueryInput,
    request: ExecuteQueryRequest,
    token: CancellationToken,
) -> Result<QueryExecutionResult, QueryCommandError> {
    let id = request.query_id;
    let started = Instant::now();
    let at = chrono::Utc::now().to_rfc3339();
    let timeout = Duration::from_millis(request.timeout_ms);
    let result = run(profile, Operation::Query(request), timeout, token)
        .await
        .and_then(|output| match output {
            Output::Query(result) => Ok(result),
            _ => Err(QueryError::Internal),
        });
    state.active_queries.lock().await.remove(&id);
    let history = snapshot_store::QueryHistoryEntry {
        id: uuid::Uuid::new_v4(),
        source_id: input.source_id,
        executed_at: at,
        sql_text: input.sql,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        row_count: result.as_ref().map_or(0, |r| r.row_count),
        status: match &result {
            Ok(_) => "succeeded",
            Err(QueryError::Cancelled) => "cancelled",
            Err(_) => "failed",
        }
        .into(),
        error_kind: result.as_ref().err().map(|e| e.kind().into()),
    };
    let _ = state.store.save_query_history(&history).await;
    result.map_err(|e| query_command_error(id, e))
}

pub async fn revoke_unused_grants(
    state: &AppState,
    removed: &DataSourceProfile,
) -> Result<(), String> {
    let Some(file) = &removed.sqlite else {
        return Ok(());
    };
    let profiles = state
        .store
        .list_data_sources()
        .await
        .map_err(crate::safe_store_error)?;
    for candidate in std::iter::once(&file.path).chain(file.access_directory.iter()) {
        let mut used = false;
        for profile in &profiles {
            if profile.sqlite.as_ref().is_some_and(|s| {
                &s.path == candidate || s.access_directory.as_ref() == Some(candidate)
            }) {
                used = true;
                break;
            }
            let settings = state
                .store
                .get_data_source_settings(profile.id)
                .await
                .map_err(crate::safe_store_error)?;
            let tls = &profile.security.tls;
            let ssh = profile.security.ssh.as_ref();
            let credential_paths = [
                tls.ca_certificate.as_ref(),
                tls.client_certificate.as_ref(),
                tls.client_key.as_ref(),
                ssh.and_then(|s| s.private_key.as_ref()),
                ssh.and_then(|s| s.known_hosts.as_ref()),
            ];
            if settings.git.repository_path == *candidate
                || credential_paths.contains(&Some(candidate))
            {
                used = true;
                break;
            }
        }
        if !used {
            crate::file_access::forget(Path::new(candidate))?;
        }
    }
    Ok(())
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;
    use schema_model::{ConnectionSecurity, DatabaseType, SslMode};
    use sqlx::{Executor, sqlite::SqliteConnectOptions};
    fn profile(path: &Path) -> DataSourceProfile {
        let now = chrono::Utc::now();
        DataSourceProfile {
            id: uuid::Uuid::new_v4(),
            display_name: "Local".into(),
            host: String::new(),
            port: 0,
            database: "local.db".into(),
            username: String::new(),
            database_type: DatabaseType::Sqlite,
            ssl_mode: SslMode::Disable,
            security: ConnectionSecurity::default(),
            sqlite: Some(SqliteFile {
                path: path.to_string_lossy().into(),
                access_directory: None,
            }),
            created_at: now,
            updated_at: now,
        }
    }
    async fn app_state(profile: &DataSourceProfile) -> AppState {
        let store = snapshot_store::LocalSnapshotStore::open("sqlite::memory:")
            .await
            .unwrap();
        store.save_data_source(profile).await.unwrap();
        AppState {
            store,
            ai_limiter: std::sync::Arc::new(tokio::sync::Semaphore::new(840)),
            snapshot_captures: std::sync::Arc::default(),
            cloud_operations: std::sync::Arc::default(),
            active_queries: std::sync::Arc::default(),
        }
    }
    fn query_request(sql: &str) -> ExecuteQueryRequest {
        ExecuteQueryRequest {
            query_id: uuid::Uuid::new_v4(),
            sql: sql.into(),
            row_limit: 100,
            timeout_ms: 30_000,
            max_cell_bytes: 1024,
            max_result_bytes: 1024 * 1024,
        }
    }
    fn query_input(
        profile: &DataSourceProfile,
        request: &ExecuteQueryRequest,
    ) -> ExecuteReadonlyQueryInput {
        ExecuteReadonlyQueryInput {
            query_id: request.query_id,
            source_id: profile.id,
            sql: request.sql.clone(),
            row_limit: request.row_limit,
            timeout_ms: request.timeout_ms,
        }
    }
    #[tokio::test]
    async fn dropped_query_caller_releases_registry_after_worker_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("drop.db");
        std::fs::write(&path, []).unwrap();
        let profile = profile(&path);
        let state = app_state(&profile).await;
        let request = query_request(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
        );
        let id = request.query_id;
        let input = query_input(&profile, &request);
        let (worker_state, worker_profile) = (state.clone(), profile.clone());
        let caller =
            tokio::spawn(async move { query(&worker_state, worker_profile, input, request).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !state.active_queries.lock().await.contains_key(&id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let history = state
                    .store
                    .list_query_history(profile.id, 100)
                    .await
                    .unwrap();
                if state.active_queries.lock().await.is_empty() && !history.is_empty() {
                    assert_eq!(history[0].status, "cancelled");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let next = query_request("SELECT 1");
        let result = query(&state, profile.clone(), query_input(&profile, &next), next).await;
        assert!(
            result.is_ok(),
            "following query must not see a stale active entry"
        );
        assert!(state.active_queries.lock().await.is_empty());
    }
    #[tokio::test]
    async fn query_is_registered_before_the_owner_task_is_scheduled() {
        use std::future::Future;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cancel.db");
        std::fs::write(&path, []).unwrap();
        let profile = profile(&path);
        let state = app_state(&profile).await;
        let request = query_request(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
        );
        let id = request.query_id;
        let input = query_input(&profile, &request);
        let mut pending = Box::pin(query(&state, profile, input, request));
        std::future::poll_fn(|context| {
            assert!(pending.as_mut().poll(context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        // This current-thread runtime has not polled the spawned owner yet.
        state
            .active_queries
            .lock()
            .await
            .get(&id)
            .expect("Stop must already find the query")
            .1
            .cancel();
        let result = pending.await.unwrap_err();
        assert_eq!(result.kind, "cancelled");
        assert!(state.active_queries.lock().await.is_empty());
    }
    #[tokio::test]
    async fn sqlite_name_edits_work_without_reopening_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        for bound in [true, false] {
            let mut original = profile(&dir.path().join("missing.db"));
            if !bound {
                original.sqlite = None;
            }
            let state = app_state(&original).await;
            let input = crate::SaveDataSourceInput {
                sqlite: original.sqlite.clone(),
                id: Some(original.id),
                display_name: "Renamed locally".into(),
                host: String::new(),
                port: 0,
                database: original.database.clone(),
                username: String::new(),
                password: String::new(),
                database_type: DatabaseType::Sqlite,
                ssl_mode: SslMode::Disable,
                security: ConnectionSecurity::default(),
                ssh_password: None,
            };
            let saved = crate::save_data_source_using(input, &state).await.unwrap();
            assert_eq!(saved.display_name, "Renamed locally");
            assert_eq!(saved.database, original.database);
            assert_eq!(
                state
                    .store
                    .get_data_source(original.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .sqlite,
                original.sqlite
            );
            assert!(!dir.path().join("missing.db").exists());
            assert!(
                state
                    .store
                    .latest_snapshot(original.id)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }
    #[test]
    fn sqlite_does_not_probe_database_credentials_or_report_weak_tls() {
        let local = profile(Path::new("/missing/local.db"));
        let mut network = local.clone();
        network.id = uuid::Uuid::new_v4();
        network.database_type = DatabaseType::PostgreSql;
        network.sqlite = None;
        let profiles = [local.clone(), network.clone()];
        assert_eq!(
            crate::network_security_status(&profiles, Some(local.id), |_| panic!(
                "SQLite cannot read network credentials"
            )),
            (false, 1)
        );
        assert_eq!(
            crate::network_security_status(&profiles, Some(network.id), |id| id == network.id),
            (true, 1)
        );
    }
    #[tokio::test]
    async fn cloud_capability_gate_uses_uploaded_schema_not_connection_profile() {
        let mut network = profile(Path::new("/unused.db"));
        network.database_type = DatabaseType::PostgreSql;
        network.sqlite = None;
        let state = app_state(&network).await;
        let mut imported = DatabaseSnapshot::new(
            network.id,
            DatabaseInfo {
                name: "imported.sqlite".into(),
                database_type: DatabaseType::Sqlite,
                version: "3".into(),
            },
            vec![schema_model::SchemaDefinition::empty("main")],
        );
        imported.canonicalize().unwrap();
        state.store.save_snapshot(&imported).await.unwrap();
        let input = crate::SyncProjectInput {
            source_id: network.id,
            project_id: uuid::Uuid::new_v4(),
            api_url: "https://cloud.invalid".into(),
            access_token: String::new(),
            base_version: 0,
        };
        let mut settings = settings_model::CloudSettings {
            sync_snapshots: true,
            ..Default::default()
        };
        let mut bundle = crate::build_cloud_bundle(&state.store, &input, &settings)
            .await
            .unwrap();
        assert!(crate::cloud_requires_sqlite_support(&bundle));
        settings.sync_snapshots = false;
        bundle = crate::build_cloud_bundle(&state.store, &input, &settings)
            .await
            .unwrap();
        assert!(!crate::cloud_requires_sqlite_support(&bundle));
        let mut changes = schema_diff::diff_snapshots(&imported, &imported);
        changes.operations.push(schema_diff::SchemaOperation {
            operation_type: schema_diff::OperationType::AlterTable,
            object: schema_model::ObjectKey::table("main", "example"),
            risk: schema_diff::RiskLevel::Medium,
            before: Some("CREATE TABLE example(value)".into()),
            after: Some("CREATE TABLE example(value) STRICT".into()),
        });
        bundle.change_set = Some(changes);
        assert!(crate::cloud_requires_sqlite_support(&bundle));
    }
    #[tokio::test]
    async fn file_lifecycle_capture_and_rebinding_do_not_require_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local.db");
        let mut writer = sqlx::SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        writer
            .execute("CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .unwrap();
        writer.close().await.unwrap();
        let profile = profile(&path);
        assert_eq!(
            test(profile.clone()).await.unwrap().database_type,
            DatabaseType::Sqlite
        );
        let first = capture(profile.clone(), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(first.schemas[0].tables[0].key.name, "example");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            first.fingerprint,
            capture(profile.clone(), Duration::from_secs(5))
                .await
                .unwrap()
                .fingerprint
        );
        assert_eq!(bytes, std::fs::read(&path).unwrap());
        let mut restored = profile.clone();
        restored.sqlite = None;
        assert!(
            test(restored)
                .await
                .unwrap_err()
                .contains("Select the SQLite file again")
        );
        let mut relocated = profile.clone();
        relocated.sqlite.as_mut().unwrap().path =
            dir.path().join("other.db").to_string_lossy().into();
        assert_ne!(
            semantic_model::knowledge::source_identity(Some(&profile)),
            semantic_model::knowledge::source_identity(Some(&relocated))
        );
        let mut bad_folder = profile;
        bad_folder.sqlite.as_mut().unwrap().access_directory =
            Some(dir.path().join("missing").to_string_lossy().into());
        assert!(test(bad_folder).await.is_err());
    }
}
