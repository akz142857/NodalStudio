//! Device-local change review. A decision never substitutes for knowledge validation.
use crate::{LocalSnapshotStore, SnapshotStoreError, deserialize_payloads, knowledge};
use chrono::Utc;
use schema_model::{DatabaseSnapshot, LogicalRelationshipStatus, ObjectKey};
use semantic_model::{
    DomainGroup, SavedView,
    knowledge::{
        KnowledgeBasis, KnowledgeOrigin, KnowledgeStatus, annotation_version, digest, owning_table,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

type Result<T> = std::result::Result<T, SnapshotStoreError>;
fn conflict(message: &str) -> SnapshotStoreError {
    SnapshotStoreError::ReviewConflict(message.into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub key: String,
    pub kind: String,
    pub title: String,
    pub object: Option<ObjectKey>,
    pub reason: String,
    pub before: Value,
    pub after: Value,
    pub evidence: String,
    pub status: String,
    pub note: String,
    pub actions: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvent {
    pub round_id: Uuid,
    pub id: Uuid,
    pub at: String,
    pub action: String,
    pub item: Option<ReviewItem>,
    pub text: String,
    #[serde(default)]
    pub items: Vec<ReviewItem>,
    #[serde(default)]
    pub restorable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkspace {
    pub source_id: Uuid,
    pub round_id: Option<Uuid>,
    pub baseline: Option<Uuid>,
    pub target: Uuid,
    pub baseline_at: Option<String>,
    pub target_at: String,
    pub revision: String,
    pub initialized: bool,
    pub completed: bool,
    pub identity_changed: bool,
    pub items: Vec<ReviewItem>,
    pub events: Vec<ReviewEvent>,
    pub coverage: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRequest {
    pub source_id: Uuid,
    pub revision: String,
    pub prepared_at: String,
    pub operation_id: Uuid,
    pub action: String,
    pub item_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub item_keys: Vec<String>,
    pub text: Option<String>,
}
/// Server-side filters and bounded cursor paging for the desktop transport.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewQuery {
    pub view: Option<String>,
    pub search: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPage {
    #[serde(flatten)]
    pub workspace: ReviewWorkspace,
    pub pending_count: usize,
    pub impact_count: usize,
    pub structure_count: usize,
    pub total: usize,
    pub next_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct ReviewCursor {
    source: Uuid,
    revision: String,
    filter: String,
    offset: usize,
}
impl ReviewQuery {
    /// # Errors
    /// Rejects unsupported views and oversized search/page input before any write.
    pub fn validate(&self) -> Result<()> {
        if !matches!(
            self.view.as_deref().unwrap_or("impact"),
            "impact" | "structure" | "events"
        ) || self.limit.is_some_and(|n| n == 0 || n > 100)
            || self
                .search
                .as_ref()
                .is_some_and(|q| q.chars().count() > 200)
            || self.cursor.as_ref().is_some_and(|c| c.len() > 2048)
        {
            return Err(conflict("Invalid review page query."));
        }
        Ok(())
    }
}
/// Bounds the response before serialization; completion always uses the full projection.
/// # Errors
/// Rejects a cursor from a different source, filter, page size or evidence revision.
pub fn page_workspace(mut workspace: ReviewWorkspace, query: &ReviewQuery) -> Result<ReviewPage> {
    query.validate()?;
    let view = query.view.as_deref().unwrap_or("impact");
    let search = query.search.as_deref().unwrap_or("").trim().to_lowercase();
    let limit = query.limit.unwrap_or(50);
    let filter = digest(&(view, &search, limit));
    let offset = if let Some(raw) = &query.cursor {
        let cursor: ReviewCursor =
            serde_json::from_str(raw).map_err(|_| conflict("Invalid review cursor."))?;
        if cursor.source != workspace.source_id
            || cursor.revision != workspace.revision
            || cursor.filter != filter
        {
            return Err(conflict("Review page expired. Return to the first page."));
        }
        cursor.offset
    } else {
        0
    };
    let pending_count = workspace
        .items
        .iter()
        .filter(|i| i.status != "resolved")
        .count();
    let structure_count = workspace
        .items
        .iter()
        .filter(|i| i.kind == "structure")
        .count();
    let impact_count = workspace.items.len() - structure_count;
    let total = if view == "events" {
        workspace.items.clear();
        workspace.events.reverse();
        workspace.events.retain(|e| {
            format!(
                "{} {} {}",
                e.action,
                e.item.as_ref().map_or("", |i| &i.title),
                e.text
            )
            .to_lowercase()
            .contains(&search)
                || e.items
                    .iter()
                    .any(|item| item.title.to_lowercase().contains(&search))
        });
        workspace.events.len()
    } else {
        workspace.events.clear();
        workspace.items.retain(|i| {
            (i.kind == "structure") == (view == "structure")
                && format!("{} {}", i.title, i.kind)
                    .to_lowercase()
                    .contains(&search)
        });
        workspace.items.sort_by(|a, b| {
            (a.status == "resolved", &a.title, &a.key).cmp(&(
                b.status == "resolved",
                &b.title,
                &b.key,
            ))
        });
        workspace.items.len()
    };
    if offset > total {
        return Err(conflict("Invalid review page offset."));
    }
    let next_cursor = if offset.saturating_add(limit) < total {
        Some(serde_json::to_string(&ReviewCursor {
            source: workspace.source_id,
            revision: workspace.revision.clone(),
            filter,
            offset: offset + limit,
        })?)
    } else {
        None
    };
    workspace.items = workspace
        .items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    workspace.events = workspace
        .events
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    Ok(ReviewPage {
        workspace,
        pending_count,
        impact_count,
        structure_count,
        total,
        next_cursor,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Baseline {
    snapshot: Uuid,
    identity: String,
    round: Uuid,
    completed: bool,
}

impl LocalSnapshotStore {
    pub(super) async fn initialize_change_review(&self) -> Result<()> {
        for sql in [
            "CREATE TABLE IF NOT EXISTS change_review_baselines(source_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS change_review_events(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, round_id TEXT NOT NULL, request_digest TEXT NOT NULL, payload_json TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS change_review_events_source ON change_review_events(source_id,round_id)",
            "CREATE TABLE IF NOT EXISTS change_review_receipts(source_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)",
        ] {
            sqlx::query(sql).execute(&self.pool).await?;
        }
        Ok(())
    }
    /// Records an unsuccessful capture without replacing the saved model.
    /// # Errors
    /// Returns storage errors; no raw connection errors or credentials are persisted.
    pub async fn record_review_capture_failure(&self, source: Uuid) -> Result<()> {
        let receipt = json!({"status":"failed", "at":Utc::now().to_rfc3339()});
        sqlx::query("INSERT INTO change_review_receipts VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json")
            .bind(source.to_string()).bind(receipt.to_string()).execute(&self.pool).await?;
        Ok(())
    }

    /// Loads current evidence and durable decisions together. No source database writes.
    /// # Errors
    /// Returns storage errors or an unavailable current snapshot.
    pub async fn change_review(&self, source: Uuid) -> Result<ReviewWorkspace> {
        let mut tx = self.pool.begin().await?;
        let result = workspace(&mut tx, source).await?;
        tx.commit().await?;
        Ok(result)
    }
    /// Applies a guarded local decision and its audit event in one transaction.
    /// # Errors
    /// Rejects stale evidence, invalid actions, conflicting retries and storage failures.
    #[allow(clippy::too_many_lines)]
    pub async fn apply_change_review(&self, request: &ReviewRequest) -> Result<ReviewWorkspace> {
        let mut tx = self.pool.begin().await?;
        let request_hash = digest(request);
        let duplicate: Option<String> =
            sqlx::query_scalar("SELECT request_digest FROM change_review_events WHERE id=?")
                .bind(request.operation_id.to_string())
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(hash) = duplicate {
            if hash != request_hash {
                return Err(conflict(
                    "This operation was already used with different input.",
                ));
            }
            let result = workspace(&mut tx, request.source_id).await?;
            tx.commit().await?;
            return Ok(result);
        }
        let prepared = chrono::DateTime::parse_from_rfc3339(&request.prepared_at)
            .map_err(|_| conflict("Invalid review preview time."))?;
        let age = Utc::now().signed_duration_since(prepared);
        if age > chrono::Duration::minutes(10) || age < chrono::Duration::seconds(-30) {
            return Err(conflict("Review preview expired. Prepare it again."));
        }
        let current = workspace(&mut tx, request.source_id).await?;
        if current.revision != request.revision {
            return Err(conflict(
                "Review evidence changed. Reload before applying this decision; your draft is retained.",
            ));
        }
        let text = request.text.as_deref().unwrap_or("").trim();
        if text.chars().count() > 2000 {
            return Err(conflict("Use at most 2,000 characters."));
        }
        let mut baseline = baseline_in(&mut tx, request.source_id).await?;
        let snapshot = knowledge::snapshot_in(&mut tx, request.source_id)
            .await?
            .ok_or_else(|| conflict("Capture a schema first."))?;
        let mut item = request
            .item_key
            .as_ref()
            .and_then(|key| current.items.iter().find(|i| &i.key == key))
            .cloned();
        let mut batch = Vec::new();
        if request.action != "seenBatch" && !request.item_keys.is_empty() {
            return Err(conflict(
                "Item selection is only supported for structural batch review.",
            ));
        }
        if matches!(request.action.as_str(), "start" | "restart" | "complete")
            && request.item_key.is_some()
        {
            return Err(conflict("Round actions must not select a review item."));
        }
        if request.action == "restore" {
            let event = current.events.iter().find(|e| request.item_key.as_deref() == Some(e.id.to_string().as_str()) && e.restorable)
                .ok_or_else(|| conflict("This archive cannot be restored: it was already restored or its current description changed."))?;
            item.clone_from(&event.item);
        }
        if request.action == "start" || request.action == "restart" {
            let receipt: Option<String> = sqlx::query_scalar(
                "SELECT payload_json FROM change_review_receipts WHERE source_id=?",
            )
            .bind(request.source_id.to_string())
            .fetch_optional(&mut *tx)
            .await?;
            let identity = knowledge::identity_in(&mut tx, request.source_id).await?;
            if let Some(raw) = receipt {
                let receipt: Value = serde_json::from_str(&raw)?;
                if receipt["status"] == "failed"
                    || receipt["identity"]
                        .as_str()
                        .is_some_and(|captured| captured != identity)
                {
                    return Err(conflict(
                        "Refresh the database successfully for the current connection before establishing a comparison starting point.",
                    ));
                }
            }
            if request.action == "start" && baseline.is_some() {
                return Err(conflict("A comparison baseline already exists."));
            }
            if request.action == "restart" && text.is_empty() {
                return Err(conflict(
                    "Explain why the comparison starting point must change.",
                ));
            }
            if request.action == "restart" {
                sqlx::query("UPDATE annotation_confirmations SET invalid_reason='Comparison scope restarted; review against current evidence.' WHERE source_id=?")
                    .bind(request.source_id.to_string()).execute(&mut *tx).await?;
            }
            baseline = Some(Baseline {
                snapshot: snapshot.id,
                identity: knowledge::identity_in(&mut tx, request.source_id).await?,
                round: Uuid::new_v4(),
                completed: false,
            });
        } else {
            if baseline.is_none() || current.identity_changed {
                return Err(conflict(
                    "Establish a comparison starting point for this connection first.",
                ));
            }
            if request.action == "seenBatch" {
                let keys: std::collections::HashSet<_> = request.item_keys.iter().collect();
                if keys.is_empty()
                    || keys.len() > 100
                    || keys.len() != request.item_keys.len()
                    || request.item_key.is_some()
                {
                    return Err(conflict(
                        "Select between 1 and 100 distinct structure changes.",
                    ));
                }
                for key in &request.item_keys {
                    let i = current.items.iter().find(|i| &i.key == key && i.kind == "structure" && i.status != "resolved" && i.actions.iter().any(|a| a == "seen"))
                        .ok_or_else(|| conflict("Batch review only accepts unresolved structure changes from this revision."))?;
                    batch.push(i.clone());
                }
            } else if request.action == "restore" {
                let i = item
                    .as_ref()
                    .ok_or_else(|| conflict("Missing archived statement."))?;
                let target = i
                    .object
                    .as_ref()
                    .ok_or_else(|| conflict("Missing archive target."))?;
                let mut annotation = knowledge::annotation_in(&mut tx, request.source_id, target)
                    .await?
                    .ok_or_else(|| conflict("The annotation no longer exists."))?;
                if annotation
                    .description
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty())
                {
                    return Err(conflict(
                        "Restoring must not overwrite an existing description.",
                    ));
                }
                annotation.description = Some(
                    i.before["description"]
                        .as_str()
                        .ok_or_else(|| conflict("The archive has no original text."))?
                        .into(),
                );
                annotation.updated_at = Utc::now();
                sqlx::query("UPDATE object_annotations SET payload_json=?,updated_at=? WHERE source_id=? AND object_key=?")
                    .bind(serde_json::to_string(&annotation)?).bind(annotation.updated_at.to_rfc3339()).bind(request.source_id.to_string()).bind(serde_json::to_string(target)?).execute(&mut *tx).await?;
                sqlx::query("UPDATE annotation_confirmations SET invalid_reason='Restored archived text requires a new local confirmation.' WHERE source_id=? AND object_key=?")
                    .bind(request.source_id.to_string()).bind(serde_json::to_string(target)?).execute(&mut *tx).await?;
                if let Some(b) = baseline.as_mut()
                    && b.completed
                {
                    b.completed = false;
                    b.round = Uuid::new_v4();
                }
            } else if request.action == "complete" {
                if current.items.iter().any(|i| i.status != "resolved") {
                    return Err(conflict(
                        "Resolve or explicitly review every item before completing this round. Deferred items remain open.",
                    ));
                }
                if current.completed {
                    return Err(conflict("This round is already complete."));
                }
                let base = baseline
                    .as_mut()
                    .ok_or_else(|| conflict("Missing baseline."))?;
                base.snapshot = snapshot.id;
                base.completed = true;
            } else {
                let item = item
                    .as_ref()
                    .ok_or_else(|| conflict("This review item is no longer available."))?;
                if !item.actions.contains(&request.action) {
                    return Err(conflict(
                        "This action is not available for the current evidence.",
                    ));
                }
                if matches!(
                    request.action.as_str(),
                    "defer" | "archive" | "acceptLimitation" | "disable"
                ) && text.is_empty()
                {
                    return Err(conflict("Record a reason for this decision."));
                }
                match request.action.as_str() {
                    "confirm" => {
                        let target = item
                            .object
                            .as_ref()
                            .ok_or_else(|| conflict("Missing knowledge target."))?;
                        let old =
                            knowledge::annotation_in(&mut tx, request.source_id, target).await?;
                        let states = knowledge::states_in(&mut tx, request.source_id).await?;
                        let state = states.iter().find(|s| &s.object_key == target);
                        let logical =
                            knowledge::relationships_in(&mut tx, request.source_id).await?;
                        let owner = owning_table(&snapshot, target)
                            .ok_or_else(|| conflict("The target is no longer observable."))?;
                        // Preserve the full old dependency set. Do not silently downgrade AI evidence to one table.
                        let keys = state.and_then(|s| s.confirmation.as_ref()).map_or_else(
                            || vec![owner],
                            |c| c.basis.tables.iter().map(|(key, _)| key.clone()).collect(),
                        );
                        let mut basis = KnowledgeBasis::from_tables(&snapshot, &keys, &logical);
                        if basis.tables.len() != keys.len() {
                            return Err(conflict(
                                "Some supporting tables are missing. Defer or archive this statement.",
                            ));
                        }
                        if let Some(previous) = state.and_then(|s| s.confirmation.as_ref()) {
                            for (id, _) in &previous.basis.relationships {
                                let relation = logical.iter().find(|r| r.id == *id && r.status == LogicalRelationshipStatus::Active).ok_or_else(|| conflict("A supporting relationship is no longer active. Defer or archive this statement."))?;
                                if !basis.relationships.iter().any(|(key, _)| key == id) {
                                    basis.relationships.push((
                                        *id,
                                        semantic_model::knowledge::relationship_digest(relation),
                                    ));
                                }
                            }
                            for (key, _, _) in &previous.basis.notes {
                                let note = states
                                    .iter()
                                    .find(|s| {
                                        &s.object_key == key
                                            && s.status == KnowledgeStatus::Confirmed
                                    })
                                    .and_then(|s| s.confirmation.as_ref())
                                    .ok_or_else(|| {
                                        conflict("Review the supporting statement first.")
                                    })?;
                                basis.notes.push((
                                    key.clone(),
                                    note.id,
                                    note.description_digest.clone(),
                                ));
                            }
                        }
                        basis.source_identity =
                            Some(knowledge::identity_in(&mut tx, request.source_id).await?);
                        let origin = KnowledgeOrigin {
                            kind: "changeReview".into(),
                            request_id: None,
                            provider: None,
                            model: None,
                            generated_at: None,
                            // The audit event stores the full item. Keep confirmation provenance compact
                            // so repeated reviews cannot recursively embed every older confirmation.
                            evidence: json!({"reviewItem": item.key, "evidenceDigest": item.evidence, "snapshot": snapshot.id}),
                        };
                        knowledge::confirm_in(
                            &mut tx,
                            request.operation_id,
                            request.source_id,
                            target,
                            &annotation_version(old.as_ref()),
                            &basis,
                            text,
                            &origin,
                        )
                        .await?;
                    }
                    "archive" => {
                        let target = item
                            .object
                            .as_ref()
                            .ok_or_else(|| conflict("Missing annotation target."))?;
                        let mut annotation =
                            knowledge::annotation_in(&mut tx, request.source_id, target)
                                .await?
                                .ok_or_else(|| conflict("The statement no longer exists."))?;
                        // The event retains the original text/evidence. Clearing only description keeps tags/owner/layout,
                        // and prevents every existing AI/export/shared-text consumer from reusing archived prose.
                        annotation.description = None;
                        annotation.updated_at = Utc::now();
                        sqlx::query("UPDATE object_annotations SET payload_json=?,updated_at=? WHERE source_id=? AND object_key=?")
                            .bind(serde_json::to_string(&annotation)?).bind(annotation.updated_at.to_rfc3339()).bind(request.source_id.to_string()).bind(serde_json::to_string(target)?).execute(&mut *tx).await?;
                    }
                    "disable" => {
                        let id = item
                            .key
                            .strip_prefix("relation:")
                            .ok_or_else(|| conflict("Missing relationship."))?;
                        let mut relations =
                            knowledge::relationships_in(&mut tx, request.source_id).await?;
                        let r = relations
                            .iter_mut()
                            .find(|r| r.id.to_string() == id)
                            .ok_or_else(|| conflict("The relationship changed."))?;
                        r.status = LogicalRelationshipStatus::Disabled;
                        sqlx::query("UPDATE logical_relationships SET payload_json=? WHERE source_id=? AND id=?")
                            .bind(serde_json::to_string(r)?).bind(request.source_id.to_string()).bind(id).execute(&mut *tx).await?;
                    }
                    "seen" | "defer" | "acceptLimitation" => {}
                    _ => return Err(conflict("Unsupported review action.")),
                }
            }
        }
        let base = baseline
            .as_ref()
            .ok_or_else(|| conflict("Missing baseline."))?;
        sqlx::query("INSERT INTO change_review_baselines VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json")
            .bind(request.source_id.to_string()).bind(serde_json::to_string(base)?).execute(&mut *tx).await?;
        if let Some(i) = &item {
            let payload = if matches!(request.action.as_str(), "confirm" | "archive" | "restore") {
                let a = knowledge::annotation_in(
                    &mut tx,
                    request.source_id,
                    i.object
                        .as_ref()
                        .ok_or_else(|| conflict("Missing annotation target."))?,
                )
                .await?;
                Some(("annotation.save", serde_json::to_value(a)?))
            } else if request.action == "disable" {
                let relations = knowledge::relationships_in(&mut tx, request.source_id).await?;
                let r = relations
                    .iter()
                    .find(|r| format!("relation:{}", r.id) == i.key);
                Some(("logical_relationship.save", serde_json::to_value(r)?))
            } else {
                None
            };
            if let Some((kind, payload)) = payload {
                Self::enqueue_sync_in(
                    &mut tx,
                    &crate::SyncQueueItem {
                        id: Uuid::new_v4(),
                        source_id: request.source_id,
                        event_kind: kind.into(),
                        idempotency_key: format!("change-review:{}", request.operation_id),
                        payload,
                        base_version: 0,
                        attempts: 0,
                        state: "pending".into(),
                        created_at: Utc::now().to_rfc3339(),
                    },
                )
                .await?;
            }
        }
        let event = ReviewEvent {
            round_id: base.round,
            id: request.operation_id,
            at: Utc::now().to_rfc3339(),
            action: request.action.clone(),
            item,
            text: text.into(),
            items: batch,
            restorable: false,
        };
        sqlx::query("INSERT INTO change_review_events VALUES(?,?,?,?,?)")
            .bind(request.operation_id.to_string())
            .bind(request.source_id.to_string())
            .bind(base.round.to_string())
            .bind(request_hash)
            .bind(serde_json::to_string(&event)?)
            .execute(&mut *tx)
            .await?;
        let result = workspace(&mut tx, request.source_id).await?;
        tx.commit().await?;
        Ok(result)
    }
}

async fn baseline_in(tx: &mut Transaction<'_, Sqlite>, source: Uuid) -> Result<Option<Baseline>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT payload_json FROM change_review_baselines WHERE source_id=?")
            .bind(source.to_string())
            .fetch_optional(&mut **tx)
            .await?;
    raw.map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(Into::into)
}

pub(super) async fn receipt_in(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &DatabaseSnapshot,
) -> Result<()> {
    let receipt = json!({"at": Utc::now().to_rfc3339(), "snapshotId": snapshot.id, "identity": knowledge::identity_in(tx, snapshot.source_id).await?, "schemas": snapshot.schemas.iter().map(|s| &s.name).collect::<Vec<_>>(), "coverage": "observedMetadataOnly", "status": "success"});
    sqlx::query("INSERT INTO change_review_receipts VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json")
        .bind(snapshot.source_id.to_string()).bind(receipt.to_string()).execute(&mut **tx).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn item(
    kind: &str,
    key: String,
    title: String,
    object: Option<ObjectKey>,
    reason: &str,
    before: Value,
    after: Value,
    actions: &[&str],
) -> ReviewItem {
    let evidence = digest(&(&key, &before, &after, reason));
    ReviewItem {
        key,
        kind: kind.into(),
        title,
        object,
        reason: reason.into(),
        before,
        after,
        evidence,
        status: "open".into(),
        note: String::new(),
        actions: actions.iter().map(|s| (*s).into()).collect(),
    }
}

#[allow(clippy::too_many_lines)]
async fn workspace(tx: &mut Transaction<'_, Sqlite>, source: Uuid) -> Result<ReviewWorkspace> {
    let target = knowledge::snapshot_in(tx, source)
        .await?
        .ok_or_else(|| conflict("Capture a schema first."))?;
    let identity = knowledge::identity_in(tx, source).await?;
    let mut base = baseline_in(tx, source).await?;
    let before = if let Some(b) = &base {
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT payload_json FROM schema_snapshots WHERE id=? AND source_id=?",
        )
        .bind(b.snapshot.to_string())
        .bind(source.to_string())
        .fetch_optional(&mut **tx)
        .await?;
        raw.map(|s| serde_json::from_str::<DatabaseSnapshot>(&s))
            .transpose()?
    } else {
        None
    };
    let annotations: Vec<semantic_model::ObjectAnnotation> = deserialize_payloads(
        sqlx::query(
            "SELECT payload_json FROM object_annotations WHERE source_id=? ORDER BY object_key",
        )
        .bind(source.to_string())
        .fetch_all(&mut **tx)
        .await?,
    )?;
    let states = knowledge::states_in(tx, source).await?;
    let logical = knowledge::relationships_in(tx, source).await?;
    let groups: Vec<DomainGroup> = deserialize_payloads(
        sqlx::query("SELECT payload_json FROM domain_groups WHERE source_id=? ORDER BY id")
            .bind(source.to_string())
            .fetch_all(&mut **tx)
            .await?,
    )?;
    let views: Vec<SavedView> = deserialize_payloads(
        sqlx::query("SELECT payload_json FROM saved_views WHERE source_id=? ORDER BY id")
            .bind(source.to_string())
            .fetch_all(&mut **tx)
            .await?,
    )?;
    let receipt: Option<String> =
        sqlx::query_scalar("SELECT payload_json FROM change_review_receipts WHERE source_id=?")
            .bind(source.to_string())
            .fetch_optional(&mut **tx)
            .await?;
    let mut items = Vec::new();
    if receipt
        .as_deref()
        .and_then(|r| serde_json::from_str::<Value>(r).ok())
        .is_some_and(|r| r["status"] == "failed")
    {
        items.push(item(
            "coverage",
            "captureFailed".into(),
            "Capture".into(),
            None,
            "captureFailed",
            Value::Null,
            Value::Null,
            &["defer"],
        ));
    }

    if let Some(old) = &before {
        let diff = schema_diff::diff_snapshots(old, &target);
        for operation in diff.operations {
            let key = format!("structure:{}", digest(&operation));
            items.push(item(
                "structure",
                key,
                format!("{}.{}", operation.object.schema, operation.object.name),
                Some(operation.object.clone()),
                serde_json::to_value(operation.operation_type)?
                    .as_str()
                    .unwrap_or("changed"),
                json!(operation.before),
                json!(operation.after),
                &["seen", "defer"],
            ));
        }
        let old_schemas: std::collections::BTreeSet<_> =
            old.schemas.iter().map(|s| &s.name).collect();
        let new_schemas: std::collections::BTreeSet<_> =
            target.schemas.iter().map(|s| &s.name).collect();
        if old_schemas != new_schemas
            || old.database.database_type != target.database.database_type
            || old.database.name != target.database.name
        {
            items.push(item(
                "coverage",
                "coverage".into(),
                "Coverage".into(),
                None,
                "scopeChanged",
                json!(old_schemas),
                json!(new_schemas),
                &["defer"],
            ));
        }
    } else if base.is_some() {
        items.push(item(
            "coverage",
            "coverage".into(),
            "Coverage".into(),
            None,
            "baselineMissing",
            Value::Null,
            Value::Null,
            &["defer"],
        ));
    }
    for a in &annotations {
        if a.description
            .as_ref()
            .is_none_or(|text| text.trim().is_empty())
        {
            continue;
        }
        if let Some(s) = states
            .iter()
            .find(|s| s.object_key == a.object_key && s.status != KnowledgeStatus::Confirmed)
        {
            let available = s.status != KnowledgeStatus::Unavailable;
            let keys = s.confirmation.as_ref().map_or_else(
                || {
                    owning_table(&target, &a.object_key)
                        .into_iter()
                        .collect::<Vec<_>>()
                },
                |c| c.basis.tables.iter().map(|(k, _)| k.clone()).collect(),
            );
            let evidence: Vec<_> = target
                .schemas
                .iter()
                .flat_map(|s| &s.tables)
                .filter(|t| keys.contains(&t.key))
                .collect();
            let reason = if !available {
                "notObserved"
            } else if s.confirmation.is_none() {
                "notConfirmed"
            } else {
                "supportChanged"
            };
            items.push(item("annotation", format!("annotation:{}", digest(&a.object_key)), format!("{}.{}", a.object_key.schema, a.object_key.name), Some(a.object_key.clone()), reason,
                json!({"description": a.description, "confirmation": s.confirmation}), json!({"tables": evidence, "relationships": logical.iter().filter(|r| s.confirmation.as_ref().is_some_and(|c| c.basis.relationships.iter().any(|(id, _)| *id == r.id))).collect::<Vec<_>>(), "notes": s.confirmation.as_ref().map(|c| c.basis.notes.iter().map(|(key, _, _)| states.iter().find(|state| &state.object_key == key)).collect::<Vec<_>>()), "state": s.reason}),
                if available { &["confirm", "defer", "archive"] } else { &["defer", "archive"] }));
        }
    }
    for r in &logical {
        if r.status == LogicalRelationshipStatus::Disabled {
            continue;
        }
        let endpoints_missing = [&r.source, &r.target].iter().any(|e| {
            !target.schemas.iter().flat_map(|s| &s.tables).any(|t| {
                t.key.schema == e.schema
                    && t.key.name == e.table
                    && e.columns
                        .iter()
                        .all(|c| t.columns.iter().any(|col| &col.name == c))
            })
        });
        let changed = before.as_ref().is_some_and(|b| {
            [&r.source, &r.target].iter().any(|e| {
                semantic_model::knowledge::table_digest(b, &ObjectKey::table(&e.schema, &e.table))
                    != semantic_model::knowledge::table_digest(
                        &target,
                        &ObjectKey::table(&e.schema, &e.table),
                    )
            })
        });
        if endpoints_missing || changed || r.status != LogicalRelationshipStatus::Active {
            let tables: Vec<_> = target
                .schemas
                .iter()
                .flat_map(|s| &s.tables)
                .filter(|t| {
                    [&r.source, &r.target]
                        .iter()
                        .any(|e| t.key.schema == e.schema && t.key.name == e.table)
                })
                .collect();
            let invalid = endpoints_missing
                || matches!(
                    r.status,
                    LogicalRelationshipStatus::Orphaned | LogicalRelationshipStatus::Conflicted
                );
            items.push(item(
                "relationship",
                format!("relation:{}", r.id),
                r.name.clone(),
                Some(ObjectKey::table(&r.source.schema, &r.source.table)),
                if invalid {
                    "relationshipUnavailable"
                } else {
                    "relationshipChanged"
                },
                json!(r),
                json!(tables),
                if invalid {
                    &["disable", "defer"]
                } else {
                    &["seen", "disable", "defer"]
                },
            ));
        }
    }
    let known = semantic_model::known_object_keys(&target);
    for g in &groups {
        let missing: Vec<_> = g.table_keys.iter().filter(|k| !known.contains(k)).collect();
        if !missing.is_empty() {
            items.push(item(
                "domain",
                format!("domain:{}", g.id),
                g.name.clone(),
                None,
                "missingReferences",
                json!(g),
                json!(missing),
                &["acceptLimitation", "defer"],
            ));
        }
    }
    for v in &views {
        let missing: Vec<_> = v
            .root_table_keys
            .iter()
            .filter(|k| !known.contains(k))
            .collect();
        if !missing.is_empty() {
            items.push(item(
                "view",
                format!("view:{}", v.id),
                v.name.clone(),
                None,
                "missingReferences",
                json!(v),
                json!(missing),
                &["acceptLimitation", "defer"],
            ));
        }
    }
    if let Some(b) = base.as_mut()
        && b.completed
        && target.id != b.snapshot
    {
        b.round = Uuid::new_v4();
        b.completed = false;
        sqlx::query("UPDATE change_review_baselines SET payload_json=? WHERE source_id=?")
            .bind(serde_json::to_string(b)?)
            .bind(source.to_string())
            .execute(&mut **tx)
            .await?;
    }
    let rows = sqlx::query(
        "SELECT payload_json FROM change_review_events WHERE source_id=? ORDER BY rowid",
    )
    .bind(source.to_string())
    .fetch_all(&mut **tx)
    .await?;
    let mut events: Vec<ReviewEvent> = deserialize_payloads(rows)?;
    for i in &mut items {
        i.evidence = digest(&(&identity, &i.evidence));
        if let Some(e) = events.iter().rev().find(|e| {
            matches!(
                e.action.as_str(),
                "seen" | "seenBatch" | "defer" | "acceptLimitation"
            ) && (e.round_id == base.as_ref().map_or(Uuid::nil(), |b| b.round)
                || e.action == "acceptLimitation")
                && e.item.iter().chain(&e.items).any(|old| {
                    old.key == i.key
                        && old.evidence == i.evidence
                        && (i.kind != "annotation" || e.action == "defer")
                })
        }) {
            i.status = if e.action == "defer" {
                "deferred"
            } else {
                "resolved"
            }
            .into();
            i.note.clone_from(&e.text);
        }
    }
    // A completed baseline starts a new round only when new evidence requires work.
    if let Some(b) = base.as_mut()
        && b.completed
        && (target.id != b.snapshot || items.iter().any(|i| i.status != "resolved"))
    {
        // Accepted limitations remain accepted until their evidence changes, across rounds.
        b.round = Uuid::new_v4();
        b.completed = false;
        sqlx::query("UPDATE change_review_baselines SET payload_json=? WHERE source_id=?")
            .bind(serde_json::to_string(b)?)
            .bind(source.to_string())
            .execute(&mut **tx)
            .await?;
    }
    // Revisions cover all semantic writers, including imports and other windows, without fragile UI invalidation.
    let revision = digest(&(
        &base,
        target.id,
        &identity,
        &annotations,
        &states,
        &logical,
        &groups,
        &views,
        &receipt,
        &events,
    ));
    let restorable: Vec<bool> = events
        .iter()
        .map(|event| {
            if event.action != "archive" {
                return false;
            }
            let Some(old) = &event.item else {
                return false;
            };
            let Some(key) = &old.object else {
                return false;
            };
            old.before["description"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                && annotations.iter().any(|a| {
                    &a.object_key == key
                        && a.description.as_ref().is_none_or(|s| s.trim().is_empty())
                })
                && events
                    .iter()
                    .rev()
                    .find(|e| {
                        e.item
                            .as_ref()
                            .is_some_and(|i| i.object.as_ref() == Some(key))
                            && matches!(e.action.as_str(), "archive" | "restore" | "confirm")
                    })
                    .is_some_and(|e| e.id == event.id)
        })
        .collect();
    for (event, allowed) in events.iter_mut().zip(restorable) {
        event.restorable = allowed;
    }
    Ok(ReviewWorkspace {
        source_id: source,
        round_id: base.as_ref().map(|b| b.round),
        baseline: base.as_ref().map(|b| b.snapshot),
        target: target.id,
        baseline_at: before.map(|s| s.captured_at.to_rfc3339()),
        target_at: target.captured_at.to_rfc3339(),
        revision,
        initialized: base.is_some(),
        completed: base.as_ref().is_some_and(|b| b.completed),
        identity_changed: base.as_ref().is_some_and(|b| b.identity != identity),
        items,
        events,
        coverage: if receipt.is_some() {
            "observedMetadataOnly"
        } else {
            "legacyCoverageUnknown"
        }
        .into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{
        ColumnDefinition, DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition,
    };
    fn fixture(source: Uuid, changed: bool) -> DatabaseSnapshot {
        let mut table = TableDefinition::empty("app", "payments");
        table.columns.push(ColumnDefinition {
            name: "order_id".into(),
            ordinal_position: 1,
            formatted_type: "bigint".into(),
            type_schema: "pg_catalog".into(),
            type_name: "int8".into(),
            nullable: changed,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        });
        let mut snapshot = DatabaseSnapshot::new(
            source,
            DatabaseInfo {
                name: "review_fixture".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "app".into(),
                tables: vec![table],
                views: vec![],
                enums: vec![],
                programs: vec![],
                dependencies: vec![],
            }],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }
    fn request(
        w: &ReviewWorkspace,
        action: &str,
        item: Option<&ReviewItem>,
        text: &str,
    ) -> ReviewRequest {
        ReviewRequest {
            source_id: w.source_id,
            revision: w.revision.clone(),
            prepared_at: Utc::now().to_rfc3339(),
            operation_id: Uuid::new_v4(),
            action: action.into(),
            item_key: item.map(|i| i.key.clone()),
            item_keys: vec![],
            text: Some(text.into()),
        }
    }
    async fn action(
        store: &LocalSnapshotStore,
        w: &ReviewWorkspace,
        verb: &str,
        item: Option<&ReviewItem>,
        text: &str,
    ) -> ReviewWorkspace {
        store
            .apply_change_review(&request(w, verb, item, text))
            .await
            .unwrap()
    }
    async fn setup(store: &LocalSnapshotStore) -> ReviewWorkspace {
        let s = fixture(Uuid::new_v4(), false);
        store.save_captured_snapshot(&s).await.unwrap();
        let a = semantic_model::ObjectAnnotation {
            source_id: s.source_id,
            object_key: ObjectKey::table("app", "payments"),
            description: Some("Every payment belongs to an order.".into()),
            tags: vec!["billing".into()],
            owner: Some("QA".into()),
            is_core: true,
            updated_at: Utc::now(),
        };
        store.save_annotation(&a).await.unwrap();
        let w = store.change_review(s.source_id).await.unwrap();
        action(store, &w, "start", None, "").await
    }
    #[tokio::test]
    async fn complete_refresh_defer_reopen_and_confirm() {
        let path =
            std::env::temp_dir().join(format!("nodal-review-test-{}.sqlite", Uuid::new_v4()));
        let store = LocalSnapshotStore::open_path(&path).await.unwrap();
        let w = setup(&store).await;
        assert!(!w.completed);
        assert_eq!(w.items[0].reason, "notConfirmed");
        assert!(
            store
                .apply_change_review(&request(&w, "complete", None, ""))
                .await
                .is_err()
        );
        let w = action(
            &store,
            &w,
            "confirm",
            Some(&w.items[0]),
            "Every payment belongs to an order.",
        )
        .await;
        assert!(w.items.is_empty());
        let w = action(&store, &w, "complete", None, "").await;
        assert!(w.completed);
        let initial = w.baseline;
        let next = fixture(w.source_id, true);
        store.save_captured_snapshot(&next).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        assert_eq!(w.baseline, initial);
        assert!(!w.completed);
        assert_eq!(w.items.iter().filter(|i| i.kind == "annotation").count(), 1);
        let annotation = w.items.iter().find(|i| i.kind == "annotation").unwrap();
        let w = action(
            &store,
            &w,
            "defer",
            Some(annotation),
            "Check optional checkout flow",
        )
        .await;
        let store = LocalSnapshotStore::open_path(&path).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        assert_eq!(
            w.items
                .iter()
                .find(|i| i.kind == "annotation")
                .unwrap()
                .status,
            "deferred"
        );
        assert!(
            store
                .apply_change_review(&request(&w, "complete", None, ""))
                .await
                .is_err()
        );
        let annotation = w.items.iter().find(|i| i.kind == "annotation").unwrap();
        let w = action(
            &store,
            &w,
            "confirm",
            Some(annotation),
            "A payment may be created before an order is assigned.",
        )
        .await;
        let structure = w.items.iter().find(|i| i.kind == "structure").unwrap();
        let req = request(&w, "seen", Some(structure), "");
        let w = store.apply_change_review(&req).await.unwrap();
        assert_eq!(
            store.apply_change_review(&req).await.unwrap().events.len(),
            w.events.len()
        );
        let mut changed_req = req.clone();
        changed_req.text = Some("different".into());
        assert!(store.apply_change_review(&changed_req).await.is_err());
        let w = action(&store, &w, "complete", None, "").await;
        assert!(w.completed);
        assert_eq!(w.baseline, Some(next.id));
        assert!(store.change_review(w.source_id).await.unwrap().completed);
        let annotations = store.confirmed_annotations(w.source_id).await.unwrap();
        assert_eq!(annotations[0].tags, vec!["billing"]);
        assert_eq!(annotations[0].owner.as_deref(), Some("QA"));
    }
    #[tokio::test]
    async fn stale_refresh_and_semantic_edits_cannot_complete() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let stale = request(&w, "confirm", Some(&w.items[0]), "Keep this description");
        store
            .save_captured_snapshot(&fixture(w.source_id, true))
            .await
            .unwrap();
        assert!(store.apply_change_review(&stale).await.is_err());
        let w = store.change_review(w.source_id).await.unwrap();
        let mut a = store.list_annotations(w.source_id).await.unwrap().remove(0);
        a.description = Some("edited elsewhere".into());
        store.save_annotation(&a).await.unwrap();
        assert!(
            store
                .apply_change_review(&request(
                    &w,
                    "confirm",
                    w.items.iter().find(|i| i.kind == "annotation"),
                    "stale"
                ))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn archive_preserves_text_in_history_and_removes_current_context() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let w = action(
            &store,
            &w,
            "archive",
            Some(&w.items[0]),
            "No longer maintained",
        )
        .await;
        assert!(w.items.is_empty());
        assert!(
            store
                .confirmed_annotations(w.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        let a = store.list_annotations(w.source_id).await.unwrap().remove(0);
        assert!(a.description.is_none());
        assert_eq!(a.tags, vec!["billing"]);
        assert_eq!(
            w.events.last().unwrap().item.as_ref().unwrap().before["description"],
            "Every payment belongs to an order."
        );
    }
    #[tokio::test]
    async fn baseline_survives_retention_and_duplicate_capture() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let original = w.baseline.unwrap();
        let changed = fixture(w.source_id, true);
        store.save_captured_snapshot(&changed).await.unwrap();
        store
            .prune_snapshots(w.source_id, Some(1), None, false)
            .await
            .unwrap();
        assert!(store.get_snapshot(original).await.unwrap().is_some());
        let again = store
            .save_captured_snapshot(&fixture(w.source_id, true))
            .await
            .unwrap();
        assert!(!again.stored);
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().target,
            changed.id
        );
    }
    #[tokio::test]
    async fn scope_loss_blocks_completion_and_restart_does_not_confirm() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let mut next = fixture(w.source_id, true);
        next.schemas.clear();
        next.canonicalize().unwrap();
        store.save_captured_snapshot(&next).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        assert!(w.items.iter().any(|i| i.kind == "coverage"));
        assert!(
            !w.items
                .iter()
                .find(|i| i.kind == "annotation")
                .unwrap()
                .actions
                .contains(&"confirm".into())
        );
        let w = action(
            &store,
            &w,
            "restart",
            None,
            "Changed visible scope; investigate missing objects separately",
        )
        .await;
        assert!(!w.completed);
        assert!(w.items.iter().any(|i| i.kind == "annotation"));
    }
    #[tokio::test]
    async fn accepted_view_limitations_do_not_reopen_completed_round() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let v = SavedView {
            id: Uuid::new_v4(),
            source_id: w.source_id,
            name: "Old view".into(),
            root_table_keys: vec![ObjectKey::table("app", "missing")],
            relationship_depth: 1,
            updated_at: Utc::now(),
        };
        store.save_view(&v).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        let w = action(
            &store,
            &w,
            "acceptLimitation",
            w.items.iter().find(|i| i.kind == "view"),
            "Keep for historical context",
        )
        .await;
        let w = action(
            &store,
            &w,
            "archive",
            w.items.iter().find(|i| i.kind == "annotation"),
            "Archive",
        )
        .await;
        let w = action(&store, &w, "complete", None, "").await;
        assert!(w.completed);
        assert!(store.change_review(w.source_id).await.unwrap().completed);
    }
    #[tokio::test]
    async fn failed_capture_blocks_completion_until_success_and_expired_previews_do_not_write() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let mut expired = request(
            &w,
            "confirm",
            Some(&w.items[0]),
            "A payment belongs to an order.",
        );
        expired.prepared_at = (Utc::now() - chrono::Duration::minutes(11)).to_rfc3339();
        assert!(store.apply_change_review(&expired).await.is_err());
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().events.len(),
            w.events.len()
        );
        let w = action(
            &store,
            &w,
            "confirm",
            Some(&w.items[0]),
            "A payment belongs to an order.",
        )
        .await;
        let w = action(&store, &w, "complete", None, "").await;
        store
            .record_review_capture_failure(w.source_id)
            .await
            .unwrap();
        let failed = store.change_review(w.source_id).await.unwrap();
        assert_eq!(failed.baseline, w.baseline);
        assert!(!failed.completed);
        assert!(failed.items.iter().any(|i| i.reason == "captureFailed"));
        assert!(
            store
                .apply_change_review(&request(&failed, "complete", None, ""))
                .await
                .is_err()
        );
        store
            .save_captured_snapshot(&fixture(w.source_id, false))
            .await
            .unwrap();
        let recovered = store.change_review(w.source_id).await.unwrap();
        assert!(!recovered.items.iter().any(|i| i.reason == "captureFailed"));
        assert!(
            action(&store, &recovered, "complete", None, "")
                .await
                .completed
        );
    }

    #[tokio::test]
    async fn failed_audit_insert_rolls_back_annotation_confirmation_and_sync() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let before = store.list_annotations(w.source_id).await.unwrap();
        let queued = store.pending_sync().await.unwrap();
        sqlx::query("CREATE TRIGGER fail_review BEFORE INSERT ON change_review_events BEGIN SELECT RAISE(ABORT, 'acceptance injected failure'); END").execute(&store.pool).await.unwrap();
        assert!(
            store
                .apply_change_review(&request(
                    &w,
                    "confirm",
                    Some(&w.items[0]),
                    "Changed description"
                ))
                .await
                .is_err()
        );
        assert_eq!(store.list_annotations(w.source_id).await.unwrap(), before);
        assert_eq!(store.pending_sync().await.unwrap(), queued);
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().revision,
            w.revision
        );
    }

    #[tokio::test]
    async fn independent_sources_and_lost_objects_do_not_inherit_decisions() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let first = setup(&store).await;
        let second = setup(&store).await;
        let _ = action(&store, &first, "archive", Some(&first.items[0]), "Retired").await;
        assert_eq!(
            store
                .change_review(second.source_id)
                .await
                .unwrap()
                .revision,
            second.revision
        );
        let mut gone = fixture(second.source_id, false);
        gone.schemas[0].tables.clear();
        gone.canonicalize().unwrap();
        store.save_captured_snapshot(&gone).await.unwrap();
        let w = store.change_review(second.source_id).await.unwrap();
        let note = w.items.iter().find(|i| i.kind == "annotation").unwrap();
        assert_eq!(note.reason, "notObserved");
        assert!(!note.actions.contains(&"confirm".into()));
        assert!(
            store
                .apply_change_review(&request(&w, "confirm", Some(note), "Still valid"))
                .await
                .is_err()
        );
        assert_eq!(
            store.list_annotations(second.source_id).await.unwrap()[0]
                .description
                .as_deref(),
            Some("Every payment belongs to an order.")
        );
    }
    #[tokio::test]
    async fn reconfirmation_preserves_all_supporting_tables_and_rejects_missing_support() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let mut snapshot = fixture(w.source_id, false);
        snapshot.schemas[0]
            .tables
            .push(TableDefinition::empty("app", "orders"));
        snapshot.canonicalize().unwrap();
        store.save_captured_snapshot(&snapshot).await.unwrap();
        let a = store.list_annotations(w.source_id).await.unwrap().remove(0);
        let origin = KnowledgeOrigin {
            kind: "manualReview".into(),
            request_id: None,
            provider: None,
            model: None,
            generated_at: None,
            evidence: json!({}),
        };
        let basis = KnowledgeBasis::from_tables(
            &snapshot,
            &[
                ObjectKey::table("app", "payments"),
                ObjectKey::table("app", "orders"),
            ],
            &[],
        );
        store
            .confirm_knowledge(
                Uuid::new_v4(),
                w.source_id,
                &a.object_key,
                &annotation_version(Some(&a)),
                &basis,
                a.description.as_deref().unwrap(),
                &origin,
            )
            .await
            .unwrap();
        let mut changed = snapshot.clone();
        changed.id = Uuid::new_v4();
        changed.captured_at = Utc::now();
        changed.schemas[0]
            .tables
            .iter_mut()
            .find(|t| t.key.name == "orders")
            .unwrap()
            .comment = Some("Changed evidence".into());
        changed.canonicalize().unwrap();
        store.save_captured_snapshot(&changed).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        let w = action(
            &store,
            &w,
            "confirm",
            w.items.iter().find(|i| i.kind == "annotation"),
            "Payment references order.",
        )
        .await;
        let states = store.knowledge_states(w.source_id).await.unwrap();
        assert_eq!(
            states[0].confirmation.as_ref().unwrap().basis.tables.len(),
            2
        );
        let mut missing = changed.clone();
        missing.id = Uuid::new_v4();
        missing.captured_at = Utc::now();
        missing.schemas[0].tables.retain(|t| t.key.name != "orders");
        missing.canonicalize().unwrap();
        store.save_captured_snapshot(&missing).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        assert!(
            store
                .apply_change_review(&request(
                    &w,
                    "confirm",
                    w.items.iter().find(|i| i.kind == "annotation"),
                    "Discard missing dependency silently"
                ))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn large_catalog_review_keeps_every_change_and_reports_projection_latency() {
        for count in [500, 2000] {
            let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
            let mut base = fixture(Uuid::new_v4(), false);
            let template = base.schemas[0].tables[0].clone();
            base.schemas[0].tables = (0..count)
                .map(|index| {
                    let mut table = template.clone();
                    table.key.name = format!("orders_{index}");
                    table.columns = (0..4)
                        .map(|col| {
                            let mut c = template.columns[0].clone();
                            c.name = format!("field_{col}");
                            c.ordinal_position = col + 1;
                            c
                        })
                        .collect();
                    table
                })
                .collect();
            base.canonicalize().unwrap();
            store.save_captured_snapshot(&base).await.unwrap();
            let w = store.change_review(base.source_id).await.unwrap();
            action(&store, &w, "start", None, "").await;
            let mut target = base.clone();
            target.id = Uuid::new_v4();
            target.captured_at = Utc::now();
            for table in &mut target.schemas[0].tables {
                for col in &mut table.columns {
                    col.nullable = true;
                }
            }
            target.canonicalize().unwrap();
            store.save_captured_snapshot(&target).await.unwrap();
            let mut elapsed = Vec::new();
            for _ in 0..10 {
                let start = std::time::Instant::now();
                let review = store.change_review(base.source_id).await.unwrap();
                elapsed.push(start.elapsed().as_millis());
                assert_eq!(review.items.len(), count * 4);
                assert_eq!(review.baseline, Some(base.id));
                assert!(!review.completed);
            }
            elapsed.sort_unstable();
            println!(
                "review_projection tables={count} items={} samples=10 p95_ms={}",
                count * 4,
                elapsed[9]
            );
        }
    }
    async fn many_changes(store: &LocalSnapshotStore) -> ReviewWorkspace {
        let w = setup(store).await;
        let mut next = fixture(w.source_id, true);
        let template = next.schemas[0].tables[0].columns[0].clone();
        for n in 0..124 {
            let mut c = template.clone();
            c.name = format!("added_{n:03}");
            c.ordinal_position = n + 2;
            next.schemas[0].tables[0].columns.push(c);
        }
        next.canonicalize().unwrap();
        store.save_captured_snapshot(&next).await.unwrap();
        store.change_review(w.source_id).await.unwrap()
    }

    #[tokio::test]
    async fn server_pages_are_bounded_complete_and_revision_source_filter_bound() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = many_changes(&store).await;
        let mut q = ReviewQuery {
            view: Some("structure".into()),
            limit: Some(50),
            ..Default::default()
        };
        let p1 = page_workspace(w.clone(), &q).unwrap();
        assert_eq!(p1.total, 125);
        assert_eq!(p1.pending_count, 126);
        assert_eq!(p1.workspace.items.len(), 50);
        assert!(p1.workspace.events.is_empty());
        let mut keys = p1
            .workspace
            .items
            .iter()
            .map(|i| i.key.clone())
            .collect::<Vec<_>>();
        q.cursor = p1.next_cursor.clone();
        let p2 = page_workspace(w.clone(), &q).unwrap();
        keys.extend(p2.workspace.items.iter().map(|i| i.key.clone()));
        q.cursor = p2.next_cursor.clone();
        let p3 = page_workspace(w.clone(), &q).unwrap();
        keys.extend(p3.workspace.items.iter().map(|i| i.key.clone()));
        assert!(p3.next_cursor.is_none());
        assert_eq!(p3.workspace.items.len(), 25);
        assert_eq!(
            keys.iter().collect::<std::collections::HashSet<_>>().len(),
            125
        );
        let mut other = w.clone();
        other.source_id = Uuid::new_v4();
        assert!(page_workspace(other, &q).is_err());
        let mut changed = w.clone();
        changed.revision = "new".into();
        assert!(page_workspace(changed, &q).is_err());
        q.search = Some("added".into());
        assert!(page_workspace(w.clone(), &q).is_err());
        q.cursor = None;
        q.search = Some("added_123".into());
        let result = page_workspace(w.clone(), &q).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.pending_count, 126);
        q.limit = Some(101);
        assert!(page_workspace(w, &q).is_err());
    }

    #[tokio::test]
    async fn structure_batch_is_atomic_idempotent_and_never_confirms_descriptions() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = many_changes(&store).await;
        let keys: Vec<_> = w
            .items
            .iter()
            .filter(|i| i.kind == "structure")
            .take(50)
            .map(|i| i.key.clone())
            .collect();
        let mut req = request(&w, "seenBatch", None, "");
        req.item_keys = keys.clone();
        for bad_keys in [
            vec![keys[0].clone(), keys[0].clone()],
            vec!["structure:missing".into()],
            Vec::new(),
            w.items
                .iter()
                .filter(|i| i.kind == "structure")
                .take(101)
                .map(|i| i.key.clone())
                .collect(),
        ] {
            let mut bad = req.clone();
            bad.item_keys = bad_keys;
            assert!(store.apply_change_review(&bad).await.is_err());
            assert_eq!(
                store.change_review(w.source_id).await.unwrap().revision,
                w.revision
            );
        }
        let mut invalid = req.clone();
        invalid.item_keys.push(
            w.items
                .iter()
                .find(|i| i.kind == "annotation")
                .unwrap()
                .key
                .clone(),
        );
        assert!(store.apply_change_review(&invalid).await.is_err());
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().revision,
            w.revision
        );
        let after = store.apply_change_review(&req).await.unwrap();
        assert_eq!(
            after
                .items
                .iter()
                .filter(|i| i.status == "resolved")
                .count(),
            50
        );
        assert!(
            after
                .items
                .iter()
                .any(|i| i.kind == "annotation" && i.status == "open")
        );
        assert_eq!(after.events.last().unwrap().items.len(), 50);
        assert_eq!(
            store.apply_change_review(&req).await.unwrap().events.len(),
            after.events.len()
        );
        assert!(
            store
                .apply_change_review(&request(&after, "complete", None, ""))
                .await
                .is_err()
        );
        assert!(
            store
                .confirmed_annotations(w.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        let mut stale = req.clone();
        stale.operation_id = Uuid::new_v4();
        assert!(store.apply_change_review(&stale).await.is_err());
    }

    #[tokio::test]
    async fn round_actions_reject_item_selectors_without_writes() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let snapshot = fixture(Uuid::new_v4(), false);
        store.save_captured_snapshot(&snapshot).await.unwrap();
        let w = store.change_review(snapshot.source_id).await.unwrap();
        for verb in ["start", "restart", "complete"] {
            let mut req = request(&w, verb, None, "scope changed");
            req.item_key = Some("domain:unexpected".into());
            assert!(store.apply_change_review(&req).await.is_err());
            assert_eq!(
                store.change_review(w.source_id).await.unwrap().revision,
                w.revision
            );
        }
        let w = many_changes(&store).await;
        let i = w.items.iter().find(|i| i.kind == "structure").unwrap();
        assert!(
            store
                .apply_change_review(&request(&w, "restart", Some(i), "scope changed"))
                .await
                .is_err()
        );
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().revision,
            w.revision
        );
    }

    #[tokio::test]
    async fn restart_cannot_relabel_old_connection_evidence_or_bypass_failed_capture() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        sqlx::query("UPDATE change_review_receipts SET payload_json=? WHERE source_id=?")
            .bind(json!({"status":"success", "identity":"previous-connection"}).to_string())
            .bind(w.source_id.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        assert!(
            store
                .apply_change_review(&request(&w, "restart", None, "new connection"))
                .await
                .is_err()
        );
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().revision,
            w.revision
        );
        store
            .record_review_capture_failure(w.source_id)
            .await
            .unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        assert!(
            store
                .apply_change_review(&request(&w, "restart", None, "retry"))
                .await
                .is_err()
        );
        store
            .save_captured_snapshot(&fixture(w.source_id, false))
            .await
            .unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        let restarted = action(&store, &w, "restart", None, "fresh capture").await;
        assert!(!restarted.completed);
        assert!(
            restarted
                .items
                .iter()
                .any(|i| i.kind == "annotation" && i.status != "resolved")
        );
    }

    #[tokio::test]
    async fn legacy_round_events_cannot_resolve_items() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = many_changes(&store).await;
        let i = w
            .items
            .iter()
            .find(|i| i.kind == "structure")
            .unwrap()
            .clone();
        let event = ReviewEvent {
            round_id: w.round_id.unwrap(),
            id: Uuid::new_v4(),
            at: Utc::now().to_rfc3339(),
            action: "restart".into(),
            item: Some(i.clone()),
            text: "legacy malformed selector".into(),
            items: vec![],
            restorable: false,
        };
        sqlx::query("INSERT INTO change_review_events VALUES(?,?,?,?,?)")
            .bind(event.id.to_string())
            .bind(w.source_id.to_string())
            .bind(event.round_id.to_string())
            .bind("legacy")
            .bind(serde_json::to_string(&event).unwrap())
            .execute(&store.pool)
            .await
            .unwrap();
        let current = store.change_review(w.source_id).await.unwrap();
        assert_eq!(
            current
                .items
                .iter()
                .find(|it| it.key == i.key)
                .unwrap()
                .status,
            "open"
        );
    }

    #[tokio::test]
    async fn history_search_finds_batch_members_case_insensitively() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = many_changes(&store).await;
        let i = w
            .items
            .iter()
            .find(|i| i.title.ends_with("added_123"))
            .unwrap();
        let mut req = request(&w, "seenBatch", None, "");
        req.item_keys = vec![i.key.clone()];
        let w = store.apply_change_review(&req).await.unwrap();
        let page = page_workspace(
            w,
            &ReviewQuery {
                view: Some("events".into()),
                search: Some("ADDED_123".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.workspace.events[0].id, req.operation_id);
        assert_eq!(page.pending_count, 125);
    }

    #[tokio::test]
    async fn archive_restore_reopens_completed_round_without_resurrecting_confirmation() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let w = action(
            &store,
            &w,
            "confirm",
            Some(&w.items[0]),
            "Every payment belongs to an order.",
        )
        .await;
        let mut a = store.list_annotations(w.source_id).await.unwrap().remove(0);
        a.description = Some("Revised statement".into());
        store.save_annotation(&a).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        let w = action(
            &store,
            &w,
            "archive",
            Some(&w.items[0]),
            "Archive before rewrite",
        )
        .await;
        let archived = w.events.last().unwrap().id;
        assert!(w.events.last().unwrap().restorable);
        let w = action(&store, &w, "complete", None, "").await;
        let mut restore = request(&w, "restore", None, "");
        restore.item_key = Some(archived.to_string());
        let next = store.apply_change_review(&restore).await.unwrap();
        assert!(!next.completed);
        assert_eq!(next.baseline, w.baseline);
        assert_ne!(next.round_id, w.round_id);
        assert!(
            store
                .confirmed_annotations(w.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(next.items.iter().any(|i| i.kind == "annotation"));
        assert!(
            !next
                .events
                .iter()
                .find(|e| e.id == archived)
                .unwrap()
                .restorable
        );
        assert_eq!(
            store
                .apply_change_review(&restore)
                .await
                .unwrap()
                .events
                .len(),
            next.events.len()
        );
        let a = store.list_annotations(w.source_id).await.unwrap().remove(0);
        assert_eq!(a.description.as_deref(), Some("Revised statement"));
        assert_eq!(a.tags, vec!["billing"]);
        let mut again = request(&next, "restore", None, "");
        again.item_key = Some(archived.to_string());
        assert!(store.apply_change_review(&again).await.is_err());
    }

    #[tokio::test]
    async fn restore_rejects_overwrite_and_missing_target_stays_unavailable() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = setup(&store).await;
        let w = action(&store, &w, "archive", Some(&w.items[0]), "Retired").await;
        let archived = w.events.last().unwrap().id;
        let mut a = store.list_annotations(w.source_id).await.unwrap().remove(0);
        a.description = Some("Newer authored text".into());
        store.save_annotation(&a).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        let mut restore = request(&w, "restore", None, "");
        restore.item_key = Some(archived.to_string());
        assert!(store.apply_change_review(&restore).await.is_err());
        let w = action(
            &store,
            &w,
            "archive",
            w.items.iter().find(|i| i.kind == "annotation"),
            "Archive newer text",
        )
        .await;
        let latest = w.events.last().unwrap().id;
        let mut missing = fixture(w.source_id, true);
        missing.schemas[0].tables.clear();
        missing.canonicalize().unwrap();
        store.save_captured_snapshot(&missing).await.unwrap();
        let w = store.change_review(w.source_id).await.unwrap();
        let mut restore = request(&w, "restore", None, "");
        restore.item_key = Some(latest.to_string());
        let next = store.apply_change_review(&restore).await.unwrap();
        assert!(next.items.iter().any(|i| i.kind == "annotation"
            && i.reason == "notObserved"
            && !i.actions.contains(&"confirm".into())));
    }

    #[tokio::test]
    async fn archive_restore_and_batch_roll_back_if_audit_fails() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let w = many_changes(&store).await;
        let w = action(
            &store,
            &w,
            "archive",
            w.items.iter().find(|i| i.kind == "annotation"),
            "Retired",
        )
        .await;
        let mut restore = request(&w, "restore", None, "");
        restore.item_key = Some(w.events.last().unwrap().id.to_string());
        let queued = store.pending_sync().await.unwrap();
        sqlx::query("CREATE TRIGGER fail_review_extension BEFORE INSERT ON change_review_events BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END").execute(&store.pool).await.unwrap();
        assert!(store.apply_change_review(&restore).await.is_err());
        let mut batch = request(&w, "seenBatch", None, "");
        batch.item_keys = w
            .items
            .iter()
            .filter(|i| i.kind == "structure")
            .take(2)
            .map(|i| i.key.clone())
            .collect();
        assert!(store.apply_change_review(&batch).await.is_err());
        assert_eq!(
            store.change_review(w.source_id).await.unwrap().revision,
            w.revision
        );
        assert!(
            store.list_annotations(w.source_id).await.unwrap()[0]
                .description
                .is_none()
        );
        assert_eq!(store.pending_sync().await.unwrap(), queued);
    }
    #[tokio::test]
    async fn history_pages_include_old_archives_without_sending_all_audit_evidence() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let mut w = setup(&store).await;
        for n in 0..55 {
            w = action(
                &store,
                &w,
                "defer",
                Some(&w.items[0]),
                &format!("history {n:02}"),
            )
            .await;
        }
        let query = ReviewQuery {
            view: Some("events".into()),
            limit: Some(50),
            ..Default::default()
        };
        let first = page_workspace(w.clone(), &query).unwrap();
        assert!(first.workspace.items.is_empty());
        assert_eq!(first.workspace.events.len(), 50);
        assert_eq!(first.total, 56);
        assert_eq!(first.workspace.events[0].text, "history 54");
        let last = page_workspace(
            w.clone(),
            &ReviewQuery {
                cursor: first.next_cursor.clone(),
                ..query.clone()
            },
        )
        .unwrap();
        assert_eq!(last.workspace.events.len(), 6);
        assert!(last.next_cursor.is_none());
        let next = action(&store, &w, "defer", Some(&w.items[0]), "new decision").await;
        assert!(
            page_workspace(
                next,
                &ReviewQuery {
                    cursor: first.next_cursor,
                    ..query
                }
            )
            .is_err()
        );
    }
}
