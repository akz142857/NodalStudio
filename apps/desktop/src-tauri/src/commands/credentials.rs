//! Keychain credential and security-status commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn save_ai_credential(
    input: SecretInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    save_secret(AI_KEYRING_SERVICE, input.source_id, &input.secret)?;
    mark_credential_configured(&state.store, input.source_id, "ai", true).await
}

#[tauri::command]
pub(crate) async fn save_cloud_credential(
    input: SecretInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    save_secret(CLOUD_KEYRING_SERVICE, input.source_id, &input.secret)?;
    mark_credential_configured(&state.store, input.source_id, "cloud", true).await
}

#[tauri::command]
pub(crate) async fn clear_credentials(
    input: ClearCredentialsInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if input.database {
        delete_secret(KEYRING_SERVICE, input.source_id)?;
        delete_secret(connection_credentials::SSH_SERVICE, input.source_id)?;
    }
    if input.ai {
        delete_secret(AI_KEYRING_SERVICE, input.source_id)?;
        mark_credential_configured(&state.store, input.source_id, "ai", false).await?;
    }
    if input.cloud {
        delete_secret(CLOUD_KEYRING_SERVICE, input.source_id)?;
        delete_secret(CLOUD_REFRESH_KEYRING_SERVICE, input.source_id)?;
        mark_credential_configured(&state.store, input.source_id, "cloud", false).await?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_security_status(
    input: SettingsInput,
    state: State<'_, AppState>,
) -> Result<SecurityStatus, String> {
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    let profiles = state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)?;
    let pending = state.store.pending_sync().await.map_err(safe_store_error)?;
    let source_id = input.source_id;
    let mut stale_model_sources = 0_u64;
    for profile in &profiles {
        let model_is_stale = state
            .store
            .latest_snapshot(profile.id)
            .await
            .map_err(safe_store_error)?
            .is_none_or(|snapshot| Utc::now() - snapshot.captured_at > chrono::Duration::days(30));
        stale_model_sources += u64::from(model_is_stale);
    }
    let mut unresolved_git_conflict_reports = 0_u64;
    for settings in state
        .store
        .list_data_source_settings()
        .await
        .map_err(safe_store_error)?
    {
        if settings.git.repository_path.trim().is_empty() {
            continue;
        }
        let _access =
            file_access::access(std::path::Path::new(settings.git.repository_path.trim()))?;
        let path = std::path::Path::new(settings.git.repository_path.trim()).join(".nodalstudio");
        // A directory that cannot be read must not audit as zero conflicts: this
        // is the security panel, and "could not check" reported as "nothing to
        // see" is the one failure mode it must not have. list_conflict_reports
        // already returns Ok(empty) when there is simply no workspace.
        unresolved_git_conflict_reports +=
            u64::try_from(list_conflict_reports(&path)?.len()).unwrap_or(u64::MAX);
    }
    let (database_credential_configured, weak_ssl_sources) =
        network_security_status(&profiles, source_id, |id| {
            credential_exists(KEYRING_SERVICE, id)
        });
    Ok(SecurityStatus {
        offline_mode: app.privacy.offline_mode,
        database_credential_configured,
        ai_credential_configured: source_id
            .is_some_and(|id| credential_exists(AI_KEYRING_SERVICE, id)),
        cloud_credential_configured: source_id
            .is_some_and(|id| credential_exists(CLOUD_KEYRING_SERVICE, id)),
        weak_ssl_sources,
        failed_or_conflicted_sync_items: pending
            .iter()
            .filter(|item| item.state == "conflict" || item.attempts > 0)
            .count() as u64,
        stale_model_sources,
        unresolved_git_conflict_reports,
    })
}

// SQLite has no transport or database password. Do not probe its Keychain entry
// or report its deliberately disabled TLS setting as a network security issue.
pub(crate) fn network_security_status(
    profiles: &[DataSourceProfile],
    source_id: Option<Uuid>,
    has_credential: impl FnOnce(Uuid) -> bool,
) -> (bool, u64) {
    let network_source = profiles.iter().find(|profile| {
        Some(profile.id) == source_id && profile.database_type != DatabaseType::Sqlite
    });
    let configured = network_source.is_some_and(|profile| has_credential(profile.id));
    let weak = profiles
        .iter()
        .filter(|profile| {
            profile.database_type != DatabaseType::Sqlite && profile.ssl_mode == SslMode::Disable
        })
        .count() as u64;
    (configured, weak)
}

#[tauri::command]
pub(crate) async fn list_sync_diagnostics(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<SyncDiagnostic>, String> {
    Ok(state
        .store
        .pending_sync()
        .await
        .map_err(safe_store_error)?
        .into_iter()
        .filter(|item| item.source_id == input.source_id)
        .map(|item| SyncDiagnostic {
            id: item.id,
            event_kind: item.event_kind,
            attempts: item.attempts,
            state: item.state,
            created_at: item.created_at,
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn list_external_access(
    state: State<'_, AppState>,
) -> Result<Vec<ExternalAccessRecord>, String> {
    state
        .store
        .list_external_access()
        .await
        .map_err(safe_store_error)
}
