//! Binds a confirmed manual DDL statement to the selected desktop connection.
use crate::{AppState, CaptureSnapshotResult, connection_credentials, safe_store_error};
use query_engine::schema_ddl::{DdlError, execute_mysql_ddl, execute_postgres_ddl};
use schema_model::{DataSourceProfile, DatabaseSnapshot, DatabaseType};
use std::time::Duration;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDdlInput {
    source_id: uuid::Uuid,
    database_type: DatabaseType,
    host: String,
    port: u16,
    database: String,
    username: String,
    profile_updated_at: chrono::DateTime<chrono::Utc>,
    sql: String,
}

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DdlReceipt {
    Refreshed { capture: Box<CaptureSnapshotResult> },
    RefreshFailed { message: String },
    OutcomeUnknown,
}

fn matches_target(input: &NetworkDdlInput, profile: &DataSourceProfile) -> bool {
    profile.id == input.source_id
        && profile.database_type == input.database_type
        && profile.host == input.host
        && profile.port == input.port
        && profile.database == input.database
        && profile.username == input.username
        && profile.updated_at == input.profile_updated_at
}

#[tauri::command]
pub async fn execute_network_ddl(
    input: NetworkDdlInput,
    state: tauri::State<'_, AppState>,
) -> Result<DdlReceipt, String> {
    let state = state.inner().clone();
    tokio::spawn(async move { execute(&state, input).await })
        .await
        .map_err(|_| "Unable to complete the schema operation.".to_owned())?
}

async fn execute(state: &AppState, input: NetworkDdlInput) -> Result<DdlReceipt, String> {
    if input.database_type == DatabaseType::Sqlite {
        return Err("Use the local SQLite DDL entry point.".into());
    }
    let gate = crate::snapshot_capture_gate(state, input.source_id).await;
    let _permit = tokio::time::timeout(Duration::from_secs(15), gate.acquire_owned())
        .await
        .map_err(|_| "A database snapshot is still being captured. Try again shortly.".to_owned())?
        .map_err(|_| "Unable to lock the schema workspace.".to_owned())?;
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .filter(|profile| matches_target(&input, profile))
        .ok_or("The selected database connection changed. Review the statement again.")?;
    connection_credentials::require_binding(&profile)?;
    let settings = state
        .store
        .get_data_source_settings(profile.id)
        .await
        .map_err(safe_store_error)?;
    let timeout = Duration::from_secs(u64::from(settings.refresh.introspection_timeout_seconds));
    let (password, tunnel, connect_timeout) = crate::prepare_query_connection(state, &profile)
        .await
        .map_err(|error| error.public_message())?;

    let capture = match profile.database_type {
        DatabaseType::PostgreSql => {
            let options = crate::connection_options_from_profile(&profile, &password)
                .with_socket(tunnel.postgres_socket())
                .with_connect_timeout(connect_timeout);
            let pool = postgres_adapter::connect(&options)
                .await
                .map_err(crate::safe_connection_error)?;
            if let Err(error) = execute_postgres_ddl(&pool, &input.sql).await {
                pool.close().await;
                return ddl_failure(&error);
            }
            let capture =
                tokio::time::timeout(timeout, postgres_adapter::inspect_schema(&pool, profile.id))
                    .await
                    .map_err(|_| "PostgreSQL introspection timed out.".to_owned())
                    .and_then(|snapshot| snapshot.map_err(crate::safe_connection_error));
            pool.close().await;
            capture
        }
        DatabaseType::MySql => {
            let options = crate::mysql_connection_options_from_profile(&profile, &password)
                .with_socket(tunnel.mysql_socket())
                .with_connect_timeout(connect_timeout);
            let pool = mysql_adapter::connect(&options)
                .await
                .map_err(crate::safe_mysql_error)?;
            if let Err(error) = execute_mysql_ddl(&pool, &profile.database, &input.sql).await {
                pool.close().await;
                return ddl_failure(&error);
            }
            let capture =
                tokio::time::timeout(timeout, mysql_adapter::inspect_schema(&pool, profile.id))
                    .await
                    .map_err(|_| "MySQL introspection timed out.".to_owned())
                    .and_then(|snapshot| snapshot.map_err(crate::safe_mysql_error));
            pool.close().await;
            capture
        }
        DatabaseType::Sqlite => unreachable!("SQLite is dispatched through its local file command"),
    };
    Ok(match persist_capture(state, &input, capture).await {
        Ok(capture) => DdlReceipt::Refreshed {
            capture: Box::new(capture),
        },
        Err(message) => DdlReceipt::RefreshFailed { message },
    })
}

fn ddl_failure(error: &DdlError) -> Result<DdlReceipt, String> {
    match error {
        DdlError::OutcomeUnknown => Ok(DdlReceipt::OutcomeUnknown),
        _ => Err(error.to_string()),
    }
}

async fn persist_capture(
    state: &AppState,
    input: &NetworkDdlInput,
    capture: Result<DatabaseSnapshot, String>,
) -> Result<CaptureSnapshotResult, String> {
    let capture = capture?;
    if !state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .is_some_and(|profile| matches_target(input, &profile))
    {
        return Err(
            "The selected database connection changed after the statement completed.".into(),
        );
    }
    state
        .store
        .save_captured_snapshot(&capture)
        .await
        .map_err(safe_store_error)
}
