use sqlparser::{
    ast::{Query, Select, SetExpr, Statement},
    dialect::PostgreSqlDialect,
    parser::Parser,
};

use crate::QueryError;

/// Accepts exactly one `PostgreSQL` read-only query statement.
///
/// # Errors
/// Returns [`QueryError::Validation`] for empty, unparseable, multi-statement, locking,
/// `SELECT INTO`, DML, DDL, transaction, session, procedure, and copy statements.
pub fn validate_read_only_postgres(sql: &str) -> Result<(), QueryError> {
    let statements = Parser::parse_sql(&PostgreSqlDialect {}, sql)
        .map_err(|error| QueryError::Validation(format!("SQL could not be parsed: {error}")))?;
    if statements.len() != 1 {
        return Err(QueryError::Validation(
            "Exactly one read-only SQL statement is allowed.".into(),
        ));
    }
    match &statements[0] {
        Statement::Query(query) => validate_query(query),
        _ => Err(QueryError::Validation(
            "Only SELECT and read-only WITH queries are allowed.".into(),
        )),
    }
}

fn validate_query(query: &Query) -> Result<(), QueryError> {
    if !query.locks.is_empty() {
        return Err(QueryError::Validation(
            "SELECT locking clauses are not allowed in read-only Query.".into(),
        ));
    }
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            validate_query(&cte.query)?;
        }
    }
    validate_set_expr(&query.body)
}

fn validate_set_expr(expression: &SetExpr) -> Result<(), QueryError> {
    match expression {
        SetExpr::Select(select) => validate_select(select),
        SetExpr::Query(query) => validate_query(query),
        SetExpr::SetOperation { left, right, .. } => {
            validate_set_expr(left)?;
            validate_set_expr(right)
        }
        _ => Err(QueryError::Validation(
            "Only SELECT query expressions are allowed.".into(),
        )),
    }
}

fn validate_select(select: &Select) -> Result<(), QueryError> {
    if select.into.is_some() {
        return Err(QueryError::Validation(
            "SELECT INTO is not allowed in read-only Query.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_select_and_read_only_cte() {
        assert!(validate_read_only_postgres("SELECT 1").is_ok());
        assert!(
            validate_read_only_postgres("WITH value AS (SELECT 1 AS id) SELECT id FROM value")
                .is_ok()
        );
        assert!(validate_read_only_postgres("SELECT 1 UNION ALL SELECT 2").is_ok());
    }

    #[test]
    fn rejects_multiple_and_mutating_statements() {
        for sql in [
            "SELECT 1; SELECT 2",
            "INSERT INTO users(id) VALUES (1)",
            "UPDATE users SET name = 'x'",
            "DELETE FROM users",
            "CREATE TABLE unsafe(id int)",
            "ALTER TABLE users ADD COLUMN unsafe int",
            "DROP TABLE users",
            "TRUNCATE users",
            "CALL unsafe()",
            "COPY users TO STDOUT",
            "BEGIN",
            "SET ROLE admin",
        ] {
            assert!(validate_read_only_postgres(sql).is_err(), "accepted {sql}");
        }
    }

    #[test]
    fn rejects_select_into_and_locking() {
        assert!(validate_read_only_postgres("SELECT * INTO copied FROM users").is_err());
        assert!(validate_read_only_postgres("SELECT * FROM users FOR UPDATE").is_err());
    }
}
