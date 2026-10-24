//! Atomic, device-local review batches with guarded, durable undo.
use crate::{LocalSnapshotStore, SnapshotStoreError, deserialize_payloads};
use chrono::Utc;
use schema_model::{
    DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship, LogicalRelationshipOrigin,
    LogicalRelationshipStatus, RelationshipCardinality, RelationshipEndpoint, TableDefinition,
};
use semantic_model::knowledge::digest;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Sqlite, Transaction};
use std::collections::BTreeSet;
use uuid::Uuid;

type Result<T> = std::result::Result<T, SnapshotStoreError>;
fn conflict(message: &str) -> SnapshotStoreError {
    SnapshotStoreError::ReviewConflict(message.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewAction {
    Confirm,
    Ignore,
    Restore,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntry {
    pub key: String,
    pub source: Option<RelationshipEndpoint>,
    pub target: Option<RelationshipEndpoint>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub source_id: Uuid,
    pub snapshot_id: Uuid,
    pub action: ReviewAction,
    pub entries: Vec<ReviewEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCheck {
    pub entry: ReviewEntry,
    pub reason: Option<String>,
    pub cardinality: RelationshipCardinality,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPreview {
    pub revision: String,
    pub checks: Vec<ReviewCheck>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReviewBatch {
    pub request: ReviewRequest,
    pub revision: String,
    pub batch_id: Uuid,
    pub approved_keys: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBatch {
    pub id: Uuid,
    pub source_id: Uuid,
    pub action: ReviewAction,
    pub created_at: String,
    pub keys: Vec<String>,
    pub undone_at: Option<String>,
    pub skipped_keys: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredChange {
    key: String,
    item_id: String,
    logical: bool,
    before: Option<Value>,
    after: Option<Value>,
    version: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBatch {
    summary: ReviewBatch,
    request_digest: String,
    changes: Vec<StoredChange>,
}
struct Model {
    snapshot: DatabaseSnapshot,
    relationships: Vec<LogicalRelationship>,
    ignored: Vec<IgnoredRelationshipInference>,
    revision: String,
}

impl LocalSnapshotStore {
    pub(super) async fn initialize_relationship_batches(&self) -> Result<()> {
        sqlx::query("CREATE TABLE IF NOT EXISTS relationship_review_batches (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL)").execute(&self.pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS relationship_review_batches_source ON relationship_review_batches(source_id, created_at DESC)").execute(&self.pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS relationship_review_versions (source_id TEXT NOT NULL, item_key TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(source_id,item_key))").execute(&self.pool).await?;
        // Cover every writer, including individual edits, imports, and delete/recreate cycles.
        for (table, column, prefix) in [
            ("logical_relationships", "id", "logical:"),
            (
                "ignored_relationship_inferences",
                "relationship_key",
                "ignored:",
            ),
        ] {
            for (event, record) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
                sqlx::query(sqlx::AssertSqlSafe(format!("CREATE TRIGGER IF NOT EXISTS review_version_{table}_{event} AFTER {event} ON {table} BEGIN INSERT INTO relationship_review_versions(source_id,item_key,version) VALUES ({record}.source_id,'{prefix}' || {record}.{column},1) ON CONFLICT(source_id,item_key) DO UPDATE SET version=version+1; END"))).execute(&self.pool).await?;
            }
        }
        Ok(())
    }

    /// Check the whole selection against one consistent local model.
    /// # Errors
    /// Rejects stale snapshots, invalid selections, or storage errors.
    pub async fn preview_relationship_batch(
        &self,
        request: &ReviewRequest,
    ) -> Result<ReviewPreview> {
        let mut tx = self.pool.begin().await?;
        let model = model_in(&mut tx, request).await?;
        let preview = preview(request, &model)?;
        tx.commit().await?;
        Ok(preview)
    }

    /// Save an approved subset and its undo record in one transaction. Retries are idempotent.
    /// # Errors
    /// Rejects changed evidence, risky mappings, reused operation ids, and database failures.
    pub async fn apply_relationship_batch(&self, input: &ApplyReviewBatch) -> Result<ReviewBatch> {
        let mut tx = self.pool.begin().await?;
        let request_digest = digest(input);
        if let Some(stored) = batch_in(&mut tx, input.request.source_id, input.batch_id).await? {
            if stored.request_digest != request_digest {
                return Err(conflict(
                    "This batch id belongs to a different selection. Preview again.",
                ));
            }
            return Ok(stored.summary);
        }
        let model = model_in(&mut tx, &input.request).await?;
        let checked = preview(&input.request, &model)?;
        if checked.revision != input.revision {
            return Err(conflict(
                "The model changed after preview. Refresh the preview before applying this batch.",
            ));
        }
        let approved: BTreeSet<_> = input.approved_keys.iter().collect();
        if approved.is_empty()
            || approved.len() != input.approved_keys.len()
            || approved.iter().any(|key| {
                !checked
                    .checks
                    .iter()
                    .any(|check| &check.entry.key == *key && check.reason.is_none())
            })
        {
            return Err(conflict(
                "The selection contains candidates requiring individual review. Refresh the preview.",
            ));
        }
        let now = Utc::now();
        let mut changes = Vec::new();
        for check in checked
            .checks
            .iter()
            .filter(|check| approved.contains(&check.entry.key))
        {
            let mut change = plan_change(
                input.request.action,
                input.request.source_id,
                check,
                &model,
                now,
            )?;
            write_item(
                &mut tx,
                input.request.source_id,
                &change.item_id,
                change.logical,
                change.after.as_ref(),
                &input.batch_id.to_string(),
            )
            .await?;
            change.version = version_in(
                &mut tx,
                input.request.source_id,
                &change.item_id,
                change.logical,
            )
            .await?;
            changes.push(change);
        }
        let summary = ReviewBatch {
            id: input.batch_id,
            source_id: input.request.source_id,
            action: input.request.action,
            created_at: now.to_rfc3339(),
            keys: changes.iter().map(|change| change.key.clone()).collect(),
            undone_at: None,
            skipped_keys: Vec::new(),
        };
        save_batch(
            &mut tx,
            &StoredBatch {
                summary: summary.clone(),
                request_digest,
                changes,
            },
        )
        .await?;
        tx.commit().await?;
        Ok(summary)
    }

    /// Returns durable local review history, newest first.
    /// # Errors
    /// Returns storage or decoding errors.
    pub async fn list_relationship_batches(&self, source: Uuid) -> Result<Vec<ReviewBatch>> {
        let rows = sqlx::query("SELECT payload_json FROM relationship_review_batches WHERE source_id=? ORDER BY created_at DESC").bind(source.to_string()).fetch_all(&self.pool).await?;
        let batches: Vec<StoredBatch> = deserialize_payloads(rows)?;
        Ok(batches.into_iter().map(|batch| batch.summary).collect())
    }

    /// Undo only unchanged items. A later edit or delete/recreate is never overwritten.
    /// # Errors
    /// Rejects missing batches or database failures; all applicable reversals are atomic.
    pub async fn undo_relationship_batch(&self, source: Uuid, id: Uuid) -> Result<ReviewBatch> {
        let mut tx = self.pool.begin().await?;
        let mut batch = batch_in(&mut tx, source, id)
            .await?
            .ok_or_else(|| conflict("This review batch is unavailable for this data source."))?;
        if batch.summary.undone_at.is_some() {
            return Ok(batch.summary);
        }
        for change in &batch.changes {
            let table = if change.logical {
                "logical_relationships"
            } else {
                "ignored_relationship_inferences"
            };
            let column = if change.logical {
                "id"
            } else {
                "relationship_key"
            };
            let current: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT payload_json FROM {table} WHERE source_id=? AND {column}=?"
            )))
            .bind(source.to_string())
            .bind(&change.item_id)
            .fetch_optional(&mut *tx)
            .await?;
            let current: Option<Value> = current
                .map(|value| serde_json::from_str(&value))
                .transpose()?;
            if current != change.after
                || version_in(&mut tx, source, &change.item_id, change.logical).await?
                    != change.version
            {
                batch.summary.skipped_keys.push(change.key.clone());
                continue;
            }
            write_item(
                &mut tx,
                source,
                &change.item_id,
                change.logical,
                change.before.as_ref(),
                &format!("undo:{id}"),
            )
            .await?;
        }
        batch.summary.undone_at = Some(Utc::now().to_rfc3339());
        save_batch(&mut tx, &batch).await?;
        tx.commit().await?;
        Ok(batch.summary)
    }
}

fn plan_change(
    action: ReviewAction,
    source_id: Uuid,
    check: &ReviewCheck,
    model: &Model,
    now: chrono::DateTime<Utc>,
) -> Result<StoredChange> {
    let key = check.entry.key.clone();
    let (item_id, logical, before, after) = match action {
        ReviewAction::Confirm => {
            let source = check
                .entry
                .source
                .clone()
                .ok_or_else(|| conflict("Missing source mapping."))?;
            let target = check
                .entry
                .target
                .clone()
                .ok_or_else(|| conflict("Missing target mapping."))?;
            let mut relationship = LogicalRelationship {
                id: Uuid::new_v4(),
                source_id,
                name: format!(
                    "{}_{}_{}_{}",
                    source.table,
                    source.columns.join("_"),
                    target.table,
                    target.columns.join("_")
                )
                .chars()
                .take(160)
                .collect(),
                source,
                target,
                cardinality: check.cardinality,
                status: LogicalRelationshipStatus::Active,
                origin: LogicalRelationshipOrigin::ConfirmedInference,
                note: None,
                evidence: vec![
                    "Naming candidate reviewed in a batch".into(),
                    "Matching types and signedness; unique target; no competing logical target"
                        .into(),
                ],
                created_at: now,
                updated_at: now,
            };
            relationship.canonicalize();
            (
                relationship.id.to_string(),
                true,
                None,
                Some(serde_json::to_value(relationship)?),
            )
        }
        ReviewAction::Ignore => (
            key.clone(),
            false,
            None,
            Some(serde_json::to_value(IgnoredRelationshipInference {
                source_id,
                relationship_key: key.clone(),
                ignored_at: now,
            })?),
        ),
        ReviewAction::Restore => {
            let old = model
                .ignored
                .iter()
                .find(|entry| entry.relationship_key == key)
                .ok_or_else(|| conflict("This ignore entry changed. Refresh the preview."))?;
            (key.clone(), false, Some(serde_json::to_value(old)?), None)
        }
    };
    Ok(StoredChange {
        key,
        item_id,
        logical,
        before,
        after,
        version: 0,
    })
}

async fn model_in(tx: &mut Transaction<'_, Sqlite>, request: &ReviewRequest) -> Result<Model> {
    if request.entries.is_empty() || request.entries.len() > 5000 {
        return Err(conflict(
            "Select between 1 and 5,000 candidates for this batch.",
        ));
    }
    let raw: Option<String> = sqlx::query_scalar("SELECT payload_json FROM schema_snapshots WHERE source_id=? ORDER BY captured_at DESC LIMIT 1").bind(request.source_id.to_string()).fetch_optional(&mut **tx).await?;
    let snapshot: DatabaseSnapshot = serde_json::from_str(
        &raw.ok_or_else(|| conflict("Capture a schema before reviewing candidates."))?,
    )?;
    if snapshot.id != request.snapshot_id {
        return Err(conflict(
            "The schema snapshot changed. Reopen the latest model before reviewing this batch.",
        ));
    }
    let relationships: Vec<LogicalRelationship> = deserialize_payloads(
        sqlx::query("SELECT payload_json FROM logical_relationships WHERE source_id=? ORDER BY id")
            .bind(request.source_id.to_string())
            .fetch_all(&mut **tx)
            .await?,
    )?;
    let ignored: Vec<IgnoredRelationshipInference> = deserialize_payloads(sqlx::query("SELECT payload_json FROM ignored_relationship_inferences WHERE source_id=? ORDER BY relationship_key").bind(request.source_id.to_string()).fetch_all(&mut **tx).await?)?;
    let profile: Option<String> =
        sqlx::query_scalar("SELECT payload_json FROM data_sources WHERE id=?")
            .bind(request.source_id.to_string())
            .fetch_optional(&mut **tx)
            .await?;
    let versions: Vec<(String, i64)> = sqlx::query_as("SELECT item_key,version FROM relationship_review_versions WHERE source_id=? ORDER BY item_key").bind(request.source_id.to_string()).fetch_all(&mut **tx).await?;
    let revision = digest(&(
        request,
        &snapshot.id,
        &snapshot.fingerprint,
        &profile,
        &relationships,
        &ignored,
        &versions,
    ));
    Ok(Model {
        snapshot,
        relationships,
        ignored,
        revision,
    })
}
fn table_at<'a>(
    snapshot: &'a DatabaseSnapshot,
    endpoint: &RelationshipEndpoint,
) -> Option<&'a TableDefinition> {
    snapshot
        .schemas
        .iter()
        .find(|schema| schema.name == endpoint.schema)?
        .tables
        .iter()
        .find(|table| table.key.name == endpoint.table)
}
fn unique(table: &TableDefinition, columns: &[String]) -> bool {
    table
        .primary_key
        .as_ref()
        .is_some_and(|key| key.columns == columns)
        || table
            .indexes
            .iter()
            .any(|index| index.unique && index.predicate.is_none() && index.columns == columns)
}
fn confirmation_check(
    entry: &ReviewEntry,
    model: &Model,
) -> (Option<String>, RelationshipCardinality) {
    let blocked = |reason: &str| (Some(reason.into()), RelationshipCardinality::Unspecified);
    let (Some(source), Some(target)) = (&entry.source, &entry.target) else {
        return blocked("Missing field mapping");
    };
    if source.columns.len() != 1 || target.columns.len() != 1 || source == target {
        return blocked("Review this field mapping individually");
    }
    if source.schema != target.schema {
        return blocked("Cross-schema mapping requires individual review");
    }
    if entry.key != format!("{}->{}", source.display_key(), target.display_key()) {
        return blocked("The candidate key no longer matches its fields");
    }
    let (Some(left), Some(right)) = (
        table_at(&model.snapshot, source),
        table_at(&model.snapshot, target),
    ) else {
        return blocked("A table no longer exists");
    };
    let (Some(a), Some(b)) = (
        left.columns.iter().find(|c| c.name == source.columns[0]),
        right.columns.iter().find(|c| c.name == target.columns[0]),
    ) else {
        return blocked("A field no longer exists");
    };
    let unsigned = |value: &str| {
        value
            .split_whitespace()
            .any(|part| part.eq_ignore_ascii_case("unsigned"))
    };
    if !a.type_name.eq_ignore_ascii_case(&b.type_name)
        || !a.type_schema.eq_ignore_ascii_case(&b.type_schema)
        || unsigned(&a.formatted_type) != unsigned(&b.formatted_type)
    {
        return blocked("Column types or signedness differ");
    }
    if !unique(right, &target.columns) {
        return blocked("The target is not independently unique");
    }
    if left
        .foreign_keys
        .iter()
        .any(|key| key.columns.contains(&a.name))
    {
        return blocked("This field already participates in a physical foreign key");
    }
    if model.relationships.iter().any(|r| {
        r.relationship_key() == entry.key
            || (r.source.schema == source.schema
                && r.source.table == source.table
                && r.source.columns.contains(&a.name)
                && r.status != LogicalRelationshipStatus::Orphaned)
    }) {
        return blocked("This source field already has a logical relationship");
    }
    let rule = format!(
        "rule:naming-id:{}.{}.{}",
        source.schema, source.table, a.name
    );
    if model
        .ignored
        .iter()
        .any(|i| i.relationship_key == entry.key || i.relationship_key == rule)
    {
        return blocked("This candidate is currently ignored");
    }
    let Some(stem) = a.name.strip_suffix("_id") else {
        return blocked("This naming pattern needs individual review");
    };
    if b.name != "id" || !unambiguous_target(model, stem, target) {
        return blocked("The naming target is ambiguous or requires contextual review");
    }
    (
        None,
        if unique(left, &source.columns) {
            RelationshipCardinality::OneToOne
        } else {
            RelationshipCardinality::ManyToOne
        },
    )
}
fn unambiguous_target(model: &Model, stem: &str, target: &RelationshipEndpoint) -> bool {
    let plural = stem
        .strip_suffix('y')
        .map_or_else(|| format!("{stem}s"), |base| format!("{base}ies"));
    let matches: Vec<_> = model
        .snapshot
        .schemas
        .iter()
        .flat_map(|s| &s.tables)
        .filter(|t| {
            t.primary_key
                .as_ref()
                .is_some_and(|key| key.columns.iter().any(|c| c == "id"))
                && (t.key.name == stem
                    || t.key.name == plural
                    || t.key.name.ends_with(&format!("_{stem}"))
                    || t.key.name.ends_with(&format!("_{plural}")))
        })
        .collect();
    [stem, plural.as_str()].contains(&target.table.as_str()) && matches.len() == 1
}
fn preview(request: &ReviewRequest, model: &Model) -> Result<ReviewPreview> {
    let mut seen = BTreeSet::new();
    let mut checks = Vec::new();
    for entry in &request.entries {
        if entry.key.is_empty() || entry.key.len() > 1000 || !seen.insert(&entry.key) {
            return Err(conflict(
                "The batch contains an invalid or duplicate candidate key.",
            ));
        }
        let (mut reason, cardinality) = match request.action {
            ReviewAction::Confirm => confirmation_check(entry, model),
            ReviewAction::Ignore => (
                if entry.key.starts_with("rule:") {
                    Some("Bulk ignore applies only to individual candidates".into())
                } else if model
                    .ignored
                    .iter()
                    .any(|i| i.relationship_key == entry.key)
                {
                    Some("Already ignored".into())
                } else {
                    None
                },
                RelationshipCardinality::Unspecified,
            ),
            ReviewAction::Restore => (
                if model
                    .ignored
                    .iter()
                    .any(|i| i.relationship_key == entry.key)
                {
                    None
                } else {
                    Some("This entry is no longer ignored".into())
                },
                RelationshipCardinality::Unspecified,
            ),
        };
        if request.action == ReviewAction::Confirm
            && request
                .entries
                .iter()
                .any(|other| other.key != entry.key && other.source == entry.source)
        {
            reason = Some("Multiple selected candidates share this source field".into());
        }
        checks.push(ReviewCheck {
            entry: entry.clone(),
            reason,
            cardinality,
        });
    }
    Ok(ReviewPreview {
        revision: model.revision.clone(),
        checks,
    })
}
async fn batch_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
    id: Uuid,
) -> Result<Option<StoredBatch>> {
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload_json FROM relationship_review_batches WHERE source_id=? AND id=?",
    )
    .bind(source.to_string())
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await?;
    payload
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}
async fn save_batch(tx: &mut Transaction<'_, Sqlite>, batch: &StoredBatch) -> Result<()> {
    let affected = sqlx::query("INSERT INTO relationship_review_batches(id,source_id,created_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json WHERE source_id=excluded.source_id")
        .bind(batch.summary.id.to_string()).bind(batch.summary.source_id.to_string()).bind(&batch.summary.created_at).bind(serde_json::to_string(batch)?).execute(&mut **tx).await?.rows_affected();
    if affected != 1 {
        return Err(conflict("This batch id belongs to another data source."));
    }
    Ok(())
}
async fn version_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
    id: &str,
    logical: bool,
) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT version FROM relationship_review_versions WHERE source_id=? AND item_key=?",
    )
    .bind(source.to_string())
    .bind(format!(
        "{}:{id}",
        if logical { "logical" } else { "ignored" }
    ))
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or(0))
}
async fn write_item(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
    id: &str,
    logical: bool,
    value: Option<&Value>,
    operation: &str,
) -> Result<()> {
    let (kind, payload) = if logical {
        if let Some(value) = value {
            let relationship: LogicalRelationship = serde_json::from_value(value.clone())?;
            sqlx::query("INSERT INTO logical_relationships(id,source_id,relationship_key,status,updated_at,payload_json) VALUES(?,?,?,?,?,?)")
                .bind(id).bind(source.to_string()).bind(relationship.relationship_key()).bind("active").bind(relationship.updated_at.to_rfc3339()).bind(serde_json::to_string(value)?).execute(&mut **tx).await?;
            ("logical_relationship.save", value.clone())
        } else {
            sqlx::query("DELETE FROM logical_relationships WHERE source_id=? AND id=?")
                .bind(source.to_string())
                .bind(id)
                .execute(&mut **tx)
                .await?;
            ("logical_relationship.delete", json!({"relationshipId":id}))
        }
    } else if let Some(value) = value {
        let ignored: IgnoredRelationshipInference = serde_json::from_value(value.clone())?;
        sqlx::query("INSERT INTO ignored_relationship_inferences(source_id,relationship_key,ignored_at,payload_json) VALUES(?,?,?,?)")
            .bind(source.to_string()).bind(id).bind(ignored.ignored_at.to_rfc3339()).bind(serde_json::to_string(value)?).execute(&mut **tx).await?;
        ("logical_relationship.ignore_inference", value.clone())
    } else {
        sqlx::query(
            "DELETE FROM ignored_relationship_inferences WHERE source_id=? AND relationship_key=?",
        )
        .bind(source.to_string())
        .bind(id)
        .execute(&mut **tx)
        .await?;
        (
            "logical_relationship.restore_inference",
            json!({"sourceId":source,"relationshipKey":id}),
        )
    };
    sqlx::query("INSERT INTO sync_queue(id,source_id,event_kind,idempotency_key,payload_json,base_version,attempts,state,created_at) VALUES(?,?,?,?,?,0,0,'pending',?)")
        .bind(Uuid::new_v4().to_string()).bind(source.to_string()).bind(kind).bind(format!("review:{operation}:{kind}:{id}")).bind(serde_json::to_string(&payload)?).bind(Utc::now().to_rfc3339()).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{
        ColumnDefinition, DatabaseInfo, DatabaseType, PrimaryKeyDefinition, SchemaDefinition,
    };
    fn column(name: &str) -> ColumnDefinition {
        ColumnDefinition {
            name: name.into(),
            ordinal_position: 1,
            formatted_type: "int unsigned".into(),
            type_schema: String::new(),
            type_name: "int".into(),
            nullable: false,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        }
    }
    fn table(name: &str, fields: &[&str]) -> TableDefinition {
        let mut table = TableDefinition::empty("app", name);
        table.columns = fields.iter().map(|name| column(name)).collect();
        table.primary_key = Some(PrimaryKeyDefinition {
            name: format!("{name}_pk"),
            columns: vec!["id".into()],
        });
        table
    }
    fn fixture() -> DatabaseSnapshot {
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "fixture".into(),
                database_type: DatabaseType::MySql,
                version: "8".into(),
            },
            vec![SchemaDefinition {
                programs: Vec::new(),
                dependencies: Vec::new(),
                name: "app".into(),
                tables: vec![
                    table("orders", &["id", "customer_id"]),
                    table("customers", &["id"]),
                    table("items", &["id", "order_id"]),
                    table("payments", &["id", "order_id"]),
                ],
                views: vec![],
                enums: vec![],
            }],
        );
        snapshot.schemas[0].tables[3].columns[1].formatted_type = "int".into();
        snapshot.canonicalize().unwrap();
        snapshot
    }
    fn entry(source: &str, field: &str, target: &str) -> ReviewEntry {
        let source = RelationshipEndpoint::new("app", source, vec![field.into()]);
        let target = RelationshipEndpoint::new("app", target, vec!["id".into()]);
        ReviewEntry {
            key: format!("{}->{}", source.display_key(), target.display_key()),
            source: Some(source),
            target: Some(target),
        }
    }
    fn request(snapshot: &DatabaseSnapshot, action: ReviewAction) -> ReviewRequest {
        ReviewRequest {
            source_id: snapshot.source_id,
            snapshot_id: snapshot.id,
            action,
            entries: vec![
                entry("orders", "customer_id", "customers"),
                entry("items", "order_id", "orders"),
                entry("payments", "order_id", "orders"),
            ],
        }
    }
    async fn input(store: &LocalSnapshotStore, request: ReviewRequest) -> ApplyReviewBatch {
        let preview = store.preview_relationship_batch(&request).await.unwrap();
        ApplyReviewBatch {
            request,
            revision: preview.revision,
            batch_id: Uuid::new_v4(),
            approved_keys: preview
                .checks
                .iter()
                .filter(|c| c.reason.is_none())
                .map(|c| c.entry.key.clone())
                .collect(),
        }
    }
    async fn setup() -> (LocalSnapshotStore, DatabaseSnapshot) {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let snapshot = fixture();
        store.save_snapshot(&snapshot).await.unwrap();
        (store, snapshot)
    }

    #[tokio::test]
    async fn confirms_only_safe_subset_idempotently_and_undo_preserves_later_edits() {
        let (store, snapshot) = setup().await;
        let input = input(&store, request(&snapshot, ReviewAction::Confirm)).await;
        assert_eq!(input.approved_keys.len(), 2);
        let mut risky = input.clone();
        risky
            .approved_keys
            .push(risky.request.entries[2].key.clone());
        assert!(store.apply_relationship_batch(&risky).await.is_err());
        assert!(
            store
                .list_logical_relationships(snapshot.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        let batch = store.apply_relationship_batch(&input).await.unwrap();
        assert_eq!(
            store.apply_relationship_batch(&input).await.unwrap().id,
            batch.id
        );
        let mut relations = store
            .list_logical_relationships(snapshot.source_id)
            .await
            .unwrap();
        assert_eq!(relations.len(), 2);
        let duplicate_preview = store
            .preview_relationship_batch(&request(&snapshot, ReviewAction::Confirm))
            .await
            .unwrap();
        assert!(
            duplicate_preview
                .checks
                .iter()
                .all(|check| check.reason.is_some())
        );
        relations[0].note = Some("Subsequent user edit".into());
        store
            .save_logical_relationship(&relations[0])
            .await
            .unwrap();
        let undone = store
            .undo_relationship_batch(snapshot.source_id, batch.id)
            .await
            .unwrap();
        assert_eq!(undone.skipped_keys.len(), 1);
        assert_eq!(
            store
                .list_logical_relationships(snapshot.source_id)
                .await
                .unwrap(),
            vec![relations[0].clone()]
        );
        assert_eq!(
            store
                .undo_relationship_batch(snapshot.source_id, batch.id)
                .await
                .unwrap()
                .skipped_keys,
            undone.skipped_keys
        );
        assert!(
            store
                .undo_relationship_batch(Uuid::new_v4(), batch.id)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn rejects_changed_preview_and_same_id_reuse_across_sources() {
        let (store, snapshot) = setup().await;
        let input = input(&store, request(&snapshot, ReviewAction::Ignore)).await;
        store
            .save_ignored_relationship_inference(&IgnoredRelationshipInference {
                source_id: snapshot.source_id,
                relationship_key: "unrelated".into(),
                ignored_at: Utc::now(),
            })
            .await
            .unwrap();
        assert!(store.apply_relationship_batch(&input).await.is_err());
        let mut fresh = input.clone();
        fresh.revision = store
            .preview_relationship_batch(&fresh.request)
            .await
            .unwrap()
            .revision;
        store.apply_relationship_batch(&fresh).await.unwrap();
        let mut other = fixture();
        other.source_id = Uuid::new_v4();
        store.save_snapshot(&other).await.unwrap();
        let mut foreign_request = request(&other, ReviewAction::Ignore);
        foreign_request.entries.truncate(1);
        let mut foreign = ApplyReviewBatch {
            request: foreign_request,
            revision: String::new(),
            batch_id: fresh.batch_id,
            approved_keys: vec![fresh.approved_keys[0].clone()],
        };
        foreign.revision = store
            .preview_relationship_batch(&foreign.request)
            .await
            .unwrap()
            .revision;
        assert!(store.apply_relationship_batch(&foreign).await.is_err());
        assert!(
            store
                .list_ignored_relationship_inferences(other.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_relationship_batches(snapshot.source_id)
                .await
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn rolls_back_all_model_history_and_sync_writes_on_failure() {
        let (store, snapshot) = setup().await;
        let input = input(&store, request(&snapshot, ReviewAction::Confirm)).await;
        sqlx::query("CREATE TRIGGER reject_review_sync BEFORE INSERT ON sync_queue BEGIN SELECT RAISE(ABORT,'fixture failure'); END").execute(&store.pool).await.unwrap();
        assert!(store.apply_relationship_batch(&input).await.is_err());
        assert!(
            store
                .list_logical_relationships(snapshot.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_relationship_batches(snapshot.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        sqlx::query("DROP TRIGGER reject_review_sync")
            .execute(&store.pool)
            .await
            .unwrap();
        let batch = store.apply_relationship_batch(&input).await.unwrap();
        sqlx::query("CREATE TRIGGER reject_review_undo BEFORE INSERT ON sync_queue BEGIN SELECT RAISE(ABORT,'fixture undo failure'); END").execute(&store.pool).await.unwrap();
        assert!(
            store
                .undo_relationship_batch(snapshot.source_id, batch.id)
                .await
                .is_err()
        );
        assert_eq!(
            store
                .list_logical_relationships(snapshot.source_id)
                .await
                .unwrap()
                .len(),
            2
        );
        assert!(
            store
                .list_relationship_batches(snapshot.source_id)
                .await
                .unwrap()[0]
                .undone_at
                .is_none()
        );
    }
    #[tokio::test]
    async fn ignore_restore_and_undo_persist_across_restart_and_detect_absent_aba() {
        let path = std::env::temp_dir().join(format!("nodal-batch-test-{}.sqlite", Uuid::new_v4()));
        let store = LocalSnapshotStore::open_path(&path).await.unwrap();
        let snapshot = fixture();
        store.save_snapshot(&snapshot).await.unwrap();
        let ignored = store
            .apply_relationship_batch(
                &input(&store, request(&snapshot, ReviewAction::Ignore)).await,
            )
            .await
            .unwrap();
        store.pool.close().await;
        let store = LocalSnapshotStore::open_path(&path).await.unwrap();
        assert_eq!(
            store
                .list_relationship_batches(snapshot.source_id)
                .await
                .unwrap()[0]
                .id,
            ignored.id
        );
        let restored = store
            .apply_relationship_batch(
                &input(&store, request(&snapshot, ReviewAction::Restore)).await,
            )
            .await
            .unwrap();
        assert!(
            store
                .list_ignored_relationship_inferences(snapshot.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        // An ignore followed by an individual restore looks absent again but is a later decision.
        let key = restored.keys[0].clone();
        store
            .save_ignored_relationship_inference(&IgnoredRelationshipInference {
                source_id: snapshot.source_id,
                relationship_key: key.clone(),
                ignored_at: Utc::now(),
            })
            .await
            .unwrap();
        store
            .restore_relationship_inference(snapshot.source_id, &key)
            .await
            .unwrap();
        let result = store
            .undo_relationship_batch(snapshot.source_id, restored.id)
            .await
            .unwrap();
        assert_eq!(result.skipped_keys, vec![key]);
        assert_eq!(
            store
                .list_ignored_relationship_inferences(snapshot.source_id)
                .await
                .unwrap()
                .len(),
            2
        );
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn excludes_ambiguous_targets_existing_logical_and_composite_keys() {
        let (store, mut snapshot) = setup().await;
        snapshot.id = Uuid::new_v4();
        snapshot.captured_at = Utc::now();
        snapshot.schemas[0]
            .tables
            .push(table("mail_orders", &["id"]));
        snapshot.schemas[0]
            .tables
            .iter_mut()
            .find(|t| t.key.name == "customers")
            .unwrap()
            .primary_key
            .as_mut()
            .unwrap()
            .columns
            .push("tenant_id".into());
        snapshot.canonicalize().unwrap();
        store.save_snapshot(&snapshot).await.unwrap();
        let preview = store
            .preview_relationship_batch(&request(&snapshot, ReviewAction::Confirm))
            .await
            .unwrap();
        assert!(preview.checks.iter().all(|check| check.reason.is_some()));
        let mut stale = request(&snapshot, ReviewAction::Ignore);
        stale.snapshot_id = Uuid::new_v4();
        assert!(store.preview_relationship_batch(&stale).await.is_err());
    }
}
