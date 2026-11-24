use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sqlx::{
    AssertSqlSafe, Column, Connection, Executor, PgPool, Postgres, Row, SqlSafeStr, TypeInfo,
};
use tokio_util::sync::CancellationToken;

use crate::{
    ExecuteQueryRequest, QueryColumn, QueryError, QueryExecutionResult, value::cells_from_row,
};

struct ReadSession {
    connection: sqlx::pool::PoolConnection<Postgres>,
    clean: bool,
}

impl Drop for ReadSession {
    fn drop(&mut self) {
        if !self.clean {
            self.connection.close_on_drop();
        }
    }
}

/// Executes one validated query in a PostgreSQL read-only transaction.
///
/// # Errors
/// Returns a public-safe validation, connection, database, timeout, cancellation or size error.
pub async fn execute_postgres_query(
    pool: &PgPool,
    request: &ExecuteQueryRequest,
    cancellation: &CancellationToken,
) -> Result<QueryExecutionResult, QueryError> {
    request.validate()?;
    let started = Instant::now();
    let operation = async {
        let mut session = ReadSession {
            connection: pool.acquire().await.map_err(|_| QueryError::Connection)?,
            clean: false,
        };
        let connection = &mut *session.connection;
        let setup = AssertSqlSafe(format!(
            "BEGIN READ ONLY; SET LOCAL statement_timeout = {}",
            request.timeout_ms
        ));
        sqlx::raw_sql(setup)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_database_error(&error))?;
        let mut stream = sqlx::raw_sql(AssertSqlSafe(request.sql.clone())).fetch(&mut *connection);
        let mut rows = Vec::new();
        let mut columns = Vec::new();
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
            result_bytes += bytes;
            if result_bytes > request.max_result_bytes {
                return Err(QueryError::ResultLimit);
            }
            rows.push(cells);
        }
        drop(stream);
        if columns.is_empty() || columns.iter().any(|column| column.database_type == "?") {
            let description = connection
                .describe(AssertSqlSafe(request.sql.clone()).into_sql_str())
                .await
                .map_err(|error| map_database_error(&error))?;
            columns = query_columns(description.columns());
        }
        if !truncated {
            sqlx::raw_sql("ROLLBACK")
                .execute(&mut *connection)
                .await
                .map_err(|_| QueryError::Database)?;
            // A read-only SELECT can still alter PostgreSQL session state via functions.
            connection
                .clear_cached_statements()
                .await
                .map_err(|_| QueryError::Database)?;
            sqlx::raw_sql("DISCARD ALL")
                .execute(&mut *connection)
                .await
                .map_err(|_| QueryError::Database)?;
            session.clean = true;
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
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(QueryError::Cancelled),
        result = tokio::time::timeout(Duration::from_millis(request.timeout_ms), operation) =>
            result.unwrap_or(Err(QueryError::Timeout)),
    }
}

fn query_columns(columns: &[sqlx::postgres::PgColumn]) -> Vec<QueryColumn> {
    columns
        .iter()
        .map(|column| QueryColumn {
            name: column.name().to_owned(),
            database_type: column.type_info().name().to_owned(),
        })
        .collect()
}

fn map_database_error(error: &sqlx::Error) -> QueryError {
    if let sqlx::Error::Database(database) = error
        && database.code().as_deref() == Some("57014")
    {
        return QueryError::Timeout;
    }
    QueryError::Database
}
