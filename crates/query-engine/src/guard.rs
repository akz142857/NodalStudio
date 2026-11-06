use sqlparser::{
    ast::{Expr, Query, Select, SetExpr, Statement, Visit, Visitor},
    dialect::{MySqlDialect, PostgreSqlDialect},
    parser::Parser,
    tokenizer::{Token, Tokenizer, Whitespace},
};
use std::ops::ControlFlow;

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

/// Accepts one `MySQL` SELECT/CTE, excluding writes, locks and executable comments.
///
/// # Errors
/// Returns a validation error for SQL outside the read-only Query contract.
pub fn validate_read_only_mysql(sql: &str) -> Result<(), QueryError> {
    let dialect = MySqlDialect {};
    let tokens = Tokenizer::new(&dialect, sql)
        .tokenize()
        .map_err(|_| QueryError::Validation("MySQL SQL could not be parsed.".into()))?;
    for token in tokens {
        let forbidden = match token {
            // Server-executed comments/hints can change semantics or disable time limits.
            Token::Whitespace(Whitespace::MultiLineComment(comment)) => {
                comment.starts_with(['!', '+'])
                    || comment.to_ascii_uppercase().starts_with("M!")
                    || comment.contains("/*")
            }
            Token::Assignment => true,
            Token::Word(word) => {
                word.quote_style.is_none() && word.value.eq_ignore_ascii_case("INTO")
            }
            _ => false,
        };
        if forbidden {
            return Err(QueryError::Validation("MySQL Query does not allow SELECT INTO, variable assignments, executable comments or optimizer hints.".into()));
        }
    }
    let statements = Parser::parse_sql(&dialect, sql).map_err(|_| {
        QueryError::Validation(
            "MySQL SQL could not be parsed. Use one read-only SELECT or WITH query.".into(),
        )
    })?;
    if statements.len() != 1 || !matches!(statements[0], Statement::Query(_)) {
        return Err(QueryError::Validation(
            "Exactly one read-only SELECT or WITH query is allowed.".into(),
        ));
    }
    match statements.visit(&mut ReadOnly {
        allow_values: false,
    }) {
        ControlFlow::Continue(()) => Ok(()),
        ControlFlow::Break(error) => Err(error),
    }
}

// Visit every subquery, including scalar subqueries and derived tables.
struct ReadOnly {
    allow_values: bool,
}
impl Visitor for ReadOnly {
    type Break = QueryError;
    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<QueryError> {
        match validate_query_with_values(query, self.allow_values) {
            Ok(()) => ControlFlow::Continue(()),
            Err(error) => ControlFlow::Break(error),
        }
    }
    fn pre_visit_expr(&mut self, expression: &Expr) -> ControlFlow<QueryError> {
        if let Expr::Function(function) = expression {
            let name = function
                .name
                .to_string()
                .replace('`', "")
                .to_ascii_uppercase();
            if matches!(
                name.as_str(),
                "GET_LOCK" | "RELEASE_LOCK" | "RELEASE_ALL_LOCKS" | "LOAD_FILE"
            ) {
                return ControlFlow::Break(QueryError::Validation(
                    "Lock and server-file functions are not allowed in read-only Query.".into(),
                ));
            }
        }
        ControlFlow::Continue(())
    }
}

fn validate_query(query: &Query) -> Result<(), QueryError> {
    validate_query_with_values(query, false)
}

fn validate_query_with_values(query: &Query, allow_values: bool) -> Result<(), QueryError> {
    if !query.locks.is_empty() {
        return Err(QueryError::Validation(
            "SELECT locking clauses are not allowed in read-only Query.".into(),
        ));
    }
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            validate_query_with_values(&cte.query, allow_values)?;
        }
    }
    validate_set_expr(&query.body, allow_values)
}

fn validate_set_expr(expression: &SetExpr, allow_values: bool) -> Result<(), QueryError> {
    match expression {
        SetExpr::Select(select) => validate_select(select),
        SetExpr::Query(query) => validate_query_with_values(query, allow_values),
        SetExpr::SetOperation { left, right, .. } => {
            validate_set_expr(left, allow_values)?;
            validate_set_expr(right, allow_values)
        }
        SetExpr::Values(_) if allow_values => Ok(()),
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

/// Accepts one `SQLite` SELECT/WITH with no extension, file or PRAGMA functions.
/// # Errors
/// Rejects unsupported statements, side effects and ambiguous SQL.
pub fn validate_read_only_sqlite(sql: &str) -> Result<(), QueryError> {
    if sql.len() > 1024 * 1024 {
        return Err(QueryError::Validation(
            "SQLite SQL exceeds the 1 MiB statement limit.".into(),
        ));
    }
    let statements = Parser::parse_sql(&sqlparser::dialect::SQLiteDialect {}, sql)
        .map_err(|_| QueryError::Validation("SQLite SQL could not be parsed.".into()))?;
    if statements.len() != 1 || !matches!(statements[0], Statement::Query(_)) {
        return Err(QueryError::Validation(
            "Exactly one read-only SELECT or WITH query is allowed.".into(),
        ));
    }
    // VALUES is a read-only expression used by ordinary SQLite CTE anchors.
    // Keep the outer command restricted to SELECT/WITH rather than standalone VALUES.
    if matches!(&statements[0], Statement::Query(query) if query.with.is_none() && matches!(query.body.as_ref(), SetExpr::Values(_)))
    {
        return Err(QueryError::Validation(
            "Use SELECT or WITH for SQLite queries.".into(),
        ));
    }
    if let ControlFlow::Break(error) = statements.visit(&mut ReadOnly { allow_values: true }) {
        return Err(error);
    }
    match statements.visit(&mut SqliteReadOnly) {
        ControlFlow::Continue(()) => Ok(()),
        ControlFlow::Break(error) => Err(error),
    }
}
struct SqliteReadOnly;
impl Visitor for SqliteReadOnly {
    type Break = QueryError;
    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<QueryError> {
        if let Expr::Function(f) = expr {
            let name = f
                .name
                .to_string()
                .replace(['"', '`', '[', ']'], "")
                .to_ascii_lowercase();
            if name.split('.').any(|s| {
                s.starts_with("pragma_")
                    || matches!(
                        s,
                        "load_extension" | "readfile" | "writefile" | "fts3_tokenizer" | "eval"
                    )
            }) {
                return ControlFlow::Break(QueryError::Validation(
                    "SQLite extension, file and PRAGMA functions are unavailable.".into(),
                ));
            }
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_relation(&mut self, name: &sqlparser::ast::ObjectName) -> ControlFlow<QueryError> {
        let name = name
            .to_string()
            .replace(['"', '`', '[', ']'], "")
            .to_ascii_lowercase();
        if name.split('.').any(|s| s.starts_with("pragma_")) {
            return ControlFlow::Break(QueryError::Validation(
                "Use the structure viewer for SQLite metadata.".into(),
            ));
        }
        ControlFlow::Continue(())
    }
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

    #[test]
    fn accepts_mysql_queries_and_literal_comment_markers() {
        for sql in [
            "SELECT `order``item` FROM `Sales Ops`.`orders` LIMIT 10",
            "WITH items AS (SELECT 1 AS id) SELECT id FROM items UNION ALL SELECT 2",
            "SELECT '/*! not executable */', 'INTO', '`', 1 # trailing comment\n",
            "SELECT JSON_EXTRACT('{\"ok\":true}', '$.ok')",
        ] {
            assert!(validate_read_only_mysql(sql).is_ok(), "rejected {sql}");
        }
    }

    #[test]
    fn rejects_mysql_writes_and_nested_or_hidden_side_effects() {
        for sql in [
            "SELECT 1; DELETE FROM users",
            "UPDATE users SET id=2",
            "DROP TABLE users",
            "CALL unsafe()",
            "SET autocommit=0",
            "SELECT * FROM users INTO OUTFILE '/tmp/unsafe'",
            "SELECT 1 INTO @x",
            "SELECT @x := 1",
            "SELECT * FROM users FOR UPDATE",
            "SELECT * FROM users LOCK IN SHARE MODE",
            "SELECT (SELECT id FROM users FOR UPDATE)",
            "SELECT * FROM (SELECT * FROM users FOR SHARE) AS nested",
            "SELECT 1 /*! INTO OUTFILE '/tmp/unsafe' */",
            "SELECT /*+ MAX_EXECUTION_TIME(0) */ 1",
            "SELECT 1 /*M! INTO OUTFILE '/tmp/unsafe' */",
            "SELECT GET_LOCK('lock', 10)",
            "SELECT LOAD_FILE('/tmp/secret')",
        ] {
            assert!(validate_read_only_mysql(sql).is_err(), "accepted {sql}");
        }
    }
}
