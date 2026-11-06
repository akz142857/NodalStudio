//! Read-only local `SQLite` access. Never applies migrations or changes journal mode.
mod metadata;
pub use metadata::inspect_schema;
use schema_model::{DatabaseInfo, DatabaseType};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum SqliteError {
    #[error("Choose an existing local SQLite database file.")]
    InvalidPath,
    #[error(
        "Unable to read this SQLite database. Check file and folder permissions, WAL sidecars, locks, and whether the file is encrypted or damaged."
    )]
    Database(#[from] sqlx::Error),
    #[error("SQLite metadata exceeds the supported size limit.")]
    Limit,
    #[error("SQLite structure capture was cancelled or timed out.")]
    Interrupted,
    #[error("Unable to encode SQLite metadata.")]
    Model(#[from] schema_model::SchemaModelError),
}

/// Checks that the selected path is an existing absolute file.
/// # Errors
/// Rejects relative paths, directories and missing files.
pub fn validate_path(path: &Path) -> Result<(), SqliteError> {
    if !path.is_absolute() || !path.is_file() {
        return Err(SqliteError::InvalidPath);
    }
    Ok(())
}

/// Opens only an existing file, with bounded lock waits and no extension loading.
/// # Errors
/// Returns an error for unavailable files or invalid `SQLite` databases.
pub async fn connect(path: &Path) -> Result<SqliteConnection, SqliteError> {
    validate_path(path)?;
    Ok(SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(Duration::from_millis(250))
            .pragma("query_only", "ON")
            .pragma("trusted_schema", "OFF"),
    )
    .await?)
}

/// Installs an engine-level deadline; the callback never touches the connection.
/// # Errors
/// Returns an error if the worker cannot be acquired.
pub async fn set_deadline(
    connection: &mut SqliteConnection,
    token: CancellationToken,
    deadline: Instant,
) -> Result<(), SqliteError> {
    connection
        .lock_handle()
        .await?
        .set_progress_handler(1000, move || {
            !token.is_cancelled() && Instant::now() < deadline
        });
    Ok(())
}

/// Validates the catalog without reading user rows.
/// # Errors
/// Returns errors for non-databases, encrypted files and inaccessible catalogs.
pub async fn test_connection(
    connection: &mut SqliteConnection,
    name: &str,
) -> Result<DatabaseInfo, SqliteError> {
    let _: i64 = sqlx::query_scalar("SELECT count(*) FROM main.sqlite_schema")
        .fetch_one(&mut *connection)
        .await?;
    let version = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(connection)
        .await?;
    Ok(DatabaseInfo {
        name: name.to_owned(),
        database_type: DatabaseType::Sqlite,
        version,
    })
}
