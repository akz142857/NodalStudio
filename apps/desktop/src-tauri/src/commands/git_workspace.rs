//! `.nodalstudio/` Git workspace export, preview and import commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn export_git_workspace(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<ExportReceipt, String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let (_, workspace) = render_local_workspace(&state.store, input.source_id).await?;
    write_workspace(
        std::path::Path::new(input.repository_path.trim()),
        &workspace,
    )
    .map_err(|error| safe_git_workspace_error(&error))
}

pub(crate) async fn render_local_workspace(
    store: &LocalSnapshotStore,
    source_id: Uuid,
) -> Result<(DatabaseSnapshot, WorkspaceFiles), String> {
    let snapshot = store
        .latest_snapshot(source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before exporting Git workspace files.".to_owned())?;
    let annotations = store
        .list_annotations(source_id)
        .await
        .map_err(safe_store_error)?;
    let domain_groups = store
        .list_domain_groups(source_id)
        .await
        .map_err(safe_store_error)?;
    let saved_views = store
        .list_views(source_id)
        .await
        .map_err(safe_store_error)?;
    let provenance = store
        .list_change_provenance(source_id)
        .await
        .map_err(safe_store_error)?;
    let lineage = store
        .list_lineage(source_id)
        .await
        .map_err(safe_store_error)?;
    let relationships = store
        .list_logical_relationships(source_id)
        .await
        .map_err(safe_store_error)?;
    let workspace = render_workspace(&WorkspaceInput {
        snapshot: &snapshot,
        annotations: &annotations,
        domain_groups: &domain_groups,
        saved_views: &saved_views,
        provenance: &provenance,
        lineage: &lineage,
        relationships: &relationships,
    })
    .map_err(|error| safe_git_workspace_error(&error))?;
    Ok((snapshot, workspace))
}

#[tauri::command]
pub(crate) async fn preview_git_export(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<WorkspacePreview, String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let (_, workspace) = render_local_workspace(&state.store, input.source_id).await?;
    preview_workspace(
        std::path::Path::new(input.repository_path.trim()),
        &workspace,
    )
    .map_err(|error| safe_git_workspace_error(&error))
}

#[tauri::command]
pub(crate) async fn preview_git_import(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<GitImportPreview, String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before importing Git workspace files.".to_owned())?;
    let workspace = read_workspace(std::path::Path::new(input.repository_path.trim()))
        .map_err(|error| safe_git_workspace_error(&error))?;
    let local_relationships = state
        .store
        .list_logical_relationships(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let relationship_conflicts = workspace
        .relationships
        .iter()
        .filter_map(|document| {
            let key = logical_relationship_key(&document.from, &document.to);
            local_relationships
                .iter()
                .find(|relationship| relationship.relationship_key() == key)
                .and_then(|relationship| {
                    (relationship.name != document.name
                        || relationship.cardinality != document.cardinality
                        || relationship.note != document.note)
                        .then_some(key)
                })
        })
        .collect();
    Ok(GitImportPreview {
        annotations: workspace
            .semantics
            .iter()
            .map(|document| {
                usize::from(document.value != SemanticValue::default()) + document.members.len()
            })
            .sum(),
        domain_groups: workspace.domain_groups.len(),
        saved_views: workspace.saved_views.len(),
        provenance: workspace.provenance.len(),
        lineage_links: workspace.lineage.len(),
        logical_relationships: workspace.relationships.len(),
        relationship_conflicts,
        fingerprint_matches: snapshot.fingerprint == workspace.manifest.schema_fingerprint,
        workspace_fingerprint: workspace.manifest.schema_fingerprint,
    })
}

#[tauri::command]
pub(crate) async fn import_git_workspace(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<ImportGitWorkspaceResult, String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before importing Git workspace files.".to_owned())?;
    let workspace = read_workspace(std::path::Path::new(input.repository_path.trim()))
        .map_err(|error| safe_git_workspace_error(&error))?;
    let now = Utc::now();
    let imported_annotations =
        import_git_semantics(&state.store, input.source_id, &workspace.semantics, now).await?;
    import_git_domain_groups(&state.store, input.source_id, &workspace.domain_groups, now).await?;
    import_git_saved_views(&state.store, input.source_id, &workspace.saved_views, now).await?;
    import_git_provenance(&state.store, &workspace.provenance, now).await?;
    if !workspace.lineage.is_empty() {
        state
            .store
            .replace_lineage(input.source_id, &workspace.lineage)
            .await
            .map_err(safe_store_error)?;
    }
    let existing_relationships = state
        .store
        .list_logical_relationships(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let mut imported_logical_relationships = 0;
    for document in &workspace.relationships {
        let key = logical_relationship_key(&document.from, &document.to);
        let existing_id = existing_relationships
            .iter()
            .find(|relationship| relationship.relationship_key() == key)
            .map(|relationship| relationship.id);
        persist_logical_relationship(
            SaveLogicalRelationshipInput {
                id: existing_id,
                source_id: input.source_id,
                name: document.name.clone(),
                source: document.from.clone(),
                target: document.to.clone(),
                cardinality: document.cardinality,
                origin: Some(LogicalRelationshipOrigin::Imported),
                note: document.note.clone(),
                evidence: vec!["Imported from .nodalstudio/relationships".into()],
                disabled: false,
                allow_type_mismatch: true,
            },
            &state,
        )
        .await?;
        imported_logical_relationships += 1;
    }
    Ok(ImportGitWorkspaceResult {
        imported_annotations,
        imported_domain_groups: workspace.domain_groups.len(),
        imported_saved_views: workspace.saved_views.len(),
        imported_provenance: workspace.provenance.len(),
        imported_lineage_links: workspace.lineage.len(),
        imported_logical_relationships,
        fingerprint_matches: snapshot.fingerprint == workspace.manifest.schema_fingerprint,
        workspace_fingerprint: workspace.manifest.schema_fingerprint,
    })
}

pub(crate) async fn import_git_semantics(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    semantics: &[SemanticDocument],
    updated_at: chrono::DateTime<Utc>,
) -> Result<usize, String> {
    let mut imported = 0;
    for document in semantics {
        if document.value != SemanticValue::default() {
            store
                .save_annotation(&git_annotation(
                    source_id,
                    document.object.clone(),
                    &document.value,
                    updated_at,
                ))
                .await
                .map_err(safe_store_error)?;
            imported += 1;
        }
        for (member, value) in &document.members {
            if let Some(column) = member.strip_prefix("column:") {
                store
                    .save_annotation(&git_annotation(
                        source_id,
                        document
                            .object
                            .child(schema_model::ObjectKind::Column, column),
                        value,
                        updated_at,
                    ))
                    .await
                    .map_err(safe_store_error)?;
                imported += 1;
            }
        }
    }
    Ok(imported)
}

pub(crate) async fn import_git_domain_groups(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    documents: &[DomainDocument],
    updated_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    for document in documents {
        let mut group = DomainGroup {
            id: document.id,
            source_id,
            name: document.name.clone(),
            description: document.description.clone(),
            color: document.color.clone(),
            table_keys: document.tables.clone(),
            updated_at,
        };
        group.canonicalize();
        store
            .save_domain_group(&group)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(())
}

pub(crate) async fn import_git_saved_views(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    documents: &[ViewDocument],
    updated_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    for document in documents {
        let mut view = SavedView {
            id: document.id,
            source_id,
            name: document.name.clone(),
            root_table_keys: document.roots.clone(),
            relationship_depth: document.relationship_depth,
            updated_at,
        };
        view.canonicalize();
        store.save_view(&view).await.map_err(safe_store_error)?;
    }
    Ok(())
}

pub(crate) async fn import_git_provenance(
    store: &LocalSnapshotStore,
    documents: &[ProvenanceDocument],
    recorded_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    for document in documents {
        let mut provenance = ChangeProvenance {
            change_set_id: document.change_set_id,
            branch: document.branch.clone(),
            commit_sha: document.commit_sha.clone(),
            pull_request_url: document.pull_request_url.clone(),
            migration_files: document.migration_files.clone(),
            recorded_at,
        };
        provenance.canonicalize();
        store
            .save_change_provenance(&provenance)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(())
}

pub(crate) fn git_annotation(
    source_id: Uuid,
    object_key: schema_model::ObjectKey,
    value: &SemanticValue,
    updated_at: chrono::DateTime<Utc>,
) -> ObjectAnnotation {
    ObjectAnnotation {
        source_id,
        object_key,
        description: value.description.clone(),
        tags: value.tags.iter().cloned().collect(),
        owner: value.owner.clone(),
        is_core: value.is_core,
        updated_at,
    }
}
