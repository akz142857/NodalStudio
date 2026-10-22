//! Application-owned update state. The `WebView` never supplies install bytes or signing keys.
use crate::AppState;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;

const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "IPC preserves existing capability flags alongside release-discovery capabilities"
)]
pub struct UpdateStatus {
    phase: &'static str,
    current_version: String,
    available_version: Option<String>,
    download_url: Option<String>,
    notes: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    checked_at: Option<String>,
    error: Option<String>,
    configured: bool,
    can_check: bool,
    manual_only: bool,
    source: Option<String>,
    configuration_message: Option<String>,
    can_download: bool,
    can_install: bool,
}
#[derive(Clone, PartialEq, Eq)]
struct Feed {
    url: String,
    channel: String,
    manual: bool,
}
#[derive(Default)]
struct Session {
    status: UpdateStatus,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    feed: Option<Feed>,
    cancel: CancellationToken,
}
#[derive(Default)]
pub struct UpdateState {
    session: Mutex<Session>,
    operation: tokio::sync::Mutex<()>,
    installing: AtomicBool,
}
impl UpdateState {
    fn change(&self, f: impl FnOnce(&mut Session)) {
        f(&mut self.session.lock().expect("update state"));
    }
    fn record_download_progress(
        &self,
        chunk: usize,
        total: Option<u64>,
        limit: &CancellationToken,
    ) {
        self.change(|s| {
            s.status.downloaded_bytes = s.status.downloaded_bytes.saturating_add(chunk as u64);
            s.status.total_bytes = total;
            if s.status.downloaded_bytes > MAX_UPDATE_BYTES
                || total.is_some_and(|size| size > MAX_UPDATE_BYTES)
            {
                limit.cancel();
            }
        });
    }
    fn fail(&self, message: &str) {
        self.change(|s| {
            s.status.phase = "error";
            s.status.error = Some(message.into());
            s.status.can_download = s.update.is_some() && s.bytes.is_none();
            s.status.can_install = s.bytes.is_some();
        });
    }
}

pub fn reject_during_install(invoke: &tauri::ipc::Invoke) -> bool {
    invoke
        .message
        .state_ref()
        .get::<UpdateState>()
        .installing
        .load(Ordering::Acquire)
        && invoke.message.command() != "get_update_status"
}
fn transport_allowed(url: &reqwest::Url, app_id: &str) -> bool {
    if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
        return true;
    }
    cfg!(feature = "updater-smoke-test")
        && app_id.ends_with(".updater-smoke")
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && url.username().is_empty()
        && url.password().is_none()
}
async fn feed(app: &tauri::AppHandle, state: &AppState, online: bool) -> Result<Feed, String> {
    let effective = crate::effective_settings(&state.store, None).await?;
    if online && effective.app.privacy.offline_mode {
        return Err("Update checks and downloads are blocked by completely offline mode.".into());
    }
    let policy = state
        .store
        .get_organization_policy()
        .await
        .map_err(crate::safe_store_error)?;
    let expired = policy.expires_at.as_deref().is_some_and(|value| {
        chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|time| time <= chrono::Utc::now())
    });
    if !expired && !policy.allow_update_checks {
        return Err("Application updates are disabled by your organization.".into());
    }
    let channel = match effective.app.updates.channel {
        settings_model::UpdateChannel::Stable => "stable",
        settings_model::UpdateChannel::Beta => "beta",
    };
    resolve_feed(
        app.config().plugins.0.get("updater"),
        effective.app.updates.custom_feed_url.as_deref(),
        channel,
        &app.config().identifier,
        cfg!(target_os = "macos"),
    )
}

fn resolve_feed(
    updater: Option<&serde_json::Value>,
    custom: Option<&str>,
    channel: &str,
    identifier: &str,
    supports_install: bool,
) -> Result<Feed, String> {
    let custom = custom.map(str::trim).filter(|s| !s.is_empty());
    let has_key = updater
        .and_then(|v| v.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    if !has_key || !supports_install {
        if custom.is_some() {
            return Err("Custom signed feeds require a macOS distribution with an embedded update signing key. Clear the custom feed to check GitHub Releases.".into());
        }
        return Ok(Feed {
            url: crate::github_releases::endpoint(channel),
            channel: channel.into(),
            manual: true,
        });
    }
    let endpoint = custom
        .or_else(|| {
            updater
                .and_then(|v| v.get("endpoints"))
                .and_then(|v| v.get(0))
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or(crate::github_releases::UPDATE_FEED);
    if channel == "beta" && custom.is_none() && !endpoint.contains("{channel}") {
        return Err("This distribution provides stable updates. Select Stable or configure a dedicated beta feed in Advanced update settings.".into());
    }
    let url = endpoint.replace("{channel}", channel);
    let parsed = reqwest::Url::parse(&url).map_err(|_| "The update feed URL is invalid.")?;
    if !transport_allowed(&parsed, identifier) {
        return Err("Update feeds must use HTTPS without embedded credentials.".into());
    }
    Ok(Feed {
        url,
        channel: channel.into(),
        manual: false,
    })
}
#[tauri::command]
pub async fn get_update_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    let selected = feed(&app, &state, false).await;
    let mut result = updates
        .session
        .lock()
        .map_err(|_| "Update state unavailable")?
        .status
        .clone();
    if result.phase.is_empty() {
        result.phase = "idle";
    }
    result.current_version = app.package_info().version.to_string();
    result.configured = selected.as_ref().is_ok_and(|feed| !feed.manual);
    result.can_check = selected.is_ok();
    result.manual_only = selected.as_ref().is_ok_and(|feed| feed.manual);
    result.source = selected.as_ref().ok().map(|feed| {
        if feed.manual
            || feed
                .url
                .starts_with("https://github.com/akz142857/NodalStudio/")
        {
            "GitHub Releases".into()
        } else {
            "Custom update feed".into()
        }
    });
    result.configuration_message = match &selected {
        Err(error) => Some(error.clone()),
        Ok(feed) if feed.manual => Some("New versions are checked on GitHub. Install releases manually; this build does not support signed in-app installation.".into()),
        _ => None,
    };
    let session = updates
        .session
        .lock()
        .map_err(|_| "Update state unavailable")?;
    if session
        .feed
        .as_ref()
        .is_some_and(|previous| selected.as_ref().ok() != Some(previous))
    {
        result.phase = "idle";
        result.available_version = None;
        result.notes = None;
        result.download_url = None;
        result.checked_at = None;
        result.error = None;
        result.can_download = false;
        result.can_install = false;
    }
    Ok(result)
}

#[tauri::command]
pub async fn open_update_releases(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // The WebView cannot supply an arbitrary URL, executable or shell argument.
    feed(&app, &state, true).await?;
    state
        .store
        .record_external_access("updates", "attempted")
        .await
        .map_err(crate::safe_store_error)?;
    let mut command = if cfg!(target_os = "macos") {
        std::process::Command::new("/usr/bin/open")
    } else if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else {
        std::process::Command::new("xdg-open")
    };
    command
        .arg(crate::github_releases::RELEASES_PAGE)
        .spawn()
        .map_err(|_| "Unable to open GitHub Releases in your browser.")?;
    Ok(())
}
#[tauri::command]
pub async fn check_for_updates(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    let operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    updates.change(|s| {
        s.update = None;
        s.bytes = None;
        s.feed = None;
        s.status = UpdateStatus {
            phase: "checking",
            current_version: app.package_info().version.to_string(),
            ..Default::default()
        };
    });
    let result: Result<(), String> = async {
        let selected = feed(&app, &state, true).await?;
        state.store.record_external_access("updates", "attempted").await.map_err(crate::safe_store_error)?;
        if selected.manual {
            let release = crate::github_releases::check(&selected.channel, &app.package_info().version).await?;
            updates.change(|s| {
                s.status.phase = if release.is_some() { "available" } else { "upToDate" };
                s.status.available_version = release.as_ref().map(|r| r.version.clone());
                s.status.notes = release.and_then(|r| r.notes);
                s.status.checked_at = Some(chrono::Utc::now().to_rfc3339());
                s.feed = Some(selected);
            });
            return Ok(());
        }
        let stable = selected.channel == "stable";
        let secure_transport = !(cfg!(feature = "updater-smoke-test")
            && app.config().identifier.ends_with(".updater-smoke"));
        let client = app
            .updater_builder()
            .endpoints(vec![
                selected.url.parse().map_err(|_| "Invalid update URL")?,
            ])
            .map_err(|_| "Invalid update feed configuration")?
            .timeout(Duration::from_secs(30))
            .version_comparator(move |current, remote| {
                remote.version > current && (!stable || remote.version.pre.is_empty())
            })
            .configure_client(move |client| {
                let client = client
                    .connect_timeout(Duration::from_secs(30))
                    .read_timeout(Duration::from_secs(30));
                if secure_transport {
                    client.https_only(true)
                } else {
                    client.no_proxy().https_only(false)
                }
            })
            .build()
            .map_err(|_| "Unable to initialize the updater")?;
        let update = client.check().await.map_err(|error| match error {
            tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_) =>
                "This release has no signed update for this system architecture. Check GitHub Releases for a compatible installer.",
            tauri_plugin_updater::Error::ReleaseNotFound | tauri_plugin_updater::Error::Serialization(_) =>
                "The signed update manifest is missing or invalid. The release must include latest.json and a signed application archive.",
            _ => "Unable to check updates. Check the network and update feed, then try again.",
        })?;
        if let Some(value) = &update {
            let url = reqwest::Url::parse(value.download_url.as_str())
                .map_err(|_| "Invalid download URL")?;
            if !transport_allowed(&url, &app.config().identifier) {
                return Err(
                    "The update download must use HTTPS without embedded credentials.".to_owned(),
                );
            }
        }
        updates.change(|s| {
            s.status.phase = if update.is_some() {
                "available"
            } else {
                "upToDate"
            };
            s.status.available_version = update.as_ref().map(|u| u.version.clone());
            s.status.notes = update.as_ref().and_then(|u| u.body.clone());
            s.status.download_url = update.as_ref().map(|u| u.download_url.to_string());
            s.status.checked_at = Some(chrono::Utc::now().to_rfc3339());
            s.status.can_download = update.is_some();
            s.status.configured = true;
            s.feed = Some(selected);
            s.update = update;
        });
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = result {
        updates.fail(&e);
        return Err(e);
    }
    drop(operation);
    get_update_status(app, state, updates).await
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> Result<(), String> {
    let _operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let result: Result<(), String> = async {
        let selected = feed(&app, &state, true).await?;
        if selected.manual { return Err("This build requires manual installation from GitHub Releases.".into()); }
        let (update, cancel) = {
            let mut session = updates.session.lock().map_err(|_| "Update state unavailable")?;
            if session.feed.as_ref() != Some(&selected) { return Err("Update settings changed. Check for updates again.".into()); }
            let mut update = session.update.clone().ok_or("Check for updates before downloading.")?;
            // The feed's 30-second timeout also propagates to Update::download.
            // Full application packages need a separate, bounded transfer deadline.
            update.timeout = Some(Duration::from_mins(30));
            session.cancel = CancellationToken::new(); session.bytes = None;
            session.status.phase = "downloading"; session.status.error = None;
            session.status.downloaded_bytes = 0; session.status.total_bytes = None;
            session.status.can_download = false; session.status.can_install = false;
            (update, session.cancel.clone())
        };
        let size_limit = CancellationToken::new();
        let bytes = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err("Download cancelled. You can retry when ready.".into()),
            () = size_limit.cancelled() => return Err("The update download exceeds the supported size limit.".into()),
            result = update.download(|chunk, total| updates.record_download_progress(chunk, total, &size_limit),
                || updates.change(|s| s.status.phase = "verifying")) => result.map_err(|_| "The download failed or its signature could not be verified. Nothing was installed; retry the download.")?,
        };
        if size_limit.is_cancelled() || bytes.len() as u64 > MAX_UPDATE_BYTES {
            return Err("The update download exceeds the supported size limit.".into());
        }
        if cancel.is_cancelled() {
            return Err("Download cancelled. You can retry when ready.".into());
        }
        // The official updater verified these exact in-memory bytes. Inspect the signed app identity too.
        validate_archive(&bytes, &update.version, &app.config().identifier)?;
        updates.change(|s| { s.bytes = Some(bytes); s.status.phase = "ready"; s.status.can_install = true; });
        Ok(())
    }.await;
    if let Err(e) = result {
        updates.fail(&e);
        return Err(e);
    }
    Ok(())
}
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn cancel_update_download(updates: State<'_, UpdateState>) {
    updates.change(|s| s.cancel.cancel());
}

fn validate_bundle_metadata(
    data: &[u8],
    version: &str,
    identifier: &str,
) -> Result<String, String> {
    let plist = plist::Value::from_reader(std::io::Cursor::new(data))
        .map_err(|_| "Invalid application metadata")?;
    let values = plist
        .as_dictionary()
        .ok_or("Invalid application metadata")?;
    if values
        .get("CFBundleIdentifier")
        .and_then(plist::Value::as_string)
        != Some(identifier)
        || values
            .get("CFBundleShortVersionString")
            .and_then(plist::Value::as_string)
            != Some(version)
    {
        return Err(
            "The signed application does not match the announced version or application identity."
                .into(),
        );
    }
    let name = values
        .get("CFBundleExecutable")
        .and_then(plist::Value::as_string)
        .filter(|name| !name.is_empty())
        .ok_or("The update has no application executable metadata.")?;
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("Invalid application executable name.".into());
    }
    Ok(name.to_owned())
}

fn validate_archive(bytes: &[u8], version: &str, identifier: &str) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut matched = false;
    let mut root = None;
    let mut expanded = 0u64;
    let mut paths = BTreeSet::new();
    let mut executable = None;
    let mut binaries = BTreeMap::new();
    for entry in archive
        .entries()
        .map_err(|_| "The update is not a valid application archive.")?
    {
        let mut entry = entry.map_err(|_| "Unable to read update archive")?;
        let path = entry
            .path()
            .map_err(|_| "Invalid archive path")?
            .into_owned();
        let parts: Vec<_> = path.components().collect();
        if parts.is_empty() || parts.iter().any(|p| !matches!(p, Component::Normal(_))) {
            return Err("Unsafe path in update archive.".into());
        }
        let first = parts[0].as_os_str().to_string_lossy().into_owned();
        if Path::new(&first).extension().is_none_or(|ext| ext != "app")
            || root.as_ref().is_some_and(|r| r != &first)
        {
            return Err("The archive must contain exactly one application.".into());
        }
        root = Some(first);
        if !paths.insert(path.clone()) {
            return Err("Duplicate path in update archive.".into());
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("Unsupported link or special file in update archive.".into());
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_UPDATE_BYTES {
            return Err("The expanded update exceeds the supported size limit.".into());
        }
        if kind.is_file()
            && parts.len() == 4
            && parts[1].as_os_str() == "Contents"
            && parts[2].as_os_str() == "MacOS"
        {
            binaries.insert(
                parts[3].as_os_str().to_owned(),
                entry.size() > 0 && entry.header().mode().is_ok_and(|mode| mode & 0o100 != 0),
            );
        }
        if parts.len() == 3
            && parts[1].as_os_str() == "Contents"
            && parts[2].as_os_str() == "Info.plist"
        {
            if matched || !kind.is_file() || entry.size() > 128 * 1024 {
                return Err("Invalid application metadata in update archive.".into());
            }
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|_| "Unable to read application metadata")?;
            executable = Some(validate_bundle_metadata(&data, version, identifier)?);
            matched = true;
        }
    }
    if !matched {
        return Err("The update archive has no application metadata.".into());
    }
    if executable
        .as_ref()
        .is_none_or(|name| binaries.get(std::ffi::OsStr::new(name)) != Some(&true))
    {
        return Err(
            "The update archive is missing a nonempty, executable application binary.".into(),
        );
    }
    // tar stops at its end marker before the gzip trailer. Consume the remainder
    // with a bound so a damaged compressed payload cannot pass verification.
    let remaining = MAX_UPDATE_BYTES.saturating_sub(expanded);
    let tail = std::io::copy(
        &mut archive.into_inner().take(remaining + 1),
        &mut std::io::sink(),
    )
    .map_err(|_| "The compressed update archive is damaged.")?;
    if tail > remaining {
        return Err("The expanded update exceeds the supported size limit.".into());
    }
    Ok(())
}

fn installed_bundle(executable: &Path) -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") {
        return Err("In-app installation is currently supported on macOS only.".into());
    }
    let bundle = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("Unable to locate the installed application")?;
    if bundle.extension().is_none_or(|e| e != "app") || bundle.starts_with("/Volumes") {
        return Err(
            "Move Nodal Studio to Applications and launch the installed app before updating."
                .into(),
        );
    }
    let parent = bundle
        .parent()
        .ok_or("Unable to locate application folder")?;
    let probe = parent.join(format!(".nodal-update-{}", uuid::Uuid::new_v4()));
    fs_probe(&probe)?;
    Ok(bundle.into())
}
fn fs_probe(path: &Path) -> Result<(), String> {
    std::fs::create_dir(path).map_err(|_| "The application folder is not writable. Ask an administrator to install the update manually.")?;
    std::fs::remove_dir(path).map_err(|_| "Unable to prepare the application folder".to_owned())
}
fn copy_app(from: &Path, to: &Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/ditto")
        .arg(from)
        .arg(to)
        .status()
        .map_err(|_| "Unable to back up the current application")?;
    if !status.success() {
        return Err(
            "Unable to copy the application. Check available disk space and folder permissions."
                .into(),
        );
    }
    Ok(())
}
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> Result<(), String> {
    let _operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    updates.installing.store(true, Ordering::Release);
    let result: Result<PathBuf, String> = async {
        let selected = feed(&app, &state, false).await?;
        if selected.manual { return Err("This build requires manual installation from GitHub Releases.".into()); }
        if !state.active_queries.lock().await.is_empty()
            || state.snapshot_captures.lock().await.values().any(|s| s.available_permits() == 0)
            || state.cloud_operations.lock().await.values().any(|s| s.available_permits() == 0)
            || state.ai_limiter.available_permits() < 840 {
            return Err("Wait for active queries, captures, AI requests and synchronization to finish, then retry.".to_owned());
        }
        let (update, bytes) = {
            let mut s = updates.session.lock().map_err(|_| "Update state unavailable")?;
            if s.feed.as_ref() != Some(&selected) { return Err("Update settings changed. Check for updates again.".into()); }
            let update = s.update.clone().ok_or("No update is selected")?;
            let bytes = s.bytes.clone().ok_or("Download and verify the update before installing.")?;
            s.status.phase = "installing"; s.status.error = None; s.status.can_install = false;
            (update, bytes)
        };
        let executable = std::env::current_exe().map_err(|_| "Unable to find the application")?;
        let bundle = installed_bundle(&executable)?;
        let data = app.path().app_data_dir().map_err(|_| "Unable to find the data directory")?;
        let backups = data.join("update-backups").join(format!("{}-{}", app.package_info().version, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&backups).map_err(|_| "Unable to create the update backup directory")?;
        // Includes room for expanded archive, original app and the local database backup.
        let database_size = std::fs::metadata(data.join("nodalstudio.sqlite3")).map_or(0, |m| m.len());
        let required = 1024 * 1024 * 1024 + database_size.saturating_mul(2);
        for location in [&data, bundle.parent().ok_or("Missing application folder")?, &std::env::temp_dir()] {
            if available_space(location)? < required {
                return Err("Not enough disk space to install safely. Free at least 1 GB plus space for a database backup, then retry.".into());
            }
        }
        state.store.backup_for_update(&backups.join("nodalstudio.sqlite3")).await.map_err(|_| "Unable to create a verified data backup. The update was not installed.")?;
        let old_app = backups.join("Nodal Studio.app");
        let rollback = old_app.clone();
        let destination = bundle.clone();
        tokio::task::spawn_blocking(move || {
            copy_app(&destination, &old_app)?;
            if let Err(error) = update.install(&bytes) {
                // A failed replacement must not strand the user without an installed app.
                if destination.exists() { std::fs::remove_dir_all(&destination).map_err(|_| "Installation failed; the previous application is in update-backups. Restore it manually.")?; }
                copy_app(&rollback, &destination).map_err(|_| "Installation failed; restore the previous application from update-backups.")?;
                return Err(format!("Installation failed; the previous application was restored. {error}"));
            }
            Ok::<(), String>(())
        }).await.map_err(|_| "The installer could not complete. The backup is in update-backups.")??;
        Ok::<PathBuf, String>(bundle)
    }.await;
    let bundle = match result {
        Ok(bundle) => bundle,
        Err(e) => {
            updates.installing.store(false, Ordering::Release);
            updates.fail(&e);
            return Err(e);
        }
    };
    // LaunchServices must reopen the bundle on macOS. Spawning its executable
    // directly can leave the replacement running without a registered window.
    if let Err(error) = restart_installed_app(&bundle) {
        updates.installing.store(false, Ordering::Release);
        updates.fail(&error);
        return Err(error);
    }
    app.exit(0);
    Ok(())
}

fn restart_installed_app(bundle: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    // All arguments are separate argv entries; paths never become shell code.
    // Wait for this process to exit before opening the same installed bundle.
    Command::new("/bin/sh")
        .args(["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$2\"", "nodal-update-restart"])
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "The update was installed, but automatic restart could not start. Quit and reopen Nodal Studio.")?;
    Ok(())
}

fn available_space(path: &Path) -> Result<u64, String> {
    let output = std::process::Command::new("/bin/df")
        .args(["-Pk"])
        .arg(path)
        .output()
        .map_err(|_| "Unable to check available disk space")?;
    if !output.status.success() {
        return Err("Unable to check available disk space".into());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|value| value.parse::<u64>().ok())
        .map(|kb| kb.saturating_mul(1024))
        .ok_or_else(|| "Unable to read available disk space".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_checks_do_not_authorize_unsigned_installation() {
        let feed = resolve_feed(None, None, "stable", "com.claycosmos.nodalstudio", true).unwrap();
        assert!(feed.manual);
        assert_eq!(feed.url, crate::github_releases::endpoint("stable"));
        assert!(
            resolve_feed(
                None,
                Some("https://other.example/feed"),
                "stable",
                "com.claycosmos.nodalstudio",
                true
            )
            .is_err()
        );
        let signed = serde_json::json!({"pubkey":"embedded-key", "endpoints":[crate::github_releases::UPDATE_FEED]});
        assert!(
            resolve_feed(
                Some(&signed),
                None,
                "stable",
                "com.claycosmos.nodalstudio",
                false
            )
            .unwrap()
            .manual
        );
        let feed = resolve_feed(
            Some(&signed),
            None,
            "stable",
            "com.claycosmos.nodalstudio",
            true,
        )
        .unwrap();
        assert!(!feed.manual);
        assert_eq!(feed.url, crate::github_releases::UPDATE_FEED);
    }

    #[test]
    fn beta_and_custom_feeds_are_explicit_and_still_require_secure_transport() {
        let config = serde_json::json!({"pubkey":"embedded-key"});
        assert!(resolve_feed(Some(&config), None, "beta", "app", true).is_err());
        let feed = resolve_feed(
            Some(&config),
            Some("https://example.com/{channel}.json"),
            "beta",
            "app",
            true,
        )
        .unwrap();
        assert_eq!(feed.url, "https://example.com/beta.json");
        assert!(!feed.manual);
        for url in [
            "http://example.com/feed",
            "https://user:secret@example.com/feed",
        ] {
            assert!(resolve_feed(Some(&config), Some(url), "stable", "app", true).is_err());
        }
    }
    fn metadata(version: &str, identifier: &str) -> Vec<u8> {
        let mut values = plist::Dictionary::new();
        values.insert("CFBundleIdentifier".into(), identifier.into());
        values.insert("CFBundleShortVersionString".into(), version.into());
        values.insert("CFBundleExecutable".into(), "nodalstudio-desktop".into());
        let mut data = Vec::new();
        plist::Value::Dictionary(values)
            .to_writer_xml(&mut data)
            .unwrap();
        data
    }
    fn package(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (path, data, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(*mode);
            header.set_cksum();
            archive.append_data(&mut header, path, *data).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }
    fn archive(version: &str, identifier: &str) -> Vec<u8> {
        package(&[
            (
                "Nodal Studio.app/Contents/Info.plist",
                &metadata(version, identifier),
                0o644,
            ),
            (
                "Nodal Studio.app/Contents/MacOS/nodalstudio-desktop",
                b"binary",
                0o755,
            ),
        ])
    }
    #[test]
    fn signed_archive_must_match_the_announced_version_and_app() {
        let bytes = archive("0.1.2", "com.claycosmos.nodalstudio");
        assert!(validate_archive(&bytes, "0.1.2", "com.claycosmos.nodalstudio").is_ok());
        assert!(validate_archive(&bytes, "0.1.3", "com.claycosmos.nodalstudio").is_err());
        assert!(validate_archive(&bytes, "0.1.2", "other.app").is_err());
        assert!(validate_archive(b"damaged", "0.1.2", "com.claycosmos.nodalstudio").is_err());
    }
    #[test]
    fn incomplete_duplicate_and_corrupt_application_packages_are_rejected() {
        let metadata = metadata("0.1.2", "com.claycosmos.nodalstudio");
        let plist = (
            "Nodal Studio.app/Contents/Info.plist",
            metadata.as_slice(),
            0o644,
        );
        let executable = "Nodal Studio.app/Contents/MacOS/nodalstudio-desktop";
        for entries in [
            vec![plist],
            vec![plist, (executable, b"", 0o755)],
            vec![plist, (executable, b"binary", 0o644)],
            vec![plist, (executable, b"binary", 0o001)],
            vec![
                plist,
                (executable, b"binary", 0o755),
                (executable, b"replacement", 0o755),
            ],
        ] {
            assert!(
                validate_archive(&package(&entries), "0.1.2", "com.claycosmos.nodalstudio")
                    .is_err()
            );
        }
        let mut damaged = archive("0.1.2", "com.claycosmos.nodalstudio");
        let trailer = damaged.len() - 8;
        damaged[trailer] ^= 1;
        assert!(validate_archive(&damaged, "0.1.2", "com.claycosmos.nodalstudio").is_err());
    }
    #[test]
    fn production_transport_rejects_http_and_embedded_credentials() {
        for url in [
            "http://localhost/feed",
            "http://updates.example/feed",
            "https://user:secret@updates.example/feed",
        ] {
            assert!(!transport_allowed(
                &url.parse().unwrap(),
                "com.claycosmos.nodalstudio"
            ));
        }
        assert!(transport_allowed(
            &"https://updates.example/feed".parse().unwrap(),
            "com.claycosmos.nodalstudio"
        ));
    }
    #[test]
    fn cannot_install_from_a_disk_image_or_development_binary() {
        assert!(
            installed_bundle(Path::new(
                "/Volumes/Nodal/Nodal Studio.app/Contents/MacOS/nodalstudio-desktop"
            ))
            .is_err()
        );
        assert!(installed_bundle(Path::new("/tmp/target/debug/nodalstudio-desktop")).is_err());
    }
    #[test]
    fn oversized_responses_cancel_with_and_without_content_length() {
        let state = UpdateState::default();
        let advertised = CancellationToken::new();
        state.record_download_progress(1, Some(MAX_UPDATE_BYTES + 1), &advertised);
        assert!(advertised.is_cancelled());
        assert!(!state.session.lock().unwrap().status.can_install);

        let streamed = CancellationToken::new();
        state.change(|s| s.status.downloaded_bytes = MAX_UPDATE_BYTES - 1);
        state.record_download_progress(1, None, &streamed);
        assert!(!streamed.is_cancelled());
        state.record_download_progress(1, None, &streamed);
        assert!(streamed.is_cancelled());
        assert!(!state.session.lock().unwrap().status.can_install);
    }
    #[test]
    fn failed_verification_never_enables_installation() {
        let state = UpdateState::default();
        state.fail("Invalid signature");
        let session = state.session.lock().unwrap();
        assert!(!session.status.can_install);
        assert_eq!(session.status.phase, "error");
    }
}
