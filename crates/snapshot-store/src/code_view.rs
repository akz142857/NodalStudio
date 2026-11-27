use uuid::Uuid;

use crate::{LocalSnapshotStore, SnapshotStoreError};

impl LocalSnapshotStore {
    /// Verifies that the snapshot was captured against the currently saved database connection.
    ///
    /// # Errors
    /// Returns an error if the capture does not match the connection or `SQLite` is unavailable.
    pub async fn validate_code_view_snapshot(
        &self,
        snapshot: &schema_model::DatabaseSnapshot,
    ) -> Result<(), SnapshotStoreError> {
        let mut tx = self.pool.begin().await?;
        crate::ontology::ensure_captured_connection(&mut tx, snapshot, true).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Reads the local project binding for a data source.
    ///
    /// # Errors
    /// Returns any `SQLite` storage error.
    pub async fn code_view_binding(
        &self,
        source_id: Uuid,
    ) -> Result<Option<String>, SnapshotStoreError> {
        Ok(
            sqlx::query_scalar("SELECT payload FROM code_view_bindings WHERE source_id = ?")
                .bind(source_id.to_string())
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    /// Stores the project binding selected in the desktop app.
    ///
    /// # Errors
    /// Returns any `SQLite` storage error.
    pub async fn save_code_view_binding(
        &self,
        source_id: Uuid,
        binding_id: Uuid,
        payload: &str,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query("INSERT INTO code_view_bindings (source_id, binding_id, payload) SELECT id, ?, ? FROM data_sources WHERE id = ? ON CONFLICT (source_id) DO UPDATE SET binding_id = excluded.binding_id, payload = excluded.payload")
            .bind(binding_id.to_string())
            .bind(payload)
            .bind(source_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Removes access to a project without discarding previously recorded evidence.
    ///
    /// # Errors
    /// Returns any `SQLite` storage error.
    pub async fn remove_code_view_binding(
        &self,
        source_id: Uuid,
        binding_id: Uuid,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query("DELETE FROM code_view_bindings WHERE source_id = ? AND binding_id = ?")
            .bind(source_id.to_string())
            .bind(binding_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Loads locally confirmed links without mixing them with Git-imported or derived links.
    ///
    /// # Errors
    /// Returns any `SQLite` storage error.
    pub async fn code_view_links(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<String>, SnapshotStoreError> {
        Ok(sqlx::query_scalar(
            "SELECT payload FROM code_view_links WHERE source_id = ? ORDER BY link_id",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?)
    }

    /// Stores a local confirmation only while its originating project binding is current.
    ///
    /// # Errors
    /// Returns any `SQLite` storage error.
    pub async fn save_code_view_link(
        &self,
        source_id: Uuid,
        binding_id: Uuid,
        link_id: &str,
        payload: &str,
    ) -> Result<bool, SnapshotStoreError> {
        let result = sqlx::query("INSERT INTO code_view_links (source_id, link_id, payload) SELECT source_id, ?, ? FROM code_view_bindings WHERE source_id = ? AND binding_id = ? ON CONFLICT (source_id, link_id) DO UPDATE SET payload = excluded.payload")
            .bind(link_id)
            .bind(payload)
            .bind(source_id.to_string())
            .bind(binding_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }
}
