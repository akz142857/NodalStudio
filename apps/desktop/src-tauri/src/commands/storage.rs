//! Local storage usage, cleanup and data-source management commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn get_storage_usage(state: State<'_, AppState>) -> Result<StorageUsage, String> {
    state.store.storage_usage().await.map_err(safe_store_error)
}

#[tauri::command]
pub(crate) async fn clear_layouts(
    input: SettingsInput,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    state
        .store
        .clear_layouts(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
pub(crate) const fn clear_regenerable_cache() -> u64 {
    // Schema models are persisted as history, not cache. This remains an
    // explicit boundary for future thumbnails or derived search indexes.
    0
}

#[tauri::command]
pub(crate) async fn delete_source_data(
    input: DeleteSourceDataInput,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if !input.selection.connection && !input.selection.history && !input.selection.semantics {
        return Err("Select at least one local data category to delete.".into());
    }
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let sqlite_source = profile
        .as_ref()
        .is_some_and(|p| p.database_type == DatabaseType::Sqlite);
    let affected = state
        .store
        .delete_source_data(
            input.source_id,
            input.selection.connection,
            input.selection.history,
            input.selection.semantics,
        )
        .await
        .map_err(safe_store_error)?;
    if input.selection.connection
        && let Some(profile) = &profile
    {
        sqlite_source::revoke_unused_grants(&state, profile).await?;
    }
    if input.remove_database_credential && !sqlite_source {
        delete_secret(KEYRING_SERVICE, input.source_id)?;
        delete_secret(connection_credentials::SSH_SERVICE, input.source_id)?;
    }
    Ok(affected)
}

#[tauri::command]
pub(crate) async fn preview_source_data_deletion(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<SourceDataImpact, String> {
    state
        .store
        .source_data_impact(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
pub(crate) async fn generate_event_trigger_script(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The data source no longer exists.".to_owned())?;
    if profile.database_type != DatabaseType::PostgreSql {
        return Err("Event Trigger enhancement is currently available for PostgreSQL only.".into());
    }
    Ok(EventTriggerPlan {
        schema: "public".into(),
        channel: format!("nodalstudio_{}", input.source_id.simple()),
        enabled: true,
    }
    .review_sql())
}

#[tauri::command]
pub(crate) async fn rename_data_source(
    input: RenameSourceInput,
    state: State<'_, AppState>,
) -> Result<DataSourceProfile, String> {
    if input.display_name.trim().is_empty() {
        return Err("A data source name is required.".into());
    }
    let mut profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The data source no longer exists.".to_owned())?;
    profile.display_name = input.display_name.trim().to_owned();
    profile.updated_at = Utc::now();
    state
        .store
        .save_data_source(&profile)
        .await
        .map_err(safe_store_error)?;
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn duplicate_data_source(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<DataSourceProfile, String> {
    let original = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The data source no longer exists.".to_owned())?;
    let now = Utc::now();
    let id = Uuid::new_v4();
    let copy = DataSourceProfile {
        server_source_id: None,
        sqlite: original.sqlite,
        connection_sync: original
            .connection_sync
            .filter(|identity| identity.pending)
            .map(|identity| schema_model::ConnectionSyncIdentity {
                origin_id: id,
                ..identity
            }),
        id,
        display_name: format!("{} copy", original.display_name),
        host: original.host,
        port: original.port,
        database: original.database,
        username: original.username,
        database_type: original.database_type,
        ssl_mode: original.ssl_mode,
        security: original.security,
        created_at: now,
        updated_at: now,
    };
    state
        .store
        .save_data_source(&copy)
        .await
        .map_err(safe_store_error)?;
    let mut source_settings = state
        .store
        .get_data_source_settings(input.source_id)
        .await
        .map_err(safe_store_error)?;
    source_settings.source_id = copy.id;
    source_settings.ai.credential_configured = false;
    source_settings.cloud.credential_configured = false;
    source_settings.cloud.enabled = false;
    source_settings.cloud.project_id.clear();
    source_settings.cloud.base_version = 0;
    source_settings.cloud.last_success_at = None;
    state
        .store
        .save_data_source_settings(&source_settings)
        .await
        .map_err(safe_store_error)?;
    Ok(copy)
}

#[tauri::command]
pub(crate) async fn factory_reset(
    app: tauri::AppHandle,
    input: FactoryResetInput,
    state: State<'_, AppState>,
    connection_folder: State<'_, connection_sync::folder::FolderRuntime>,
    review: State<'_, code_view::review::ReviewState>,
) -> Result<u64, String> {
    if input.confirmation != "DELETE LOCAL DATA" {
        return Err("Factory reset requires the exact confirmation phrase.".into());
    }
    let _connection_sync =
        connection_sync::folder::prepare_factory_reset(&connection_folder, &state.store).await?;
    let profiles = state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)?;
    for profile in &profiles {
        delete_secret(KEYRING_SERVICE, profile.id)?;
        delete_secret(connection_credentials::SSH_SERVICE, profile.id)?;
        delete_secret(AI_KEYRING_SERVICE, profile.id)?;
        delete_secret(CLOUD_KEYRING_SERVICE, profile.id)?;
        delete_secret(CLOUD_REFRESH_KEYRING_SERVICE, profile.id)?;
    }
    code_view::review::reset_local_data(&app, &review).await;
    #[cfg(all(
        target_os = "macos",
        any(feature = "code-extensions", feature = "mac-app-store")
    ))]
    code_view::extensions::remove_all_storage(&app).await;
    let affected = state
        .store
        .factory_reset()
        .await
        .map_err(safe_store_error)?;
    state.notify_offline(false);
    Ok(affected)
}
