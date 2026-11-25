//! Cloud account, project, share and audit commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn list_cloud_audit(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<CloudAuditEntry>, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud audit is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let project_id = Uuid::parse_str(cloud.project_id.trim()).map_err(|_| {
        "Configure a valid Cloud Project ID before loading audit events.".to_owned()
    })?;
    let mut endpoint = reqwest::Url::parse(cloud.endpoint.trim())
        .map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() != "https" && !local_development {
        return Err("Cloud audit requires HTTPS outside local development.".into());
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    let endpoint = endpoint
        .join(&format!("v1/projects/{project_id}/audit"))
        .map_err(|_| "Cloud API URL cannot form an audit endpoint.".to_owned())?;
    let token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure the Cloud token before loading audit events.".to_owned())?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    cloud_http_client()?
        .get(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cloud audit endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the audit request.".to_owned())?
        .json::<Vec<CloudAuditEntry>>()
        .await
        .map_err(|_| "Cloud returned invalid audit events.".to_owned())
}

pub(crate) fn cloud_settings_endpoint(base: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut endpoint =
        reqwest::Url::parse(base.trim()).map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() != "https" && !local_development {
        return Err("Cloud account operations require HTTPS outside local development.".into());
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    endpoint
        .join(path)
        .map_err(|_| "Cloud API URL cannot form the requested endpoint.".to_owned())
}

pub(crate) async fn persist_cloud_session(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    account_label: String,
    session: CloudAuthSession,
) -> Result<CloudAccountResult, String> {
    save_secret(CLOUD_KEYRING_SERVICE, source_id, &session.access_token)?;
    save_secret(
        CLOUD_REFRESH_KEYRING_SERVICE,
        source_id,
        &session.refresh_token,
    )?;
    let mut settings = store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    settings.cloud.account_label.clone_from(&account_label);
    settings.cloud.team_id = session.team_id.to_string();
    settings.cloud.credential_configured = true;
    store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    Ok(CloudAccountResult {
        account_label,
        team_id: session.team_id.to_string(),
        access_expires_at: session.access_expires_at,
    })
}

#[tauri::command]
pub(crate) async fn bootstrap_cloud_account(
    input: CloudBootstrapInput,
    state: State<'_, AppState>,
) -> Result<CloudAccountResult, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud account creation is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let endpoint = cloud_settings_endpoint(&cloud.endpoint, "v1/auth/bootstrap")?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let account_label = input.email.trim().to_owned();
    let session = cloud_http_client()?
        .post(endpoint)
        .header("x-bootstrap-secret", input.bootstrap_secret)
        .json(&serde_json::json!({
            "email": input.email,
            "displayName": input.display_name,
            "teamName": input.team_name,
        }))
        .send()
        .await
        .map_err(|_| "Cloud account endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud account creation was rejected.".to_owned())?
        .json::<CloudAuthSession>()
        .await
        .map_err(|_| "Cloud returned an invalid account session.".to_owned())?;
    persist_cloud_session(&state.store, input.source_id, account_label, session).await
}

#[tauri::command]
pub(crate) async fn refresh_cloud_session(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<CloudAccountResult, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud session refresh is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let endpoint = cloud_settings_endpoint(&cloud.endpoint, "v1/auth/refresh")?;
    let refresh_token =
        keyring::Entry::new(CLOUD_REFRESH_KEYRING_SERVICE, &input.source_id.to_string())
            .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
            .get_password()
            .map_err(|_| "No Cloud refresh token is stored in Keychain.".to_owned())?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let session = cloud_http_client()?
        .post(endpoint)
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|_| "Cloud session endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud session refresh was rejected.".to_owned())?
        .json::<CloudAuthSession>()
        .await
        .map_err(|_| "Cloud returned an invalid refreshed session.".to_owned())?;
    persist_cloud_session(
        &state.store,
        input.source_id,
        cloud.account_label.clone(),
        session,
    )
    .await
}

#[tauri::command]
pub(crate) async fn create_cloud_project(
    input: CloudProjectInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud project creation is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let team_id = Uuid::parse_str(cloud.team_id.trim())
        .map_err(|_| "Configure a valid Team ID before creating a project.".to_owned())?;
    let endpoint = cloud_settings_endpoint(&cloud.endpoint, "v1/projects")?;
    let token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| {
            "Configure or refresh the Cloud account before creating a project.".to_owned()
        })?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let project = cloud_http_client()?
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "teamId": team_id, "name": input.name }))
        .send()
        .await
        .map_err(|_| "Cloud project endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud project creation was rejected.".to_owned())?
        .json::<CloudProjectRecord>()
        .await
        .map_err(|_| "Cloud returned an invalid project record.".to_owned())?;
    let mut settings = state
        .store
        .get_data_source_settings(input.source_id)
        .await
        .map_err(safe_store_error)?;
    settings.cloud.project_id = project.id.to_string();
    settings.cloud.enabled = true;
    settings.cloud.base_version = 0;
    state
        .store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    Ok(format!("{} ({})", project.name, project.id))
}

pub(crate) async fn cloud_project_request(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    suffix: &str,
) -> Result<(reqwest::Url, String), String> {
    let effective = effective_settings(store, Some(source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud sharing is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let project_id = Uuid::parse_str(cloud.project_id.trim())
        .map_err(|_| "Configure a valid Cloud Project ID first.".to_owned())?;
    let endpoint = cloud_settings_endpoint(
        &cloud.endpoint,
        &format!("v1/projects/{project_id}/shares{suffix}"),
    )?;
    let token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure or refresh the Cloud account first.".to_owned())?;
    Ok((endpoint, token))
}

#[tauri::command]
pub(crate) async fn list_cloud_shares(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<CloudShareSummary>, String> {
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, "").await?;
    cloud_http_client()?
        .get(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share list request.".to_owned())?
        .json()
        .await
        .map_err(|_| "Cloud returned invalid share records.".to_owned())
}

#[tauri::command]
pub(crate) async fn create_cloud_share(
    input: CloudShareInput,
    state: State<'_, AppState>,
) -> Result<CloudShareRecord, String> {
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, "").await?;
    cloud_http_client()?
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "expiresAt": input.expires_at }))
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share creation request.".to_owned())?
        .json()
        .await
        .map_err(|_| "Cloud returned an invalid share record.".to_owned())
}

#[tauri::command]
pub(crate) async fn revoke_cloud_share(
    input: CloudShareActionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let suffix = format!("/{}", input.share_id);
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, &suffix).await?;
    cloud_http_client()?
        .delete(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share revocation request.".to_owned())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn rotate_cloud_share(
    input: CloudShareActionInput,
    state: State<'_, AppState>,
) -> Result<CloudShareRecord, String> {
    let suffix = format!("/{}/rotate", input.share_id);
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, &suffix).await?;
    cloud_http_client()?
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "expiresAt": input.expires_at }))
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share rotation request.".to_owned())?
        .json()
        .await
        .map_err(|_| "Cloud returned an invalid share record.".to_owned())
}

#[tauri::command]
pub(crate) async fn update_project_settings(
    settings: ProjectSettings,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    settings
        .validate()
        .map_err(|error| format!("Invalid project settings: {error}"))?;
    let mut source_id = None;
    for profile in state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)?
    {
        let source_settings = state
            .store
            .get_data_source_settings(profile.id)
            .await
            .map_err(safe_store_error)?;
        if source_settings.cloud.project_id == settings.project_id {
            source_id = Some(profile.id);
            break;
        }
    }
    let _operation = if let Some(source_id) = source_id {
        Some(acquire_cloud_operation(&state, source_id).await?)
    } else {
        None
    };
    state
        .store
        .save_project_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    if let Some(source_id) = source_id {
        enqueue_sync_event(
            &state.store,
            source_id,
            "project.settings",
            &settings.updated_at,
            serde_json::to_value(&settings)
                .map_err(|_| "Unable to create project settings sync metadata.".to_owned())?,
        )
        .await?;
    }
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
    Ok(apply_settings_layers(app, None, Some(settings), &policy))
}
