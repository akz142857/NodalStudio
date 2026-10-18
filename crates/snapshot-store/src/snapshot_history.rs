use crate::{LocalSnapshotStore, SnapshotStoreError};
use sqlx::Connection;

impl LocalSnapshotStore {
    // Keep immutable snapshot IDs and change-set references, but allow A -> B -> A
    // to record the second A. Deduplication applies to consecutive captures only.
    pub(super) async fn migrate_snapshot_history(&self) -> Result<(), SnapshotStoreError> {
        let mut connection = self.pool.acquire().await?;
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *connection)
            .await?;
        let result = async {
            let mut tx = connection.begin().await?;
            for statement in [
                "CREATE TABLE schema_snapshots_v5 (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, captured_at TEXT NOT NULL, fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL)",
                "INSERT INTO schema_snapshots_v5 SELECT id,source_id,captured_at,fingerprint,payload_json FROM schema_snapshots",
                "DROP TABLE schema_snapshots",
                "ALTER TABLE schema_snapshots_v5 RENAME TO schema_snapshots",
                "CREATE INDEX schema_snapshots_source_time_idx ON schema_snapshots (source_id,captured_at DESC)",
            ] {
                if let Err(error) = sqlx::query(statement).execute(&mut *tx).await {
                    tx.rollback().await?;
                    return Err(SnapshotStoreError::from(error));
                }
            }
            if !sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&mut *tx)
                .await?
                .is_empty()
            {
                tx.rollback().await?;
                return Err(SnapshotStoreError::KnowledgeConflict(
                    "Snapshot migration found invalid history references.".into(),
                ));
            }
            tx.commit().await?;
            Ok(())
        }
        .await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut *connection)
            .await?;
        result
    }
}
