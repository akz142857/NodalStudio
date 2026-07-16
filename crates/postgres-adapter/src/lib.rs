//! Read-only `PostgreSQL` schema introspection.

use std::time::Duration;

use schema_model::{
    ColumnDefinition, ConstraintDefinition, ConstraintType, DatabaseInfo, DatabaseSnapshot,
    DatabaseType, EnumDefinition, ForeignKeyDefinition, IdentityKind, IndexDefinition, MatchType,
    ObjectKey, ObjectKind, PrimaryKeyDefinition, ReferentialAction, SchemaDefinition,
    TableDefinition, TableKind, ViewDefinition,
};
use sqlx::{
    PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone)]
pub struct PostgresConnectionOptions {
    connection: PostgresConnection,
    pub max_connections: u32,
    pub connect_timeout: Duration,
}

#[derive(Clone)]
enum PostgresConnection {
    Url(String),
    Fields(Box<PgConnectOptions>),
}

#[derive(Debug, Clone, Copy)]
pub enum PostgresSslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

impl PostgresConnectionOptions {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            connection: PostgresConnection::Url(url.into()),
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
        ssl_mode: PostgresSslMode,
    ) -> Self {
        let ssl_mode = match ssl_mode {
            PostgresSslMode::Disable => PgSslMode::Disable,
            PostgresSslMode::Prefer => PgSslMode::Prefer,
            PostgresSslMode::Require => PgSslMode::Require,
            PostgresSslMode::VerifyCa => PgSslMode::VerifyCa,
            PostgresSslMode::VerifyFull => PgSslMode::VerifyFull,
        };
        let connect_options = PgConnectOptions::new()
            .host(host)
            .port(port)
            .database(database)
            .username(username)
            .password(password)
            .ssl_mode(ssl_mode);
        Self {
            connection: PostgresConnection::Fields(Box::new(connect_options)),
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
pub enum PostgresAdapterError {
    #[error("PostgreSQL query failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("failed to canonicalize PostgreSQL snapshot: {0}")]
    Canonicalization(#[from] schema_model::SchemaModelError),
    #[error("unsupported PostgreSQL relation kind: {0}")]
    UnsupportedRelationKind(String),
    #[error("unsupported PostgreSQL referential action: {0}")]
    UnsupportedReferentialAction(String),
    #[error("unsupported PostgreSQL foreign-key match type: {0}")]
    UnsupportedMatchType(String),
    #[error("metadata referenced unknown table {schema}.{table}")]
    UnknownTable { schema: String, table: String },
}

/// Creates a small connection pool for metadata queries.
///
/// # Errors
///
/// Returns [`PostgresAdapterError::Database`] when the target cannot be reached or
/// rejects the supplied credentials.
pub async fn connect(options: &PostgresConnectionOptions) -> Result<PgPool, PostgresAdapterError> {
    let pool_options = PgPoolOptions::new()
        .max_connections(options.max_connections)
        .acquire_timeout(options.connect_timeout);
    match &options.connection {
        PostgresConnection::Url(url) => Ok(pool_options.connect(url).await?),
        PostgresConnection::Fields(connect_options) => Ok(pool_options
            .connect_with(connect_options.as_ref().clone())
            .await?),
    }
}

/// Reads the database name and server version without touching application data.
///
/// # Errors
///
/// Returns [`PostgresAdapterError::Database`] when the metadata query fails.
pub async fn test_connection(pool: &PgPool) -> Result<DatabaseInfo, PostgresAdapterError> {
    let row = sqlx::query(
        "SELECT current_database() AS name, current_setting('server_version') AS version",
    )
    .fetch_one(pool)
    .await?;

    Ok(DatabaseInfo {
        name: row.try_get("name")?,
        database_type: DatabaseType::PostgreSql,
        version: row.try_get("version")?,
    })
}

/// Captures the supported physical schema metadata and derives a stable fingerprint.
///
/// # Errors
///
/// Returns an error when a metadata query fails, when the server reports an unknown
/// catalog code, or when the canonical snapshot cannot be serialized.
pub async fn inspect_schema(
    pool: &PgPool,
    source_id: Uuid,
) -> Result<DatabaseSnapshot, PostgresAdapterError> {
    let database = test_connection(pool).await?;
    let mut schemas = load_schemas(pool).await?;
    load_tables(pool, &mut schemas).await?;
    load_columns(pool, &mut schemas).await?;
    load_primary_keys(pool, &mut schemas).await?;
    load_foreign_keys(pool, &mut schemas).await?;
    load_indexes(pool, &mut schemas).await?;
    load_constraints(pool, &mut schemas).await?;
    load_views(pool, &mut schemas).await?;
    load_enums(pool, &mut schemas).await?;

    let mut snapshot = DatabaseSnapshot::new(source_id, database, schemas);
    snapshot.canonicalize()?;
    Ok(snapshot)
}

async fn load_schemas(pool: &PgPool) -> Result<Vec<SchemaDefinition>, PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT nspname AS schema_name
        FROM pg_namespace
        WHERE nspname <> 'information_schema'
          AND nspname NOT LIKE 'pg\_%' ESCAPE '\'
        ORDER BY nspname
        ",
    )
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            row.try_get::<String, _>("schema_name")
                .map(SchemaDefinition::empty)
                .map_err(PostgresAdapterError::from)
        })
        .collect()
}

async fn load_tables(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            relation.relkind::text AS relation_kind,
            obj_description(relation.oid, 'pg_class') AS comment
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relkind IN ('r', 'p', 'f')
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        ORDER BY namespace.nspname, relation.relname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        let relation_kind: String = row.try_get("relation_kind")?;
        let mut table = TableDefinition::empty(&schema_name, table_name);
        table.table_kind = parse_table_kind(&relation_kind)?;
        table.comment = row.try_get("comment")?;
        find_schema_mut(schemas, &schema_name)?.tables.push(table);
    }
    Ok(())
}

async fn load_columns(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            attribute.attname AS column_name,
            attribute.attnum::int4 AS ordinal_position,
            format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
            type_namespace.nspname AS type_schema,
            data_type.typname AS type_name,
            NOT attribute.attnotnull AS nullable,
            pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value,
            attribute.attidentity::text AS identity_kind,
            attribute.attgenerated <> '' AS generated,
            col_description(attribute.attrelid, attribute.attnum) AS comment
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_type data_type ON data_type.oid = attribute.atttypid
        JOIN pg_namespace type_namespace ON type_namespace.oid = data_type.typnamespace
        LEFT JOIN pg_attrdef default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE relation.relkind IN ('r', 'p', 'f')
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        ORDER BY namespace.nspname, relation.relname, attribute.attnum
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        let identity: String = row.try_get("identity_kind")?;
        find_table_mut(schemas, &schema_name, &table_name)?
            .columns
            .push(ColumnDefinition {
                name: row.try_get("column_name")?,
                ordinal_position: row.try_get("ordinal_position")?,
                formatted_type: row.try_get("formatted_type")?,
                type_schema: row.try_get("type_schema")?,
                type_name: row.try_get("type_name")?,
                nullable: row.try_get("nullable")?,
                default_value: row.try_get("default_value")?,
                identity: parse_identity(&identity),
                generated: row.try_get("generated")?,
                comment: row.try_get("comment")?,
            });
    }
    Ok(())
}

async fn load_primary_keys(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS columns
        FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN LATERAL unnest(constraint_row.conkey)
          WITH ORDINALITY AS key_column(attnum, ordinality) ON TRUE
        JOIN pg_attribute attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum = key_column.attnum
        WHERE constraint_row.contype = 'p'
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        GROUP BY namespace.nspname, relation.relname, constraint_row.conname
        ORDER BY namespace.nspname, relation.relname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        find_table_mut(schemas, &schema_name, &table_name)?.primary_key =
            Some(PrimaryKeyDefinition {
                name: row.try_get("constraint_name")?,
                columns: row.try_get("columns")?,
            });
    }
    Ok(())
}

async fn load_foreign_keys(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            source_namespace.nspname AS schema_name,
            source_relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            array_agg(source_attribute.attname::text ORDER BY source_key.ordinality) AS columns,
            target_namespace.nspname AS referenced_schema,
            target_relation.relname AS referenced_table,
            array_agg(target_attribute.attname::text ORDER BY target_key.ordinality) AS referenced_columns,
            constraint_row.confupdtype::text AS on_update,
            constraint_row.confdeltype::text AS on_delete,
            constraint_row.confmatchtype::text AS match_type,
            constraint_row.condeferrable AS deferrable,
            constraint_row.condeferred AS initially_deferred
        FROM pg_constraint constraint_row
        JOIN pg_class source_relation ON source_relation.oid = constraint_row.conrelid
        JOIN pg_namespace source_namespace ON source_namespace.oid = source_relation.relnamespace
        JOIN pg_class target_relation ON target_relation.oid = constraint_row.confrelid
        JOIN pg_namespace target_namespace ON target_namespace.oid = target_relation.relnamespace
        JOIN LATERAL unnest(constraint_row.conkey)
          WITH ORDINALITY AS source_key(attnum, ordinality) ON TRUE
        JOIN LATERAL unnest(constraint_row.confkey)
          WITH ORDINALITY AS target_key(attnum, ordinality)
          ON target_key.ordinality = source_key.ordinality
        JOIN pg_attribute source_attribute
          ON source_attribute.attrelid = source_relation.oid
         AND source_attribute.attnum = source_key.attnum
        JOIN pg_attribute target_attribute
          ON target_attribute.attrelid = target_relation.oid
         AND target_attribute.attnum = target_key.attnum
        WHERE constraint_row.contype = 'f'
          AND source_namespace.nspname <> 'information_schema'
          AND source_namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        GROUP BY
            source_namespace.nspname,
            source_relation.relname,
            constraint_row.conname,
            target_namespace.nspname,
            target_relation.relname,
            constraint_row.confupdtype,
            constraint_row.confdeltype,
            constraint_row.confmatchtype,
            constraint_row.condeferrable,
            constraint_row.condeferred
        ORDER BY source_namespace.nspname, source_relation.relname, constraint_row.conname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        let on_update: String = row.try_get("on_update")?;
        let on_delete: String = row.try_get("on_delete")?;
        let match_type: String = row.try_get("match_type")?;
        find_table_mut(schemas, &schema_name, &table_name)?
            .foreign_keys
            .push(ForeignKeyDefinition {
                name: row.try_get("constraint_name")?,
                columns: row.try_get("columns")?,
                referenced_schema: row.try_get("referenced_schema")?,
                referenced_table: row.try_get("referenced_table")?,
                referenced_columns: row.try_get("referenced_columns")?,
                on_update: parse_referential_action(&on_update)?,
                on_delete: parse_referential_action(&on_delete)?,
                match_type: parse_match_type(&match_type)?,
                deferrable: row.try_get("deferrable")?,
                initially_deferred: row.try_get("initially_deferred")?,
            });
    }
    Ok(())
}

async fn load_indexes(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            index_relation.relname AS index_name,
            access_method.amname AS method,
            index_row.indisunique AS unique,
            index_row.indisprimary AS primary,
            pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate,
            array_agg(
                pg_get_indexdef(index_row.indexrelid, position.position, TRUE)
                ORDER BY position.position
            ) AS columns
        FROM pg_index index_row
        JOIN pg_class relation ON relation.oid = index_row.indrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
        JOIN pg_am access_method ON access_method.oid = index_relation.relam
        JOIN LATERAL generate_series(1, index_row.indnkeyatts) AS position(position) ON TRUE
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        GROUP BY
            namespace.nspname,
            relation.relname,
            index_relation.relname,
            access_method.amname,
            index_row.indisunique,
            index_row.indisprimary,
            index_row.indpred,
            index_row.indrelid
        ORDER BY namespace.nspname, relation.relname, index_relation.relname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        find_table_mut(schemas, &schema_name, &table_name)?
            .indexes
            .push(IndexDefinition {
                name: row.try_get("index_name")?,
                method: row.try_get("method")?,
                columns: row.try_get("columns")?,
                unique: row.try_get("unique")?,
                primary: row.try_get("primary")?,
                predicate: row.try_get("predicate")?,
            });
    }
    Ok(())
}

async fn load_constraints(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            constraint_row.contype::text AS constraint_type,
            pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE constraint_row.contype IN ('c', 'u', 'x')
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        ORDER BY namespace.nspname, relation.relname, constraint_row.conname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let table_name: String = row.try_get("table_name")?;
        let constraint_type: String = row.try_get("constraint_type")?;
        let constraint_type = match constraint_type.as_str() {
            "c" => ConstraintType::Check,
            "u" => ConstraintType::Unique,
            "x" => ConstraintType::Exclusion,
            _ => continue,
        };
        find_table_mut(schemas, &schema_name, &table_name)?
            .constraints
            .push(ConstraintDefinition {
                name: row.try_get("constraint_name")?,
                constraint_type,
                definition: row.try_get("definition")?,
            });
    }
    Ok(())
}

async fn load_views(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS view_name,
            pg_get_viewdef(relation.oid, TRUE) AS definition,
            relation.relkind = 'm' AS materialized,
            obj_description(relation.oid, 'pg_class') AS comment
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relkind IN ('v', 'm')
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        ORDER BY namespace.nspname, relation.relname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let view_name: String = row.try_get("view_name")?;
        find_schema_mut(schemas, &schema_name)?
            .views
            .push(ViewDefinition {
                key: ObjectKey::new(ObjectKind::View, &schema_name, view_name),
                definition: row.try_get("definition")?,
                materialized: row.try_get("materialized")?,
                comment: row.try_get("comment")?,
            });
    }
    Ok(())
}

async fn load_enums(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"
        SELECT
            namespace.nspname AS schema_name,
            data_type.typname AS enum_name,
            array_agg(enum_value.enumlabel::text ORDER BY enum_value.enumsortorder) AS values
        FROM pg_type data_type
        JOIN pg_namespace namespace ON namespace.oid = data_type.typnamespace
        JOIN pg_enum enum_value ON enum_value.enumtypid = data_type.oid
        WHERE namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        GROUP BY namespace.nspname, data_type.typname
        ORDER BY namespace.nspname, data_type.typname
        ",
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let schema_name: String = row.try_get("schema_name")?;
        let enum_name: String = row.try_get("enum_name")?;
        find_schema_mut(schemas, &schema_name)?
            .enums
            .push(EnumDefinition {
                key: ObjectKey::new(ObjectKind::Enum, &schema_name, enum_name),
                values: row.try_get("values")?,
            });
    }
    Ok(())
}

fn find_schema_mut<'a>(
    schemas: &'a mut [SchemaDefinition],
    schema_name: &str,
) -> Result<&'a mut SchemaDefinition, PostgresAdapterError> {
    schemas
        .iter_mut()
        .find(|schema| schema.name == schema_name)
        .ok_or_else(|| PostgresAdapterError::UnknownTable {
            schema: schema_name.into(),
            table: "<schema>".into(),
        })
}

fn find_table_mut<'a>(
    schemas: &'a mut [SchemaDefinition],
    schema_name: &str,
    table_name: &str,
) -> Result<&'a mut TableDefinition, PostgresAdapterError> {
    find_schema_mut(schemas, schema_name)?
        .tables
        .iter_mut()
        .find(|table| table.key.name == table_name)
        .ok_or_else(|| PostgresAdapterError::UnknownTable {
            schema: schema_name.into(),
            table: table_name.into(),
        })
}

fn parse_table_kind(code: &str) -> Result<TableKind, PostgresAdapterError> {
    match code {
        "r" => Ok(TableKind::Ordinary),
        "p" => Ok(TableKind::Partitioned),
        "f" => Ok(TableKind::Foreign),
        other => Err(PostgresAdapterError::UnsupportedRelationKind(other.into())),
    }
}

fn parse_identity(code: &str) -> Option<IdentityKind> {
    match code {
        "a" => Some(IdentityKind::Always),
        "d" => Some(IdentityKind::ByDefault),
        _ => None,
    }
}

fn parse_referential_action(code: &str) -> Result<ReferentialAction, PostgresAdapterError> {
    match code {
        "a" => Ok(ReferentialAction::NoAction),
        "r" => Ok(ReferentialAction::Restrict),
        "c" => Ok(ReferentialAction::Cascade),
        "n" => Ok(ReferentialAction::SetNull),
        "d" => Ok(ReferentialAction::SetDefault),
        other => Err(PostgresAdapterError::UnsupportedReferentialAction(
            other.into(),
        )),
    }
}

fn parse_match_type(code: &str) -> Result<MatchType, PostgresAdapterError> {
    match code {
        "s" => Ok(MatchType::Simple),
        "f" => Ok(MatchType::Full),
        "p" => Ok(MatchType::Partial),
        other => Err(PostgresAdapterError::UnsupportedMatchType(other.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_postgres_catalog_codes() {
        assert_eq!(parse_table_kind("p").unwrap(), TableKind::Partitioned);
        assert_eq!(
            parse_referential_action("c").unwrap(),
            ReferentialAction::Cascade
        );
        assert_eq!(parse_match_type("f").unwrap(), MatchType::Full);
        assert_eq!(parse_identity("d"), Some(IdentityKind::ByDefault));
    }
}
