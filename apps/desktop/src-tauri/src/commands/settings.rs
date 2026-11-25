//! App, data-source and organization settings commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn get_settings(
    input: SettingsInput,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    effective_settings(&state.store, input.source_id).await
}

pub(crate) async fn effective_settings(
    store: &LocalSnapshotStore,
    source_id: Option<Uuid>,
) -> Result<EffectiveSettings, String> {
    let app = store.get_app_settings().await.map_err(safe_store_error)?;
    let source = if let Some(source_id) = source_id {
        Some(
            store
                .get_data_source_settings(source_id)
                .await
                .map_err(safe_store_error)?,
        )
    } else {
        None
    };
    let project = if let Some(project_id) = source
        .as_ref()
        .map(|settings| settings.cloud.project_id.trim())
        .filter(|project_id| !project_id.is_empty())
    {
        store
            .get_project_settings(project_id)
            .await
            .map_err(safe_store_error)?
    } else {
        None
    };
    let mut policy = store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    if policy.expires_at.as_deref().is_some_and(|value| {
        chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|expires| expires <= Utc::now())
    }) {
        policy = OrganizationPolicy::default();
    }
    Ok(apply_settings_layers(app, source, project, &policy))
}

#[tauri::command]
pub(crate) async fn update_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    settings
        .validate()
        .map_err(|error| format!("Invalid settings: {error}"))?;
    state
        .store
        .save_app_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    let policy = state
        .store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_policy(settings, None, &policy))
}

#[tauri::command]
pub(crate) async fn update_data_source_settings(
    settings: DataSourceSettings,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    settings
        .validate()
        .map_err(|error| format!("Invalid settings: {error}"))?;
    state
        .store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    let policy = state
        .store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_policy(app, Some(settings), &policy))
}

#[tauri::command]
pub(crate) async fn reset_app_settings(
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    update_app_settings(AppSettings::default(), state).await
}

#[tauri::command]
pub(crate) async fn reset_data_source_settings(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    update_data_source_settings(DataSourceSettings::defaults_for(input.source_id), state).await
}

#[tauri::command]
pub(crate) async fn update_organization_policy(
    policy: OrganizationPolicy,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    state
        .store
        .save_organization_policy(&policy)
        .await
        .map_err(safe_store_error)?;
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_policy(app, None, &policy))
}

#[tauri::command]
pub(crate) async fn refresh_organization_policy(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Organization policy refresh is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    if cloud.endpoint.trim().is_empty() || cloud.team_id.trim().is_empty() {
        return Err("Configure a Cloud endpoint and Team ID before refreshing policy.".into());
    }
    let mut endpoint = reqwest::Url::parse(cloud.endpoint.trim())
        .map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() != "https" && !local_development {
        return Err("Cloud policy refresh requires HTTPS outside local development.".into());
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    let team_id = Uuid::parse_str(cloud.team_id.trim())
        .map_err(|_| "Team ID must be a valid UUID.".to_owned())?;
    let endpoint = endpoint
        .join(&format!("v1/teams/{team_id}/policy"))
        .map_err(|_| "Cloud API URL cannot form a policy endpoint.".to_owned())?;
    let access_token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure the Cloud token before refreshing policy.".to_owned())?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let policy = cloud_http_client()?
        .get(endpoint)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "Cloud policy endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the organization policy request.".to_owned())?
        .json::<OrganizationPolicy>()
        .await
        .map_err(|_| "Cloud returned an invalid organization policy.".to_owned())?;
    state
        .store
        .save_organization_policy(&policy)
        .await
        .map_err(safe_store_error)?;
    effective_settings(&state.store, Some(input.source_id)).await
}
