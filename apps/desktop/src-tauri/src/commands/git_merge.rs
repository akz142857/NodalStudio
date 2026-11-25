//! Git merge-driver status and conflict-report commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn check_merge_driver(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<MergeDriverStatus, String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let root = std::path::Path::new(input.repository_path.trim());
    if !root.is_absolute() || !root.is_dir() {
        return Err("Choose an existing absolute repository directory.".into());
    }
    let repository_is_git = if purchase::IS_MAS {
        git_readiness::has_git_marker(root)
    } else {
        Command::new("git")
            .args([
                "-C",
                input.repository_path.trim(),
                "rev-parse",
                "--is-inside-work-tree",
            ])
            .output()
            .is_ok_and(|output| output.status.success())
    };
    let driver_configured = !purchase::IS_MAS
        && Command::new("git")
            .args([
                "-C",
                input.repository_path.trim(),
                "config",
                "--get",
                "merge.nodalstudio-semantic.driver",
            ])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .contains("nodalstudio-semantic-merge")
            });
    let workspace_root = root.join(".nodalstudio");
    let attributes_configured = fs::read_to_string(workspace_root.join(".gitattributes"))
        .is_ok_and(|value| value.contains("merge=nodalstudio-semantic"));
    let conflict_reports = list_conflict_reports(&workspace_root)?;
    let expected_version = env!("CARGO_PKG_VERSION").to_owned();
    let driver_version = if purchase::IS_MAS {
        None
    } else {
        Command::new("nodalstudio-semantic-merge")
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                String::from_utf8(output.stdout)
                    .ok()
                    .and_then(|value| value.split_whitespace().last().map(str::to_owned))
            })
    };
    let workspace_fingerprint = fs::read_to_string(workspace_root.join("project.json"))
        .ok()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|value| value.get("schemaFingerprint")?.as_str().map(str::to_owned));
    let local_fingerprint = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .map(|snapshot| snapshot.fingerprint);
    Ok(MergeDriverStatus {
        repository_is_git,
        manifest_present: workspace_root.join("project.json").is_file(),
        attributes_configured,
        driver_configured,
        driver_version,
        expected_version,
        install_command: if purchase::IS_MAS {
            String::new()
        } else {
            "git config --local merge.nodalstudio-semantic.name 'Nodal Studio semantic merge' && git config --local merge.nodalstudio-semantic.driver 'nodalstudio-semantic-merge %O %A %B'".into()
        },
        conflict_reports,
        fingerprint_matches: workspace_fingerprint
            .zip(local_fingerprint)
            .map(|(workspace, local)| workspace == local),
    })
}

pub(crate) fn list_conflict_reports(
    workspace_root: &std::path::Path,
) -> Result<Vec<String>, String> {
    let semantics = workspace_root.join("semantics");
    if !semantics.is_dir() {
        return Ok(Vec::new());
    }
    let mut directories = vec![semantics];
    let mut reports = Vec::new();
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)
            .map_err(|_| "Unable to inspect Git conflict reports.".to_owned())?
        {
            let entry = entry.map_err(|_| "Unable to inspect Git conflict reports.".to_owned())?;
            let path = entry.path();
            if path.is_dir() {
                directories.push(path);
            } else if path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .is_some_and(|name| name.ends_with(".conflicts.json"))
            {
                let relative = path
                    .strip_prefix(workspace_root)
                    .map_err(|_| "Git conflict report path is invalid.".to_owned())?;
                reports.push(relative.to_string_lossy().into_owned());
            }
        }
    }
    reports.sort();
    Ok(reports)
}

pub(crate) fn conflict_report_path(
    input: &ConflictReportInput,
) -> Result<std::path::PathBuf, String> {
    let root = std::path::PathBuf::from(input.repository_path.trim()).join(".nodalstudio");
    let relative = std::path::Path::new(input.report_path.trim());
    if !root.is_dir()
        || relative.is_absolute()
        || !input.report_path.starts_with("semantics/")
        || !input.report_path.ends_with(".conflicts.json")
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Choose a listed semantic conflict report.".into());
    }
    Ok(root.join(relative))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn read_git_conflict_report(input: ConflictReportInput) -> Result<String, String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let path = conflict_report_path(&input)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 1024 * 1024) {
        return Err("The conflict report is missing or exceeds 1 MB.".into());
    }
    fs::read_to_string(path).map_err(|_| "Unable to read the conflict report.".into())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn delete_git_conflict_report(input: ConflictReportInput) -> Result<(), String> {
    let _access = file_access::access(std::path::Path::new(input.repository_path.trim()))?;
    let path = conflict_report_path(&input)?;
    fs::remove_file(path).map_err(|_| "Unable to remove the reviewed conflict report.".into())
}

pub(crate) async fn mark_credential_configured(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    kind: &str,
    configured: bool,
) -> Result<(), String> {
    let mut settings = store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    match kind {
        "ai" => settings.ai.credential_configured = configured,
        "cloud" => settings.cloud.credential_configured = configured,
        _ => return Err("Unsupported credential type.".into()),
    }
    store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)
}

pub(crate) fn save_secret(service: &str, source_id: Uuid, secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("A non-empty credential is required.".into());
    }
    keyring::Entry::new(service, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .set_password(secret)
        .map_err(|_| "Unable to save the credential in the operating system keychain.".to_owned())
}

pub(crate) fn delete_secret(service: &str, source_id: Uuid) -> Result<(), String> {
    let entry = keyring::Entry::new(service, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Unable to remove the credential from the operating system keychain.".into()),
    }
}

pub(crate) fn credential_exists(service: &str, source_id: Uuid) -> bool {
    keyring::Entry::new(service, &source_id.to_string())
        .and_then(|entry| entry.get_password())
        .is_ok()
}

pub(crate) async fn cleanup_retired_external_artifacts(
    database_path: &Path,
    app_cache_dir: &Path,
) -> Result<(), String> {
    for connection_id in retired_model_connection_ids(database_path).await? {
        delete_secret(RETIRED_MODEL_KEYRING_SERVICE, connection_id)?;
    }
    let managed_projects = app_cache_dir.join("projects");
    if managed_projects.exists() {
        fs::remove_dir_all(&managed_projects)
            .map_err(|_| "Unable to remove the retired managed project cache.".to_owned())?;
    }
    Ok(())
}

pub(crate) async fn retired_model_connection_ids(
    database_path: &Path,
) -> Result<Vec<Uuid>, String> {
    if !database_path.is_file() {
        return Ok(Vec::new());
    }
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|_| "Unable to inspect retired local project data.".to_owned())?;
    let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .map_err(|_| "Unable to inspect the local schema version.".to_owned())?;
    if version >= 3 {
        pool.close().await;
        return Ok(Vec::new());
    }
    let table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_connections')",
    )
    .fetch_one(&pool)
    .await
    .map_err(|_| "Unable to inspect retired model credentials.".to_owned())?
        != 0;
    if !table_exists {
        pool.close().await;
        return Ok(Vec::new());
    }
    let accounts = sqlx::query_scalar::<_, String>("SELECT id FROM model_connections")
        .fetch_all(&pool)
        .await
        .map_err(|_| "Unable to inspect retired model credentials.".to_owned())?;
    pool.close().await;
    accounts
        .into_iter()
        .map(|account| {
            Uuid::parse_str(&account)
                .map_err(|_| "Retired model credential identity is invalid.".to_owned())
        })
        .collect()
}
