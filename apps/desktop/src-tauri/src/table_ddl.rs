//! Read the definition of one table without running user-provided SQL.
use std::time::Duration;

use schema_model::{DataSourceProfile, DatabaseType};
use sqlx::{AssertSqlSafe, Row};

use crate::{AppState, connection_credentials, prepare_query_connection, sqlite_source};

pub(crate) const MAX_DDL_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const DDL_TOO_LARGE: &str = "The table definition exceeds the display limit.";
const UNAVAILABLE: &str = "The table definition is unavailable.";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDdlInput {
    source_id: uuid::Uuid,
    connection_revision: chrono::DateTime<chrono::Utc>,
    schema: String,
    name: String,
}

#[tauri::command]
pub async fn read_table_ddl(
    input: TableDdlInput,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    if [&input.schema, &input.name]
        .iter()
        .any(|name| name.is_empty() || name.contains('\0'))
    {
        return Err(UNAVAILABLE.into());
    }
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(crate::safe_store_error)?
        .filter(|profile| profile.updated_at == input.connection_revision)
        .ok_or("The selected connection changed.")?;
    if profile.database_type == DatabaseType::Sqlite {
        let file = profile
            .sqlite
            .filter(|_| input.schema == "main")
            .ok_or(UNAVAILABLE)?;
        return sqlite_source::read_table_ddl(file, input.name).await;
    }
    if profile.database_type == DatabaseType::MySql && input.schema != profile.database {
        return Err(UNAVAILABLE.into());
    }
    connection_credentials::require_binding(&profile)?;
    tokio::time::timeout(
        Duration::from_secs(20),
        read_network(&state, &profile, &input),
    )
    .await
    .map_err(|_| "Reading the table definition timed out.".to_owned())?
}

async fn read_network(
    state: &AppState,
    profile: &DataSourceProfile,
    input: &TableDdlInput,
) -> Result<String, String> {
    let (password, tunnel, timeout) = prepare_query_connection(state, profile)
        .await
        .map_err(|error| error.public_message())?;
    let statement = match profile.database_type {
        DatabaseType::MySql => {
            let options = crate::mysql_connection_options_from_profile(profile, &password)
                .with_socket(tunnel.mysql_socket())
                .with_connect_timeout(timeout);
            let pool = mysql_adapter::connect(&options)
                .await
                .map_err(crate::safe_mysql_error)?;
            let sql = format!(
                "SHOW CREATE TABLE `{}`.`{}`",
                input.schema.replace('`', "``"),
                input.name.replace('`', "``"),
            );
            let result = sqlx::query(AssertSqlSafe(sql.as_str()))
                .fetch_one(&pool)
                .await
                .and_then(|row| row.try_get::<String, _>("Create Table"));
            pool.close().await;
            result.map_err(|_| UNAVAILABLE)?
        }
        DatabaseType::PostgreSql => {
            let options = crate::connection_options_from_profile(profile, &password)
                .with_socket(tunnel.postgres_socket())
                .with_connect_timeout(timeout);
            let pool = postgres_adapter::connect(&options)
                .await
                .map_err(crate::safe_connection_error)?;
            let result = read_postgres(&pool, input).await;
            pool.close().await;
            result?
        }
        DatabaseType::Sqlite => return Err(UNAVAILABLE.into()),
    };
    let mut definition = String::new();
    append_statement(&mut definition, &statement)?;
    Ok(definition)
}

async fn read_postgres(pool: &sqlx::PgPool, input: &TableDdlInput) -> Result<String, String> {
    let mut transaction = pool.begin().await.map_err(|_| UNAVAILABLE)?;
    sqlx::raw_sql("SET TRANSACTION READ ONLY; SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '8s';")
        .execute(&mut *transaction)
        .await
        .map_err(|_| UNAVAILABLE)?;
    let definition = sqlx::query_scalar::<_, String>(include_str!("table_ddl_postgres.sql"))
        .bind(&input.schema)
        .bind(&input.name)
        .bind(i32::try_from(MAX_DDL_BYTES).map_err(|_| DDL_TOO_LARGE)?)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| UNAVAILABLE)?;
    transaction.commit().await.map_err(|_| UNAVAILABLE)?;
    definition.ok_or_else(|| UNAVAILABLE.into())
}

pub(crate) fn append_statement(
    definition: &mut String,
    statement: &str,
) -> Result<(), &'static str> {
    let statement = statement.trim_end();
    let trailing = if statement.ends_with(';') { "" } else { ";" };
    let separator = if definition.is_empty() { "" } else { "\n\n" };
    if definition.len() + separator.len() + statement.len() + trailing.len() > MAX_DDL_BYTES {
        return Err(DDL_TOO_LARGE);
    }
    definition.push_str(separator);
    definition.push_str(statement);
    definition.push_str(trailing);
    Ok(())
}
