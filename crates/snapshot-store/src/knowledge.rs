//! All mutation paths share database triggers; local confirmations never travel in exports.
use crate::{LocalSnapshotStore, SnapshotStoreError, deserialize_payloads};
use chrono::Utc;
use schema_model::{DatabaseSnapshot, LogicalRelationship, ObjectKey};
use semantic_model::{
    ObjectAnnotation,
    knowledge::{
        KnowledgeBasis, KnowledgeConfirmation, KnowledgeOrigin, KnowledgeState, KnowledgeStatus,
        annotation_version, digest, owning_table, source_identity,
    },
};
use sqlx::{Row, Sqlite, Transaction};
use uuid::Uuid;

type Result<T> = std::result::Result<T, SnapshotStoreError>;
fn conflict(message: &str) -> SnapshotStoreError {
    SnapshotStoreError::KnowledgeConflict(message.into())
}

impl LocalSnapshotStore {
    pub(super) async fn initialize_knowledge(&self) -> Result<()> {
        for statement in [
            "CREATE TABLE IF NOT EXISTS annotation_confirmations (source_id TEXT NOT NULL, object_key TEXT NOT NULL, payload_json TEXT NOT NULL, invalid_reason TEXT, PRIMARY KEY(source_id,object_key))",
            "CREATE TRIGGER IF NOT EXISTS annotation_text_changed AFTER UPDATE ON object_annotations WHEN json_extract(OLD.payload_json,'$.description') IS NOT json_extract(NEW.payload_json,'$.description') BEGIN UPDATE annotation_confirmations SET invalid_reason='Description changed; review the final text on this device.' WHERE source_id=NEW.source_id AND object_key=NEW.object_key; END",
            "CREATE TRIGGER IF NOT EXISTS annotation_removed AFTER DELETE ON object_annotations BEGIN DELETE FROM annotation_confirmations WHERE source_id=OLD.source_id AND object_key=OLD.object_key; END",
            // Only existing dependencies are downgraded; unrelated relationship edits stay unrelated.
            "CREATE TRIGGER IF NOT EXISTS knowledge_relation_changed AFTER UPDATE ON logical_relationships WHEN json_extract(OLD.payload_json,'$.sourceId','$.source','$.target','$.cardinality','$.status') IS NOT json_extract(NEW.payload_json,'$.sourceId','$.source','$.target','$.cardinality','$.status') BEGIN UPDATE annotation_confirmations SET invalid_reason='A supporting logical relationship changed.' WHERE source_id=OLD.source_id AND EXISTS (SELECT 1 FROM json_each(annotation_confirmations.payload_json,'$.basis.relationships') WHERE json_extract(value,'$[0]')=OLD.id); END",
            "CREATE TRIGGER IF NOT EXISTS knowledge_relation_removed AFTER DELETE ON logical_relationships BEGIN UPDATE annotation_confirmations SET invalid_reason='A supporting logical relationship was removed.' WHERE source_id=OLD.source_id AND EXISTS (SELECT 1 FROM json_each(annotation_confirmations.payload_json,'$.basis.relationships') WHERE json_extract(value,'$[0]')=OLD.id); END",
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    /// Returns per-object local eligibility, durably downgrading changed dependencies.
    /// # Errors
    /// Returns database or serialization errors.
    pub async fn knowledge_states(&self, source: Uuid) -> Result<Vec<KnowledgeState>> {
        let mut tx = self.pool.begin().await?;
        let states = states_in(&mut tx, source).await?;
        tx.commit().await?;
        Ok(states)
    }

    /// Read descriptions and their local validity from the same transaction.
    /// # Errors
    /// Returns database or serialization errors.
    pub async fn annotation_knowledge(
        &self,
        source: Uuid,
    ) -> Result<(Vec<ObjectAnnotation>, Vec<KnowledgeState>)> {
        let mut tx = self.pool.begin().await?;
        let states = states_in(&mut tx, source).await?;
        let annotations: Vec<ObjectAnnotation> = deserialize_payloads(
            sqlx::query("SELECT payload_json FROM object_annotations WHERE source_id=?")
                .bind(source.to_string())
                .fetch_all(&mut *tx)
                .await?,
        )?;
        tx.commit().await?;
        Ok((annotations, states))
    }

    /// Read locally eligible descriptions. AI consumers must also enforce each basis
    /// against the actual request scope; this filter alone is not a sending policy.
    /// # Errors
    /// Returns database or serialization errors.
    pub async fn confirmed_annotations(&self, source: Uuid) -> Result<Vec<ObjectAnnotation>> {
        let (annotations, states) = self.annotation_knowledge(source).await?;
        Ok(annotations
            .into_iter()
            .filter(|a| {
                states.iter().any(|s| {
                    s.object_key == a.object_key
                        && s.status == KnowledgeStatus::Confirmed
                        && s.confirmation
                            .as_ref()
                            .is_some_and(|c| c.description_digest == digest(&a.description))
                })
            })
            .collect())
    }

    /// Atomically compare the old annotation and evidence, then save only its description
    /// and the local confirmation. Other authored properties are preserved.
    /// # Errors
    /// Rejects concurrent edits, stale evidence, missing objects and unsupported text.
    #[allow(clippy::too_many_arguments)]
    pub async fn confirm_knowledge(
        &self,
        id: Uuid,
        source: Uuid,
        target: &ObjectKey,
        expected_version: &str,
        basis: &KnowledgeBasis,
        text: &str,
        origin: &KnowledgeOrigin,
    ) -> Result<ObjectAnnotation> {
        let text = text.trim();
        if text.is_empty() || text.chars().count() > 2000 {
            return Err(conflict("Use a description of 1–2,000 characters."));
        }
        let mut tx = self.pool.begin().await?;
        let identity = identity_in(&mut tx, source).await?;
        if basis
            .source_identity
            .as_ref()
            .is_some_and(|expected| expected != &identity)
        {
            return Err(conflict(
                "The database connection changed. Review a fresh draft.",
            ));
        }
        let states = states_in(&mut tx, source).await?;
        let mut annotation = annotation_in(&mut tx, source, target).await?;
        // A lost command response can be retried without a duplicate confirmation/write.
        if states.iter().any(|s| {
            s.object_key == *target
                && s.status == KnowledgeStatus::Confirmed
                && s.confirmation
                    .as_ref()
                    .is_some_and(|c| c.id == id && c.final_text == text)
        }) {
            return annotation.ok_or_else(|| conflict("The confirmed object is unavailable."));
        }
        if annotation_version(annotation.as_ref()) != expected_version {
            return Err(conflict(
                "The annotation was edited elsewhere. Reopen the comparison before confirming.",
            ));
        }
        let snapshot = snapshot_in(&mut tx, source)
            .await?
            .ok_or_else(|| conflict("No current snapshot is available."))?;
        if owning_table(&snapshot, target).is_none()
            || !basis.structure_matches(&snapshot, &relationships_in(&mut tx, source).await?)
            || !notes_match(basis, &states)
        {
            return Err(conflict(
                "The target or supporting evidence changed. Review a fresh draft.",
            ));
        }
        if !basis
            .tables
            .iter()
            .any(|(key, _)| Some(key.clone()) == owning_table(&snapshot, target))
        {
            return Err(conflict("The draft has no evidence for its target."));
        }
        // A new confirmation must not invalidate one of the very notes it relies on.
        if basis
            .notes
            .iter()
            .any(|(key, _, _)| key == target || depends_on(key, target, &states, &mut Vec::new()))
        {
            return Err(conflict(
                "This draft depends on circular team notes. Review against structure independently.",
            ));
        }
        let mut annotation = annotation.take().unwrap_or(ObjectAnnotation {
            source_id: source,
            object_key: target.clone(),
            description: None,
            tags: vec![],
            owner: None,
            is_core: false,
            updated_at: Utc::now(),
        });
        annotation.description = Some(text.into());
        annotation.updated_at = Utc::now();
        let mut basis = basis.clone();
        basis.source_identity = Some(identity);
        let record = KnowledgeConfirmation {
            id,
            source_id: source,
            object_key: target.clone(),
            final_text: text.into(),
            description_digest: digest(&annotation.description),
            snapshot_id: snapshot.id,
            fingerprint: snapshot.fingerprint,
            confirmed_at: Utc::now(),
            basis,
            origin: origin.clone(),
        };
        sqlx::query("INSERT INTO object_annotations(source_id,object_key,updated_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(source_id,object_key) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json")
            .bind(source.to_string()).bind(serde_json::to_string(target)?).bind(annotation.updated_at.to_rfc3339()).bind(serde_json::to_string(&annotation)?).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO annotation_confirmations(source_id,object_key,payload_json,invalid_reason) VALUES(?,?,?,NULL) ON CONFLICT(source_id,object_key) DO UPDATE SET payload_json=excluded.payload_json,invalid_reason=NULL")
            .bind(source.to_string()).bind(serde_json::to_string(target)?).bind(serde_json::to_string(&record)?).execute(&mut *tx).await?;
        states_in(&mut tx, source).await?;
        tx.commit().await?;
        Ok(annotation)
    }
}
fn depends_on(
    key: &ObjectKey,
    target: &ObjectKey,
    states: &[KnowledgeState],
    visited: &mut Vec<ObjectKey>,
) -> bool {
    if visited.contains(key) {
        return false;
    }
    visited.push(key.clone());
    states
        .iter()
        .find(|s| &s.object_key == key)
        .and_then(|s| s.confirmation.as_ref())
        .is_some_and(|c| {
            c.basis
                .notes
                .iter()
                .any(|(k, _, _)| k == target || depends_on(k, target, states, visited))
        })
}
fn notes_match(basis: &KnowledgeBasis, states: &[KnowledgeState]) -> bool {
    basis.notes.iter().all(|(key, id, hash)| {
        states.iter().any(|s| {
            s.object_key == *key
                && s.status == KnowledgeStatus::Confirmed
                && s.confirmation
                    .as_ref()
                    .is_some_and(|c| c.id == *id && c.description_digest == *hash)
        })
    })
}
async fn identity_in(tx: &mut Transaction<'_, Sqlite>, source: Uuid) -> Result<String> {
    let row = sqlx::query("SELECT payload_json FROM data_sources WHERE id=?")
        .bind(source.to_string())
        .fetch_optional(&mut **tx)
        .await?;
    let profile: Option<schema_model::DataSourceProfile> = row
        .map(|r| serde_json::from_str(r.get("payload_json")))
        .transpose()?;
    Ok(source_identity(profile.as_ref()))
}
async fn snapshot_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
) -> Result<Option<DatabaseSnapshot>> {
    let row = sqlx::query("SELECT payload_json FROM schema_snapshots WHERE source_id=? ORDER BY captured_at DESC LIMIT 1").bind(source.to_string()).fetch_optional(&mut **tx).await?;
    Ok(row
        .map(|r| serde_json::from_str(r.get("payload_json")))
        .transpose()?)
}
async fn relationships_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
) -> Result<Vec<LogicalRelationship>> {
    deserialize_payloads(
        sqlx::query("SELECT payload_json FROM logical_relationships WHERE source_id=?")
            .bind(source.to_string())
            .fetch_all(&mut **tx)
            .await?,
    )
}
async fn annotation_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
    target: &ObjectKey,
) -> Result<Option<ObjectAnnotation>> {
    let row = sqlx::query(
        "SELECT payload_json FROM object_annotations WHERE source_id=? AND object_key=?",
    )
    .bind(source.to_string())
    .bind(serde_json::to_string(target)?)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row
        .map(|r| serde_json::from_str(r.get("payload_json")))
        .transpose()?)
}

pub(super) async fn states_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
) -> Result<Vec<KnowledgeState>> {
    let annotations: Vec<ObjectAnnotation> = deserialize_payloads(
        sqlx::query(
            "SELECT payload_json FROM object_annotations WHERE source_id=? ORDER BY object_key",
        )
        .bind(source.to_string())
        .fetch_all(&mut **tx)
        .await?,
    )?;
    let rows = sqlx::query(
        "SELECT payload_json,invalid_reason FROM annotation_confirmations WHERE source_id=?",
    )
    .bind(source.to_string())
    .fetch_all(&mut **tx)
    .await?;
    let records: Vec<(KnowledgeConfirmation, Option<String>)> = rows
        .into_iter()
        .map(|r| {
            Ok((
                serde_json::from_str(r.get("payload_json"))?,
                r.get("invalid_reason"),
            ))
        })
        .collect::<Result<_>>()?;
    let identity = identity_in(tx, source).await?;
    let snapshot = snapshot_in(tx, source).await?;
    let logical = relationships_in(tx, source).await?;
    let mut states: Vec<_> = annotations.iter().map(|a| {
        let previous = records.iter().find(|(r, _)| r.object_key == a.object_key);
        let available = snapshot.as_ref().is_some_and(|s| owning_table(s, &a.object_key).is_some());
        let valid = available && previous.is_some_and(|(r, reason)| reason.is_none() && r.basis.source_identity.as_ref() == Some(&identity) && r.source_id == source && r.description_digest == digest(&a.description) && r.basis.structure_matches(snapshot.as_ref().unwrap(), &logical));
        KnowledgeState { source_id: source, object_key: a.object_key.clone(), status: if !available { KnowledgeStatus::Unavailable } else if valid { KnowledgeStatus::Confirmed } else { KnowledgeStatus::PendingReview }, reason: if !available { "The object is missing or cannot be mapped reliably.".into() } else if valid { "Confirmed on this device against current evidence; a team statement, not a database fact.".into() } else { previous.and_then(|(_, r)| r.clone()).unwrap_or_else(|| if previous.is_some() { "Supporting structure or description changed; review required.".into() } else { "No local confirmation. Imported, legacy and unreviewed descriptions require review on this device.".into() }) }, confirmation: previous.map(|(c, _)| c.clone()) }
    }).collect();
    // Propagate invalidation through confirmed semantic dependencies without promoting any record.
    loop {
        let invalid: Vec<_> = states
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                s.status == KnowledgeStatus::Confirmed
                    && !notes_match(&s.confirmation.as_ref().unwrap().basis, &states)
            })
            .map(|(i, _)| i)
            .collect();
        if invalid.is_empty() {
            break;
        }
        for i in invalid {
            states[i].status = KnowledgeStatus::PendingReview;
            states[i].reason = "A supporting team statement needs review or was replaced.".into();
        }
    }
    for s in &states {
        if s.status != KnowledgeStatus::Confirmed && s.confirmation.is_some() {
            sqlx::query("UPDATE annotation_confirmations SET invalid_reason=COALESCE(invalid_reason,?) WHERE source_id=? AND object_key=?").bind(&s.reason).bind(source.to_string()).bind(serde_json::to_string(&s.object_key)?).execute(&mut **tx).await?;
        }
    }
    Ok(states)
}
