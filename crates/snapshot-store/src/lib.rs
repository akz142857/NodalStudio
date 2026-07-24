//! Local `SQLite` persistence for immutable snapshots and change sets.

use std::{collections::BTreeSet, path::Path, str::FromStr};

use chrono::Utc;
use extension_model::{ChangeProvenance, CodeLineageLink};
use schema_diff::SchemaChangeSet;
use schema_model::{
    DataSourceProfile, DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship,
};
use semantic_model::{CanvasLayout, DomainGroup, ObjectAnnotation, SavedView};
use serde::{Deserialize, Serialize};
use settings_model::{
    AppSettings, DataSourceSettings, OrganizationPolicy, ProjectSettings, StorageUsage,
};
use sqlx::{Row, SqlitePool, sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions};
use thiserror::Error;
use uuid::Uuid;

const LOCAL_SCHEMA_VERSION: i64 = 3;

#[derive(Debug, Error)]
pub enum SnapshotStoreError {
    #[error("SQLite operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("stored snapshot payload is invalid: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("stored identifier is invalid: {0}")]
    Identifier(#[from] uuid::Error),
    #[error("local database schema version {0} is newer than this application supports")]
    UnsupportedSchema(i64),
    #[error("local database backup failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: Uuid,
    pub source_id: Uuid,
    pub captured_at: String,
    pub fingerprint: String,
    pub database_name: String,
    pub schema_count: usize,
    pub table_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncQueueItem {
    pub id: Uuid,
    pub source_id: Uuid,
    pub event_kind: String,
    pub idempotency_key: String,
    pub payload: serde_json::Value,
    pub base_version: i64,
    pub attempts: u32,
    pub state: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDataImpact {
    pub connection_records: u64,
    pub snapshot_records: u64,
    pub semantic_records: u64,
    pub pending_sync_records: u64,
    pub snapshot_bytes: u64,
    pub semantic_bytes: u64,
    pub sync_queue_bytes: u64,
    pub estimated_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableModelBackup {
    pub format_version: u16,
    pub exported_at: String,
    pub source_id: Uuid,
    pub source_profile: Option<DataSourceProfile>,
    pub source_settings: DataSourceSettings,
    pub snapshots: Vec<DatabaseSnapshot>,
    pub change_sets: Vec<SchemaChangeSet>,
    pub annotations: Vec<ObjectAnnotation>,
    pub domain_groups: Vec<DomainGroup>,
    pub saved_views: Vec<SavedView>,
    pub layouts: Vec<CanvasLayout>,
    pub provenance: Vec<ChangeProvenance>,
    pub lineage: Vec<CodeLineageLink>,
    #[serde(default)]
    pub logical_relationships: Vec<LogicalRelationship>,
    #[serde(default)]
    pub ignored_relationship_inferences: Vec<IgnoredRelationshipInference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAccessRecord {
    pub capability: String,
    pub last_access_at: String,
    pub outcome: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryHistoryEntry {
    pub id: Uuid,
    pub source_id: Uuid,
    pub executed_at: String,
    pub sql_text: String,
    pub duration_ms: u64,
    pub row_count: usize,
    pub status: String,
    pub error_kind: Option<String>,
}

impl From<&DatabaseSnapshot> for SnapshotSummary {
    fn from(snapshot: &DatabaseSnapshot) -> Self {
        Self {
            id: snapshot.id,
            source_id: snapshot.source_id,
            captured_at: snapshot.captured_at.to_rfc3339(),
            fingerprint: snapshot.fingerprint.clone(),
            database_name: snapshot.database.name.clone(),
            schema_count: snapshot.schemas.len(),
            table_count: snapshot
                .schemas
                .iter()
                .map(|schema| schema.tables.len())
                .sum(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LocalSnapshotStore {
    pool: SqlitePool,
}

impl LocalSnapshotStore {
    /// Opens a `SQLite` database and creates the `Nodal Studio` tables when needed.
    ///
    /// # Errors
    ///
    /// Returns an error when the URL is invalid, `SQLite` cannot be opened, or the
    /// local schema cannot be initialized.
    pub async fn open(database_url: &str) -> Result<Self, SnapshotStoreError> {
        let options = SqliteConnectOptions::from_str(database_url)?
            .create_if_missing(true)
            .foreign_keys(true);
        Self::open_with_options(options).await
    }

    /// Opens a file-backed `SQLite` database without converting the path to a URL.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be opened or initialized.
    pub async fn open_path(path: impl AsRef<Path>) -> Result<Self, SnapshotStoreError> {
        let path = path.as_ref();
        if path.exists() {
            let probe_options = SqliteConnectOptions::new()
                .filename(path)
                .foreign_keys(true);
            let probe = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(probe_options)
                .await?;
            let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&probe)
                .await?;
            probe.close().await;
            if version < LOCAL_SCHEMA_VERSION {
                let backup = path.with_extension(format!("pre-v{version}.bak"));
                if !backup.exists() {
                    std::fs::copy(path, backup)?;
                }
            }
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        Self::open_with_options(options).await
    }

    async fn open_with_options(options: SqliteConnectOptions) -> Result<Self, SnapshotStoreError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let store = Self { pool };
        store.initialize().await?;
        Ok(store)
    }

    /// Creates or updates a non-sensitive data-source profile.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_data_source(
        &self,
        profile: &DataSourceProfile,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT INTO data_sources (id, display_name, updated_at, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(profile.id.to_string())
        .bind(&profile.display_name)
        .bind(profile.updated_at.to_rfc3339())
        .bind(serde_json::to_string(profile)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists all non-sensitive data-source profiles by display name.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn list_data_sources(&self) -> Result<Vec<DataSourceProfile>, SnapshotStoreError> {
        let rows = sqlx::query("SELECT payload_json FROM data_sources ORDER BY display_name")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get("payload_json")).map_err(Into::into))
            .collect()
    }

    /// Loads one non-sensitive data-source profile.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn get_data_source(
        &self,
        id: Uuid,
    ) -> Result<Option<DataSourceProfile>, SnapshotStoreError> {
        let row = sqlx::query("SELECT payload_json FROM data_sources WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map_err(Into::into)
    }

    /// Saves the versioned, non-sensitive application settings document.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or serialization fails.
    pub async fn save_app_settings(
        &self,
        settings: &AppSettings,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "INSERT INTO app_settings (settings_key, schema_version, payload_json) VALUES ('global', ?, ?) ON CONFLICT(settings_key) DO UPDATE SET schema_version = excluded.schema_version, payload_json = excluded.payload_json",
        )
        .bind(i64::from(settings.schema_version))
        .bind(serde_json::to_string(settings)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads application settings, returning product defaults before the first save.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or deserialization fails.
    pub async fn get_app_settings(&self) -> Result<AppSettings, SnapshotStoreError> {
        let row =
            sqlx::query("SELECT payload_json FROM app_settings WHERE settings_key = 'global'")
                .fetch_optional(&self.pool)
                .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map(Option::unwrap_or_default)
            .map_err(Into::into)
    }

    /// Saves settings scoped to one database source. Secrets are not part of this type.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or serialization fails.
    pub async fn save_data_source_settings(
        &self,
        settings: &DataSourceSettings,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "INSERT INTO data_source_settings (source_id, schema_version, payload_json) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET schema_version = excluded.schema_version, payload_json = excluded.payload_json",
        )
        .bind(settings.source_id.to_string())
        .bind(i64::from(settings.schema_version))
        .bind(serde_json::to_string(settings)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads source settings or creates a default document for a known source ID.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or deserialization fails.
    pub async fn get_data_source_settings(
        &self,
        source_id: Uuid,
    ) -> Result<DataSourceSettings, SnapshotStoreError> {
        let row = sqlx::query("SELECT payload_json FROM data_source_settings WHERE source_id = ?")
            .bind(source_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map(|value| value.unwrap_or_else(|| DataSourceSettings::defaults_for(source_id)))
            .map_err(Into::into)
    }

    /// Lists every source-scoped non-sensitive settings document.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or deserialization fails.
    pub async fn list_data_source_settings(
        &self,
    ) -> Result<Vec<DataSourceSettings>, SnapshotStoreError> {
        let rows = sqlx::query("SELECT payload_json FROM data_source_settings ORDER BY source_id")
            .fetch_all(&self.pool)
            .await?;
        deserialize_payloads(rows)
    }

    /// Saves shared project policy without local credentials or layouts.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or serialization fails.
    pub async fn save_project_settings(
        &self,
        settings: &ProjectSettings,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "INSERT INTO project_settings (project_id, schema_version, payload_json) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET schema_version = excluded.schema_version, payload_json = excluded.payload_json",
        )
        .bind(&settings.project_id)
        .bind(i64::from(settings.schema_version))
        .bind(serde_json::to_string(settings)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads shared project settings when they have been cached locally.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or deserialization fails.
    pub async fn get_project_settings(
        &self,
        project_id: &str,
    ) -> Result<Option<ProjectSettings>, SnapshotStoreError> {
        let row = sqlx::query("SELECT payload_json FROM project_settings WHERE project_id = ?")
            .bind(project_id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map_err(Into::into)
    }

    /// Persists an organization policy cache without credentials or user data.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or serialization fails.
    pub async fn save_organization_policy(
        &self,
        policy: &OrganizationPolicy,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "INSERT INTO organization_policy (policy_key, version, payload_json) VALUES ('active', ?, ?) ON CONFLICT(policy_key) DO UPDATE SET version = excluded.version, payload_json = excluded.payload_json",
        )
        .bind(i64::try_from(policy.version).unwrap_or(i64::MAX))
        .bind(serde_json::to_string(policy)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads the cached organization policy or unrestricted local defaults.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or deserialization fails.
    pub async fn get_organization_policy(&self) -> Result<OrganizationPolicy, SnapshotStoreError> {
        let row =
            sqlx::query("SELECT payload_json FROM organization_policy WHERE policy_key = 'active'")
                .fetch_optional(&self.pool)
                .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map(Option::unwrap_or_default)
            .map_err(Into::into)
    }

    /// Records a non-sensitive external capability access timestamp.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` persistence fails.
    pub async fn record_external_access(
        &self,
        capability: &str,
        outcome: &str,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "INSERT INTO external_access_log (capability, last_access_at, outcome) VALUES (?, ?, ?) ON CONFLICT(capability) DO UPDATE SET last_access_at = excluded.last_access_at, outcome = excluded.outcome",
        )
        .bind(capability)
        .bind(Utc::now().to_rfc3339())
        .bind(outcome)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists the latest non-sensitive external capability access timestamps.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails.
    pub async fn list_external_access(
        &self,
    ) -> Result<Vec<ExternalAccessRecord>, SnapshotStoreError> {
        Ok(sqlx::query(
            "SELECT capability, last_access_at, outcome FROM external_access_log ORDER BY capability",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| ExternalAccessRecord {
            capability: row.get("capability"),
            last_access_at: row.get("last_access_at"),
            outcome: row.get("outcome"),
        })
        .collect())
    }

    /// Calculates non-sensitive local storage totals directly from `SQLite` payload sizes.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` aggregation fails.
    pub async fn storage_usage(&self) -> Result<StorageUsage, SnapshotStoreError> {
        let row = sqlx::query(
            r"
            SELECT
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM schema_snapshots) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM schema_change_sets) AS snapshot_bytes,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM object_annotations) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM domain_groups) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM saved_views) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM change_provenance) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM code_lineage) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM logical_relationships) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM ignored_relationship_inferences) AS semantic_bytes,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM canvas_layouts) AS layout_bytes,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM sync_queue) AS sync_queue_bytes,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM app_settings) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM data_source_settings) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM project_settings) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM organization_policy) AS settings_bytes,
              (SELECT COUNT(*) FROM schema_snapshots) AS snapshot_count,
              (SELECT COUNT(*) FROM sync_queue WHERE state IN ('pending', 'conflict')) AS pending_sync_count
            ",
        )
        .fetch_one(&self.pool)
        .await?;
        let unsigned = |column| u64::try_from(row.get::<i64, _>(column)).unwrap_or(0);
        Ok(StorageUsage {
            snapshot_bytes: unsigned("snapshot_bytes"),
            semantic_bytes: unsigned("semantic_bytes"),
            layout_bytes: unsigned("layout_bytes"),
            sync_queue_bytes: unsigned("sync_queue_bytes"),
            settings_bytes: unsigned("settings_bytes"),
            snapshot_count: unsigned("snapshot_count"),
            pending_sync_count: unsigned("pending_sync_count"),
        })
    }

    /// Deletes personal canvas coordinates without touching snapshots or semantics.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` deletion fails.
    pub async fn clear_layouts(&self, source_id: Option<Uuid>) -> Result<u64, SnapshotStoreError> {
        let result = if let Some(source_id) = source_id {
            sqlx::query("DELETE FROM canvas_layouts WHERE source_id = ?")
                .bind(source_id.to_string())
                .execute(&self.pool)
                .await?
        } else {
            sqlx::query("DELETE FROM canvas_layouts")
                .execute(&self.pool)
                .await?
        };
        Ok(result.rows_affected())
    }

    /// Previews record counts and serialized payload bytes affected by source cleanup.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` aggregation fails.
    pub async fn source_data_impact(
        &self,
        source_id: Uuid,
    ) -> Result<SourceDataImpact, SnapshotStoreError> {
        let source = source_id.to_string();
        let row = sqlx::query(
            r"
            SELECT
              (SELECT COUNT(*) FROM data_sources WHERE id = ?) AS connection_records,
              (SELECT COUNT(*) FROM schema_snapshots WHERE source_id = ?) AS snapshot_records,
              (SELECT COUNT(*) FROM object_annotations WHERE source_id = ?) +
              (SELECT COUNT(*) FROM domain_groups WHERE source_id = ?) +
              (SELECT COUNT(*) FROM saved_views WHERE source_id = ?) +
              (SELECT COUNT(*) FROM canvas_layouts WHERE source_id = ?) +
              (SELECT COUNT(*) FROM code_lineage WHERE source_id = ?) +
              (SELECT COUNT(*) FROM logical_relationships WHERE source_id = ?) +
              (SELECT COUNT(*) FROM ignored_relationship_inferences WHERE source_id = ?) AS semantic_records,
              (SELECT COUNT(*) FROM sync_queue WHERE source_id = ? AND state IN ('pending', 'conflict')) AS pending_sync_records,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM schema_snapshots WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM schema_change_sets WHERE after_snapshot_id IN (SELECT id FROM schema_snapshots WHERE source_id = ?)) AS snapshot_bytes,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM object_annotations WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM domain_groups WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM saved_views WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM canvas_layouts WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM code_lineage WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM logical_relationships WHERE source_id = ?) +
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM ignored_relationship_inferences WHERE source_id = ?) AS semantic_bytes,
              (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM sync_queue WHERE source_id = ?) AS sync_queue_bytes
            ",
        )
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .bind(&source)
        .fetch_one(&self.pool)
        .await?;
        let unsigned = |column| u64::try_from(row.get::<i64, _>(column)).unwrap_or(0);
        Ok(SourceDataImpact {
            connection_records: unsigned("connection_records"),
            snapshot_records: unsigned("snapshot_records"),
            semantic_records: unsigned("semantic_records"),
            pending_sync_records: unsigned("pending_sync_records"),
            snapshot_bytes: unsigned("snapshot_bytes"),
            semantic_bytes: unsigned("semantic_bytes"),
            sync_queue_bytes: unsigned("sync_queue_bytes"),
            estimated_bytes: unsigned("snapshot_bytes")
                + unsigned("semantic_bytes")
                + unsigned("sync_queue_bytes"),
        })
    }

    /// Deletes explicitly selected categories of local data for one source.
    ///
    /// Connection, history, and semantic deletion are independent so cloud or
    /// credential removal is never implied by local cleanup.
    ///
    /// # Errors
    ///
    /// Returns an error when the transactional `SQLite` deletion fails.
    pub async fn delete_source_data(
        &self,
        source_id: Uuid,
        delete_connection: bool,
        delete_history: bool,
        delete_semantics: bool,
    ) -> Result<u64, SnapshotStoreError> {
        let source = source_id.to_string();
        let mut transaction = self.pool.begin().await?;
        let mut affected = 0_u64;
        if delete_history {
            affected += sqlx::query(
                "DELETE FROM change_provenance WHERE change_set_id IN (SELECT c.id FROM schema_change_sets c JOIN schema_snapshots s ON s.id = c.after_snapshot_id WHERE s.source_id = ?)",
            )
            .bind(&source)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            affected += sqlx::query(
                "DELETE FROM schema_change_sets WHERE after_snapshot_id IN (SELECT id FROM schema_snapshots WHERE source_id = ?) OR before_snapshot_id IN (SELECT id FROM schema_snapshots WHERE source_id = ?)",
            )
            .bind(&source)
            .bind(&source)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            affected += sqlx::query("DELETE FROM schema_snapshots WHERE source_id = ?")
                .bind(&source)
                .execute(&mut *transaction)
                .await?
                .rows_affected();
        }
        if delete_semantics {
            for statement in [
                "DELETE FROM object_annotations WHERE source_id = ?",
                "DELETE FROM domain_groups WHERE source_id = ?",
                "DELETE FROM saved_views WHERE source_id = ?",
                "DELETE FROM canvas_layouts WHERE source_id = ?",
                "DELETE FROM code_lineage WHERE source_id = ?",
                "DELETE FROM logical_relationships WHERE source_id = ?",
                "DELETE FROM ignored_relationship_inferences WHERE source_id = ?",
                "DELETE FROM sync_queue WHERE source_id = ?",
            ] {
                affected += sqlx::query(statement)
                    .bind(&source)
                    .execute(&mut *transaction)
                    .await?
                    .rows_affected();
            }
        }
        if delete_connection {
            affected += sqlx::query("DELETE FROM data_source_settings WHERE source_id = ?")
                .bind(&source)
                .execute(&mut *transaction)
                .await?
                .rows_affected();
            affected += sqlx::query("DELETE FROM data_sources WHERE id = ?")
                .bind(&source)
                .execute(&mut *transaction)
                .await?
                .rows_affected();
        }
        transaction.commit().await?;
        Ok(affected)
    }

    /// Deletes every local `Nodal Studio` record in one transaction.
    ///
    /// Keychain credentials are intentionally handled by the desktop boundary,
    /// because this storage crate never has access to operating-system secrets.
    ///
    /// # Errors
    ///
    /// Returns an error when the transactional `SQLite` reset fails.
    pub async fn factory_reset(&self) -> Result<u64, SnapshotStoreError> {
        let mut transaction = self.pool.begin().await?;
        let mut affected = 0_u64;
        for statement in [
            "DELETE FROM change_provenance",
            "DELETE FROM schema_change_sets",
            "DELETE FROM schema_snapshots",
            "DELETE FROM object_annotations",
            "DELETE FROM domain_groups",
            "DELETE FROM saved_views",
            "DELETE FROM canvas_layouts",
            "DELETE FROM code_lineage",
            "DELETE FROM logical_relationships",
            "DELETE FROM ignored_relationship_inferences",
            "DELETE FROM sync_queue",
            "DELETE FROM data_source_settings",
            "DELETE FROM data_sources",
            "DELETE FROM project_settings",
            "DELETE FROM organization_policy",
            "DELETE FROM external_access_log",
            "DELETE FROM app_settings",
        ] {
            affected += sqlx::query(statement)
                .execute(&mut *transaction)
                .await?
                .rows_affected();
        }
        transaction.commit().await?;
        Ok(affected)
    }

    /// Creates or updates semantic metadata for a physical database object.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_annotation(
        &self,
        annotation: &ObjectAnnotation,
    ) -> Result<(), SnapshotStoreError> {
        let object_key = serde_json::to_string(&annotation.object_key)?;
        sqlx::query(
            r"
            INSERT INTO object_annotations (source_id, object_key, updated_at, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_id, object_key) DO UPDATE SET
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(annotation.source_id.to_string())
        .bind(object_key)
        .bind(annotation.updated_at.to_rfc3339())
        .bind(serde_json::to_string(annotation)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists semantic annotations for one data source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn list_annotations(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<ObjectAnnotation>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT payload_json FROM object_annotations WHERE source_id = ? ORDER BY updated_at DESC",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Creates or updates a model-only relationship for one data source.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_logical_relationship(
        &self,
        relationship: &LogicalRelationship,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT INTO logical_relationships (
                id, source_id, relationship_key, status, updated_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                relationship_key = excluded.relationship_key,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(relationship.id.to_string())
        .bind(relationship.source_id.to_string())
        .bind(relationship.relationship_key())
        .bind(format!("{:?}", relationship.status).to_lowercase())
        .bind(relationship.updated_at.to_rfc3339())
        .bind(serde_json::to_string(relationship)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists model-only relationships for a data source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or stored JSON decoding fails.
    pub async fn list_logical_relationships(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<LogicalRelationship>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT payload_json FROM logical_relationships WHERE source_id = ? ORDER BY updated_at DESC",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Deletes a model-only relationship while enforcing data-source isolation.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` deletion fails.
    pub async fn delete_logical_relationship(
        &self,
        source_id: Uuid,
        relationship_id: Uuid,
    ) -> Result<bool, SnapshotStoreError> {
        Ok(
            sqlx::query("DELETE FROM logical_relationships WHERE source_id = ? AND id = ?")
                .bind(source_id.to_string())
                .bind(relationship_id.to_string())
                .execute(&self.pool)
                .await?
                .rows_affected()
                > 0,
        )
    }

    /// Persists a dismissed inferred relationship candidate.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_ignored_relationship_inference(
        &self,
        ignored: &IgnoredRelationshipInference,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT INTO ignored_relationship_inferences (
                source_id, relationship_key, ignored_at, payload_json
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_id, relationship_key) DO UPDATE SET
                ignored_at = excluded.ignored_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(ignored.source_id.to_string())
        .bind(&ignored.relationship_key)
        .bind(ignored.ignored_at.to_rfc3339())
        .bind(serde_json::to_string(ignored)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists dismissed inferred relationship candidates for a data source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or stored JSON decoding fails.
    pub async fn list_ignored_relationship_inferences(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<IgnoredRelationshipInference>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT payload_json FROM ignored_relationship_inferences WHERE source_id = ? ORDER BY ignored_at DESC",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Creates or updates a business-domain group.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_domain_group(&self, group: &DomainGroup) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT INTO domain_groups (id, source_id, updated_at, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(group.id.to_string())
        .bind(group.source_id.to_string())
        .bind(group.updated_at.to_rfc3339())
        .bind(serde_json::to_string(group)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists business-domain groups for one data source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn list_domain_groups(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<DomainGroup>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT payload_json FROM domain_groups WHERE source_id = ? ORDER BY updated_at DESC",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Creates or updates a saved relationship view.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_view(&self, view: &SavedView) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT INTO saved_views (id, source_id, updated_at, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(view.id.to_string())
        .bind(view.source_id.to_string())
        .bind(view.updated_at.to_rfc3339())
        .bind(serde_json::to_string(view)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists saved relationship views for one data source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn list_views(&self, source_id: Uuid) -> Result<Vec<SavedView>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT payload_json FROM saved_views WHERE source_id = ? ORDER BY updated_at DESC",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Creates or updates a persisted canvas layout.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_layout(&self, layout: &CanvasLayout) -> Result<(), SnapshotStoreError> {
        let layout_key = layout
            .view_id
            .map_or_else(|| "default".to_owned(), |id| id.to_string());
        sqlx::query(
            r"
            INSERT INTO canvas_layouts (source_id, layout_key, updated_at, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_id, layout_key) DO UPDATE SET
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            ",
        )
        .bind(layout.source_id.to_string())
        .bind(layout_key)
        .bind(layout.updated_at.to_rfc3339())
        .bind(serde_json::to_string(layout)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads a canvas layout for the default or a saved view.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn get_layout(
        &self,
        source_id: Uuid,
        view_id: Option<Uuid>,
    ) -> Result<Option<CanvasLayout>, SnapshotStoreError> {
        let layout_key = view_id.map_or_else(|| "default".to_owned(), |id| id.to_string());
        let row = sqlx::query(
            "SELECT payload_json FROM canvas_layouts WHERE source_id = ? AND layout_key = ?",
        )
        .bind(source_id.to_string())
        .bind(layout_key)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map_err(Into::into)
    }

    /// Stores a snapshot once per `(source_id, fingerprint)` pair.
    ///
    /// Returns `true` when a new row was inserted and `false` for an existing model.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_snapshot(
        &self,
        snapshot: &DatabaseSnapshot,
    ) -> Result<bool, SnapshotStoreError> {
        let result = sqlx::query(
            r"
            INSERT OR IGNORE INTO schema_snapshots (
                id, source_id, captured_at, fingerprint, payload_json
            ) VALUES (?, ?, ?, ?, ?)
            ",
        )
        .bind(snapshot.id.to_string())
        .bind(snapshot.source_id.to_string())
        .bind(snapshot.captured_at.to_rfc3339())
        .bind(&snapshot.fingerprint)
        .bind(serde_json::to_string(snapshot)?)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Loads a snapshot by identifier.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn get_snapshot(
        &self,
        id: Uuid,
    ) -> Result<Option<DatabaseSnapshot>, SnapshotStoreError> {
        let row = sqlx::query("SELECT payload_json FROM schema_snapshots WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map_err(SnapshotStoreError::from)
    }

    /// Lists snapshot summaries for one source, newest first.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn list_snapshots(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<SnapshotSummary>, SnapshotStoreError> {
        let rows = sqlx::query(
            r"
            SELECT payload_json
            FROM schema_snapshots
            WHERE source_id = ?
            ORDER BY captured_at DESC
            ",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let snapshot: DatabaseSnapshot = serde_json::from_str(row.get("payload_json"))?;
                Ok(SnapshotSummary::from(&snapshot))
            })
            .collect()
    }

    /// Loads every immutable snapshot for one source in capture order.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or stored JSON decoding fails.
    pub async fn list_snapshot_models(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<DatabaseSnapshot>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT payload_json FROM schema_snapshots WHERE source_id = ? ORDER BY captured_at",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Removes snapshots outside a count or date boundary while optionally
    /// preserving both sides of high-risk change sets.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` reads, decoding, or transactional deletion fails.
    pub async fn prune_snapshots(
        &self,
        source_id: Uuid,
        retain_count: Option<usize>,
        captured_after: Option<&str>,
        preserve_high_risk: bool,
    ) -> Result<u64, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT id, captured_at FROM schema_snapshots WHERE source_id = ? ORDER BY captured_at DESC",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut retained: BTreeSet<String> = rows
            .iter()
            .enumerate()
            .filter(|(index, row)| {
                retain_count.is_some_and(|count| *index < count)
                    || captured_after.is_some_and(|cutoff| {
                        row.get::<String, _>("captured_at").as_str() >= cutoff
                    })
                    || *index == 0
            })
            .map(|(_, row)| row.get("id"))
            .collect();
        if preserve_high_risk {
            let changes = sqlx::query(
                "SELECT c.before_snapshot_id, c.after_snapshot_id, c.payload_json FROM schema_change_sets c JOIN schema_snapshots s ON s.id = c.after_snapshot_id WHERE s.source_id = ?",
            )
            .bind(source_id.to_string())
            .fetch_all(&self.pool)
            .await?;
            for row in changes {
                let change: SchemaChangeSet = serde_json::from_str(row.get("payload_json"))?;
                if change.risk_summary.high > 0 {
                    retained.insert(row.get("before_snapshot_id"));
                    retained.insert(row.get("after_snapshot_id"));
                }
            }
        }
        let removed: Vec<String> = rows
            .into_iter()
            .map(|row| row.get("id"))
            .filter(|id| !retained.contains(id))
            .collect();
        let mut transaction = self.pool.begin().await?;
        for snapshot_id in &removed {
            sqlx::query(
                "DELETE FROM change_provenance WHERE change_set_id IN (SELECT id FROM schema_change_sets WHERE before_snapshot_id = ? OR after_snapshot_id = ?)",
            )
            .bind(snapshot_id)
            .bind(snapshot_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "DELETE FROM schema_change_sets WHERE before_snapshot_id = ? OR after_snapshot_id = ?",
            )
            .bind(snapshot_id)
            .bind(snapshot_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query("DELETE FROM schema_snapshots WHERE id = ?")
                .bind(snapshot_id)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(removed.len() as u64)
    }

    /// Loads the newest snapshot for one source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn latest_snapshot(
        &self,
        source_id: Uuid,
    ) -> Result<Option<DatabaseSnapshot>, SnapshotStoreError> {
        let row = sqlx::query(
            r"
            SELECT payload_json
            FROM schema_snapshots
            WHERE source_id = ?
            ORDER BY captured_at DESC
            LIMIT 1
            ",
        )
        .bind(source_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map_err(SnapshotStoreError::from)
    }

    /// Persists a deterministic snapshot comparison result.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_change_set(
        &self,
        change_set: &SchemaChangeSet,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT OR REPLACE INTO schema_change_sets (
                id, before_snapshot_id, after_snapshot_id, created_at, payload_json
            ) VALUES (?, ?, ?, ?, ?)
            ",
        )
        .bind(change_set.id.to_string())
        .bind(change_set.before_snapshot_id.to_string())
        .bind(change_set.after_snapshot_id.to_string())
        .bind(change_set.created_at.to_rfc3339())
        .bind(serde_json::to_string(change_set)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads all change sets for an `after_snapshot_id`.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access fails or a stored payload is invalid.
    pub async fn change_sets_for_snapshot(
        &self,
        after_snapshot_id: Uuid,
    ) -> Result<Vec<SchemaChangeSet>, SnapshotStoreError> {
        let rows = sqlx::query(
            r"
            SELECT payload_json
            FROM schema_change_sets
            WHERE after_snapshot_id = ?
            ORDER BY created_at DESC
            ",
        )
        .bind(after_snapshot_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(row.get("payload_json")).map_err(Into::into))
            .collect()
    }

    /// Adds a metadata-only event to the durable local synchronization queue.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn enqueue_sync(&self, item: &SyncQueueItem) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            INSERT OR IGNORE INTO sync_queue (
                id, source_id, event_kind, idempotency_key, payload_json,
                base_version, attempts, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(item.id.to_string())
        .bind(item.source_id.to_string())
        .bind(&item.event_kind)
        .bind(&item.idempotency_key)
        .bind(serde_json::to_string(&item.payload)?)
        .bind(item.base_version)
        .bind(item.attempts)
        .bind(&item.state)
        .bind(&item.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lists pending and conflicted sync events in creation order.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or stored JSON decoding fails.
    pub async fn pending_sync(&self) -> Result<Vec<SyncQueueItem>, SnapshotStoreError> {
        let rows = sqlx::query(
            "SELECT id, source_id, event_kind, idempotency_key, payload_json, base_version, attempts, state, created_at FROM sync_queue WHERE state IN ('pending', 'conflict') ORDER BY created_at",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(SyncQueueItem {
                    id: Uuid::parse_str(row.get("id"))?,
                    source_id: Uuid::parse_str(row.get("source_id"))?,
                    event_kind: row.get("event_kind"),
                    idempotency_key: row.get("idempotency_key"),
                    payload: serde_json::from_str(row.get("payload_json"))?,
                    base_version: row.get("base_version"),
                    attempts: row.get("attempts"),
                    state: row.get("state"),
                    created_at: row.get("created_at"),
                })
            })
            .collect()
    }

    /// Marks an event as uploaded or conflicted while retaining its audit trail.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` persistence fails.
    pub async fn update_sync_state(&self, id: Uuid, state: &str) -> Result<(), SnapshotStoreError> {
        sqlx::query("UPDATE sync_queue SET state = ?, attempts = attempts + 1 WHERE id = ?")
            .bind(state)
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Atomically acknowledges one frozen Cloud upload batch and advances its source version.
    /// Events created after the batch was captured remain pending.
    ///
    /// # Errors
    ///
    /// Returns an error when local settings, queue state, or serialization cannot be committed.
    pub async fn complete_cloud_sync(
        &self,
        source_id: Uuid,
        event_ids: &[Uuid],
        base_version: i64,
        completed_at: &str,
    ) -> Result<usize, SnapshotStoreError> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query("SELECT payload_json FROM data_source_settings WHERE source_id = ?")
            .bind(source_id.to_string())
            .fetch_optional(&mut *transaction)
            .await?;
        let mut settings = row
            .map(|row| serde_json::from_str::<DataSourceSettings>(row.get("payload_json")))
            .transpose()?
            .unwrap_or_else(|| DataSourceSettings::defaults_for(source_id));
        settings.cloud.base_version = base_version;
        settings.cloud.last_success_at = Some(completed_at.to_owned());
        settings.cloud.credential_configured = true;
        sqlx::query(
            "INSERT INTO data_source_settings (source_id, schema_version, payload_json) VALUES (?, ?, ?) \
             ON CONFLICT(source_id) DO UPDATE SET schema_version = excluded.schema_version, payload_json = excluded.payload_json",
        )
        .bind(source_id.to_string())
        .bind(i64::from(settings.schema_version))
        .bind(serde_json::to_string(&settings)?)
        .execute(&mut *transaction)
        .await?;
        let mut updated = 0;
        for id in event_ids {
            let result = sqlx::query(
                "UPDATE sync_queue SET state = 'uploaded', attempts = attempts + 1 \
                 WHERE id = ? AND source_id = ? AND state IN ('pending', 'conflict')",
            )
            .bind(id.to_string())
            .bind(source_id.to_string())
            .execute(&mut *transaction)
            .await?;
            updated += usize::try_from(result.rows_affected()).unwrap_or(usize::MAX);
        }
        transaction.commit().await?;
        Ok(updated)
    }

    /// Imports a fully validated portable model as one atomic `SQLite` transaction.
    ///
    /// # Errors
    ///
    /// Returns an error without committing any record when serialization, references,
    /// or persistence fail.
    #[allow(clippy::too_many_lines)]
    pub async fn import_portable_model(
        &self,
        bundle: &PortableModelBackup,
    ) -> Result<(), SnapshotStoreError> {
        let source = bundle.source_id.to_string();
        let mut transaction = self.pool.begin().await?;
        if let Some(profile) = &bundle.source_profile {
            sqlx::query(
                "INSERT INTO data_sources (id, display_name, updated_at, payload_json) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at, payload_json = excluded.payload_json",
            )
            .bind(profile.id.to_string())
            .bind(&profile.display_name)
            .bind(profile.updated_at.to_rfc3339())
            .bind(serde_json::to_string(profile)?)
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            "INSERT INTO data_source_settings (source_id, schema_version, payload_json) VALUES (?, ?, ?) \
             ON CONFLICT(source_id) DO UPDATE SET schema_version = excluded.schema_version, payload_json = excluded.payload_json",
        )
        .bind(&source)
        .bind(i64::from(bundle.source_settings.schema_version))
        .bind(serde_json::to_string(&bundle.source_settings)?)
        .execute(&mut *transaction)
        .await?;
        for snapshot in &bundle.snapshots {
            sqlx::query(
                "INSERT OR IGNORE INTO schema_snapshots (id, source_id, captured_at, fingerprint, payload_json) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(snapshot.id.to_string())
            .bind(snapshot.source_id.to_string())
            .bind(snapshot.captured_at.to_rfc3339())
            .bind(&snapshot.fingerprint)
            .bind(serde_json::to_string(snapshot)?)
            .execute(&mut *transaction)
            .await?;
        }
        for change_set in &bundle.change_sets {
            sqlx::query(
                "INSERT OR REPLACE INTO schema_change_sets (id, before_snapshot_id, after_snapshot_id, created_at, payload_json) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(change_set.id.to_string())
            .bind(change_set.before_snapshot_id.to_string())
            .bind(change_set.after_snapshot_id.to_string())
            .bind(change_set.created_at.to_rfc3339())
            .bind(serde_json::to_string(change_set)?)
            .execute(&mut *transaction)
            .await?;
        }
        for annotation in &bundle.annotations {
            sqlx::query(
                "INSERT INTO object_annotations (source_id, object_key, updated_at, payload_json) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(source_id, object_key) DO UPDATE SET updated_at = excluded.updated_at, payload_json = excluded.payload_json",
            )
            .bind(annotation.source_id.to_string())
            .bind(serde_json::to_string(&annotation.object_key)?)
            .bind(annotation.updated_at.to_rfc3339())
            .bind(serde_json::to_string(annotation)?)
            .execute(&mut *transaction)
            .await?;
        }
        for group in &bundle.domain_groups {
            sqlx::query(
                "INSERT INTO domain_groups (id, source_id, updated_at, payload_json) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, updated_at = excluded.updated_at, payload_json = excluded.payload_json",
            )
            .bind(group.id.to_string())
            .bind(group.source_id.to_string())
            .bind(group.updated_at.to_rfc3339())
            .bind(serde_json::to_string(group)?)
            .execute(&mut *transaction)
            .await?;
        }
        for view in &bundle.saved_views {
            sqlx::query(
                "INSERT INTO saved_views (id, source_id, updated_at, payload_json) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, updated_at = excluded.updated_at, payload_json = excluded.payload_json",
            )
            .bind(view.id.to_string())
            .bind(view.source_id.to_string())
            .bind(view.updated_at.to_rfc3339())
            .bind(serde_json::to_string(view)?)
            .execute(&mut *transaction)
            .await?;
        }
        for layout in &bundle.layouts {
            let layout_key = layout
                .view_id
                .map_or_else(|| "default".to_owned(), |id| id.to_string());
            sqlx::query(
                "INSERT INTO canvas_layouts (source_id, layout_key, updated_at, payload_json) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(source_id, layout_key) DO UPDATE SET updated_at = excluded.updated_at, payload_json = excluded.payload_json",
            )
            .bind(layout.source_id.to_string())
            .bind(layout_key)
            .bind(layout.updated_at.to_rfc3339())
            .bind(serde_json::to_string(layout)?)
            .execute(&mut *transaction)
            .await?;
        }
        for provenance in &bundle.provenance {
            sqlx::query(
                "INSERT OR REPLACE INTO change_provenance (change_set_id, recorded_at, payload_json) VALUES (?, ?, ?)",
            )
            .bind(provenance.change_set_id.to_string())
            .bind(provenance.recorded_at.to_rfc3339())
            .bind(serde_json::to_string(provenance)?)
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query("DELETE FROM code_lineage WHERE source_id = ?")
            .bind(&source)
            .execute(&mut *transaction)
            .await?;
        for link in &bundle.lineage {
            sqlx::query(
                "INSERT INTO code_lineage (source_id, object_key, file_path, payload_json) VALUES (?, ?, ?, ?)",
            )
            .bind(&source)
            .bind(serde_json::to_string(&link.object_key)?)
            .bind(&link.file_path)
            .bind(serde_json::to_string(link)?)
            .execute(&mut *transaction)
            .await?;
        }
        for relationship in &bundle.logical_relationships {
            sqlx::query(
                "INSERT INTO logical_relationships (id, source_id, relationship_key, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, relationship_key = excluded.relationship_key, status = excluded.status, updated_at = excluded.updated_at, payload_json = excluded.payload_json",
            )
            .bind(relationship.id.to_string())
            .bind(relationship.source_id.to_string())
            .bind(relationship.relationship_key())
            .bind(format!("{:?}", relationship.status).to_lowercase())
            .bind(relationship.updated_at.to_rfc3339())
            .bind(serde_json::to_string(relationship)?)
            .execute(&mut *transaction)
            .await?;
        }
        for ignored in &bundle.ignored_relationship_inferences {
            sqlx::query(
                "INSERT INTO ignored_relationship_inferences (source_id, relationship_key, ignored_at, payload_json) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(source_id, relationship_key) DO UPDATE SET ignored_at = excluded.ignored_at, payload_json = excluded.payload_json",
            )
            .bind(ignored.source_id.to_string())
            .bind(&ignored.relationship_key)
            .bind(ignored.ignored_at.to_rfc3339())
            .bind(serde_json::to_string(ignored)?)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Associates Git and migration evidence with a structural change set.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn save_change_provenance(
        &self,
        provenance: &ChangeProvenance,
    ) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "INSERT OR REPLACE INTO change_provenance (change_set_id, recorded_at, payload_json) VALUES (?, ?, ?)",
        )
        .bind(provenance.change_set_id.to_string())
        .bind(provenance.recorded_at.to_rfc3339())
        .bind(serde_json::to_string(provenance)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Loads Git and migration evidence for a change set.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or JSON decoding fails.
    pub async fn get_change_provenance(
        &self,
        change_set_id: Uuid,
    ) -> Result<Option<ChangeProvenance>, SnapshotStoreError> {
        let row = sqlx::query("SELECT payload_json FROM change_provenance WHERE change_set_id = ?")
            .bind(change_set_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| serde_json::from_str(row.get("payload_json")))
            .transpose()
            .map_err(Into::into)
    }

    /// Lists Git and migration evidence associated with snapshots from one source.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or JSON decoding fails.
    pub async fn list_change_provenance(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<ChangeProvenance>, SnapshotStoreError> {
        let rows = sqlx::query(
            r"
            SELECT provenance.payload_json
            FROM change_provenance provenance
            JOIN schema_change_sets changes
              ON changes.id = provenance.change_set_id
            JOIN schema_snapshots snapshot
              ON snapshot.id = changes.after_snapshot_id
            WHERE snapshot.source_id = ?
            ORDER BY provenance.recorded_at, provenance.change_set_id
            ",
        )
        .bind(source_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        deserialize_payloads(rows)
    }

    /// Replaces code/ORM lineage links for one data source.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or `SQLite` persistence fails.
    pub async fn replace_lineage(
        &self,
        source_id: Uuid,
        links: &[CodeLineageLink],
    ) -> Result<(), SnapshotStoreError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM code_lineage WHERE source_id = ?")
            .bind(source_id.to_string())
            .execute(&mut *transaction)
            .await?;
        for link in links {
            sqlx::query("INSERT INTO code_lineage (source_id, object_key, file_path, payload_json) VALUES (?, ?, ?, ?)")
                .bind(source_id.to_string())
                .bind(serde_json::to_string(&link.object_key)?)
                .bind(&link.file_path)
                .bind(serde_json::to_string(link)?)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Lists persisted code/ORM lineage links.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` access or JSON decoding fails.
    pub async fn list_lineage(
        &self,
        source_id: Uuid,
    ) -> Result<Vec<CodeLineageLink>, SnapshotStoreError> {
        let rows = sqlx::query("SELECT payload_json FROM code_lineage WHERE source_id = ? ORDER BY file_path, object_key")
            .bind(source_id.to_string())
            .fetch_all(&self.pool)
            .await?;
        deserialize_payloads(rows)
    }

    /// Saves a local query-history entry and retains at most 100 entries per source.
    ///
    /// # Errors
    /// Returns an error when the local `SQLite` operation fails.
    pub async fn save_query_history(
        &self,
        entry: &QueryHistoryEntry,
    ) -> Result<(), SnapshotStoreError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            r"
            INSERT INTO query_history (
                id, source_id, executed_at, sql_text, duration_ms, row_count, status, error_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(entry.id.to_string())
        .bind(entry.source_id.to_string())
        .bind(&entry.executed_at)
        .bind(&entry.sql_text)
        .bind(i64::try_from(entry.duration_ms).unwrap_or(i64::MAX))
        .bind(i64::try_from(entry.row_count).unwrap_or(i64::MAX))
        .bind(&entry.status)
        .bind(&entry.error_kind)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r"
            DELETE FROM query_history
            WHERE source_id = ? AND id NOT IN (
                SELECT id FROM query_history
                WHERE source_id = ?
                ORDER BY executed_at DESC
                LIMIT 100
            )
            ",
        )
        .bind(entry.source_id.to_string())
        .bind(entry.source_id.to_string())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Lists local query history newest-first.
    ///
    /// # Errors
    /// Returns an error when `SQLite` access fails or an identifier is invalid.
    pub async fn list_query_history(
        &self,
        source_id: Uuid,
        limit: u32,
    ) -> Result<Vec<QueryHistoryEntry>, SnapshotStoreError> {
        let rows = sqlx::query(
            r"
            SELECT id, source_id, executed_at, sql_text, duration_ms, row_count, status, error_kind
            FROM query_history
            WHERE source_id = ?
            ORDER BY executed_at DESC
            LIMIT ?
            ",
        )
        .bind(source_id.to_string())
        .bind(i64::from(limit.clamp(1, 100)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(QueryHistoryEntry {
                    id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                    source_id: Uuid::parse_str(row.get::<String, _>("source_id").as_str())?,
                    executed_at: row.get("executed_at"),
                    sql_text: row.get("sql_text"),
                    duration_ms: u64::try_from(row.get::<i64, _>("duration_ms")).unwrap_or(0),
                    row_count: usize::try_from(row.get::<i64, _>("row_count")).unwrap_or(0),
                    status: row.get("status"),
                    error_kind: row.get("error_kind"),
                })
            })
            .collect()
    }

    /// Deletes one local query-history entry belonging to the source.
    ///
    /// # Errors
    /// Returns an error when `SQLite` access fails.
    pub async fn delete_query_history(
        &self,
        source_id: Uuid,
        history_id: Uuid,
    ) -> Result<bool, SnapshotStoreError> {
        let result = sqlx::query("DELETE FROM query_history WHERE id = ? AND source_id = ?")
            .bind(history_id.to_string())
            .bind(source_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Clears all local query history for one source.
    ///
    /// # Errors
    /// Returns an error when `SQLite` access fails.
    pub async fn clear_query_history(&self, source_id: Uuid) -> Result<u64, SnapshotStoreError> {
        let result = sqlx::query("DELETE FROM query_history WHERE source_id = ?")
            .bind(source_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    async fn initialize(&self) -> Result<(), SnapshotStoreError> {
        let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&self.pool)
            .await?;
        if version > LOCAL_SCHEMA_VERSION {
            return Err(SnapshotStoreError::UnsupportedSchema(version));
        }
        self.initialize_settings_tables().await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS data_sources (
                id TEXT PRIMARY KEY NOT NULL,
                display_name TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS schema_snapshots (
                id TEXT PRIMARY KEY NOT NULL,
                source_id TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                UNIQUE (source_id, fingerprint)
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE INDEX IF NOT EXISTS schema_snapshots_source_time_idx
            ON schema_snapshots (source_id, captured_at DESC)
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS schema_change_sets (
                id TEXT PRIMARY KEY NOT NULL,
                before_snapshot_id TEXT NOT NULL,
                after_snapshot_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                FOREIGN KEY (before_snapshot_id) REFERENCES schema_snapshots (id),
                FOREIGN KEY (after_snapshot_id) REFERENCES schema_snapshots (id)
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        self.initialize_semantic_tables().await?;
        self.initialize_sync_tables().await?;
        self.initialize_extension_tables().await?;
        self.remove_retired_project_tables().await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS local_schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO local_schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .bind(LOCAL_SCHEMA_VERSION)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        sqlx::query("PRAGMA user_version = 3")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn initialize_settings_tables(&self) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS app_settings (settings_key TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS data_source_settings (source_id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS organization_policy (policy_key TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS external_access_log (capability TEXT PRIMARY KEY NOT NULL, last_access_at TEXT NOT NULL, outcome TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn initialize_semantic_tables(&self) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS object_annotations (
                source_id TEXT NOT NULL,
                object_key TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (source_id, object_key)
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS domain_groups (
                id TEXT PRIMARY KEY NOT NULL,
                source_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS saved_views (
                id TEXT PRIMARY KEY NOT NULL,
                source_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS canvas_layouts (
                source_id TEXT NOT NULL,
                layout_key TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (source_id, layout_key)
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS logical_relationships (
                id TEXT PRIMARY KEY NOT NULL,
                source_id TEXT NOT NULL,
                relationship_key TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                UNIQUE(source_id, relationship_key)
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS logical_relationships_source_idx ON logical_relationships(source_id, updated_at DESC)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS ignored_relationship_inferences (
                source_id TEXT NOT NULL,
                relationship_key TEXT NOT NULL,
                ignored_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY(source_id, relationship_key)
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn initialize_sync_tables(&self) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS sync_queue (
                id TEXT PRIMARY KEY NOT NULL,
                source_id TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                payload_json TEXT NOT NULL,
                base_version INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL CHECK (state IN ('pending', 'uploaded', 'conflict')),
                created_at TEXT NOT NULL
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn initialize_extension_tables(&self) -> Result<(), SnapshotStoreError> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS change_provenance (change_set_id TEXT PRIMARY KEY NOT NULL, recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS code_lineage (source_id TEXT NOT NULL, object_key TEXT NOT NULL, file_path TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (source_id, object_key, file_path))",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r"
            CREATE TABLE IF NOT EXISTS query_history (
                id TEXT PRIMARY KEY NOT NULL,
                source_id TEXT NOT NULL,
                executed_at TEXT NOT NULL,
                sql_text TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                row_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                error_kind TEXT
            )
            ",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS query_history_source_time_idx ON query_history (source_id, executed_at DESC)",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn remove_retired_project_tables(&self) -> Result<(), SnapshotStoreError> {
        let mut transaction = self.pool.begin().await?;
        for statement in [
            "DROP TABLE IF EXISTS project_edges",
            "DROP TABLE IF EXISTS project_nodes",
            "DROP TABLE IF EXISTS project_files",
            "DROP TABLE IF EXISTS project_bindings",
            "DROP TABLE IF EXISTS project_scans",
            "DROP TABLE IF EXISTS local_projects",
            "DROP TABLE IF EXISTS ai_candidates",
            "DROP TABLE IF EXISTS ai_usage_events",
            "DROP TABLE IF EXISTS model_routes",
            "DROP TABLE IF EXISTS model_connections",
        ] {
            sqlx::query(statement).execute(&mut *transaction).await?;
        }
        transaction.commit().await?;
        Ok(())
    }
}

fn deserialize_payloads<T: for<'de> Deserialize<'de>>(
    rows: Vec<sqlx::sqlite::SqliteRow>,
) -> Result<Vec<T>, SnapshotStoreError> {
    rows.into_iter()
        .map(|row| serde_json::from_str(row.get("payload_json")).map_err(Into::into))
        .collect()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use schema_diff::diff_snapshots;
    use schema_model::{DataSourceProfile, DatabaseInfo, DatabaseType, ObjectKey, SslMode};
    use semantic_model::{CanvasPosition, DomainGroup, ObjectAnnotation};
    use std::collections::BTreeMap;

    use super::*;

    fn profile(source_id: Uuid) -> DataSourceProfile {
        let now = Utc::now();
        DataSourceProfile {
            id: source_id,
            display_name: "Imported".into(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            username: "developer".into(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Prefer,
            created_at: now,
            updated_at: now,
        }
    }

    fn snapshot(source_id: Uuid, name: &str) -> DatabaseSnapshot {
        let mut snapshot = DatabaseSnapshot::new(
            source_id,
            DatabaseInfo {
                name: name.into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            Vec::new(),
        );
        snapshot.captured_at = Utc::now();
        snapshot.canonicalize().unwrap();
        snapshot
    }

    #[tokio::test]
    async fn stores_each_source_fingerprint_once() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let first = snapshot(source_id, "app");
        let mut duplicate = first.clone();
        duplicate.id = Uuid::new_v4();

        assert!(store.save_snapshot(&first).await.unwrap());
        assert!(!store.save_snapshot(&duplicate).await.unwrap());

        let snapshots = store.list_snapshots(source_id).await.unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(store.get_snapshot(first.id).await.unwrap(), Some(first));
    }

    #[tokio::test]
    async fn portable_import_rolls_back_every_record_on_reference_failure() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let only_snapshot = snapshot(source_id, "after");
        let broken_change = SchemaChangeSet {
            id: Uuid::new_v4(),
            before_snapshot_id: Uuid::new_v4(),
            after_snapshot_id: only_snapshot.id,
            created_at: Utc::now(),
            operations: Vec::new(),
            risk_summary: schema_diff::RiskSummary::default(),
        };
        let bundle = PortableModelBackup {
            format_version: 1,
            exported_at: Utc::now().to_rfc3339(),
            source_id,
            source_profile: Some(profile(source_id)),
            source_settings: DataSourceSettings::defaults_for(source_id),
            snapshots: vec![only_snapshot],
            change_sets: vec![broken_change],
            annotations: Vec::new(),
            domain_groups: Vec::new(),
            saved_views: Vec::new(),
            layouts: Vec::new(),
            provenance: Vec::new(),
            lineage: Vec::new(),
            logical_relationships: Vec::new(),
            ignored_relationship_inferences: Vec::new(),
        };

        assert!(store.import_portable_model(&bundle).await.is_err());
        assert_eq!(store.get_data_source(source_id).await.unwrap(), None);
        assert!(store.list_snapshots(source_id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn upgrades_a_legacy_file_and_keeps_a_pre_migration_backup() {
        let root = std::env::temp_dir().join(format!("nodalstudio-migration-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("model.sqlite3");
        let options = SqliteConnectOptions::new()
            .filename(&database)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE legacy_marker (value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO legacy_marker (value) VALUES ('preserved')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE local_projects (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE project_nodes (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE model_connections (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let store = LocalSnapshotStore::open_path(&database).await.unwrap();
        let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let marker = sqlx::query_scalar::<_, String>("SELECT value FROM legacy_marker")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let retired_tables = sqlx::query_scalar::<_, String>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('local_projects', 'project_nodes', 'model_connections')",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(version, LOCAL_SCHEMA_VERSION);
        assert_eq!(marker, "preserved");
        assert!(retired_tables.is_empty());
        assert!(database.with_extension("pre-v0.bak").exists());
        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn prunes_snapshot_history_by_count_but_keeps_the_latest() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        for (index, name) in ["first", "second", "third"].into_iter().enumerate() {
            let mut value = snapshot(source_id, name);
            value.captured_at =
                Utc::now() + chrono::Duration::seconds(i64::try_from(index).unwrap());
            store.save_snapshot(&value).await.unwrap();
        }

        assert_eq!(
            store
                .prune_snapshots(source_id, Some(1), None, false)
                .await
                .unwrap(),
            2
        );
        assert_eq!(store.list_snapshots(source_id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn stores_profiles_without_credentials() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let now = Utc::now();
        let profile = DataSourceProfile {
            id: Uuid::new_v4(),
            display_name: "Local development".into(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            username: "developer".into(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Prefer,
            created_at: now,
            updated_at: now,
        };

        store.save_data_source(&profile).await.unwrap();

        assert_eq!(
            store.get_data_source(profile.id).await.unwrap(),
            Some(profile)
        );
    }

    #[tokio::test]
    async fn persists_versioned_global_source_and_policy_settings() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        assert_eq!(
            store.get_app_settings().await.unwrap(),
            AppSettings::default()
        );
        assert_eq!(
            store.get_data_source_settings(source_id).await.unwrap(),
            DataSourceSettings::defaults_for(source_id)
        );

        let mut app = AppSettings::default();
        app.privacy.offline_mode = true;
        let mut source = DataSourceSettings::defaults_for(source_id);
        source.git.repository_path = "/workspace/project".into();
        let policy = OrganizationPolicy {
            version: 4,
            source: "Security team".into(),
            force_offline: true,
            ..OrganizationPolicy::default()
        };

        store.save_app_settings(&app).await.unwrap();
        store.save_data_source_settings(&source).await.unwrap();
        store.save_organization_policy(&policy).await.unwrap();
        let project = ProjectSettings::defaults_for("project-1");
        store.save_project_settings(&project).await.unwrap();

        assert_eq!(store.get_app_settings().await.unwrap(), app);
        assert_eq!(
            store.get_data_source_settings(source_id).await.unwrap(),
            source
        );
        assert_eq!(store.get_organization_policy().await.unwrap(), policy);
        assert_eq!(
            store.get_project_settings("project-1").await.unwrap(),
            Some(project)
        );
        let usage = store.storage_usage().await.unwrap();
        assert!(usage.settings_bytes > 0);
        assert_eq!(usage.snapshot_count, 0);
    }

    #[tokio::test]
    async fn persists_change_sets_between_saved_snapshots() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let before = snapshot(source_id, "app-before");
        let after = snapshot(source_id, "app-after");
        store.save_snapshot(&before).await.unwrap();
        store.save_snapshot(&after).await.unwrap();
        let changes = diff_snapshots(&before, &after);

        store.save_change_set(&changes).await.unwrap();

        assert_eq!(
            store.change_sets_for_snapshot(after.id).await.unwrap(),
            vec![changes]
        );
    }

    #[tokio::test]
    async fn persists_semantic_metadata_separately_from_snapshots() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let now = Utc::now();
        let annotation = ObjectAnnotation {
            source_id,
            object_key: ObjectKey::table("public", "users"),
            description: Some("User accounts".into()),
            tags: vec!["identity".into()],
            owner: Some("platform".into()),
            is_core: true,
            updated_at: now,
        };
        let group = DomainGroup {
            id: Uuid::new_v4(),
            source_id,
            name: "Identity".into(),
            description: None,
            color: "#77e08a".into(),
            table_keys: vec![ObjectKey::table("public", "users")],
            updated_at: now,
        };
        let layout = CanvasLayout {
            source_id,
            view_id: None,
            positions: BTreeMap::from([(
                "public.users".into(),
                CanvasPosition {
                    x: 12.0,
                    y: 24.0,
                    width: None,
                    height: None,
                },
            )]),
            updated_at: now,
        };

        store.save_annotation(&annotation).await.unwrap();
        store.save_domain_group(&group).await.unwrap();
        store.save_layout(&layout).await.unwrap();

        assert_eq!(
            store.list_annotations(source_id).await.unwrap(),
            [annotation]
        );
        assert_eq!(store.list_domain_groups(source_id).await.unwrap(), [group]);
        assert_eq!(
            store.get_layout(source_id, None).await.unwrap(),
            Some(layout)
        );
    }

    #[tokio::test]
    async fn queues_sync_events_idempotently_and_records_conflicts() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let event = SyncQueueItem {
            id: Uuid::new_v4(),
            source_id: Uuid::new_v4(),
            event_kind: "bundle.sync".into(),
            idempotency_key: "source:fingerprint".into(),
            payload: serde_json::json!({ "fingerprint": "abc" }),
            base_version: 2,
            attempts: 0,
            state: "pending".into(),
            created_at: Utc::now().to_rfc3339(),
        };
        store.enqueue_sync(&event).await.unwrap();
        store.enqueue_sync(&event).await.unwrap();
        assert_eq!(
            store.pending_sync().await.unwrap(),
            std::slice::from_ref(&event)
        );

        store.update_sync_state(event.id, "conflict").await.unwrap();
        let queued = store.pending_sync().await.unwrap();
        assert_eq!(queued[0].state, "conflict");
        assert_eq!(queued[0].attempts, 1);
    }

    #[tokio::test]
    async fn cloud_sync_acknowledges_only_the_frozen_event_batch() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let event = |suffix: &str| SyncQueueItem {
            id: Uuid::new_v4(),
            source_id,
            event_kind: "annotation.save".into(),
            idempotency_key: format!("{source_id}:{suffix}"),
            payload: serde_json::json!({ "value": suffix }),
            base_version: 0,
            attempts: 0,
            state: "pending".into(),
            created_at: Utc::now().to_rfc3339(),
        };
        let frozen = event("frozen");
        let later = event("later");
        store.enqueue_sync(&frozen).await.unwrap();
        store.enqueue_sync(&later).await.unwrap();

        assert_eq!(
            store
                .complete_cloud_sync(source_id, &[frozen.id], 7, "2026-07-12T00:00:00Z")
                .await
                .unwrap(),
            1
        );
        assert_eq!(store.pending_sync().await.unwrap(), [later]);
        let settings = store.get_data_source_settings(source_id).await.unwrap();
        assert_eq!(settings.cloud.base_version, 7);
        assert_eq!(
            settings.cloud.last_success_at.as_deref(),
            Some("2026-07-12T00:00:00Z")
        );
    }

    #[tokio::test]
    async fn persists_provenance_and_code_lineage() {
        use extension_model::{ChangeProvenance, CodeLineageLink, LineageConfidence};

        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let provenance = ChangeProvenance {
            change_set_id: Uuid::new_v4(),
            branch: Some("main".into()),
            commit_sha: Some("abc".into()),
            pull_request_url: None,
            migration_files: vec!["001_init.sql".into()],
            recorded_at: Utc::now(),
        };
        let lineage = CodeLineageLink {
            object_key: ObjectKey::table("public", "users"),
            language: "Rust".into(),
            framework: "SQLx".into(),
            symbol: "User".into(),
            file_path: "src/user.rs".into(),
            line: Some(12),
            confidence: LineageConfidence::Declared,
        };
        store.save_change_provenance(&provenance).await.unwrap();
        store
            .replace_lineage(source_id, std::slice::from_ref(&lineage))
            .await
            .unwrap();
        assert_eq!(
            store
                .get_change_provenance(provenance.change_set_id)
                .await
                .unwrap(),
            Some(provenance)
        );
        assert_eq!(store.list_lineage(source_id).await.unwrap(), [lineage]);
    }

    #[tokio::test]
    async fn previews_source_deletion_counts_and_bytes() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let model = snapshot(source_id, "app");
        store.save_snapshot(&model).await.unwrap();
        store
            .save_annotation(&ObjectAnnotation {
                source_id,
                object_key: ObjectKey::table("public", "users"),
                description: Some("Accounts".into()),
                tags: vec![],
                owner: None,
                is_core: false,
                updated_at: Utc::now(),
            })
            .await
            .unwrap();
        store
            .enqueue_sync(&SyncQueueItem {
                id: Uuid::new_v4(),
                source_id,
                event_kind: "annotation.save".into(),
                idempotency_key: "impact-test".into(),
                payload: serde_json::json!({ "kind": "annotation" }),
                base_version: 0,
                attempts: 0,
                state: "pending".into(),
                created_at: Utc::now().to_rfc3339(),
            })
            .await
            .unwrap();

        let impact = store.source_data_impact(source_id).await.unwrap();
        assert_eq!(impact.snapshot_records, 1);
        assert_eq!(impact.semantic_records, 1);
        assert_eq!(impact.pending_sync_records, 1);
        assert!(impact.snapshot_bytes > 0);
        assert!(impact.semantic_bytes > 0);
        assert!(impact.sync_queue_bytes > 0);
        assert_eq!(
            impact.estimated_bytes,
            impact.snapshot_bytes + impact.semantic_bytes + impact.sync_queue_bytes
        );
    }

    #[tokio::test]
    async fn retains_and_clears_local_query_history() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let first = QueryHistoryEntry {
            id: Uuid::new_v4(),
            source_id,
            executed_at: "2026-07-12T01:00:00Z".into(),
            sql_text: "SELECT 1".into(),
            duration_ms: 5,
            row_count: 1,
            status: "succeeded".into(),
            error_kind: None,
        };
        let second = QueryHistoryEntry {
            id: Uuid::new_v4(),
            source_id,
            executed_at: "2026-07-12T02:00:00Z".into(),
            sql_text: "SELECT 2".into(),
            duration_ms: 8,
            row_count: 1,
            status: "failed".into(),
            error_kind: Some("database".into()),
        };
        store.save_query_history(&first).await.unwrap();
        store.save_query_history(&second).await.unwrap();
        assert_eq!(
            store.list_query_history(source_id, 100).await.unwrap(),
            [second.clone(), first.clone()]
        );
        assert!(
            store
                .delete_query_history(source_id, second.id)
                .await
                .unwrap()
        );
        assert_eq!(
            store.list_query_history(source_id, 100).await.unwrap(),
            [first]
        );
        assert_eq!(store.clear_query_history(source_id).await.unwrap(), 1);
        assert!(
            store
                .list_query_history(source_id, 100)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn persists_and_isolates_logical_relationships_and_ignored_candidates() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source_id = Uuid::new_v4();
        let other_source = Uuid::new_v4();
        let now = Utc::now();
        let relationship = LogicalRelationship {
            id: Uuid::new_v4(),
            source_id,
            name: "orders_owner".into(),
            source: schema_model::RelationshipEndpoint::new(
                "public",
                "orders",
                vec!["user_id".into()],
            ),
            target: schema_model::RelationshipEndpoint::new("public", "users", vec!["id".into()]),
            cardinality: schema_model::RelationshipCardinality::ManyToOne,
            status: schema_model::LogicalRelationshipStatus::Active,
            origin: schema_model::LogicalRelationshipOrigin::Manual,
            note: None,
            evidence: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        store
            .save_logical_relationship(&relationship)
            .await
            .unwrap();
        let stored = store.list_logical_relationships(source_id).await.unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0], relationship);
        let mut duplicate = relationship.clone();
        duplicate.id = Uuid::new_v4();
        assert!(store.save_logical_relationship(&duplicate).await.is_err());
        assert!(
            store
                .list_logical_relationships(other_source)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            !store
                .delete_logical_relationship(other_source, relationship.id)
                .await
                .unwrap()
        );

        let ignored = IgnoredRelationshipInference {
            source_id,
            relationship_key: relationship.relationship_key(),
            ignored_at: now,
        };
        store
            .save_ignored_relationship_inference(&ignored)
            .await
            .unwrap();
        assert_eq!(
            store
                .list_ignored_relationship_inferences(source_id)
                .await
                .unwrap(),
            [ignored]
        );
        assert!(
            store
                .delete_logical_relationship(source_id, relationship.id)
                .await
                .unwrap()
        );
    }
}
