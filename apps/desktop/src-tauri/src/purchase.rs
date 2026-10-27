//! Apple-owned purchase proof. Nothing persisted by the UI grants an entitlement.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

pub const IS_MAS: bool = cfg!(feature = "mac-app-store");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PurchasePhase {
    Community,
    Checking,
    Verified,
    NeedsRecovery,
    Unverified,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderReply {
    state: PurchasePhase,
    reason: Option<String>,
    environment: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseStatus {
    distribution: &'static str,
    state: PurchasePhase,
    reason: Option<String>,
    environment: Option<String>,
    checked_at: Option<String>,
    can_use_paid_features: bool,
    busy: bool,
}
impl Default for PurchaseStatus {
    fn default() -> Self {
        Self {
            distribution: if IS_MAS { "macAppStore" } else { "community" },
            state: if IS_MAS {
                PurchasePhase::Checking
            } else {
                PurchasePhase::Community
            },
            reason: None,
            environment: None,
            checked_at: None,
            can_use_paid_features: !IS_MAS,
            busy: false,
        }
    }
}
#[derive(Default)]
pub struct PurchaseState {
    status: Mutex<PurchaseStatus>,
    operation: tokio::sync::Mutex<()>,
    last_attempt: Mutex<Option<std::time::Instant>>,
}

fn apply_reply(status: &mut PurchaseStatus, reply: ProviderReply) {
    // A transient network/authentication failure never invalidates verified
    // evidence already held in this process. Nothing is restored from preferences.
    let preserve =
        status.state == PurchasePhase::Verified && reply.state == PurchasePhase::NeedsRecovery;
    if !preserve {
        status.state = match reply.state {
            PurchasePhase::Verified
                if matches!(reply.environment.as_deref(), Some("Production" | "Sandbox")) =>
            {
                PurchasePhase::Verified
            }
            PurchasePhase::NeedsRecovery => PurchasePhase::NeedsRecovery,
            PurchasePhase::Unsupported => PurchasePhase::Unsupported,
            _ => PurchasePhase::Unverified,
        };
        status.environment = reply.environment;
    }
    status.reason = reply.reason;
    status.can_use_paid_features = status.state == PurchasePhase::Verified;
    status.checked_at = Some(chrono::Utc::now().to_rfc3339());
    status.busy = false;
}

fn snapshot(state: &PurchaseState) -> Result<PurchaseStatus, String> {
    state
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "Purchase status unavailable".into())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_purchase_status(state: State<'_, PurchaseState>) -> Result<PurchaseStatus, String> {
    snapshot(&state)
}

async fn verify(app: &tauri::AppHandle, refresh: bool) -> Result<PurchaseStatus, String> {
    let state = app.state::<PurchaseState>();
    if !IS_MAS {
        return snapshot(&state);
    }
    // One writer; there are no overlapping successful/failed callbacks to reorder.
    let Ok(_operation) = state.operation.try_lock() else {
        return snapshot(&state);
    };
    {
        let mut last = state
            .last_attempt
            .lock()
            .map_err(|_| "Purchase status unavailable")?;
        if !refresh && last.is_some_and(|time| time.elapsed() < std::time::Duration::from_mins(5)) {
            return snapshot(&state);
        }
        *last = Some(std::time::Instant::now());
    }
    {
        let mut status = state
            .status
            .lock()
            .map_err(|_| "Purchase status unavailable")?;
        status.busy = true;
    }
    let _ = app.emit("purchase-status-changed", snapshot(&state)?);
    let reply = native_reply(refresh, app.config().identifier.clone()).await;
    let result = {
        let mut status = state
            .status
            .lock()
            .map_err(|_| "Purchase status unavailable")?;
        apply_reply(&mut status, reply);
        status.clone()
    };
    let _ = app.emit("purchase-status-changed", &result);
    Ok(result)
}

async fn native_reply(refresh: bool, expected_bundle: String) -> ProviderReply {
    #[cfg(feature = "mac-app-store")]
    {
        let reply = tauri::async_runtime::spawn_blocking(move || {
            storekit_bridge::check(refresh, &expected_bundle)
        })
        .await;
        match reply {
            Ok(Ok(json)) => serde_json::from_str(&json).unwrap_or(ProviderReply {
                state: PurchasePhase::Unverified,
                reason: Some("invalidNativeReply".into()),
                environment: None,
            }),
            _ => ProviderReply {
                state: PurchasePhase::NeedsRecovery,
                reason: Some("storeUnavailable".into()),
                environment: None,
            },
        }
    }
    #[cfg(not(feature = "mac-app-store"))]
    {
        let _ = (refresh, expected_bundle);
        ProviderReply {
            state: PurchasePhase::Unsupported,
            reason: None,
            environment: None,
        }
    }
}

#[tauri::command]
pub async fn restore_app_purchase(app: tauri::AppHandle) -> Result<PurchaseStatus, String> {
    // This command is invoked ONLY by the explicit user action in the purchase UI.
    verify(&app, true).await
}

#[tauri::command]
pub fn open_app_store() -> Result<(), String> {
    if !IS_MAS {
        return Err("This build is not distributed by the Mac App Store.".into());
    }
    #[cfg(target_os = "macos")]
    {
        // Fixed system URL; the WebView cannot supply a target or shell arguments.
        std::process::Command::new("/usr/bin/open")
            .arg("macappstore://showUpdatesPage")
            .spawn()
            .map_err(|_| "Unable to open the App Store.".to_owned())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("The Mac App Store requires macOS.".into())
    }
}

pub fn start(app: tauri::AppHandle) {
    if IS_MAS {
        tauri::async_runtime::spawn(async move {
            let _ = verify(&app, false).await;
        });
    }
}

/// Data recovery, inspection and settings remain available without purchase.
/// An explicit allowlist makes new commands default to requiring proof in MAS.
fn allowed_without_purchase(command: &str) -> bool {
    matches!(
        command,
        "get_runtime_info"
            | "get_diagnostic_info"
            | "reveal_app_directory"
            | "get_purchase_status"
            | "restore_app_purchase"
            | "open_app_store"
            | "get_update_status"
            | "cancel_update_download"
            | "list_data_sources"
            | "list_snapshots"
            | "get_snapshot"
            | "get_semantics"
            | "get_change_review"
            | "list_relationship_batches"
            | "list_query_history"
            | "compare_snapshots"
            | "compare_environment_snapshots"
            | "list_logical_relationships"
            | "list_ignored_relationship_inferences"
            | "get_settings"
            | "update_app_settings"
            | "reset_app_settings"
            | "get_storage_usage"
            | "get_security_status"
            | "list_sync_diagnostics"
            | "list_external_access"
            | "list_cloud_audit"
            | "list_cloud_shares"
            | "preview_source_data_deletion"
            | "pick_workspace_path"
            | "preview_settings_file"
            | "preview_portable_backup"
            | "export_portable_backup"
            | "export_settings_file"
            | "export_git_workspace"
            | "preview_git_export"
            | "save_schema_report"
            | "save_diagram_export"
            | "save_diagram_export_binary"
            | "export_query_result"
            | "save_layout"
            | "cancel_query"
            | "cancel_connection_test"
            | "cancel_knowledge_draft"
            | "cancel_table_explanation"
            | "cancel_discovery"
            | "clear_credentials"
            | "clear_regenerable_cache"
    )
}

pub fn unavailable_in_mas(command: &str) -> bool {
    command.contains("cloud")
        || matches!(
            command,
            "sync_project"
                | "refresh_organization_policy"
                | "update_organization_policy"
                | "update_project_settings"
        )
}

pub fn command_allowed(command: &str, verified: bool, mas: bool) -> bool {
    if !mas {
        return true;
    }
    if unavailable_in_mas(command) {
        return false;
    }
    // These paths must never reach the updater, even with valid purchase proof.
    if matches!(
        command,
        "check_for_updates" | "open_update_releases" | "download_update" | "install_update"
    ) {
        return false;
    }
    verified || allowed_without_purchase(command)
}

pub fn reject_reason(invoke: &tauri::ipc::Invoke) -> Option<&'static str> {
    if !IS_MAS {
        return None;
    }
    if unavailable_in_mas(invoke.message.command()) {
        return Some("Cloud collaboration is not available in the Mac App Store edition.");
    }
    let verified = invoke
        .message
        .state_ref()
        .get::<PurchaseState>()
        .status
        .lock()
        .is_ok_and(|s| s.state == PurchasePhase::Verified);
    if command_allowed(invoke.message.command(), verified, true) {
        None
    } else {
        Some(
            "This operation requires a verified Mac App Store purchase. Open Settings → Updates to restore your purchase. Your saved data remains available.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mas_cloud_is_unavailable_even_with_verified_purchase() {
        for command in [
            "bootstrap_cloud_account",
            "refresh_cloud_session",
            "create_cloud_project",
            "create_cloud_share",
            "rotate_cloud_share",
            "revoke_cloud_share",
            "list_cloud_audit",
            "sync_project",
            "save_cloud_credential",
            "refresh_organization_policy",
        ] {
            assert!(!command_allowed(command, true, true));
            assert!(!command_allowed(command, false, true));
            assert!(command_allowed(command, false, false));
        }
        assert!(command_allowed("pick_workspace_path", false, true));
    }
    fn reply(state: PurchasePhase, reason: Option<&str>) -> ProviderReply {
        ProviderReply {
            state,
            reason: reason.map(str::to_owned),
            environment: Some("Production".into()),
        }
    }
    #[test]
    fn failures_never_create_entitlement_and_unknown_native_states_fail_closed() {
        let mut s = PurchaseStatus {
            state: PurchasePhase::Checking,
            can_use_paid_features: false,
            ..Default::default()
        };
        for phase in [
            PurchasePhase::NeedsRecovery,
            PurchasePhase::Unverified,
            PurchasePhase::Community,
            PurchasePhase::Checking,
            PurchasePhase::Unsupported,
        ] {
            apply_reply(&mut s, reply(phase, None));
            assert!(!s.can_use_paid_features);
        }
        assert!(
            serde_json::from_str::<ProviderReply>(r#"{"state":"verified","isPro":true}"#).is_err()
        );
        apply_reply(
            &mut s,
            ProviderReply {
                state: PurchasePhase::Verified,
                reason: None,
                environment: Some("Xcode".into()),
            },
        );
        assert!(!s.can_use_paid_features);
    }
    #[test]
    fn cancellation_and_network_errors_preserve_evidence_but_invalid_proof_removes_it() {
        let mut s = PurchaseStatus::default();
        apply_reply(&mut s, reply(PurchasePhase::Verified, None));
        for reason in ["cancelled", "networkUnavailable", "timeout"] {
            apply_reply(&mut s, reply(PurchasePhase::NeedsRecovery, Some(reason)));
            assert!(s.can_use_paid_features);
            assert_eq!(s.state, PurchasePhase::Verified);
        }
        apply_reply(
            &mut s,
            reply(PurchasePhase::Unverified, Some("deviceMismatch")),
        );
        assert!(!s.can_use_paid_features);
        apply_reply(&mut s, reply(PurchasePhase::NeedsRecovery, None));
        assert!(!s.can_use_paid_features);
    }
    #[test]
    fn paid_operations_default_closed_but_recovery_remains_available() {
        for cmd in [
            "apply_change_review",
            "execute_readonly_query",
            "save_annotation",
            "unknown_future_command",
        ] {
            assert!(!command_allowed(cmd, false, true));
            assert!(command_allowed(cmd, true, true));
            assert!(command_allowed(cmd, false, false));
        }
        for cmd in [
            "get_change_review",
            "export_portable_backup",
            "save_schema_report",
            "restore_app_purchase",
            "cancel_query",
        ] {
            assert!(command_allowed(cmd, false, true));
        }
        for cmd in [
            "check_for_updates",
            "open_update_releases",
            "download_update",
            "install_update",
        ] {
            assert!(!command_allowed(cmd, true, true));
            assert!(command_allowed(cmd, true, false));
        }
    }
}
