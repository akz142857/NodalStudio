use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sqlx::{AssertSqlSafe, Column, Executor, MySqlPool, Row, SqlSafeStr, TypeInfo};
use tokio_util::sync::CancellationToken;

use crate::{ExecuteQueryRequest, QueryError, QueryExecutionResult, mysql_value::cells_from_row};

/// Executes a bounded `MySQL` SELECT in a dedicated read-only transaction.
///
/// # Errors
/// Returns public-safe validation, connection, database, size, timeout or cancellation errors.
pub async fn execute_mysql_query(
    pool: &MySqlPool,
    request: &ExecuteQueryRequest,
    cancellation: &CancellationToken,
) -> Result<QueryExecutionResult, QueryError> {
    request.validate_mysql()?;
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms);
    // Detach so a cancelled/partially consumed result never returns to the pool.
    let mut connection = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(QueryError::Cancelled),
        result = tokio::time::timeout_at(deadline, pool.acquire()) =>
            result.map_err(|_| QueryError::Timeout)?.map_err(|_| QueryError::Connection)?.detach(),
    };
    let mut connection_id: Option<u64> = None;
    let operation = async {
        connection_id = Some(
            sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut connection)
                .await
                .map_err(|error| map_database_error(&error))?,
        );
        // Match the editor/parser's standard MySQL quoting rules on this disposable session.
        sqlx::query("SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',ANSI_QUOTES,', ','), ',NO_BACKSLASH_ESCAPES,', ','))")
            .execute(&mut connection)
            .await
            .map_err(|error| map_database_error(&error))?;
        sqlx::query(AssertSqlSafe(format!(
            "SET SESSION max_execution_time = {}",
            request.timeout_ms
        )))
        .execute(&mut connection)
        .await
        .map_err(|error| map_database_error(&error))?;
        sqlx::raw_sql("START TRANSACTION READ ONLY")
            .execute(&mut connection)
            .await
            .map_err(|error| map_database_error(&error))?;
        let description = connection
            .describe(AssertSqlSafe(request.sql.clone()).into_sql_str())
            .await
            .map_err(|error| map_database_error(&error))?;
        let mut columns = query_columns(description.columns());
        // Text protocol preserves DECIMAL/BIGINT, fractional dates and wide MySQL TIME values.
        let mut stream = sqlx::raw_sql(AssertSqlSafe(request.sql.clone())).fetch(&mut connection);
        let mut rows = Vec::new();
        let mut result_bytes = 0usize;
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row.map_err(|error| map_database_error(&error))?;
            if rows.len() >= request.row_limit as usize {
                truncated = true;
                break;
            }
            if rows.is_empty() {
                columns = query_columns(row.columns());
            }
            let (cells, bytes) = cells_from_row(&row, request.max_cell_bytes)?;
            result_bytes = result_bytes.saturating_add(bytes);
            if result_bytes > request.max_result_bytes {
                return Err(QueryError::ResultLimit);
            }
            rows.push(cells);
        }
        Ok(QueryExecutionResult {
            query_id: request.query_id,
            row_count: rows.len(),
            columns,
            rows,
            truncated,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            notices: Vec::new(),
        })
    };
    let result = tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(QueryError::Cancelled),
        result = tokio::time::timeout_at(deadline, operation) => result.unwrap_or(Err(QueryError::Timeout)),
    };
    if (result.is_err() || result.as_ref().is_ok_and(|value| value.truncated))
        && let Some(id) = connection_id
    {
        // The target session stays alive until this command finishes, preventing ID reuse.
        // A second connection under the same account may cancel its own statements.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let mut control = pool.acquire().await?;
            control.close_on_drop();
            sqlx::raw_sql(AssertSqlSafe(format!("KILL QUERY {id}")))
                .execute(&mut *control)
                .await
        })
        .await;
    }
    // Closing the socket rolls back the read-only transaction without draining oversized results.
    drop(connection);
    result
}

fn map_database_error(error: &sqlx::Error) -> QueryError {
    if let sqlx::Error::Database(database) = error
        && database
            .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
            .is_some_and(|error| error.number() == 3024)
    {
        return QueryError::Timeout;
    }
    QueryError::Database
}

fn query_columns(columns: &[sqlx::mysql::MySqlColumn]) -> Vec<crate::QueryColumn> {
    columns
        .iter()
        .map(|column| crate::QueryColumn {
            name: column.name().to_owned(),
            database_type: column.type_info().name().to_owned(),
        })
        .collect()
}
