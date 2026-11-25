//! Settings file and portable backup import/export commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn export_settings_file(
    input: SettingsFileInput,
    state: State<'_, AppState>,
) -> Result<SettingsFileReceipt, String> {
    let path = validate_settings_file_path(&input.path)?;
    let _access = file_access::access(&path)?;
    let mut bundle = SettingsExportBundle {
        format_version: settings_model::SETTINGS_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        app: state
            .store
            .get_app_settings()
            .await
            .map_err(safe_store_error)?,
        sources: state
            .store
            .list_data_source_settings()
            .await
            .map_err(safe_store_error)?,
    };
    bundle.sanitize();
    let payload = serde_json::to_string_pretty(&bundle)
        .map_err(|_| "Unable to serialize the non-sensitive settings bundle.".to_owned())?;
    fs::write(&path, format!("{payload}\n"))
        .map_err(|_| "Unable to write the settings export file.".to_owned())?;
    Ok(SettingsFileReceipt {
        path: path.to_string_lossy().into_owned(),
        source_settings: bundle.sources.len(),
    })
}

#[tauri::command]
pub(crate) async fn import_settings_file(
    input: SettingsFileInput,
    state: State<'_, AppState>,
) -> Result<SettingsFileReceipt, String> {
    let path = validate_settings_file_path(&input.path)?;
    let _access = file_access::access(&path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 2 * 1024 * 1024) {
        return Err("Choose an existing settings JSON file smaller than 2 MB.".into());
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| "Unable to read the settings import file.".to_owned())?;
    let mut bundle: SettingsExportBundle = serde_json::from_str(&payload)
        .map_err(|_| "The settings import file is invalid.".to_owned())?;
    bundle
        .validate()
        .map_err(|error| format!("Invalid settings import: {error}"))?;
    bundle.sanitize();
    state
        .store
        .save_app_settings(&bundle.app)
        .await
        .map_err(safe_store_error)?;
    for source in &mut bundle.sources {
        let local = state
            .store
            .get_data_source_settings(source.source_id)
            .await
            .map_err(safe_store_error)?;
        source.preserve_local_bindings(&local);
        state
            .store
            .save_data_source_settings(source)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(SettingsFileReceipt {
        path: path.to_string_lossy().into_owned(),
        source_settings: bundle.sources.len(),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn preview_settings_file(
    input: SettingsFileInput,
) -> Result<SettingsFilePreview, String> {
    let path = validate_settings_file_path(&input.path)?;
    let _access = file_access::access(&path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 2 * 1024 * 1024) {
        return Err("Choose an existing settings JSON file smaller than 2 MB.".into());
    }
    let payload = fs::read_to_string(path)
        .map_err(|_| "Unable to read the settings import file.".to_owned())?;
    let mut bundle: SettingsExportBundle = serde_json::from_str(&payload)
        .map_err(|_| "The settings import file is invalid.".to_owned())?;
    bundle
        .validate()
        .map_err(|error| format!("Invalid settings import: {error}"))?;
    bundle.sanitize();
    Ok(SettingsFilePreview {
        format_version: bundle.format_version,
        exported_at: bundle.exported_at,
        source_settings: bundle.sources.len(),
        replaces_app_settings: true,
        credentials_included: false,
    })
}

pub(crate) fn validate_settings_file_path(value: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(value.trim());
    if !path.is_absolute()
        || path.extension().and_then(std::ffi::OsStr::to_str) != Some("json")
        || path.parent().is_none_or(|parent| !parent.is_dir())
    {
        return Err("Choose an absolute .json path inside an existing directory.".into());
    }
    Ok(path)
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub(crate) async fn export_portable_backup(
    input: BackupFileInput,
    state: State<'_, AppState>,
) -> Result<BackupReceipt, String> {
    let source_id = input
        .source_id
        .ok_or_else(|| "Choose an active data source before exporting a backup.".to_owned())?;
    let path = validate_backup_file_path(&input.path)?;
    let _access = file_access::access(&path)?;
    let snapshots = state
        .store
        .list_snapshot_models(source_id)
        .await
        .map_err(safe_store_error)?;
    let mut change_sets = std::collections::BTreeMap::new();
    for snapshot in &snapshots {
        for change_set in state
            .store
            .change_sets_for_snapshot(snapshot.id)
            .await
            .map_err(safe_store_error)?
        {
            change_sets.insert(change_set.id, change_set);
        }
    }
    let saved_views = state
        .store
        .list_views(source_id)
        .await
        .map_err(safe_store_error)?;
    let mut layouts = Vec::new();
    if let Some(layout) = state
        .store
        .get_layout(source_id, None)
        .await
        .map_err(safe_store_error)?
    {
        layouts.push(layout);
    }
    for view in &saved_views {
        if let Some(layout) = state
            .store
            .get_layout(source_id, Some(view.id))
            .await
            .map_err(safe_store_error)?
        {
            layouts.push(layout);
        }
    }
    let mut source_settings = state
        .store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    source_settings.ai.credential_configured = false;
    source_settings.cloud.credential_configured = false;
    let bundle = PortableBackup {
        format_version: settings_model::SETTINGS_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        source_id,
        source_profile: state
            .store
            .get_data_source(source_id)
            .await
            .map_err(safe_store_error)?
            .map(|mut profile| {
                profile.sqlite = None;
                profile
            }),
        source_settings,
        snapshots,
        change_sets: change_sets.into_values().collect(),
        annotations: state
            .store
            .list_annotations(source_id)
            .await
            .map_err(safe_store_error)?,
        domain_groups: state
            .store
            .list_domain_groups(source_id)
            .await
            .map_err(safe_store_error)?,
        saved_views,
        layouts,
        provenance: state
            .store
            .list_change_provenance(source_id)
            .await
            .map_err(safe_store_error)?,
        lineage: state
            .store
            .list_lineage(source_id)
            .await
            .map_err(safe_store_error)?,
        logical_relationships: state
            .store
            .list_logical_relationships(source_id)
            .await
            .map_err(safe_store_error)?,
        ignored_relationship_inferences: state
            .store
            .list_ignored_relationship_inferences(source_id)
            .await
            .map_err(safe_store_error)?,
    };
    let payload = serde_json::to_string(&bundle)
        .map_err(|_| "Unable to serialize the portable model backup.".to_owned())?;
    fs::write(&path, payload)
        .map_err(|_| "Unable to write the portable backup file.".to_owned())?;
    Ok(BackupReceipt {
        path: path.to_string_lossy().into_owned(),
        snapshots: bundle.snapshots.len(),
        annotations: bundle.annotations.len(),
        saved_views: bundle.saved_views.len(),
    })
}

#[tauri::command]
pub(crate) async fn import_portable_backup(
    input: BackupFileInput,
    state: State<'_, AppState>,
) -> Result<BackupReceipt, String> {
    let path = validate_backup_file_path(&input.path)?;
    let _access = file_access::access(&path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 100 * 1024 * 1024) {
        return Err("Choose an existing portable backup smaller than 100 MB.".into());
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| "Unable to read the portable backup file.".to_owned())?;
    let mut bundle: PortableBackup =
        serde_json::from_str(&payload).map_err(|_| "The portable backup is invalid.".to_owned())?;
    validate_portable_backup(&bundle)?;
    bundle.source_settings.ai.credential_configured = false;
    bundle.source_settings.cloud.credential_configured = false;
    state
        .store
        .import_portable_model(&bundle)
        .await
        .map_err(safe_store_error)?;
    Ok(BackupReceipt {
        path: path.to_string_lossy().into_owned(),
        snapshots: bundle.snapshots.len(),
        annotations: bundle.annotations.len(),
        saved_views: bundle.saved_views.len(),
    })
}

#[tauri::command]
pub(crate) async fn preview_portable_backup(
    input: BackupFileInput,
    state: State<'_, AppState>,
) -> Result<BackupPreview, String> {
    let path = validate_backup_file_path(&input.path)?;
    let _access = file_access::access(&path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 100 * 1024 * 1024) {
        return Err("Choose an existing portable backup smaller than 100 MB.".into());
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| "Unable to read the portable backup file.".to_owned())?;
    let bundle: PortableBackup =
        serde_json::from_str(&payload).map_err(|_| "The portable backup is invalid.".to_owned())?;
    validate_portable_backup(&bundle)?;
    let database = bundle.snapshots.first().map(|snapshot| &snapshot.database);
    Ok(BackupPreview {
        format_version: bundle.format_version,
        exported_at: bundle.exported_at,
        source_id: bundle.source_id,
        source_label: bundle
            .source_profile
            .as_ref()
            .map(|profile| profile.display_name.clone()),
        database_name: database.map(|database| database.name.clone()),
        database_type: database.map(|database| database.database_type),
        snapshots: bundle.snapshots.len(),
        annotations: bundle.annotations.len(),
        saved_views: bundle.saved_views.len(),
        will_update_existing_source: state
            .store
            .get_data_source(bundle.source_id)
            .await
            .map_err(safe_store_error)?
            .is_some(),
        conflict_strategy: "Local connection and service settings are preserved. New sources stay offline until configured. Cross-source ID conflicts reject the entire import.",
    })
}

pub(crate) fn validate_backup_file_path(value: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(value.trim());
    let extension = path.extension().and_then(std::ffi::OsStr::to_str);
    if !path.is_absolute()
        || !matches!(extension, Some("nodalmodel" | "sqlaimodel"))
        || path.parent().is_none_or(|parent| !parent.is_dir())
    {
        return Err("Choose an absolute .nodalmodel path inside an existing directory.".into());
    }
    Ok(path)
}

pub(crate) fn validate_portable_backup(bundle: &PortableBackup) -> Result<(), String> {
    let snapshot_ids = bundle
        .snapshots
        .iter()
        .map(|snapshot| snapshot.id)
        .collect::<BTreeSet<_>>();
    let change_set_ids = bundle
        .change_sets
        .iter()
        .map(|change_set| change_set.id)
        .collect::<BTreeSet<_>>();
    if bundle.format_version != settings_model::SETTINGS_SCHEMA_VERSION
        || bundle.source_settings.source_id != bundle.source_id
        || bundle
            .source_profile
            .as_ref()
            .is_some_and(|profile| profile.id != bundle.source_id)
        || bundle
            .snapshots
            .iter()
            .any(|snapshot| snapshot.source_id != bundle.source_id)
        || bundle
            .annotations
            .iter()
            .any(|annotation| annotation.source_id != bundle.source_id)
        || bundle
            .domain_groups
            .iter()
            .any(|group| group.source_id != bundle.source_id)
        || bundle
            .saved_views
            .iter()
            .any(|view| view.source_id != bundle.source_id)
        || bundle
            .layouts
            .iter()
            .any(|layout| layout.source_id != bundle.source_id)
        || bundle
            .logical_relationships
            .iter()
            .any(|relationship| relationship.source_id != bundle.source_id)
        || bundle
            .ignored_relationship_inferences
            .iter()
            .any(|ignored| ignored.source_id != bundle.source_id)
        || bundle.change_sets.iter().any(|change_set| {
            !snapshot_ids.contains(&change_set.before_snapshot_id)
                || !snapshot_ids.contains(&change_set.after_snapshot_id)
        })
        || bundle
            .provenance
            .iter()
            .any(|provenance| !change_set_ids.contains(&provenance.change_set_id))
    {
        return Err(
            "The portable backup has an unsupported version, mixed source IDs, or broken references."
                .into(),
        );
    }
    bundle
        .source_settings
        .validate()
        .map_err(|error| format!("Invalid source settings in backup: {error}"))
}
