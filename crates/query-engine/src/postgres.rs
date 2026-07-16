use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sqlx::{AssertSqlSafe, Column, Executor, PgPool, SqlSafeStr, TypeInfo};
use tokio_util::sync::CancellationToken;

use crate::{ExecuteQueryRequest, QueryError, QueryExecutionResult, value::cells_from_row};

/// Executes one validated query in a `PostgreSQL` read-only transaction.
///
/// # Errors
/// Returns a public-safe [`QueryError`] for validation, connection, database, timeout,
/// cancellation, type-conversion, or result-size failures.
pub async fn execute_postgres_query(
    pool: &PgPool,
    request: &ExecuteQueryRequest,
    cancellation: &CancellationToken,
) -> Result<QueryExecutionResult, QueryError> {
    request.validate()?;
    let started = Instant::now();
    let mut connection = pool.acquire().await.map_err(|_| QueryError::Connection)?;
    connection.close_on_drop();
    sqlx::query("BEGIN READ ONLY")
        .execute(&mut *connection)
        .await
        .map_err(|_| QueryError::Database)?;
    sqlx::query("SELECT set_config('statement_timeout', $1, true)")
        .bind(format!("{}ms", request.timeout_ms))
        .execute(&mut *connection)
        .await
        .map_err(|_| QueryError::Database)?;

    let description = connection
        .describe(AssertSqlSafe(request.sql.clone()).into_sql_str())
        .await
        .map_err(|error| map_database_error(&error))?;
    let columns = description
        .columns()
        .iter()
        .map(|column| crate::QueryColumn {
            name: column.name().to_owned(),
            database_type: column.type_info().name().to_owned(),
        })
        .collect();

    let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms);
    // The AST guard above accepts one read-only query and the database transaction is read-only.
    let mut stream = sqlx::raw_sql(AssertSqlSafe(request.sql.clone())).fetch(&mut *connection);
    let mut rows = Vec::new();
    let mut result_bytes = 0usize;
    let mut truncated = false;

    loop {
        let next = tokio::select! {
            () = cancellation.cancelled() => return Err(QueryError::Cancelled),
            result = tokio::time::timeout_at(deadline, stream.next()) => {
                result.map_err(|_| QueryError::Timeout)?
            }
        };
        let Some(row) = next else { break };
        let row = row.map_err(|error| map_database_error(&error))?;
        if rows.len() >= request.row_limit as usize {
            truncated = true;
            break;
        }
        let (cells, bytes) = cells_from_row(&row, request.max_cell_bytes)?;
        result_bytes = result_bytes.saturating_add(bytes);
        if result_bytes > request.max_result_bytes {
            return Err(QueryError::ResultLimit);
        }
        rows.push(cells);
    }
    drop(stream);
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .map_err(|_| QueryError::Database)?;

    Ok(QueryExecutionResult {
        query_id: request.query_id,
        row_count: rows.len(),
        columns,
        rows,
        truncated,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        notices: Vec::new(),
    })
}

fn map_database_error(error: &sqlx::Error) -> QueryError {
    if let sqlx::Error::Database(database) = error
        && database.code().as_deref() == Some("57014")
    {
        return QueryError::Timeout;
    }
    QueryError::Database
}
