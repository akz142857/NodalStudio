//! Annotation, domain group, saved view and layout commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn save_annotation(
    input: SaveAnnotationInput,
    state: State<'_, AppState>,
) -> Result<ObjectAnnotation, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    let mut annotation = ObjectAnnotation {
        source_id: input.source_id,
        object_key: input.object_key,
        description: input.description,
        tags: input.tags,
        owner: input.owner,
        is_core: input.is_core,
        updated_at: Utc::now(),
    };
    annotation.canonicalize();
    state
        .store
        .save_annotation(&annotation)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        annotation.source_id,
        "annotation.save",
        &format!(
            "{}:{}:{}:{}",
            annotation.object_key.kind as u8,
            annotation.object_key.schema,
            annotation.object_key.name,
            annotation.updated_at.timestamp_millis()
        ),
        serde_json::to_value(&annotation)
            .map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await?;
    Ok(annotation)
}

#[tauri::command]
pub(crate) async fn save_domain_group(
    input: SaveDomainGroupInput,
    state: State<'_, AppState>,
) -> Result<DomainGroup, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    if input.name.trim().is_empty() {
        return Err("A domain group requires a name.".into());
    }
    let mut group = DomainGroup {
        id: input.id.unwrap_or_else(Uuid::new_v4),
        source_id: input.source_id,
        name: input.name.trim().to_owned(),
        description: input.description,
        color: input.color,
        table_keys: input.table_keys,
        updated_at: Utc::now(),
    };
    group.canonicalize();
    state
        .store
        .save_domain_group(&group)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        group.source_id,
        "domain.save",
        &format!("{}:{}", group.id, group.updated_at.timestamp_millis()),
        serde_json::to_value(&group).map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await?;
    Ok(group)
}

#[tauri::command]
pub(crate) async fn save_view(
    input: SaveViewInput,
    state: State<'_, AppState>,
) -> Result<SavedView, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    if input.name.trim().is_empty() || input.root_table_keys.is_empty() {
        return Err("A saved view requires a name and at least one root table.".into());
    }
    ensure_current_layout_snapshot(&state.store, input.source_id, input.snapshot_id).await?;
    let mut view = SavedView {
        id: input.id.unwrap_or_else(Uuid::new_v4),
        source_id: input.source_id,
        name: input.name.trim().to_owned(),
        root_table_keys: input.root_table_keys,
        relationship_depth: input.relationship_depth,
        updated_at: Utc::now(),
    };
    view.canonicalize();
    let initial_layout = input.positions.map(|positions| CanvasLayout {
        source_id: view.source_id,
        view_id: Some(view.id),
        positions,
        viewport: input.viewport,
        updated_at: Utc::now(),
    });
    if let Some(layout) = &initial_layout {
        validate_canvas_layout(layout)?;
    }
    state
        .store
        .save_view_workspace(&view, initial_layout.as_ref())
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        view.source_id,
        "view.save",
        &format!("{}:{}", view.id, view.updated_at.timestamp_millis()),
        serde_json::to_value(&view).map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await?;
    Ok(view)
}

pub(crate) async fn ensure_current_layout_snapshot(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    snapshot_id: Option<Uuid>,
) -> Result<(), String> {
    if let Some(id) = snapshot_id
        && store
            .latest_snapshot(source_id)
            .await
            .map_err(safe_store_error)?
            .is_none_or(|snapshot| snapshot.id != id)
    {
        return Err(
            "The model changed. Return to the latest snapshot before saving this workspace.".into(),
        );
    }
    Ok(())
}

pub(crate) fn validate_canvas_layout(layout: &CanvasLayout) -> Result<(), String> {
    if layout.positions.values().any(|p| {
        !p.x.is_finite()
            || !p.y.is_finite()
            || p.width.is_some_and(|v| !v.is_finite() || v <= 0.0)
            || p.height.is_some_and(|v| !v.is_finite() || v <= 0.0)
    }) || layout.viewport.is_some_and(|v| {
        !v.x.is_finite()
            || !v.y.is_finite()
            || !v.zoom.is_finite()
            || !(0.1..=1.8).contains(&v.zoom)
    }) {
        return Err("The layout contains invalid coordinates or zoom.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)] // Match the existing source/view/snapshot IPC contract.
pub(crate) struct DeleteViewInput {
    pub(crate) source_id: Uuid,
    pub(crate) view_id: Uuid,
    pub(crate) snapshot_id: Uuid,
}

#[tauri::command]
pub(crate) async fn delete_view(
    input: DeleteViewInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    ensure_current_layout_snapshot(&state.store, input.source_id, Some(input.snapshot_id)).await?;
    state
        .store
        .delete_view(input.source_id, input.view_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
pub(crate) async fn save_layout(
    input: SaveLayoutInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    ensure_current_layout_snapshot(&state.store, input.source_id, input.snapshot_id).await?;
    if let Some(id) = input.view_id
        && !state
            .store
            .list_views(input.source_id)
            .await
            .map_err(safe_store_error)?
            .iter()
            .any(|view| view.id == id)
    {
        return Err("This saved view no longer exists.".into());
    }
    let layout = CanvasLayout {
        viewport: input.viewport,
        source_id: input.source_id,
        view_id: input.view_id,
        positions: input.positions,
        updated_at: Utc::now(),
    };
    validate_canvas_layout(&layout)?;
    state
        .store
        .save_layout(&layout)
        .await
        .map_err(safe_store_error)?;
    if layout.view_id.is_some() {
        return Ok(());
    }
    let layout = CanvasLayout {
        viewport: None,
        ..layout
    };
    enqueue_sync_event(
        &state.store,
        layout.source_id,
        "layout.save",
        &format!(
            "{}:{}",
            layout
                .view_id
                .map_or_else(|| "default".into(), |id| id.to_string()),
            layout.updated_at.timestamp_millis()
        ),
        serde_json::to_value(&layout).map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await
}

pub(crate) fn relationship_table<'a>(
    snapshot: &'a DatabaseSnapshot,
    endpoint: &RelationshipEndpoint,
) -> Option<&'a schema_model::TableDefinition> {
    snapshot
        .schemas
        .iter()
        .find(|schema| schema.name == endpoint.schema)
        .and_then(|schema| {
            schema
                .tables
                .iter()
                .find(|table| table.key.name == endpoint.table)
        })
}

pub(crate) fn endpoint_is_unique(
    table: &schema_model::TableDefinition,
    columns: &[String],
) -> bool {
    table
        .primary_key
        .as_ref()
        .is_some_and(|key| key.columns == columns)
        || table
            .indexes
            .iter()
            .any(|index| index.unique && index.columns == columns)
}

pub(crate) fn physical_relationship_exists(
    snapshot: &DatabaseSnapshot,
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
) -> bool {
    relationship_table(snapshot, source).is_some_and(|table| {
        table.foreign_keys.iter().any(|foreign_key| {
            foreign_key.columns == source.columns
                && foreign_key.referenced_schema == target.schema
                && foreign_key.referenced_table == target.table
                && foreign_key.referenced_columns == target.columns
        })
    })
}

pub(crate) fn endpoint_column_types(
    snapshot: &DatabaseSnapshot,
    endpoint: &RelationshipEndpoint,
) -> Option<Vec<(String, String, bool)>> {
    let table = relationship_table(snapshot, endpoint)?;
    endpoint
        .columns
        .iter()
        .map(|name| {
            table
                .columns
                .iter()
                .find(|column| &column.name == name)
                .map(|column| {
                    (
                        column.type_schema.to_ascii_lowercase(),
                        column.type_name.to_ascii_lowercase(),
                        column
                            .formatted_type
                            .split_whitespace()
                            .any(|part| part.eq_ignore_ascii_case("unsigned")),
                    )
                })
        })
        .collect()
}

pub(crate) fn suggested_cardinality(
    snapshot: &DatabaseSnapshot,
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
) -> RelationshipCardinality {
    let source_unique = relationship_table(snapshot, source)
        .is_some_and(|table| endpoint_is_unique(table, &source.columns));
    let target_unique = relationship_table(snapshot, target)
        .is_some_and(|table| endpoint_is_unique(table, &target.columns));
    match (source_unique, target_unique) {
        (true, true) => RelationshipCardinality::OneToOne,
        (true, false) => RelationshipCardinality::OneToMany,
        (false, true) => RelationshipCardinality::ManyToOne,
        (false, false) => RelationshipCardinality::Unspecified,
    }
}

pub(crate) fn logical_relationship_key(
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
) -> String {
    format!("{}->{}", source.display_key(), target.display_key())
}

pub(crate) fn validate_relationship_against_snapshot(
    snapshot: &DatabaseSnapshot,
    existing: &[LogicalRelationship],
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
    relationship_id: Option<Uuid>,
) -> RelationshipValidation {
    let mut messages = Vec::new();
    let mut message_codes = Vec::new();
    if source.columns.is_empty()
        || target.columns.is_empty()
        || source.columns.len() != target.columns.len()
    {
        messages.push("Relationship endpoints require the same non-zero number of columns.".into());
        message_codes.push("fieldCount");
        return RelationshipValidation {
            valid: false,
            compatible: false,
            duplicate: false,
            physical_exists: false,
            suggested_cardinality: RelationshipCardinality::Unspecified,
            status: LogicalRelationshipStatus::Orphaned,
            messages,
            message_codes,
        };
    }
    if source == target {
        messages.push("A relationship cannot connect a field to itself.".into());
        message_codes.push("selfReference");
        return RelationshipValidation {
            valid: false,
            compatible: true,
            duplicate: false,
            physical_exists: false,
            suggested_cardinality: RelationshipCardinality::Unspecified,
            status: LogicalRelationshipStatus::Conflicted,
            messages,
            message_codes,
        };
    }
    let source_types = endpoint_column_types(snapshot, source);
    let target_types = endpoint_column_types(snapshot, target);
    if source_types.is_none() || target_types.is_none() {
        messages.push("One or more relationship tables or columns no longer exist.".into());
        message_codes.push("missingField");
        return RelationshipValidation {
            valid: false,
            compatible: false,
            duplicate: false,
            physical_exists: false,
            suggested_cardinality: RelationshipCardinality::Unspecified,
            status: LogicalRelationshipStatus::Orphaned,
            messages,
            message_codes,
        };
    }
    let compatible =
        snapshot.database.database_type == DatabaseType::Sqlite || source_types == target_types;
    if snapshot.database.database_type == DatabaseType::Sqlite {
        messages.push("SQLite logical relationships are model-only; type affinity does not establish physical foreign-key compatibility or enforcement.".into());
    }
    if !compatible {
        messages.push("Source and target column types differ.".into());
        message_codes.push("typeMismatch");
    }
    let physical_exists = physical_relationship_exists(snapshot, source, target);
    if physical_exists {
        messages.push("The database already contains this physical foreign key.".into());
        message_codes.push("physicalExists");
    }
    let key = logical_relationship_key(source, target);
    let duplicate = existing.iter().any(|relationship| {
        Some(relationship.id) != relationship_id && relationship.relationship_key() == key
    });
    if duplicate {
        messages.push("This logical relationship already exists.".into());
        message_codes.push("duplicate");
    }
    let status = if physical_exists {
        LogicalRelationshipStatus::SupersededByPhysical
    } else if compatible {
        LogicalRelationshipStatus::Active
    } else {
        LogicalRelationshipStatus::Conflicted
    };
    RelationshipValidation {
        valid: compatible && !duplicate && !physical_exists,
        compatible,
        duplicate,
        physical_exists,
        suggested_cardinality: suggested_cardinality(snapshot, source, target),
        status,
        messages,
        message_codes,
    }
}

pub(crate) async fn current_relationship_validation(
    state: &AppState,
    input: &ValidateLogicalRelationshipInput,
) -> Result<RelationshipValidation, String> {
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before creating logical relationships.".to_owned())?;
    let existing = state
        .store
        .list_logical_relationships(input.source_id)
        .await
        .map_err(safe_store_error)?;
    Ok(validate_relationship_against_snapshot(
        &snapshot,
        &existing,
        &input.source,
        &input.target,
        input.relationship_id,
    ))
}
