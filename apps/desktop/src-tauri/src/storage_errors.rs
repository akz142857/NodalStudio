use snapshot_store::SnapshotStoreError;

/// Keep recovery guidance and a stable diagnostic code without exposing paths,
/// SQL, connection details or stored payloads through the desktop IPC boundary.
pub(super) fn message(error: &SnapshotStoreError) -> &'static str {
    match error {
        SnapshotStoreError::Database(sqlx::Error::PoolTimedOut) => {
            "Local storage did not become available in time. Retry opening the database. [storage-pool-timeout]"
        }
        SnapshotStoreError::Database(sqlx::Error::PoolClosed) => {
            "Local storage is closed. Restart Nodal Studio and try again. [storage-pool-closed]"
        }
        SnapshotStoreError::Database(sqlx::Error::Database(database)) => {
            let code = database
                .code()
                .and_then(|code| code.parse::<u32>().ok())
                .map(|code| code & 0xff);
            match code {
                Some(5 | 6) => {
                    "Local storage is busy with another operation. Wait briefly and retry. [storage-locked]"
                }
                Some(8) => {
                    "Local storage cannot be written. Check the app data folder permissions. [storage-read-only]"
                }
                Some(13) => "Local storage is full. Free disk space and retry. [storage-full]",
                Some(11 | 26) => {
                    "The local database could not be read. Keep the file and restore from a verified backup. [storage-invalid-database]"
                }
                _ => {
                    "A local database operation failed. Retry and include this code if it persists. [storage-database]"
                }
            }
        }
        SnapshotStoreError::Serialization(_) | SnapshotStoreError::Identifier(_) => {
            "Saved model data could not be decoded. Keep the existing data for diagnosis. [storage-invalid-record]"
        }
        SnapshotStoreError::UnsupportedSchema(_) => {
            "This local database was created by a newer version of Nodal Studio. Update the app. [storage-newer-schema]"
        }
        SnapshotStoreError::Io(_) => {
            "The local storage file could not be accessed. Check disk space and app data folder permissions. [storage-file-access]"
        }
        SnapshotStoreError::KnowledgeConflict(_) | SnapshotStoreError::ReviewConflict(_) => {
            "The saved model changed or conflicts with this operation. Reload it and retry. [storage-conflict]"
        }
        SnapshotStoreError::Database(_) => {
            "Local storage could not complete the operation. Retry and include this code if it persists. [storage-operation]"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_transient_waits_from_invalid_records_without_leaking_content() {
        assert!(message(&sqlx::Error::PoolTimedOut.into()).contains("storage-pool-timeout"));
        assert!(message(&sqlx::Error::PoolClosed.into()).contains("storage-pool-closed"));
        let invalid = serde_json::from_str::<u64>("\"private-connection-detail\"").unwrap_err();
        let rendered = message(&invalid.into());
        assert!(rendered.contains("storage-invalid-record"));
        assert!(!rendered.contains("private-connection-detail"));
    }

    #[tokio::test]
    async fn classifies_a_real_sqlite_lock_without_exposing_the_sql() {
        let path = std::env::temp_dir().join(format!(
            "nodal-storage-error-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(std::time::Duration::from_millis(10));
        let first = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        let second = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE fixture (value TEXT)")
            .execute(&first)
            .await
            .unwrap();
        let mut tx = first.begin().await.unwrap();
        sqlx::query("INSERT INTO fixture VALUES ('private-value')")
            .execute(&mut *tx)
            .await
            .unwrap();
        let error = sqlx::query("INSERT INTO fixture VALUES ('another-private-value')")
            .execute(&second)
            .await
            .unwrap_err();
        assert!(message(&error.into()).contains("storage-locked"));
        tx.rollback().await.unwrap();
        first.close().await;
        second.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
