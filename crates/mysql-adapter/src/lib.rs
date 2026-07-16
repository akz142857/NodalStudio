//! Read-only `MySQL` schema introspection through `information_schema`.

use std::{collections::BTreeMap, time::Duration};

use schema_model::{
    ColumnDefinition, DatabaseInfo, DatabaseSnapshot, DatabaseType, ForeignKeyDefinition,
    IdentityKind, IndexDefinition, MatchType, ObjectKey, PrimaryKeyDefinition, ReferentialAction,
    SchemaDefinition, TableDefinition, TableKind, ViewDefinition,
};
use sqlx::{
    MySqlPool, Row,
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode},
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone)]
pub struct MySqlConnectionOptions {
    connection: MySqlConnection,
    pub max_connections: u32,
    pub connect_timeout: Duration,
}

#[derive(Clone)]
enum MySqlConnection {
    Url(String),
    Fields(Box<MySqlConnectOptions>),
}

impl MySqlConnectionOptions {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            connection: MySqlConnection::Url(url.into()),
            max_connections: 2,
            connect_timeout: Duration::from_secs(15),
        }
    }

    pub fn from_fields(
        host: &str,
        port: u16,
        database: &str,
        username: &str,
        password: &str,
        ssl_mode: MySqlSslMode,
    ) -> Self {
        let options = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .database(database)
            .username(username)
            .password(password)
            .ssl_mode(ssl_mode);
        Self {
            connection: MySqlConnection::Fields(Box::new(options)),
            max_connections: 2,
            connect_timeout: Duration::from_secs(15),
        }
    }

    #[must_use]
    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }
}

#[derive(Debug, Error)]
pub enum MySqlAdapterError {
    #[error("MySQL query failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("failed to canonicalize MySQL snapshot: {0}")]
    Canonicalization(#[from] schema_model::SchemaModelError),
    #[error("MySQL metadata referenced unknown table {0}")]
    UnknownTable(String),
    #[error("unsupported MySQL referential action {0}")]
    ReferentialAction(String),
}

/// Creates a small `MySQL` pool used only for catalog queries.
///
/// # Errors
///
/// Returns an error when the connection cannot be established.
pub async fn connect(options: &MySqlConnectionOptions) -> Result<MySqlPool, MySqlAdapterError> {
    let pool = MySqlPoolOptions::new()
        .max_connections(options.max_connections)
        .acquire_timeout(options.connect_timeout);
    match &options.connection {
        MySqlConnection::Url(url) => Ok(pool.connect(url).await?),
        MySqlConnection::Fields(fields) => Ok(pool.connect_with(fields.as_ref().clone()).await?),
    }
}

/// Reads database identity without accessing application rows.
///
/// # Errors
///
/// Returns an error when the metadata query fails.
pub async fn test_connection(pool: &MySqlPool) -> Result<DatabaseInfo, MySqlAdapterError> {
    let row = sqlx::query("SELECT DATABASE() AS name, VERSION() AS version")
        .fetch_one(pool)
        .await?;
    Ok(DatabaseInfo {
        name: row.try_get("name")?,
        database_type: DatabaseType::MySql,
        version: row.try_get("version")?,
    })
}

/// Captures tables, columns, keys, indexes, and views from `information_schema`.
///
/// # Errors
///
/// Returns an error for failed catalog queries or invalid normalized metadata.
pub async fn inspect_schema(
    pool: &MySqlPool,
    source_id: Uuid,
) -> Result<DatabaseSnapshot, MySqlAdapterError> {
    let database = test_connection(pool).await?;
    let schema_name = database.name.clone();
    let mut schema = SchemaDefinition::empty(&schema_name);
    load_tables(pool, &mut schema).await?;
    load_columns(pool, &mut schema).await?;
    load_primary_keys(pool, &mut schema).await?;
    load_foreign_keys(pool, &mut schema).await?;
    load_indexes(pool, &mut schema).await?;
    load_views(pool, &mut schema).await?;
    let mut snapshot = DatabaseSnapshot::new(source_id, database, vec![schema]);
    snapshot.canonicalize()?;
    Ok(snapshot)
}

async fn load_tables(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME").fetch_all(pool).await?;
    for row in rows {
        schema.tables.push(TableDefinition {
            key: ObjectKey::table(&schema.name, row.try_get::<String, _>("table_name")?),
            table_kind: TableKind::Ordinary,
            columns: vec![],
            primary_key: None,
            foreign_keys: vec![],
            indexes: vec![],
            constraints: vec![],
            comment: non_empty(row.try_get("table_comment")?),
        });
    }
    Ok(())
}

async fn load_columns(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.ORDINAL_POSITION AS ordinal_position, c.COLUMN_TYPE AS column_type, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.EXTRA AS extra, c.COLUMN_COMMENT AS column_comment FROM information_schema.columns c JOIN information_schema.tables t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE='BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION").fetch_all(pool).await?;
    for row in rows {
        let table_name: String = row.try_get("table_name")?;
        table_mut(schema, &table_name)?
            .columns
            .push(ColumnDefinition {
                name: row.try_get("column_name")?,
                ordinal_position: row
                    .try_get::<u32, _>("ordinal_position")?
                    .try_into()
                    .unwrap_or(i32::MAX),
                formatted_type: row.try_get("column_type")?,
                type_schema: "mysql".into(),
                type_name: row.try_get("data_type")?,
                nullable: row.try_get::<String, _>("is_nullable")? == "YES",
                default_value: row.try_get("column_default")?,
                identity: row
                    .try_get::<String, _>("extra")?
                    .contains("auto_increment")
                    .then_some(IdentityKind::ByDefault),
                generated: row.try_get::<String, _>("extra")?.contains("GENERATED"),
                comment: non_empty(row.try_get("column_comment")?),
            });
    }
    Ok(())
}

async fn load_primary_keys(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.key_column_usage WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION").fetch_all(pool).await?;
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        grouped
            .entry(row.try_get("table_name")?)
            .or_default()
            .push(row.try_get("column_name")?);
    }
    for (table, columns) in grouped {
        table_mut(schema, &table)?.primary_key = Some(PrimaryKeyDefinition {
            name: "PRIMARY".into(),
            columns,
        });
    }
    Ok(())
}

async fn load_foreign_keys(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name, k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS referenced_table_schema, k.REFERENCED_TABLE_NAME AS referenced_table_name, k.REFERENCED_COLUMN_NAME AS referenced_column_name, r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION").fetch_all(pool).await?;
    let mut grouped: BTreeMap<(String, String), ForeignKeyDefinition> = BTreeMap::new();
    for row in rows {
        let table: String = row.try_get("table_name")?;
        let name: String = row.try_get("constraint_name")?;
        let entry = grouped
            .entry((table, name.clone()))
            .or_insert(ForeignKeyDefinition {
                name,
                columns: vec![],
                referenced_schema: row
                    .try_get("referenced_table_schema")
                    .unwrap_or_else(|_| schema.name.clone()),
                referenced_table: row.try_get("referenced_table_name").unwrap_or_default(),
                referenced_columns: vec![],
                on_update: parse_action(
                    &row.try_get::<String, _>("update_rule")
                        .unwrap_or_else(|_| "NO ACTION".into()),
                )
                .unwrap_or(ReferentialAction::NoAction),
                on_delete: parse_action(
                    &row.try_get::<String, _>("delete_rule")
                        .unwrap_or_else(|_| "NO ACTION".into()),
                )
                .unwrap_or(ReferentialAction::NoAction),
                match_type: MatchType::Simple,
                deferrable: false,
                initially_deferred: false,
            });
        entry.columns.push(row.try_get("column_name")?);
        entry
            .referenced_columns
            .push(row.try_get("referenced_column_name")?);
    }
    for ((table, _), key) in grouped {
        table_mut(schema, &table)?.foreign_keys.push(key);
    }
    Ok(())
}

async fn load_indexes(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, INDEX_TYPE AS index_type, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX").fetch_all(pool).await?;
    let mut grouped: BTreeMap<(String, String), IndexDefinition> = BTreeMap::new();
    for row in rows {
        let table: String = row.try_get("table_name")?;
        let name: String = row.try_get("index_name")?;
        let entry = grouped
            .entry((table, name.clone()))
            .or_insert(IndexDefinition {
                name: name.clone(),
                method: row.try_get("index_type").unwrap_or_else(|_| "BTREE".into()),
                columns: vec![],
                unique: row.try_get::<u8, _>("non_unique").unwrap_or(1) == 0,
                primary: name == "PRIMARY",
                predicate: None,
            });
        entry.columns.push(row.try_get("column_name")?);
    }
    for ((table, _), index) in grouped {
        table_mut(schema, &table)?.indexes.push(index);
    }
    Ok(())
}

async fn load_views(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows=sqlx::query("SELECT TABLE_NAME AS table_name, VIEW_DEFINITION AS view_definition FROM information_schema.views WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME").fetch_all(pool).await?;
    for row in rows {
        schema.views.push(ViewDefinition {
            key: ObjectKey::new(
                schema_model::ObjectKind::View,
                &schema.name,
                row.try_get::<String, _>("table_name")?,
            ),
            definition: row.try_get("view_definition")?,
            materialized: false,
            comment: None,
        });
    }
    Ok(())
}

fn table_mut<'a>(
    schema: &'a mut SchemaDefinition,
    name: &str,
) -> Result<&'a mut TableDefinition, MySqlAdapterError> {
    schema
        .tables
        .iter_mut()
        .find(|table| table.key.name == name)
        .ok_or_else(|| MySqlAdapterError::UnknownTable(name.into()))
}
fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}
fn parse_action(value: &str) -> Result<ReferentialAction, MySqlAdapterError> {
    match value {
        "NO ACTION" => Ok(ReferentialAction::NoAction),
        "RESTRICT" => Ok(ReferentialAction::Restrict),
        "CASCADE" => Ok(ReferentialAction::Cascade),
        "SET NULL" => Ok(ReferentialAction::SetNull),
        "SET DEFAULT" => Ok(ReferentialAction::SetDefault),
        other => Err(MySqlAdapterError::ReferentialAction(other.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_mysql_referential_actions() {
        assert_eq!(parse_action("CASCADE").unwrap(), ReferentialAction::Cascade);
        assert!(parse_action("UNKNOWN").is_err());
    }
    #[test]
    fn removes_empty_catalog_comments() {
        assert_eq!(non_empty("  ".into()), None);
        assert_eq!(non_empty("Accounts".into()).as_deref(), Some("Accounts"));
    }
}
