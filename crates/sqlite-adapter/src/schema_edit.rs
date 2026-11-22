//! Explicit, transactional schema changes for a local `SQLite` database.
use crate::{connect_for_write, set_deadline, table_data::TableError};
use sqlparser::{
    ast::{AlterTableOperation, ObjectName, ObjectType, Statement},
    dialect::SQLiteDialect,
    parser::Parser,
};
use sqlx::{AssertSqlSafe, Connection, SqliteConnection};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const SQL_LIMIT: usize = 256 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum SchemaEditError {
    #[error("Select or enter exactly one SQLite DDL statement of at most 256 KiB.")]
    SingleStatement,
    #[error("SQLite DDL could not be parsed: {0}")]
    Parse(String),
    #[error(
        "Use CREATE TABLE with column definitions, CREATE INDEX, ALTER TABLE, DROP TABLE, or DROP INDEX in the main database."
    )]
    Unsupported,
    #[error(transparent)]
    Connection(#[from] TableError),
    #[error("SQLite rejected the schema change: {0}")]
    Database(String),
}

fn main_object(name: &ObjectName) -> bool {
    match name.0.as_slice() {
        [name] => name.as_ident().is_some(),
        [schema, name] => {
            schema
                .as_ident()
                .is_some_and(|schema| schema.value.eq_ignore_ascii_case("main"))
                && name.as_ident().is_some()
        }
        _ => false,
    }
}

fn allowed(statement: &Statement) -> bool {
    match statement {
        Statement::CreateTable(table) => {
            main_object(&table.name)
                && !table.temporary
                && !table.external
                && table.query.is_none()
                && !table.columns.is_empty()
        }
        Statement::CreateIndex(index) => {
            index.name.as_ref().is_some_and(main_object) && main_object(&index.table_name)
        }
        Statement::AlterTable(table) => {
            main_object(&table.name)
                && matches!(
                    &table.operations[..],
                    [AlterTableOperation::AddColumn { .. }
                        | AlterTableOperation::RenameColumn { .. }
                        | AlterTableOperation::RenameTable { .. }
                        | AlterTableOperation::DropColumn { .. }]
                )
        }
        Statement::Drop {
            object_type: ObjectType::Table | ObjectType::Index,
            names,
            temporary: false,
            ..
        } => {
            matches!(names.as_slice(), [name] if main_object(name))
        }
        _ => false,
    }
}

// The native engine ends a block comment at the first */ and bracket quotes at the
// first ]. Check the original SQL's boundary independently of the AST parser so
// SQLx is never handed a hidden second statement.
fn has_single_statement(sql: &str) -> bool {
    let mut rest = sql.as_bytes();
    let mut content = false;
    let mut terminated = false;
    while let Some((&first, tail)) = rest.split_first() {
        if first.is_ascii_whitespace() {
            rest = tail;
        } else if let Some(comment) = rest.strip_prefix(b"--") {
            rest = comment
                .iter()
                .position(|&byte| byte == b'\n')
                .map_or(&[], |end| &comment[end + 1..]);
        } else if let Some(comment) = rest.strip_prefix(b"/*") {
            rest = comment
                .windows(2)
                .position(|pair| pair == b"*/")
                .map_or(&[], |end| &comment[end + 2..]);
        } else if first == b';' {
            terminated |= content;
            rest = tail;
        } else if terminated {
            return false;
        } else {
            content = true;
            rest = match first {
                b'\'' | b'"' | b'`' => match after_quoted(tail, first, true) {
                    Some(remainder) => remainder,
                    None => return false,
                },
                b'[' => match after_quoted(tail, b']', false) {
                    Some(remainder) => remainder,
                    None => return false,
                },
                _ => tail,
            };
        }
    }
    content
}

fn after_quoted(mut rest: &[u8], quote: u8, doubled_escape: bool) -> Option<&[u8]> {
    while let Some(end) = rest.iter().position(|&byte| byte == quote) {
        let tail = &rest[end + 1..];
        if doubled_escape && tail.first() == Some(&quote) {
            rest = &tail[1..];
        } else {
            return Some(tail);
        }
    }
    None
}

fn validate(sql: &str) -> Result<(), SchemaEditError> {
    if sql.len() > SQL_LIMIT || sql.contains('\0') || !has_single_statement(sql) {
        return Err(SchemaEditError::SingleStatement);
    }
    let statements = Parser::parse_sql(&SQLiteDialect {}, sql)
        .map_err(|error| SchemaEditError::Parse(error.to_string().chars().take(400).collect()))?;
    match statements.as_slice() {
        [statement] if allowed(statement) => Ok(()),
        [_] => Err(SchemaEditError::Unsupported),
        _ => Err(SchemaEditError::SingleStatement),
    }
}

fn sql_error(error: sqlx::Error) -> SchemaEditError {
    let detail = error
        .as_database_error()
        .map(|database| database.message().chars().take(400).collect());
    match TableError::from(error) {
        TableError::Database | TableError::Constraint => {
            detail.map_or_else(|| TableError::Database.into(), SchemaEditError::Database)
        }
        classified => classified.into(),
    }
}

/// Executes exactly the confirmed statement in a transaction.
/// # Errors
/// Rejects unsupported SQL, unavailable files, and failed schema changes.
pub async fn execute(path: &Path, sql: &str) -> Result<(), SchemaEditError> {
    validate(sql)?;
    let mut connection = connect_for_write(path).await?;
    let result = execute_connected(&mut connection, sql).await;
    // Preserve a successful commit even if closing the driver later reports an error.
    let _ = connection.close().await;
    result
}

async fn execute_connected(
    connection: &mut SqliteConnection,
    sql: &str,
) -> Result<(), SchemaEditError> {
    let deadline = Instant::now() + TIME_LIMIT;
    set_deadline(connection, CancellationToken::new(), deadline)
        .await
        .map_err(|_| TableError::Database)?;
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(sql_error)?;
    sqlx::query(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *transaction)
        .await
        .map_err(sql_error)?;
    if Instant::now() >= deadline {
        return Err(TableError::Timeout.into());
    }
    transaction.commit().await.map_err(sql_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    #[test]
    fn permits_one_ddl_and_rejects_other_statements_and_parser_boundary_gaps() {
        for sql in [
            "-- before\nCREATE TABLE main.\"order;name\" (id INTEGER, note TEXT DEFAULT 'it''s; fine'); -- after",
            "CREATE TABLE [items;temp] (id INTEGER)",
            "CREATE UNIQUE INDEX IF NOT EXISTS main.items_id ON items(id) WHERE id > 0;",
            "ALTER TABLE items ADD COLUMN ref INTEGER REFERENCES parent(id);",
            "ALTER TABLE items RENAME COLUMN ref TO parent_id",
            "ALTER TABLE items DROP COLUMN ref",
            "ALTER TABLE items RENAME TO renamed_items",
            "DROP TABLE IF EXISTS main.items",
            "DROP INDEX IF EXISTS items_id",
        ] {
            assert!(validate(sql).is_ok(), "{sql}: {:?}", validate(sql));
        }
        for sql in [
            "SELECT 1",
            "DELETE FROM items",
            "PRAGMA foreign_keys=OFF",
            "ATTACH 'another.db' AS other",
            "CREATE TABLE other.items (id INTEGER)",
            "CREATE TEMP TABLE item(id INTEGER)",
            "CREATE TABLE t AS SELECT 1",
            "CREATE VIRTUAL TABLE t USING fts5(x)",
            "CREATE TABLE t(id INTEGER); UPDATE items SET id=1",
            "CREATE TABLE t(id INTEGER); CREATE INDEX t_id ON t(id)",
            "CREATE TABLE t(id INTEGER) /* nested /* first */; DELETE FROM items; /* outer */",
            "CREATE TABLE [a]]; DELETE FROM items; --] (id INTEGER)",
            "CREATE TABLE t(id INTEGER); \0DELETE FROM items",
        ] {
            assert!(validate(sql).is_err(), "{sql}");
        }
    }

    #[tokio::test]
    async fn commits_tables_indexes_and_foreign_keys_and_leaves_failed_ddl_unapplied() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema.sqlite");
        std::fs::write(&path, []).unwrap();
        execute(&path, "CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .await
            .unwrap();
        execute(&path, "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER, label TEXT, FOREIGN KEY(parent_id) REFERENCES parent(id))").await.unwrap();
        execute(&path, "CREATE INDEX child_parent_idx ON child(parent_id)")
            .await
            .unwrap();
        execute(
            &path,
            "ALTER TABLE child ADD COLUMN other_parent INTEGER REFERENCES parent(id)",
        )
        .await
        .unwrap();

        let mut independent = connect_for_write(&path).await.unwrap();
        let foreign_keys: Vec<String> = sqlx::query_scalar(
            "SELECT \"from\" FROM pragma_foreign_key_list('child') ORDER BY \"from\"",
        )
        .fetch_all(&mut independent)
        .await
        .unwrap();
        assert_eq!(foreign_keys, ["other_parent", "parent_id"]);
        let indexes: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_index_list('child')")
                .fetch_all(&mut independent)
                .await
                .unwrap();
        assert_eq!(indexes, ["child_parent_idx"]);
        assert!(
            independent
                .execute("INSERT INTO child(parent_id) VALUES (100)")
                .await
                .is_err()
        );
        independent
            .execute("INSERT INTO child(label) VALUES ('duplicate'), ('duplicate')")
            .await
            .unwrap();
        assert!(
            execute(
                &path,
                "CREATE UNIQUE INDEX child_label_unique ON child(label)"
            )
            .await
            .is_err()
        );
        let created: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_schema WHERE name = 'child_label_unique'",
        )
        .fetch_one(&mut independent)
        .await
        .unwrap();
        assert_eq!(created, 0);
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM child")
            .fetch_one(&mut independent)
            .await
            .unwrap();
        assert_eq!(rows, 2);
    }
}
