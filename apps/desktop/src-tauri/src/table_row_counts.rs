use std::time::Duration;

use chrono::{DateTime, Utc};
use query_engine::{ExecuteQueryRequest, QueryCell, QueryError};
use schema_model::DatabaseType;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{AppState, execute_prepared_network_query, prepare_query_connection, sqlite_source};

const STATEMENT_TIMEOUT_MS: u64 = 2_500;
static EXACT_COUNT: Semaphore = Semaphore::const_new(1);

const POSTGRES_ESTIMATES: &str = "
    SELECT CAST(n.nspname AS text), CAST(c.relname AS text), CAST(CAST(c.reltuples AS bigint) AS text)
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND NOT c.relhassubclass AND c.reltuples >= 0
      AND n.nspname <> 'information_schema' AND LEFT(n.nspname, 3) <> 'pg_'
      AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      AND NOT pg_catalog.row_security_active(c.oid)";

const MYSQL_ESTIMATES: &str = "
    SELECT table_schema, table_name, CAST(table_rows AS CHAR)
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_rows IS NOT NULL";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCountInput {
    source_id: Uuid,
    connection_revision: DateTime<Utc>,
    target: Option<TableName>,
}

#[derive(Deserialize, Serialize)]
struct TableName {
    schema: String,
    name: String,
}

#[derive(Serialize)]
pub struct RowCount {
    #[serde(flatten)]
    table: TableName,
    count: String,
}

#[tauri::command]
pub async fn read_table_row_counts(
    input: RowCountInput,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RowCount>, String> {
    counts(input, &state)
        .await
        .map_err(|error| error.public_message())
}

async fn counts(input: RowCountInput, state: &AppState) -> Result<Vec<RowCount>, QueryError> {
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(|_| QueryError::Connection)?
        .filter(|profile| profile.updated_at == input.connection_revision)
        .ok_or(QueryError::Connection)?;
    let engine = profile.database_type;
    let sql = match &input.target {
        Some(table) => count_sql(engine, table),
        None => match engine {
            DatabaseType::PostgreSql => POSTGRES_ESTIMATES.into(),
            DatabaseType::MySql => MYSQL_ESTIMATES.into(),
            DatabaseType::Sqlite => return Ok(Vec::new()),
        },
    };
    let _exact_permit =
        if input.target.is_some() {
            Some(EXACT_COUNT.try_acquire().map_err(|_| {
                QueryError::Validation("A table row count is already running.".into())
            })?)
        } else {
            None
        };
    let request = ExecuteQueryRequest {
        query_id: Uuid::new_v4(),
        sql,
        row_limit: if input.target.is_some() {
            1
        } else {
            query_engine::MAX_ROW_LIMIT
        },
        timeout_ms: STATEMENT_TIMEOUT_MS,
        max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
        max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
    };
    let token = CancellationToken::new();
    let result = if engine == DatabaseType::Sqlite {
        sqlite_source::execute_sqlite_readonly(profile, request, token).await?
    } else {
        crate::connection_credentials::require_binding(&profile).map_err(QueryError::Validation)?;
        let (password, tunnel, timeout) = tokio::time::timeout(
            Duration::from_secs(6),
            prepare_query_connection(state, &profile),
        )
        .await
        .map_err(|_| QueryError::Timeout)??;
        execute_prepared_network_query(
            &profile,
            &password,
            &tunnel,
            timeout.min(Duration::from_secs(3)),
            &request,
            &token,
        )
        .await?
    };
    if let Some(table) = input.target {
        let count = result
            .rows
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next())
            .and_then(text_value)
            .filter(|count| count.parse::<u64>().is_ok())
            .ok_or(QueryError::Internal)?;
        Ok(vec![RowCount { table, count }])
    } else {
        Ok(result
            .rows
            .into_iter()
            .filter_map(|row| {
                let [schema, name, count] = <[QueryCell; 3]>::try_from(row).ok()?;
                let count = text_value(count).filter(|count| count.parse::<u64>().is_ok())?;
                Some(RowCount {
                    table: TableName {
                        schema: text_value(schema)?,
                        name: text_value(name)?,
                    },
                    count,
                })
            })
            .collect())
    }
}

fn text_value(cell: QueryCell) -> Option<String> {
    match cell {
        QueryCell::Text {
            value,
            truncated: false,
        } => Some(value),
        _ => None,
    }
}

fn count_sql(engine: DatabaseType, table: &TableName) -> String {
    let (quote, text) = match engine {
        DatabaseType::MySql => ('`', "CHAR"),
        DatabaseType::PostgreSql | DatabaseType::Sqlite => ('"', "TEXT"),
    };
    let escape = |name: &str| name.replace(quote, &format!("{quote}{quote}"));
    format!(
        "SELECT CAST(COUNT(*) AS {text}) FROM {quote}{}{quote}.{quote}{}{quote}",
        escape(&table.schema),
        escape(&table.name),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_queries_pass_the_engine_readonly_guards() {
        let table = TableName {
            schema: "sales".into(),
            name: "order\"`items".into(),
        };
        assert!(query_engine::validate_read_only_postgres(POSTGRES_ESTIMATES).is_ok());
        assert!(query_engine::validate_read_only_mysql(MYSQL_ESTIMATES).is_ok());
        assert!(
            query_engine::validate_read_only_postgres(&count_sql(DatabaseType::PostgreSql, &table))
                .is_ok()
        );
        assert!(
            query_engine::validate_read_only_mysql(&count_sql(DatabaseType::MySql, &table)).is_ok()
        );
        assert!(
            query_engine::validate_read_only_sqlite(&count_sql(DatabaseType::Sqlite, &table))
                .is_ok()
        );
    }
}
