//! Read-only query execution, cancellation and query history commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn execute_readonly_query(
    input: ExecuteReadonlyQueryInput,
    state: State<'_, AppState>,
) -> Result<QueryExecutionResult, QueryCommandError> {
    run_readonly_query(input, &state, None).await
}

#[tauri::command]
pub(crate) async fn execute_table_preview_query(
    input: ExecuteReadonlyQueryInput,
    state: State<'_, AppState>,
    on_registered: tauri::ipc::Channel<()>,
) -> Result<QueryExecutionResult, QueryCommandError> {
    run_readonly_query(input, &state, Some(on_registered)).await
}

pub(crate) async fn run_readonly_query(
    input: ExecuteReadonlyQueryInput,
    state: &AppState,
    on_registered: Option<tauri::ipc::Channel<()>>,
) -> Result<QueryExecutionResult, QueryCommandError> {
    let query_id = input.query_id;
    let request = ExecuteQueryRequest {
        query_id,
        sql: input.sql.clone(),
        row_limit: input.row_limit,
        timeout_ms: input.timeout_ms,
        max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
        max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
    };
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(|_| query_command_error(query_id, QueryError::Connection))?
        .ok_or_else(|| query_command_error(query_id, QueryError::Connection))?;
    if profile.database_type == DatabaseType::Sqlite {
        return sqlite_source::query(state, profile, input, request, on_registered).await;
    }
    connection_credentials::require_binding(&profile)
        .map_err(|message| query_command_error(query_id, QueryError::Validation(message)))?;
    match profile.database_type {
        DatabaseType::Sqlite => request.validate_sqlite(),
        DatabaseType::PostgreSql => request.validate(),
        DatabaseType::MySql => request.validate_mysql(),
    }
    .map_err(|error| query_command_error(query_id, error))?;
    let cancellation = CancellationToken::new();
    {
        let mut active = state.active_queries.lock().await;
        if active.contains_key(&query_id)
            || active
                .values()
                .any(|(source_id, _)| *source_id == input.source_id)
        {
            return Err(query_command_error(
                query_id,
                QueryError::Validation("A query is already running for this data source.".into()),
            ));
        }
        active.insert(query_id, (input.source_id, cancellation.clone()));
    }
    let _cancel_on_drop = cancellation.clone().drop_guard();
    if let Some(channel) = on_registered {
        let _ = channel.send(());
    }
    let state = state.clone();
    tokio::spawn(async move {
        let result = run_network_query(&state, profile, input, request, cancellation).await;
        state.active_queries.lock().await.remove(&query_id);
        result
    })
    .await
    .map_err(|_| query_command_error(query_id, QueryError::Internal))?
}

pub(crate) async fn run_network_query(
    state: &AppState,
    profile: DataSourceProfile,
    input: ExecuteReadonlyQueryInput,
    request: ExecuteQueryRequest,
    cancellation: CancellationToken,
) -> Result<QueryExecutionResult, QueryCommandError> {
    let query_id = input.query_id;
    let started = std::time::Instant::now();
    let executed_at = Utc::now().to_rfc3339();
    let session = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(query_command_error(query_id, QueryError::Cancelled)),
        prepared = prepare_read_session(state, &profile, None) => prepared.map_err(|error| query_command_error(query_id, error))?,
    };
    let result = execute_prepared_network_query(&session, &request, &cancellation).await;

    // Generated page SQL includes boundary values read from the table.
    if input.table_browse {
        return result.map_err(|error| query_command_error(query_id, error));
    }
    let history = match &result {
        Ok(value) => QueryHistoryEntry {
            id: Uuid::new_v4(),
            source_id: input.source_id,
            executed_at,
            sql_text: input.sql,
            duration_ms: value.duration_ms,
            row_count: value.row_count,
            status: "succeeded".into(),
            error_kind: None,
        },
        Err(error) => QueryHistoryEntry {
            id: Uuid::new_v4(),
            source_id: input.source_id,
            executed_at,
            sql_text: input.sql,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            row_count: 0,
            status: if matches!(error, QueryError::Cancelled) {
                "cancelled".into()
            } else {
                "failed".into()
            },
            error_kind: Some(error.kind().into()),
        },
    };
    let _ = state.store.save_query_history(&history).await;
    result.map_err(|error| query_command_error(query_id, error))
}

pub(crate) async fn execute_prepared_network_query(
    session: &connection_sessions::Session,
    request: &ExecuteQueryRequest,
    cancellation: &CancellationToken,
) -> Result<QueryExecutionResult, QueryError> {
    match &session.pool {
        DatabasePool::Postgres(pool) => execute_postgres_query(pool, request, cancellation).await,
        DatabasePool::MySql(pool) => {
            query_engine::execute_mysql_query(pool, request, cancellation).await
        }
    }
}

pub(crate) async fn prepare_query_connection(
    state: &AppState,
    profile: &DataSourceProfile,
) -> Result<(String, connection_security::Tunnel, Duration), QueryError> {
    let (password, ssh_password, timeout) = query_credentials(state, profile).await?;
    connection_security::validate(&profile.security, profile.ssl_mode)
        .map_err(QueryError::Validation)?;
    let tunnel = connection_security::Tunnel::open(
        &profile.security,
        &profile.host,
        profile.port,
        profile.database_type,
        ssh_password.as_deref(),
    )
    .await
    .map_err(QueryError::Validation)?;
    Ok((password, tunnel, timeout))
}

pub(crate) async fn query_credentials(
    state: &AppState,
    profile: &DataSourceProfile,
) -> Result<(String, Option<String>, Duration), QueryError> {
    let profile_id = profile.id;
    let security = profile.security.clone();
    let (password, ssh_password) = tokio::task::spawn_blocking(move || {
        let password = credential_entry(profile_id)
            .and_then(|entry| entry.get_password().map_err(|_| String::new()))
            .map_err(|_| QueryError::Connection)?;
        let ssh_password = connection_credentials::resolve_ssh(Some(profile_id), &security, None)
            .map_err(QueryError::Validation)?;
        Ok::<_, QueryError>((password, ssh_password))
    })
    .await
    .map_err(|_| QueryError::Internal)??;
    let source_settings = state
        .store
        .get_data_source_settings(profile.id)
        .await
        .map_err(|_| QueryError::Connection)?;
    let timeout = Duration::from_secs(u64::from(
        source_settings.refresh.connection_timeout_seconds,
    ));
    Ok((password, ssh_password, timeout))
}

pub(crate) async fn prepare_read_session(
    state: &AppState,
    profile: &DataSourceProfile,
    limit: Option<Duration>,
) -> Result<connection_sessions::Session, QueryError> {
    let (password, ssh_password, timeout) = query_credentials(state, profile).await?;
    let connect = state
        .sessions
        .open(profile, &password, ssh_password.as_deref(), timeout, || {});
    let session = if let Some(limit) = limit {
        tokio::time::timeout(limit, connect)
            .await
            .map_err(|_| QueryError::Timeout)?
    } else {
        connect.await
    };
    session.map_err(|error| match error.stage {
        "configuration" | "ssh" => QueryError::Validation(error.message),
        _ => QueryError::Connection,
    })
}

#[tauri::command]
pub(crate) async fn cancel_query(
    input: QueryIdInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let active = state.active_queries.lock().await;
    let Some((_, cancellation)) = active.get(&input.query_id) else {
        return Ok(false);
    };
    cancellation.cancel();
    Ok(true)
}

#[tauri::command]
pub(crate) async fn list_query_history(
    input: QueryHistoryInput,
    state: State<'_, AppState>,
) -> Result<Vec<QueryHistoryEntry>, String> {
    state
        .store
        .list_query_history(input.source_id, input.limit.unwrap_or(100))
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
pub(crate) async fn delete_query_history(
    input: DeleteQueryHistoryInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .store
        .delete_query_history(input.source_id, input.history_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
pub(crate) async fn clear_query_history(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    state
        .store
        .clear_query_history(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn query_command_error(query_id: Uuid, error: QueryError) -> QueryCommandError {
    QueryCommandError {
        query_id,
        kind: error.kind().into(),
        message: error.public_message(),
    }
}
