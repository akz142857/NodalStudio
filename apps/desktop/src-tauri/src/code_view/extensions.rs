//! VSIX storage for the macOS preview. Extension code runs in the UI's
//! isolated interpreter and never runs in the native process.
pub(crate) mod open_vsx;

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use rustix::fs::{CWD, RenameFlags, renameat_with};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zip::ZipArchive;

use super::review::ReviewState;
use crate::file_access::{SelectionKind, pick_workspace_path_from};

const INVALID: &str = "extensionInvalid";
const LIMIT: &str = "extensionLimit";
const STORAGE: &str = "extensionStorage";
const DISABLED: &str = "extensionDisabled";
const UNSUPPORTED: &str = "extensionUnsupported";
const CHANGED: &str = "extensionChanged";
const MAX_ARCHIVE: u64 = 32 * 1024 * 1024;
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;
const MAX_ENTRY: u64 = 2 * 1024 * 1024;
const MAX_INSTALLED: usize = 32;
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    name: String,
    publisher: String,
    version: String,
    display_name: Option<String>,
    description: Option<String>,
    engines: Engines,
    main: Option<String>,
    browser: Option<String>,
    #[serde(default)]
    activation_events: Vec<String>,
    #[serde(default)]
    extension_dependencies: Vec<String>,
    #[serde(default)]
    contributes: Contributions,
}

#[derive(Deserialize)]
struct Engines {
    vscode: String,
}

#[derive(Default, Deserialize)]
struct Contributions {
    #[serde(default)]
    languages: Vec<Language>,
    #[serde(default)]
    grammars: Vec<Grammar>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Language {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    #[serde(default)]
    filename_patterns: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grammar {
    language: Option<String>,
    scope_name: String,
    path: String,
}

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Capability {
    Diagnostics,
    Syntax,
    Unsupported,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    file_name: String,
    sha256: String,
    #[serde(default)]
    source: PackageSource,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum PackageSource {
    #[default]
    Local,
    OpenVsx,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Extension {
    id: String,
    publisher: String,
    name: String,
    description: String,
    version: String,
    engine: String,
    enabled: bool,
    capability: Capability,
    languages: Vec<Language>,
    #[serde(flatten)]
    receipt: Receipt,
}

#[derive(Serialize)]
#[serde(tag = "capability", rename_all = "camelCase")]
pub(crate) enum Prepared {
    Diagnostics {
        script: String,
    },
    #[serde(rename_all = "camelCase")]
    Syntax {
        grammar: String,
        scope_name: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExtensionAction {
    Enable,
    Disable,
    Uninstall,
}

fn is_identifier(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 80
        && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn package_id(publisher: &str, name: &str) -> Result<String, String> {
    if !is_identifier(publisher) || !is_identifier(name) {
        return Err(INVALID.into());
    }
    Ok(format!("{publisher}.{name}").to_ascii_lowercase())
}

fn has_valid_id(id: &str) -> bool {
    id.split_once('.')
        .is_some_and(|(publisher, name)| package_id(publisher, name).is_ok_and(|valid| valid == id))
}

fn asset_path<'a>(file: &'a str, extensions: &[&str]) -> Option<&'a Path> {
    let relative = Path::new(file);
    if file.contains('\\')
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    if !relative
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| extensions.contains(&ext))
    {
        return None;
    }
    Some(relative)
}

fn package_asset(root: &Path, file: &str, extensions: &[&str]) -> Option<PathBuf> {
    let relative = asset_path(file, extensions)?;
    let root = root.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    let meta = path.metadata().ok()?;
    (path.starts_with(root) && meta.is_file() && meta.len() <= MAX_ENTRY).then_some(path)
}

fn bounded_file(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| INVALID)?;
    let metadata = file.metadata().map_err(|_| INVALID)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(LIMIT.into());
    }
    let mut buffer = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut buffer)
        .map_err(|_| INVALID)?;
    if buffer.len() as u64 > limit {
        return Err(LIMIT.into());
    }
    Ok(buffer)
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    package_id(&manifest.publisher, &manifest.name)?;
    semver::Version::parse(&manifest.version).map_err(|_| INVALID)?;
    if manifest.engines.vscode.is_empty() {
        return Err(INVALID.into());
    }
    Ok(manifest)
}

fn manifest(root: &Path) -> Result<Manifest, String> {
    parse_manifest(&bounded_file(&root.join("package.json"), MAX_ENTRY)?)
}

fn grammar_for_language<'a>(
    manifest: &'a Manifest,
    language: &str,
) -> impl Iterator<Item = &'a Grammar> {
    manifest.contributes.grammars.iter().filter(move |grammar| {
        grammar.language.as_deref() == Some(language) && !grammar.scope_name.is_empty()
    })
}

fn usable_grammar<'a>(
    manifest: &'a Manifest,
    root: &Path,
    language: &str,
) -> Option<(&'a Grammar, PathBuf)> {
    grammar_for_language(manifest, language).find_map(|grammar| {
        package_asset(root, &grammar.path, &["json"]).map(|asset| (grammar, asset))
    })
}

fn capabilities(manifest: &Manifest, root: Option<&Path>) -> (Capability, Vec<Language>) {
    if !manifest.extension_dependencies.is_empty() {
        return (Capability::Unsupported, Vec::new());
    }
    let asset_exists = |file: &str, suffixes: &[&str]| match root {
        Some(path) => package_asset(path, file, suffixes).is_some(),
        None => asset_path(file, suffixes).is_some(),
    };
    if manifest
        .browser
        .as_deref()
        .is_some_and(|entry| asset_exists(entry, &["js", "cjs"]))
        && manifest
            .activation_events
            .iter()
            .any(|event| event == "onLanguage:markdown")
    {
        return (Capability::Diagnostics, Vec::new());
    }
    if manifest.main.is_none() && manifest.browser.is_none() {
        let languages: Vec<Language> = manifest
            .contributes
            .languages
            .iter()
            .filter(|language| {
                grammar_for_language(manifest, &language.id)
                    .any(|grammar| asset_exists(&grammar.path, &["json"]))
            })
            .cloned()
            .collect();
        if !languages.is_empty() {
            return (Capability::Syntax, languages);
        }
    }
    (Capability::Unsupported, Vec::new())
}

fn installation(path: &Path, project_key: &str) -> Result<Extension, String> {
    let root = path.join("extension");
    let manifest = manifest(&root)?;
    let id = package_id(&manifest.publisher, &manifest.name)?;
    let (capability, languages) = capabilities(&manifest, Some(&root));
    let receipt =
        serde_json::from_slice(&bounded_file(&path.join("installation.json"), 16 * 1024)?)
            .map_err(|_| STORAGE)?;
    Ok(Extension {
        id,
        publisher: manifest.publisher,
        name: manifest.display_name.unwrap_or(manifest.name),
        description: manifest.description.unwrap_or_default(),
        version: manifest.version,
        engine: manifest.engines.vscode,
        enabled: capability != Capability::Unsupported
            && path.join("enabled").join(project_key).is_file(),
        capability,
        languages,
        receipt,
    })
}

fn unpack(source: &[u8], target: &Path) -> Result<(), String> {
    let mut archive = ZipArchive::new(io::Cursor::new(source)).map_err(|_| INVALID)?;
    if archive.len() > 2048 {
        return Err(LIMIT.into());
    }
    let mut remaining = MAX_UNPACKED;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| INVALID)?;
        let name = entry.enclosed_name().ok_or(INVALID)?;
        if entry.is_symlink()
            || entry.name().contains('\\')
            || name
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(INVALID.into());
        }
        if !name.starts_with("extension") {
            continue;
        }
        let path = target.join(name);
        if entry.is_dir() {
            fs::create_dir_all(path).map_err(|_| INVALID)?;
            continue;
        }
        if entry.size() > remaining {
            return Err(LIMIT.into());
        }
        fs::create_dir_all(path.parent().ok_or(INVALID)?).map_err(|_| INVALID)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| INVALID)?;
        let actual =
            io::copy(&mut entry.by_ref().take(remaining + 1), &mut output).map_err(|_| INVALID)?;
        remaining = remaining.checked_sub(actual).ok_or(LIMIT)?;
    }
    Ok(())
}

fn storage(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| STORAGE)?
        .join("code-extensions-preview");
    fs::create_dir_all(&path).map_err(|_| STORAGE)?;
    Ok(path)
}

fn installed_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    fs::read_dir(root)
        .map_err(|_| STORAGE)?
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_name().to_str().is_some_and(has_valid_id) => {
                Some(Ok(entry.path()))
            }
            Ok(_) => None,
            Err(_) => Some(Err(STORAGE.into())),
        })
        .collect()
}

fn install(root: &Path, archive_path: &Path, project_key: &str) -> Result<Extension, String> {
    if archive_path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("vsix"))
    {
        return Err(INVALID.into());
    }
    let source = bounded_file(archive_path, MAX_ARCHIVE)?;
    let receipt = Receipt {
        file_name: archive_path
            .file_name()
            .ok_or(INVALID)?
            .to_string_lossy()
            .into_owned(),
        sha256: format!("{:x}", Sha256::digest(&source)),
        source: PackageSource::Local,
    };
    let (stage, extension) = stage_package(root, &source, &receipt, project_key)?;
    let destination = root.join(&extension.id);
    install_staged(root, stage.path(), &destination)?;
    Ok(extension)
}

fn stage_package(
    root: &Path,
    source: &[u8],
    receipt: &Receipt,
    project_key: &str,
) -> Result<(tempfile::TempDir, Extension), String> {
    let temp = tempfile::tempdir_in(root).map_err(|_| STORAGE)?;
    unpack(source, temp.path())?;
    let mut file = File::create(temp.path().join("installation.json")).map_err(|_| STORAGE)?;
    serde_json::to_writer(&mut file, receipt).map_err(|_| STORAGE)?;
    file.flush().map_err(|_| STORAGE)?;
    let extension = installation(temp.path(), project_key)?;
    Ok((temp, extension))
}

fn install_staged(root: &Path, stage: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err("extensionAlreadyInstalled".into());
    }
    if installed_paths(root)?.len() >= MAX_INSTALLED {
        return Err(LIMIT.into());
    }
    fs::rename(stage, destination).map_err(|_| STORAGE.into())
}

fn newer(version: &str, previous: &str) -> bool {
    let (Ok(version), Ok(previous)) = (
        semver::Version::parse(version),
        semver::Version::parse(previous),
    ) else {
        return false;
    };
    version.cmp_precedence(&previous).is_gt()
}

fn compatible_update(current: Capability, incoming: Capability) -> bool {
    incoming != Capability::Unsupported
        && (current == Capability::Unsupported || current == incoming)
}

fn replace_staged(
    stage: &Path,
    destination: &Path,
    project_key: &str,
    incoming: &Extension,
    current_sha256: &str,
) -> Result<Extension, String> {
    if !destination.exists() {
        return Err(CHANGED.into());
    }
    let current = installation(destination, project_key)?;
    if current.receipt.sha256 != current_sha256 || !newer(&incoming.version, &current.version) {
        return Err(CHANGED.into());
    }
    if !compatible_update(current.capability, incoming.capability) {
        return Err(UNSUPPORTED.into());
    }
    let previous = destination.join("enabled");
    let enabled = stage.join("enabled");
    if previous.is_dir() {
        fs::create_dir(&enabled).map_err(|_| STORAGE)?;
        for marker in fs::read_dir(previous).map_err(|_| STORAGE)? {
            let marker = marker.map_err(|_| STORAGE)?;
            if marker.file_type().map_err(|_| STORAGE)?.is_file() {
                File::create(enabled.join(marker.file_name())).map_err(|_| STORAGE)?;
            }
        }
    }
    let incoming = installation(stage, project_key)?;
    // Atomic directory exchange keeps the previous installation intact if preparation or replacement fails.
    renameat_with(CWD, stage, CWD, destination, RenameFlags::EXCHANGE).map_err(|_| STORAGE)?;
    Ok(incoming)
}

async fn with_storage<T: Send + 'static>(
    app: AppHandle,
    state: &State<'_, ReviewState>,
    project_id: Uuid,
    operation: impl FnOnce(&Path, &str) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || {
        project.directory()?;
        let _lock = STORAGE_LOCK.lock().map_err(|_| STORAGE)?;
        operation(&storage(&app)?, project.key())
    })
    .await
    .map_err(|_| STORAGE)?
}

#[tauri::command]
pub(crate) async fn list_code_extensions(
    app: AppHandle,
    state: State<'_, ReviewState>,
    project_id: Uuid,
) -> Result<Vec<Extension>, String> {
    with_storage(app, &state, project_id, |root, key| {
        let mut items = installed_paths(root)?
            .into_iter()
            .map(|path| installation(&path, key))
            .collect::<Result<Vec<_>, _>>()?;
        items.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(items)
    })
    .await
}

#[tauri::command]
pub(crate) async fn install_code_extension(
    app: AppHandle,
    state: State<'_, ReviewState>,
    project_id: Uuid,
) -> Result<Option<Extension>, String> {
    state.project(project_id)?;
    let Some(source) =
        pick_workspace_path_from(app.clone(), SelectionKind::CodeExtensionVsix, None).await?
    else {
        return Ok(None);
    };
    with_storage(app, &state, project_id, move |root, key| {
        install(root, Path::new(&source), key).map(Some)
    })
    .await
}

#[tauri::command]
pub(crate) async fn change_code_extension(
    app: AppHandle,
    state: State<'_, ReviewState>,
    project_id: Uuid,
    id: String,
    action: ExtensionAction,
) -> Result<Option<Extension>, String> {
    if !has_valid_id(&id) {
        return Err(INVALID.into());
    }
    with_storage(app, &state, project_id, move |root, key| {
        let path = root.join(id);
        let item = installation(&path, key)?;
        let enabled = path.join("enabled");
        let marker = enabled.join(key);
        match action {
            ExtensionAction::Enable => {
                if item.capability == Capability::Unsupported {
                    return Err(UNSUPPORTED.into());
                }
                fs::create_dir_all(enabled).map_err(|_| STORAGE)?;
                File::create(marker).map_err(|_| STORAGE)?;
            }
            ExtensionAction::Disable => {
                if let Err(error) = fs::remove_file(marker)
                    && error.kind() != io::ErrorKind::NotFound
                {
                    return Err(STORAGE.into());
                }
            }
            ExtensionAction::Uninstall => {
                let temp = tempfile::tempdir_in(root).map_err(|_| STORAGE)?;
                fs::rename(path, temp.path().join("removed")).map_err(|_| STORAGE)?;
                return Ok(None);
            }
        }
        installation(&path, key).map(Some)
    })
    .await
}

#[tauri::command]
pub(crate) async fn prepare_code_extension(
    app: AppHandle,
    state: State<'_, ReviewState>,
    project_id: Uuid,
    id: String,
    sha256: String,
    language: String,
) -> Result<Prepared, String> {
    if !has_valid_id(&id) {
        return Err(INVALID.into());
    }
    with_storage(app, &state, project_id, move |root, key| {
        let path = root.join(id);
        let item = installation(&path, key)?;
        if item.receipt.sha256 != sha256 {
            return Err(CHANGED.into());
        }
        if !item.enabled {
            return Err(DISABLED.into());
        }
        let root = path.join("extension");
        let manifest = manifest(&root)?;
        let read_asset = |path: &Path| {
            String::from_utf8(bounded_file(path, MAX_ENTRY)?).map_err(|_| INVALID.to_owned())
        };
        match item.capability {
            Capability::Diagnostics if language == "markdown" => {
                let entry = manifest
                    .browser
                    .as_deref()
                    .and_then(|entry| package_asset(&root, entry, &["js", "cjs"]))
                    .ok_or(UNSUPPORTED)?;
                Ok(Prepared::Diagnostics {
                    script: read_asset(&entry)?,
                })
            }
            Capability::Syntax => {
                let (grammar, entry) =
                    usable_grammar(&manifest, &root, &language).ok_or(UNSUPPORTED)?;
                Ok(Prepared::Syntax {
                    grammar: read_asset(&entry)?,
                    scope_name: grammar.scope_name.clone(),
                })
            }
            _ => Err(UNSUPPORTED.into()),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syntax_package(root: &Path, version: &str, sha256: &str) -> (tempfile::TempDir, Extension) {
        let mut archive = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        archive
            .start_file("extension/package.json", options)
            .unwrap();
        serde_json::to_writer(&mut archive, &serde_json::json!({
            "name": "sample", "publisher": "Example", "version": version,
            "engines": { "vscode": "*" },
            "contributes": {
                "languages": [{ "id": "sample", "extensions": [".sample"] }],
                "grammars": [{ "language": "sample", "scopeName": "source.sample", "path": "syntax.json" }]
            }
        })).unwrap();
        archive
            .start_file("extension/syntax.json", options)
            .unwrap();
        archive
            .write_all(br#"{"scopeName":"source.sample","patterns":[]}"#)
            .unwrap();
        let package = archive.finish().unwrap().into_inner();
        stage_package(
            root,
            &package,
            &Receipt {
                file_name: "sample.vsix".into(),
                sha256: sha256.into(),
                source: PackageSource::OpenVsx,
            },
            "current-project",
        )
        .unwrap()
    }

    #[test]
    fn update_rechecks_the_installed_package_and_preserves_project_enablement() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("example.sample");
        let old_sha = "1".repeat(64);
        let new_sha = "2".repeat(64);
        let (old, _) = syntax_package(root.path(), "1.0.0", &old_sha);
        install_staged(root.path(), old.path(), &destination).unwrap();
        fs::create_dir(destination.join("enabled")).unwrap();
        for key in ["current-project", "other-project"] {
            File::create(destination.join("enabled").join(key)).unwrap();
        }

        let (staged, incoming) = syntax_package(root.path(), "1.1.0", &new_sha);
        let conflict = replace_staged(
            staged.path(),
            &destination,
            "current-project",
            &incoming,
            &new_sha,
        );
        assert_eq!(conflict.err().as_deref(), Some(CHANGED));
        let retained = installation(&destination, "current-project").unwrap();
        assert_eq!(retained.version, "1.0.0");
        assert!(retained.enabled);

        let updated = replace_staged(
            staged.path(),
            &destination,
            "current-project",
            &incoming,
            &old_sha,
        )
        .unwrap();
        assert_eq!(updated.version, "1.1.0");
        assert_eq!(updated.receipt.sha256, new_sha);
        assert!(updated.enabled);
        assert!(installation(&destination, "other-project").unwrap().enabled);
        assert!(
            !installation(&destination, "unapproved-project")
                .unwrap()
                .enabled
        );
        assert_eq!(
            installation(staged.path(), "current-project")
                .unwrap()
                .version,
            "1.0.0"
        );
    }
}
