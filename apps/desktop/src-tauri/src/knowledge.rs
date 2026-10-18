//! Explicit, expiring local drafts. No network request and no portable confirmation flags.
use crate::{AppState, safe_store_error, table_understanding::TableAiState};
use schema_model::ObjectKey;
use semantic_model::{
    ObjectAnnotation,
    knowledge::{KnowledgeBasis, KnowledgeOrigin, annotation_version, owning_table},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftInput {
    pub snapshot_id: Uuid,
    pub target: ObjectKey,
    pub request_id: Option<Uuid>,
    pub interpretation_index: Option<usize>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPreview {
    pub id: Uuid,
    pub source_id: Uuid,
    pub snapshot_id: Uuid,
    pub target: ObjectKey,
    pub old_description: Option<String>,
    pub draft_text: String,
    pub expires_at: String,
    pub basis: KnowledgeBasis,
    pub origin: KnowledgeOrigin,
}
struct Draft {
    preview: DraftPreview,
    input: DraftInput,
    version: String,
    created: Instant,
    saved: Option<ObjectAnnotation>,
}
#[derive(Default)]
pub struct KnowledgeDrafts {
    drafts: Mutex<HashMap<Uuid, Draft>>,
}

#[tauri::command]
pub async fn prepare_knowledge_draft(
    input: DraftInput,
    app: State<'_, AppState>,
    answers: State<'_, TableAiState>,
    drafts: State<'_, KnowledgeDrafts>,
) -> Result<DraftPreview, String> {
    let draft = prepare(&input, &app, &answers).await?;
    let preview = draft.preview.clone();
    let mut map = drafts.drafts.lock().await;
    map.retain(|_, value| value.created.elapsed() < Duration::from_mins(5));
    if map.len() >= 16 {
        return Err("Too many drafts are open. Cancel an earlier draft first.".into());
    }
    map.insert(preview.id, draft);
    Ok(preview)
}
#[allow(clippy::too_many_lines)]
async fn prepare(
    input: &DraftInput,
    app: &AppState,
    answers: &TableAiState,
) -> Result<Draft, String> {
    let snapshot = app
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or("The snapshot is unavailable.")?;
    if app
        .store
        .latest_snapshot(snapshot.source_id)
        .await
        .map_err(safe_store_error)?
        .is_none_or(|s| s.id != input.snapshot_id)
    {
        return Err("Knowledge review requires the latest loaded desktop snapshot.".into());
    }
    let profile = app
        .store
        .get_data_source(snapshot.source_id)
        .await
        .map_err(safe_store_error)?;
    let source_identity = semantic_model::knowledge::source_identity(profile.as_ref());
    let target_table = owning_table(&snapshot, &input.target)
        .ok_or("The object is missing or cannot be mapped to a current table.")?;
    let annotation = app
        .store
        .list_annotations(snapshot.source_id)
        .await
        .map_err(safe_store_error)?
        .into_iter()
        .find(|a| a.object_key == input.target);
    let logical = app
        .store
        .list_logical_relationships(snapshot.source_id)
        .await
        .map_err(safe_store_error)?;
    let (text, mut basis, origin, expires_at) = if let Some(request) = input.request_id {
        let (preview, text, origin) = answers
            .draft_source(
                app,
                request,
                input
                    .interpretation_index
                    .ok_or("Choose an interpretation.")?,
            )
            .await?;
        if preview.snapshot_id != snapshot.id
            || preview.source_id != snapshot.source_id
            || preview.context.target != input.target
        {
            return Err("The answer belongs to a different target or snapshot.".into());
        }
        let mut basis = KnowledgeBasis::from_tables(&snapshot, &preview.context.tables, &logical);
        for evidence in preview
            .context
            .evidence
            .iter()
            .filter(|e| e.kind == "teamStatement" && e.object_key != input.target)
        {
            let detail: serde_json::Value = serde_json::from_str(&evidence.detail)
                .map_err(|_| "Invalid team statement evidence.")?;
            basis.notes.push((
                evidence.object_key.clone(),
                serde_json::from_value(detail["confirmationId"].clone())
                    .map_err(|_| "Invalid confirmation identity.")?,
                detail["descriptionDigest"]
                    .as_str()
                    .ok_or("Missing confirmation digest.")?
                    .into(),
            ));
        }
        (text, basis, origin, preview.expires_at)
    } else {
        let basis =
            KnowledgeBasis::from_tables(&snapshot, std::slice::from_ref(&target_table), &logical);
        let evidence = snapshot
            .schemas
            .iter()
            .flat_map(|s| &s.tables)
            .find(|t| t.key == target_table);
        (
            annotation
                .as_ref()
                .and_then(|a| a.description.clone())
                .unwrap_or_default(),
            basis,
            KnowledgeOrigin {
                kind: "manualReview".into(),
                request_id: None,
                provider: None,
                model: None,
                generated_at: None,
                evidence: serde_json::to_value(evidence)
                    .map_err(|_| "Unable to prepare evidence.")?,
            },
            (chrono::Utc::now() + Duration::from_mins(5)).to_rfc3339(),
        )
    };
    basis.source_identity = Some(source_identity);
    Ok(Draft {
        preview: DraftPreview {
            id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            snapshot_id: snapshot.id,
            target: input.target.clone(),
            old_description: annotation.as_ref().and_then(|a| a.description.clone()),
            draft_text: text,
            expires_at,
            basis,
            origin,
        },
        input: input.clone(),
        version: annotation_version(annotation.as_ref()),
        created: Instant::now(),
        saved: None,
    })
}

#[tauri::command]
pub async fn confirm_knowledge_draft(
    id: Uuid,
    text: String,
    app: State<'_, AppState>,
    answers: State<'_, TableAiState>,
    drafts: State<'_, KnowledgeDrafts>,
) -> Result<ObjectAnnotation, String> {
    let mut map = drafts.drafts.lock().await;
    let draft = map
        .get_mut(&id)
        .ok_or("The draft was cancelled. Prepare a new review.")?;
    let _operation = crate::acquire_cloud_operation(&app, draft.preview.source_id).await?;
    if let Some(saved) = &draft.saved {
        if saved.description.as_deref() != Some(text.trim()) {
            return Err("This draft was already confirmed with different text.".into());
        }
        let current = app
            .store
            .list_annotations(saved.source_id)
            .await
            .map_err(safe_store_error)?
            .into_iter()
            .find(|a| a.object_key == saved.object_key);
        let valid = app
            .store
            .knowledge_states(saved.source_id)
            .await
            .map_err(safe_store_error)?
            .iter()
            .any(|state| {
                state.object_key == saved.object_key
                    && state.status == semantic_model::knowledge::KnowledgeStatus::Confirmed
                    && state
                        .confirmation
                        .as_ref()
                        .is_some_and(|record| record.id == id)
            });
        if current.as_ref() != Some(saved) || !valid {
            return Err("The saved description or evidence changed after confirmation. Reload before retrying.".into());
        }
    } else {
        if draft.created.elapsed() >= Duration::from_mins(5) {
            return Err("The draft expired. Review current evidence again.".into());
        }
        if let Some(request) = draft.input.request_id {
            answers
                .draft_source(&app, request, draft.input.interpretation_index.unwrap_or(0))
                .await?;
        }
        let saved = app
            .store
            .confirm_knowledge(
                id,
                draft.preview.source_id,
                &draft.preview.target,
                &draft.version,
                &draft.preview.basis,
                &text,
                &draft.preview.origin,
            )
            .await
            .map_err(|e| match e {
                snapshot_store::SnapshotStoreError::KnowledgeConflict(message) => message,
                other => safe_store_error(other),
            })?;
        draft.saved = Some(saved);
    }
    let saved = draft.saved.as_ref().unwrap();
    crate::enqueue_sync_event(
        &app.store,
        saved.source_id,
        "annotation.save",
        &id.to_string(),
        serde_json::to_value(saved).map_err(|_| "Unable to queue annotation text.")?,
    )
    .await?;
    Ok(saved.clone())
}
#[tauri::command]
pub async fn cancel_knowledge_draft(
    id: Uuid,
    drafts: State<'_, KnowledgeDrafts>,
) -> Result<(), String> {
    drafts.drafts.lock().await.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{
        DataSourceProfile, DatabaseInfo, DatabaseSnapshot, DatabaseType, SchemaDefinition, SslMode,
        TableDefinition,
    };
    use semantic_model::knowledge::KnowledgeStatus;
    use snapshot_store::LocalSnapshotStore;
    use std::sync::Arc;

    #[tokio::test]
    async fn unchanged_verified_capture_can_prepare_and_confirm_a_fresh_review() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source = Uuid::new_v4();
        let table = TableDefinition::empty("public", "orders");
        let target = table.key.clone();
        let mut snapshot = DatabaseSnapshot::new(
            source,
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![table],
                views: vec![],
                enums: vec![],
            }],
        );
        snapshot.canonicalize().unwrap();
        let mut profile = DataSourceProfile {
            id: source,
            display_name: "Original".into(),
            host: "old.example".into(),
            port: 5432,
            database: "app".into(),
            username: "reader".into(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Disable,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store
            .save_verified_source(&profile, &snapshot)
            .await
            .unwrap();
        let app = AppState {
            store,
            ai_limiter: Arc::new(tokio::sync::Semaphore::new(840)),
            snapshot_captures: Arc::default(),
            cloud_operations: Arc::default(),
            active_queries: Arc::default(),
        };
        let answers = TableAiState::default();
        let mut input = DraftInput {
            snapshot_id: snapshot.id,
            target,
            request_id: None,
            interpretation_index: None,
        };
        let original = prepare(&input, &app, &answers).await.unwrap();
        app.store
            .confirm_knowledge(
                original.preview.id,
                source,
                &input.target,
                &original.version,
                &original.preview.basis,
                "Original meaning",
                &original.preview.origin,
            )
            .await
            .unwrap();
        profile.host = "replacement.example".into();
        snapshot.id = Uuid::new_v4();
        snapshot.captured_at = chrono::Utc::now();
        let accepted = app
            .store
            .save_verified_source(&profile, &snapshot)
            .await
            .unwrap();
        assert!(!accepted.stored);
        assert_eq!(
            app.store.knowledge_states(source).await.unwrap()[0].status,
            KnowledgeStatus::PendingReview
        );
        // Desktop returns this persisted result directly to the active UI.
        input.snapshot_id = accepted.snapshot.id;
        let fresh = prepare(&input, &app, &answers).await.unwrap();
        assert_ne!(
            fresh.preview.basis.source_identity,
            original.preview.basis.source_identity
        );
        app.store
            .confirm_knowledge(
                fresh.preview.id,
                source,
                &input.target,
                &fresh.version,
                &fresh.preview.basis,
                "Reviewed replacement meaning",
                &fresh.preview.origin,
            )
            .await
            .unwrap();
        assert_eq!(
            app.store.knowledge_states(source).await.unwrap()[0].status,
            KnowledgeStatus::Confirmed
        );
    }
}
