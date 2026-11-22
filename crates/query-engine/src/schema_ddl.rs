//! Manual table and index DDL over dedicated database connections.
use sqlparser::{
    ast::{AlterTableOperation, ObjectName, ObjectType, RenameTableNameKind, Statement},
    dialect::{MySqlDialect, PostgreSqlDialect},
    parser::Parser,
};
use sqlx::{AssertSqlSafe, MySqlPool, PgPool};
use std::time::Duration;

const SQL_LIMIT: usize = 256 * 1024;
const WIRE_TIMEOUT: Duration = Duration::from_secs(35);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum DdlError {
    #[error("Enter or select exactly one DDL statement of at most 256 KiB.")]
    SingleStatement,
    #[error("The DDL statement could not be parsed: {0}")]
    Parse(String),
    #[error(
        "Use CREATE TABLE with column definitions, CREATE INDEX, ALTER TABLE, DROP TABLE, or DROP INDEX in the selected database."
    )]
    Unsupported,
    #[error("MySQL DDL cannot contain executable comments or optimizer hints.")]
    MySqlComment,
    #[error("Could not execute DDL: {0}")]
    Database(String),
    #[error("The database did not finish the statement before the deadline.")]
    Timeout,
    #[error("The server did not confirm the outcome. Refresh the schema before retrying.")]
    OutcomeUnknown,
}

#[derive(Clone, Copy)]
enum Target<'a> {
    Postgres,
    MySql(&'a str),
}

impl Target<'_> {
    fn allows(self, name: &ObjectName) -> bool {
        if name.0.iter().any(|part| part.as_ident().is_none()) {
            return false;
        }
        match (self, name.0.as_slice()) {
            (_, [_]) | (Self::Postgres, [_, _]) => true,
            (Self::MySql(database), [schema, _]) => schema
                .as_ident()
                .is_some_and(|schema| schema.value == database),
            _ => false,
        }
    }
}

fn supported_alter(operation: &AlterTableOperation, target: Target<'_>) -> bool {
    match operation {
        AlterTableOperation::AddColumn { .. }
        | AlterTableOperation::AddConstraint { .. }
        | AlterTableOperation::DropColumn { .. }
        | AlterTableOperation::DropConstraint { .. }
        | AlterTableOperation::DropForeignKey { .. }
        | AlterTableOperation::DropIndex { .. }
        | AlterTableOperation::RenameColumn { .. }
        | AlterTableOperation::AlterColumn { .. }
        | AlterTableOperation::ChangeColumn { .. }
        | AlterTableOperation::ModifyColumn { .. } => true,
        AlterTableOperation::RenameTable {
            table_name: RenameTableNameKind::As(name) | RenameTableNameKind::To(name),
        } => target.allows(name),
        _ => false,
    }
}

fn validate(sql: &str, target: Target<'_>) -> Result<(), DdlError> {
    if sql.len() > SQL_LIMIT || sql.contains('\0') {
        return Err(DdlError::SingleStatement);
    }
    let parsed = match target {
        Target::Postgres => Parser::parse_sql(&PostgreSqlDialect {}, sql),
        Target::MySql(_) => {
            // Keep server-executed content excluded even when session quoting differs.
            if ["/*!", "/*+", "/*M!", "/*m!"]
                .iter()
                .any(|marker| sql.contains(marker))
            {
                return Err(DdlError::MySqlComment);
            }
            Parser::parse_sql(&MySqlDialect {}, sql)
        }
    }
    .map_err(|error| DdlError::Parse(error.to_string().chars().take(400).collect()))?;
    let [statement] = parsed.as_slice() else {
        return Err(DdlError::SingleStatement);
    };
    let allowed = match statement {
        Statement::CreateTable(table) => {
            target.allows(&table.name)
                && !table.temporary
                && !table.external
                && table.query.is_none()
                && !table.columns.is_empty()
        }
        Statement::CreateIndex(index) => {
            target.allows(&index.table_name)
                && index.name.as_ref().is_none_or(|name| target.allows(name))
                && !index.concurrently
                && index
                    .alter_options
                    .iter()
                    .all(|operation| supported_alter(operation, target))
        }
        Statement::AlterTable(table) => {
            target.allows(&table.name)
                && !table.operations.is_empty()
                && table
                    .operations
                    .iter()
                    .all(|operation| supported_alter(operation, target))
        }
        Statement::Drop {
            object_type: ObjectType::Table | ObjectType::Index,
            names,
            table,
            temporary: false,
            ..
        } => {
            matches!(names.as_slice(), [name] if target.allows(name))
                && table.as_ref().is_none_or(|name| target.allows(name))
        }
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(DdlError::Unsupported)
    }
}

fn database_error(error: &sqlx::Error) -> DdlError {
    DdlError::Database(error.as_database_error().map_or_else(
        || "The database connection did not complete the operation.".into(),
        |database| database.message().chars().take(400).collect(),
    ))
}

fn after_dispatch(error: &sqlx::Error) -> DdlError {
    if error.as_database_error().is_some() {
        database_error(error)
    } else {
        DdlError::OutcomeUnknown
    }
}

/// Applies one `PostgreSQL` DDL statement in an explicit transaction.
/// # Errors
/// Returns validation, database, timeout, or unknown-commit errors.
pub async fn execute_postgres_ddl(pool: &PgPool, sql: &str) -> Result<(), DdlError> {
    validate(sql, Target::Postgres)?;
    let mut tx = pool.begin().await.map_err(|error| database_error(&error))?;
    sqlx::query("SET LOCAL lock_timeout = '5s'")
        .execute(&mut *tx)
        .await
        .map_err(|error| database_error(&error))?;
    sqlx::query("SET LOCAL statement_timeout = '30s'")
        .execute(&mut *tx)
        .await
        .map_err(|error| database_error(&error))?;
    // The extended protocol accepts only a single statement in Parse.
    tokio::time::timeout(
        WIRE_TIMEOUT,
        sqlx::query(AssertSqlSafe(sql.to_owned())).execute(&mut *tx),
    )
    .await
    .map_err(|_| DdlError::Timeout)?
    .map_err(|error| database_error(&error))?;
    tokio::time::timeout(COMMIT_TIMEOUT, tx.commit())
        .await
        .map_err(|_| DdlError::OutcomeUnknown)?
        .map_err(|error| after_dispatch(&error))
}

/// Applies one `MySQL` DDL statement using the engine's commit semantics.
/// # Errors
/// Returns validation, database, or unknown-outcome errors.
pub async fn execute_mysql_ddl(
    pool: &MySqlPool,
    database: &str,
    sql: &str,
) -> Result<(), DdlError> {
    validate(sql, Target::MySql(database))?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| database_error(&error))?;
    sqlx::query(
        "SET SESSION lock_wait_timeout = 5, innodb_lock_wait_timeout = 5, foreign_key_checks = 1",
    )
    .execute(&mut *conn)
    .await
    .map_err(|error| database_error(&error))?;
    // A prepared statement is single-statement. MySQL schema changes implicitly commit.
    let result = tokio::time::timeout(
        WIRE_TIMEOUT,
        sqlx::query(AssertSqlSafe(sql.to_owned())).execute(&mut *conn),
    )
    .await;
    if result.is_err()
        || result.as_ref().is_ok_and(|result| {
            result
                .as_ref()
                .is_err_and(|error| error.as_database_error().is_none())
        })
    {
        let _ = conn.detach();
    }
    result
        .map_err(|_| DdlError::OutcomeUnknown)?
        .map(|_| ())
        .map_err(|error| after_dispatch(&error))
}

#[cfg(test)]
mod tests {
    use super::{DdlError, Target, validate};

    #[test]
    fn rejects_non_schema_sql_and_multiple_statements() {
        for target in [Target::Postgres, Target::MySql("app")] {
            for sql in [
                "UPDATE orders SET label = 'new'",
                "CREATE TABLE orders AS SELECT 1 AS id",
                "CREATE TEMPORARY TABLE orders(id INT)",
                "CREATE TABLE orders(id INT); DROP TABLE orders;",
                "DROP TABLE orders, customers",
                "CREATE VIEW orders_view AS SELECT * FROM orders",
            ] {
                assert!(validate(sql, target).is_err(), "{sql}");
            }
        }
        assert!(
            validate(
                "CREATE INDEX CONCURRENTLY label_idx ON orders(label)",
                Target::Postgres
            )
            .is_err()
        );
    }

    #[test]
    fn limits_mysql_targets_to_the_confirmed_database() {
        let target = Target::MySql("app");
        assert!(validate("CREATE TABLE `app`.`orders`(id INT)", target).is_ok());
        assert!(validate("DROP INDEX label_idx ON `app`.`orders`", target).is_ok());
        for sql in [
            "CREATE TABLE other.orders(id INT)",
            "CREATE INDEX label_idx ON other.orders(label)",
            "DROP INDEX label_idx ON other.orders",
            "ALTER TABLE app.orders RENAME TO other.orders",
            "DROP TABLE other.orders",
        ] {
            assert!(
                matches!(validate(sql, target), Err(DdlError::Unsupported)),
                "{sql}"
            );
        }
        assert!(matches!(
            validate(
                "CREATE TABLE orders(id INT) /*!50100 PARTITION BY KEY(id) */",
                target
            ),
            Err(DdlError::MySqlComment)
        ));
    }
}
