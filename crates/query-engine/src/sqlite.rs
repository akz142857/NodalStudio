use crate::{
    ExecuteQueryRequest, QueryCell, QueryColumn, QueryError, QueryExecutionResult, value::text_cell,
};
use futures_util::StreamExt;
use sqlx::{
    AssertSqlSafe, Column, Executor, Row, SqlSafeStr, SqliteConnection, Statement, TypeInfo,
    ValueRef,
};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Executes one bounded query. Engine callbacks enforce cancellation while `sqlite3_step` runs.
/// # Errors
/// Returns validation, cancellation, timeout, connection or result-limit errors.
pub async fn execute_sqlite_query(
    connection: &mut SqliteConnection,
    request: &ExecuteQueryRequest,
    cancellation: &CancellationToken,
) -> Result<QueryExecutionResult, QueryError> {
    request.validate_sqlite()?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(request.timeout_ms);
    let stop = cancellation.child_token();
    let _cancel_on_drop = stop.clone().drop_guard();
    let callback = stop.clone();
    connection
        .lock_handle()
        .await
        .map_err(|_| QueryError::Connection)?
        .set_progress_handler(1000, move || {
            !callback.is_cancelled() && Instant::now() < deadline
        });
    let result = run(connection, request, cancellation, deadline, started).await;
    // This stops any queued row production before acquiring the idle worker handle.
    stop.cancel();
    connection
        .lock_handle()
        .await
        .map_err(|_| QueryError::Connection)?
        .remove_progress_handler();
    if cancellation.is_cancelled() {
        return Err(QueryError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(QueryError::Timeout);
    }
    result
}
async fn run(
    connection: &mut SqliteConnection,
    request: &ExecuteQueryRequest,
    token: &CancellationToken,
    deadline: Instant,
    started: Instant,
) -> Result<QueryExecutionResult, QueryError> {
    if token.is_cancelled() {
        return Err(QueryError::Cancelled);
    }
    let description = connection
        .prepare(AssertSqlSafe(request.sql.clone()).into_sql_str())
        .await
        .map_err(|_| QueryError::Database)?;
    let columns = description
        .columns()
        .iter()
        .map(|c| QueryColumn {
            name: c.name().into(),
            database_type: match c.type_info().name() {
                "NULL" => "DYNAMIC".into(),
                declared => declared.into(),
            },
        })
        .collect();
    let mut stream = sqlx::query(AssertSqlSafe(request.sql.clone())).fetch(&mut *connection);
    let mut rows = vec![];
    let mut bytes = 0usize;
    let mut truncated = false;
    while let Some(row) = stream.next().await {
        if token.is_cancelled() {
            return Err(QueryError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(QueryError::Timeout);
        }
        let row = row.map_err(|_| QueryError::Database)?;
        if rows.len() >= request.row_limit as usize {
            truncated = true;
            break;
        }
        let mut cells = vec![];
        for i in 0..row.len() {
            let raw = row.try_get_raw(i).map_err(|_| QueryError::Internal)?;
            let kind = raw.type_info().name().to_owned();
            let cell = if raw.is_null() {
                QueryCell::Null
            } else {
                match kind.as_str() {
                    "INTEGER" => {
                        let value: i64 = row
                            .try_get_unchecked(i)
                            .map_err(|_| QueryError::UnsupportedType)?;
                        let text = value.to_string();
                        bytes = bytes.saturating_add(text.len());
                        text_cell(&text, request.max_cell_bytes)
                    }
                    "REAL" => {
                        let value: f64 = row
                            .try_get_unchecked(i)
                            .map_err(|_| QueryError::UnsupportedType)?;
                        bytes = bytes.saturating_add(value.to_string().len());
                        if value.is_finite() {
                            QueryCell::Number { value }
                        } else {
                            text_cell(&value.to_string(), request.max_cell_bytes)
                        }
                    }
                    "BLOB" => {
                        let value: Vec<u8> = row
                            .try_get_unchecked(i)
                            .map_err(|_| QueryError::UnsupportedType)?;
                        bytes = bytes.saturating_add(value.len());
                        QueryCell::Binary {
                            byte_length: value.len(),
                        }
                    }
                    _ => {
                        let value: String = row
                            .try_get_unchecked(i)
                            .map_err(|_| QueryError::UnsupportedType)?;
                        bytes = bytes.saturating_add(value.len());
                        text_cell(&value, request.max_cell_bytes)
                    }
                }
            };
            if bytes > request.max_result_bytes {
                return Err(QueryError::ResultLimit);
            }
            cells.push(cell);
        }
        rows.push(cells);
    }
    Ok(QueryExecutionResult{query_id:request.query_id,columns,row_count:rows.len(),rows,truncated,duration_ms:u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),notices:vec!["SQLite values retain their storage types; integers are exact text and BLOBs are length summaries.".into()]})
}
