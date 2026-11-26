//! Logical relationship and relationship-inference commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn validate_logical_relationship(
    input: ValidateLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<RelationshipValidation, String> {
    current_relationship_validation(&state, &input).await
}

#[tauri::command]
pub(crate) async fn list_logical_relationships(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<LogicalRelationship>, String> {
    validated_logical_relationships(&state.store, input.source_id).await
}

pub(crate) async fn validated_logical_relationships(
    store: &LocalSnapshotStore,
    source_id: Uuid,
) -> Result<Vec<LogicalRelationship>, String> {
    let snapshot = store
        .latest_snapshot(source_id)
        .await
        .map_err(safe_store_error)?;
    validate_logical_relationships_for_snapshot(store, source_id, snapshot.as_ref()).await
}

pub(crate) async fn validate_logical_relationships_for_snapshot(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    snapshot: Option<&DatabaseSnapshot>,
) -> Result<Vec<LogicalRelationship>, String> {
    let mut relationships = store
        .list_logical_relationships(source_id)
        .await
        .map_err(safe_store_error)?;
    if let Some(snapshot) = snapshot {
        let all = relationships.clone();
        for relationship in &mut relationships {
            if relationship.status == LogicalRelationshipStatus::Disabled {
                continue;
            }
            let previous = relationship.status;
            relationship.status = validate_relationship_against_snapshot(
                snapshot,
                &all,
                &relationship.source,
                &relationship.target,
                Some(relationship.id),
            )
            .status;
            if relationship.status != previous {
                store
                    .save_logical_relationship(relationship)
                    .await
                    .map_err(safe_store_error)?;
            }
        }
    }
    Ok(relationships)
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn persist_logical_relationship(
    input: SaveLogicalRelationshipInput,
    state: &AppState,
) -> Result<LogicalRelationship, String> {
    let mut source = input.source;
    let mut target = input.target;
    source.canonicalize();
    target.canonicalize();
    let endpoint_too_long = [&source, &target].iter().any(|endpoint| {
        endpoint.schema.len() > 128
            || endpoint.table.len() > 128
            || endpoint.columns.iter().any(|column| column.len() > 128)
    });
    if endpoint_too_long
        || input.name.trim().len() > 160
        || input.note.as_ref().is_some_and(|note| note.len() > 2_000)
        || input.evidence.len() > 20
        || input.evidence.iter().any(|item| item.len() > 500)
    {
        return Err("Logical relationship metadata exceeds the supported size.".into());
    }
    let validation = current_relationship_validation(
        state,
        &ValidateLogicalRelationshipInput {
            source_id: input.source_id,
            source: source.clone(),
            target: target.clone(),
            relationship_id: input.id,
        },
    )
    .await?;
    if validation.duplicate || validation.physical_exists {
        return Err(validation.messages.join(" "));
    }
    if !validation.valid && validation.compatible {
        return Err(validation.messages.join(" "));
    }
    if !validation.compatible && !input.allow_type_mismatch {
        return Err("Source and target types differ. Confirm the mismatch to continue.".into());
    }
    if validation.status == LogicalRelationshipStatus::Orphaned {
        return Err(validation.messages.join(" "));
    }
    let previous = if let Some(id) = input.id {
        state
            .store
            .list_logical_relationships(input.source_id)
            .await
            .map_err(safe_store_error)?
            .into_iter()
            .find(|relationship| relationship.id == id)
    } else {
        None
    };
    if input.id.is_some() && previous.is_none() {
        return Err("The selected logical relationship no longer exists.".into());
    }
    if input.name.trim().is_empty() {
        return Err("A logical relationship requires a name.".into());
    }
    let now = Utc::now();
    let mut relationship = LogicalRelationship {
        id: input.id.unwrap_or_else(Uuid::new_v4),
        source_id: input.source_id,
        name: input.name,
        source,
        target,
        cardinality: input.cardinality,
        status: if input.disabled {
            LogicalRelationshipStatus::Disabled
        } else {
            validation.status
        },
        origin: input.origin.unwrap_or_else(|| {
            previous
                .as_ref()
                .map_or(LogicalRelationshipOrigin::Manual, |value| value.origin)
        }),
        note: input.note,
        evidence: input.evidence,
        created_at: previous.as_ref().map_or(now, |value| value.created_at),
        updated_at: now,
    };
    relationship.canonicalize();
    state
        .store
        .save_logical_relationship(&relationship)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        relationship.source_id,
        "logical_relationship.save",
        &format!(
            "{}:{}",
            relationship.id,
            relationship.updated_at.timestamp_millis()
        ),
        serde_json::to_value(&relationship)
            .map_err(|_| "Unable to record the relationship event.".to_owned())?,
    )
    .await?;
    Ok(relationship)
}

#[tauri::command]
pub(crate) async fn create_logical_relationship(
    input: SaveLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<LogicalRelationship, String> {
    if input.id.is_some() {
        return Err("New logical relationships must not provide an id.".into());
    }
    persist_logical_relationship(input, &state).await
}

#[tauri::command]
pub(crate) async fn update_logical_relationship(
    input: SaveLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<LogicalRelationship, String> {
    if input.id.is_none() {
        return Err("Choose a logical relationship to update.".into());
    }
    persist_logical_relationship(input, &state).await
}

#[tauri::command]
pub(crate) async fn delete_logical_relationship(
    input: DeleteLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let deleted = state
        .store
        .delete_logical_relationship(input.source_id, input.relationship_id)
        .await
        .map_err(safe_store_error)?;
    if deleted {
        enqueue_sync_event(
            &state.store,
            input.source_id,
            "logical_relationship.delete",
            &format!(
                "{}:{}",
                input.relationship_id,
                Utc::now().timestamp_millis()
            ),
            serde_json::json!({ "relationshipId": input.relationship_id }),
        )
        .await?;
    }
    Ok(deleted)
}

#[tauri::command]
pub(crate) async fn ignore_relationship_inference(
    input: IgnoreRelationshipInferenceInput,
    state: State<'_, AppState>,
) -> Result<IgnoredRelationshipInference, String> {
    if input.relationship_key.trim().is_empty() {
        return Err("Choose an inferred relationship to ignore.".into());
    }
    if input.relationship_key.len() > 1_000 {
        return Err("The inferred relationship key is too long.".into());
    }
    let ignored = IgnoredRelationshipInference {
        source_id: input.source_id,
        relationship_key: input.relationship_key.trim().to_owned(),
        ignored_at: Utc::now(),
    };
    state
        .store
        .save_ignored_relationship_inference(&ignored)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        ignored.source_id,
        "logical_relationship.ignore_inference",
        &format!(
            "{}:{}",
            ignored.relationship_key,
            ignored.ignored_at.timestamp_millis()
        ),
        serde_json::to_value(&ignored)
            .map_err(|_| "Unable to record the relationship review.".to_owned())?,
    )
    .await?;
    Ok(ignored)
}

#[tauri::command]
pub(crate) async fn restore_relationship_inference(
    input: IgnoreRelationshipInferenceInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let key = input.relationship_key.trim();
    if key.is_empty() || key.len() > 1_000 {
        return Err("Choose an ignored candidate or naming rule to restore.".into());
    }
    let restored = state
        .store
        .restore_relationship_inference(input.source_id, key)
        .await
        .map_err(safe_store_error)?;
    if restored {
        enqueue_sync_event(
            &state.store,
            input.source_id,
            "logical_relationship.restore_inference",
            &format!(
                "{}:{}:{}",
                input.source_id,
                key,
                Utc::now().timestamp_millis()
            ),
            serde_json::json!({ "sourceId": input.source_id, "relationshipKey": key }),
        )
        .await?;
    }
    Ok(restored)
}

#[tauri::command]
pub(crate) async fn list_ignored_relationship_inferences(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<IgnoredRelationshipInference>, String> {
    state
        .store
        .list_ignored_relationship_inferences(input.source_id)
        .await
        .map_err(safe_store_error)
}

pub(crate) async fn enqueue_sync_event(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    event_kind: &str,
    idempotency_suffix: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    store
        .enqueue_sync(&SyncQueueItem {
            id: Uuid::new_v4(),
            source_id,
            event_kind: event_kind.to_owned(),
            idempotency_key: format!("{source_id}:{event_kind}:{idempotency_suffix}"),
            payload,
            base_version: 0,
            attempts: 0,
            state: "pending".into(),
            created_at: Utc::now().to_rfc3339(),
        })
        .await
        .map_err(safe_store_error)
}

// These legacy entries have no evidence-bound note preview. Never reuse team text here.
pub(crate) fn legacy_explanation_context(
    snapshot: &DatabaseSnapshot,
    input: &ExplainSchemaInput,
    include_comments: bool,
) -> Result<SchemaContext, String> {
    let mut context = match input.target_type.as_str() {
        "domain" => domain_context(
            snapshot,
            input
                .domain_group
                .as_ref()
                .ok_or("A domain explanation requires a domain group.")?,
            &[],
        ),
        "changeSet" => change_context(
            snapshot,
            input
                .change_set
                .as_ref()
                .ok_or("A change explanation requires a change set.")?,
            &[],
        ),
        _ => return Err("Use a prepared, scoped explanation for this target.".into()),
    };
    if !include_comments {
        for table in &mut context.tables {
            table.comment = None;
        }
    }
    Ok(context)
}

pub(crate) fn validate_remote_consent(
    ai: &settings_model::AiSettings,
    consent: Option<&RemoteAiConsent>,
) -> Result<(), String> {
    if ai.provider == AiProviderKind::Offline
        || consent.is_some_and(|c| {
            c.endpoint == ai.endpoint
                && c.model == ai.model
                && c.include_comments == ai.include_comments
        })
    {
        return Ok(());
    }
    Err("Preview and confirm the current AI destination and data scope before sending.".into())
}
