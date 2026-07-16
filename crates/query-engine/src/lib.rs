//! Safe, bounded, read-only query execution for `Nodal Studio`.

mod guard;
mod postgres;
mod value;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub use guard::validate_read_only_postgres;
pub use postgres::execute_postgres_query;

pub const DEFAULT_ROW_LIMIT: u32 = 100;
pub const MAX_ROW_LIMIT: u32 = 5_000;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 120_000;
pub const DEFAULT_CELL_BYTES: usize = 64 * 1_024;
pub const MAX_CELL_BYTES: usize = 256 * 1_024;
pub const DEFAULT_RESULT_BYTES: usize = 10 * 1_024 * 1_024;
pub const MAX_RESULT_BYTES: usize = 25 * 1_024 * 1_024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteQueryRequest {
    pub query_id: Uuid,
    pub sql: String,
    pub row_limit: u32,
    pub timeout_ms: u64,
    #[serde(default = "default_cell_bytes")]
    pub max_cell_bytes: usize,
    #[serde(default = "default_result_bytes")]
    pub max_result_bytes: usize,
}

const fn default_cell_bytes() -> usize {
    DEFAULT_CELL_BYTES
}

const fn default_result_bytes() -> usize {
    DEFAULT_RESULT_BYTES
}

impl ExecuteQueryRequest {
    /// Validates and normalizes user-controlled execution limits.
    ///
    /// # Errors
    /// Returns [`QueryError::Validation`] when SQL is empty or a limit is outside the hard bounds.
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.sql.trim().is_empty() {
            return Err(QueryError::Validation("SQL cannot be empty.".into()));
        }
        if self.row_limit == 0 || self.row_limit > MAX_ROW_LIMIT {
            return Err(QueryError::Validation(format!(
                "Row limit must be between 1 and {MAX_ROW_LIMIT}."
            )));
        }
        if self.timeout_ms == 0 || self.timeout_ms > MAX_TIMEOUT_MS {
            return Err(QueryError::Validation(format!(
                "Timeout must be between 1 and {MAX_TIMEOUT_MS} milliseconds."
            )));
        }
        if self.max_cell_bytes == 0 || self.max_cell_bytes > MAX_CELL_BYTES {
            return Err(QueryError::Validation(format!(
                "Cell limit must be between 1 and {MAX_CELL_BYTES} bytes."
            )));
        }
        if self.max_result_bytes == 0 || self.max_result_bytes > MAX_RESULT_BYTES {
            return Err(QueryError::Validation(format!(
                "Result limit must be between 1 and {MAX_RESULT_BYTES} bytes."
            )));
        }
        validate_read_only_postgres(&self.sql)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueryColumn {
    pub name: String,
    pub database_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueryCell {
    Null,
    Boolean {
        value: bool,
    },
    Number {
        value: f64,
    },
    Text {
        value: String,
        truncated: bool,
    },
    Json {
        value: serde_json::Value,
        truncated: bool,
    },
    Binary {
        byte_length: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecutionResult {
    pub query_id: Uuid,
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<QueryCell>>,
    pub row_count: usize,
    pub truncated: bool,
    pub duration_ms: u64,
    pub notices: Vec<String>,
}

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("{0}")]
    Validation(String),
    #[error("Database query failed.")]
    Database,
    #[error("Query timed out.")]
    Timeout,
    #[error("Query was cancelled.")]
    Cancelled,
    #[error("Query result exceeded the configured size limit.")]
    ResultLimit,
    #[error("The database connection is unavailable.")]
    Connection,
    #[error("An unsupported database value was returned.")]
    UnsupportedType,
    #[error("The query engine failed internally.")]
    Internal,
}

impl QueryError {
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation",
            Self::Database => "database",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::ResultLimit => "resultLimit",
            Self::Connection => "connection",
            Self::UnsupportedType => "unsupportedType",
            Self::Internal => "internal",
        }
    }

    #[must_use]
    pub fn public_message(&self) -> String {
        match self {
            Self::Validation(message) => message.clone(),
            _ => self.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(sql: &str) -> ExecuteQueryRequest {
        ExecuteQueryRequest {
            query_id: Uuid::new_v4(),
            sql: sql.into(),
            row_limit: DEFAULT_ROW_LIMIT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_cell_bytes: DEFAULT_CELL_BYTES,
            max_result_bytes: DEFAULT_RESULT_BYTES,
        }
    }

    #[test]
    fn validates_execution_limits() {
        assert!(request("SELECT 1").validate().is_ok());
        let mut invalid = request("SELECT 1");
        invalid.row_limit = MAX_ROW_LIMIT + 1;
        assert!(matches!(invalid.validate(), Err(QueryError::Validation(_))));
    }
}
