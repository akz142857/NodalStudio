//! Local VSIX storage for the macOS preview. Extension code runs in the UI's
//! isolated interpreter and never runs in the native process.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

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

fn package_asset(root: &Path, file: &str, extensions: &[&str]) -> Option<PathBuf> {
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

fn manifest(root: &Path) -> Result<Manifest, String> {
    let manifest: Manifest =
        serde_json::from_slice(&bounded_file(&root.join("package.json"), MAX_ENTRY)?)
            .map_err(|_| INVALID)?;
    package_id(&manifest.publisher, &manifest.name)?;
    semver::Version::parse(&manifest.version).map_err(|_| INVALID)?;
    if manifest.engines.vscode.is_empty() {
        return Err(INVALID.into());
    }
    Ok(manifest)
}

fn usable_grammar<'a>(
    manifest: &'a Manifest,
    root: &Path,
    language: &str,
) -> Option<(&'a Grammar, PathBuf)> {
    manifest.contributes.grammars.iter().find_map(|grammar| {
        if grammar.language.as_deref() != Some(language) || grammar.scope_name.is_empty() {
            return None;
        }
        package_asset(root, &grammar.path, &["json"]).map(|asset| (grammar, asset))
    })
}

fn capabilities(manifest: &Manifest, root: &Path) -> (Capability, Vec<Language>) {
    if !manifest.extension_dependencies.is_empty() {
        return (Capability::Unsupported, Vec::new());
    }
    if manifest
        .browser
        .as_deref()
        .and_then(|entry| package_asset(root, entry, &["js", "cjs"]))
        .is_some()
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
            .filter(|language| usable_grammar(manifest, root, &language.id).is_some())
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
    let (capability, languages) = capabilities(&manifest, &root);
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
    if installed_paths(root)?.len() >= MAX_INSTALLED {
        return Err(LIMIT.into());
    }
    let source = bounded_file(archive_path, MAX_ARCHIVE)?;
    let temp = tempfile::tempdir_in(root).map_err(|_| STORAGE)?;
    unpack(&source, temp.path())?;
    let receipt = Receipt {
        file_name: archive_path
            .file_name()
            .ok_or(INVALID)?
            .to_string_lossy()
            .into_owned(),
        sha256: format!("{:x}", Sha256::digest(source)),
    };
    let mut file = File::create(temp.path().join("installation.json")).map_err(|_| STORAGE)?;
    serde_json::to_writer(&mut file, &receipt).map_err(|_| STORAGE)?;
    file.flush().map_err(|_| STORAGE)?;
    let extension = installation(temp.path(), project_key)?;
    let destination = root.join(&extension.id);
    if destination.exists() {
        return Err("extensionAlreadyInstalled".into());
    }
    fs::rename(temp.path(), destination).map_err(|_| STORAGE)?;
    Ok(extension)
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
    language: String,
) -> Result<Prepared, String> {
    if !has_valid_id(&id) {
        return Err(INVALID.into());
    }
    with_storage(app, &state, project_id, move |root, key| {
        let path = root.join(id);
        let item = installation(&path, key)?;
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
