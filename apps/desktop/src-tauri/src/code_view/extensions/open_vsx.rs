//! Public Open VSX catalog and exact-version package downloads.
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    time::Duration,
};

use futures_util::{StreamExt, stream};
use reqwest::{Client, StatusCode, Url, redirect};
use semver::Version;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::{
    Capability, ESLINT_ARCHIVE_SHA256, ESLINT_ID, ESLINT_VERSION, Extension, MAX_ARCHIVE,
    MAX_ENTRY, PYTHON_DEBUGGER_ID, PYTHON_DEBUGGER_SHA256, PYTHON_DEBUGGER_VERSION, PackageSource,
    Receipt, ReviewState, capabilities, compatible_update, has_valid_id, install_staged,
    installation, installed_paths, newer, package_id, parse_manifest, replace_staged,
    stage_package, with_storage_read,
};
use crate::{AppState, effective_settings};

const REGISTRY: &str = "open-vsx.org";
const CDN: &str = "openvsx.eclipsecontent.org";
const NETWORK: &str = "openVsxNetwork";
const OFFLINE: &str = "openVsxOffline";
const RESPONSE: &str = "openVsxResponse";
const UNAVAILABLE: &str = "openVsxUnavailable";
const INTEGRITY: &str = "openVsxIntegrity";
const MAX_JSON: u64 = 2 * 1024 * 1024;
const SEARCH_SIZE: u32 = 20;
const FEATURED_SIZE: u32 = 7;
const PREVIEW_RECOMMENDATIONS: &[&str] = &[
    "vscode.css",
    "vscode.html",
    "vscode.json",
    "vscode.yaml",
    "davidanson.vscode-markdownlint",
    ESLINT_ID,
    PYTHON_DEBUGGER_ID,
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "Mirrors independent flags in the registry response"
)]
struct Record {
    namespace: String,
    name: String,
    version: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    deprecated: bool,
    #[serde(default)]
    target_platform: Option<String>,
    #[serde(default)]
    pre_release: bool,
    #[serde(default)]
    downloadable: bool,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    engines: BTreeMap<String, String>,
    #[serde(default)]
    all_versions: BTreeMap<String, String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogItem {
    id: String,
    publisher: String,
    name: String,
    description: String,
    version: String,
    verified: bool,
    deprecated: bool,
}

impl Record {
    fn id(&self) -> Result<String, String> {
        package_id(&self.namespace, &self.name).map_err(|_| RESPONSE.into())
    }

    fn catalog_item(&self) -> Result<CatalogItem, String> {
        Ok(CatalogItem {
            id: self.id()?,
            publisher: self.namespace.clone(),
            name: self
                .display_name
                .clone()
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| self.name.clone()),
            description: self.description.clone().unwrap_or_default(),
            version: self.version.clone(),
            verified: self.verified,
            deprecated: self.deprecated,
        })
    }

    fn file_url(&self, key: &str) -> Option<Url> {
        let url = Url::parse(self.files.get(key)?).ok()?;
        allowed_url(&url).then_some(url)
    }

    fn can_download(&self) -> bool {
        self.downloadable
            && !self.pre_release
            && stable_version(&self.version).is_some()
            && self.file_url("download").is_some()
            && self.file_url("sha256").is_some()
    }

    fn versions(&self) -> Vec<String> {
        let mut versions: Vec<_> = self
            .all_versions
            .keys()
            .filter_map(|version| stable_version(version))
            .collect();
        if let Some(version) = stable_version(&self.version)
            && !versions.contains(&version)
        {
            versions.push(version);
        }
        versions.sort_by(|a, b| b.cmp_precedence(a));
        versions
            .into_iter()
            .take(60)
            .map(|version| version.to_string())
            .collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    extensions: Vec<Record>,
    total_size: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogPage {
    items: Vec<CatalogItem>,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogDetail {
    #[serde(flatten)]
    item: CatalogItem,
    versions: Vec<String>,
    license: Option<String>,
    engine: Option<String>,
    capability: Option<Capability>,
    incompatibility: Option<CatalogIncompatibility>,
    downloadable: bool,
    can_update: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum CatalogIncompatibility {
    Debugger,
    ExtensionDependencies,
}

struct CatalogCompatibility {
    capability: Capability,
    incompatibility: Option<CatalogIncompatibility>,
}

impl CatalogCompatibility {
    fn from_manifest(manifest: &super::Manifest) -> Self {
        let capability = capabilities(manifest, None).0;
        let incompatibility = if capability != Capability::Unsupported {
            None
        } else if manifest
            .contributes
            .debuggers
            .as_array()
            .is_some_and(|items| !items.is_empty())
        {
            Some(CatalogIncompatibility::Debugger)
        } else if !manifest.extension_dependencies.is_empty() {
            Some(CatalogIncompatibility::ExtensionDependencies)
        } else {
            None
        };
        Self {
            capability,
            incompatibility,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogUpdate {
    id: String,
    version: String,
    installed_sha256: String,
}

#[derive(Serialize)]
pub(crate) struct CatalogUpdates {
    updates: Vec<CatalogUpdate>,
    failed: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogInstall {
    id: String,
    version: String,
    installed_sha256: Option<String>,
}

fn stable_version(value: &str) -> Option<Version> {
    Version::parse(value)
        .ok()
        .filter(|version| version.pre.is_empty())
}

fn allowed_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && match url.host_str() {
            Some(REGISTRY) => url.path().starts_with("/api/"),
            Some(CDN) => true,
            _ => false,
        }
}

fn api_url(segments: &[&str]) -> Url {
    let mut url = Url::parse("https://open-vsx.org/api/").expect("valid registry URL");
    url.path_segments_mut()
        .expect("registry URL has path segments")
        .pop_if_empty()
        .extend(segments);
    url
}

fn client() -> Result<Client, String> {
    static CLIENT: std::sync::OnceLock<Result<Client, ()>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .https_only(true)
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(35))
                .user_agent(concat!("NodalStudio/", env!("CARGO_PKG_VERSION")))
                .redirect(redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() < 5 && allowed_url(attempt.url()) {
                        attempt.follow()
                    } else {
                        attempt.error("Unexpected Open VSX redirect")
                    }
                }))
                .build()
                .map_err(|_| ())
        })
        .clone()
        .map_err(|()| NETWORK.into())
}

async fn get(
    client: &Client,
    url: Url,
    max: u64,
    size_error: &str,
) -> Result<Option<Vec<u8>>, String> {
    if !allowed_url(&url) {
        return Err(RESPONSE.into());
    }
    let mut response = client.get(url).send().await.map_err(|_| NETWORK)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(NETWORK.into());
    }
    if response.content_length().is_some_and(|size| size > max) {
        return Err(size_error.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK)? {
        if chunk.len() as u64 > max - body.len() as u64 {
            return Err(size_error.into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

async fn json<T: DeserializeOwned>(client: &Client, url: Url) -> Result<Option<T>, String> {
    get(client, url, MAX_JSON, RESPONSE)
        .await?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| RESPONSE.into()))
        .transpose()
}

async fn release(
    client: &Client,
    id: &str,
    version: Option<&str>,
) -> Result<Option<Record>, String> {
    if !has_valid_id(id) || version.is_some_and(|version| stable_version(version).is_none()) {
        return Err(RESPONSE.into());
    }
    let (publisher, name) = id.split_once('.').ok_or(RESPONSE)?;
    let version = version.or((id == PYTHON_DEBUGGER_ID).then_some(PYTHON_DEBUGGER_VERSION));
    let url = api_url(&[publisher, name, "universal", version.unwrap_or("latest")]);
    let Some(record) = json::<Record>(client, url).await? else {
        return Ok(None);
    };
    if record.id()? != id
        || version.is_some_and(|version| record.version != version)
        || record.target_platform.as_deref() != Some("universal")
        || stable_version(&record.version).is_none()
    {
        return Err(RESPONSE.into());
    }
    Ok(Some(record))
}

async fn declared_compatibility(
    client: &Client,
    record: &Record,
) -> Result<Option<CatalogCompatibility>, String> {
    let Some(asset) = record.file_url("manifest") else {
        return Ok(None);
    };
    let Some(bytes) = get(client, asset, MAX_ENTRY, RESPONSE).await? else {
        return Ok(None);
    };
    let Ok(manifest) = parse_manifest(&bytes) else {
        return Ok(None);
    };
    if package_id(&manifest.publisher, &manifest.name)
        .ok()
        .as_deref()
        != Some(&record.id()?)
        || manifest.version != record.version
    {
        return Ok(None);
    }
    Ok(Some(CatalogCompatibility::from_manifest(&manifest)))
}

async fn installable_item(
    client: &Client,
    id: &str,
    version: Option<&str>,
) -> Result<Option<CatalogItem>, String> {
    let version = match id {
        ESLINT_ID => Some(ESLINT_VERSION),
        PYTHON_DEBUGGER_ID => Some(PYTHON_DEBUGGER_VERSION),
        _ => version,
    };
    let Some(record) = release(client, id, version)
        .await?
        .filter(Record::can_download)
    else {
        return Ok(None);
    };
    let Some(compatibility) = declared_compatibility(client, &record).await? else {
        return Ok(None);
    };
    if compatibility.capability == Capability::Unsupported {
        return Ok(None);
    }
    let pinned_digest = match compatibility.capability {
        Capability::Eslint => Some(ESLINT_ARCHIVE_SHA256),
        Capability::PythonDebugger => Some(PYTHON_DEBUGGER_SHA256),
        _ => None,
    };
    if let Some(pinned_digest) = pinned_digest {
        let url = record.file_url("sha256").ok_or(RESPONSE)?;
        let digest = get(client, url, 256, RESPONSE).await?;
        if digest.as_deref().and_then(checksum).as_deref() != Some(pinned_digest) {
            return Ok(None);
        }
    }
    record.catalog_item().map(Some)
}

async fn online(app: &AppState) -> Result<(), String> {
    if effective_settings(&app.store, None)
        .await?
        .app
        .privacy
        .offline_mode
    {
        Err(OFFLINE.into())
    } else {
        Ok(())
    }
}

async fn while_online<T>(
    app: &AppState,
    request: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    online(app).await?;
    let mut offline_rx = app.subscribe_offline();
    let wait_for_offline = async {
        if offline_rx.wait_for(|offline| *offline).await.is_ok() {
            OFFLINE.into()
        } else {
            std::future::pending::<String>().await
        }
    };
    tokio::select! {
        biased;
        reason = wait_for_offline => Err(reason),
        result = request => result,
    }
}

#[tauri::command]
pub(crate) async fn search_code_open_vsx(
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
    project_id: Uuid,
    query: String,
    offset: u32,
) -> Result<CatalogPage, String> {
    state.project(project_id)?;
    let query = query.trim();
    if query.chars().count() > 160 {
        return Err(RESPONSE.into());
    }
    while_online(&app, catalog_page(&client()?, query, offset)).await
}

async fn catalog_page(client: &Client, query: &str, offset: u32) -> Result<CatalogPage, String> {
    let featured = query.is_empty();
    let data = json::<SearchResponse>(client, catalog_url(query, offset))
        .await?
        .ok_or(RESPONSE)?;
    let count = u32::try_from(data.extensions.len()).map_err(|_| RESPONSE)?;
    let next = offset.saturating_add(count);
    // The registry offset counts all results, including releases filtered out below.
    let next_offset = (!featured && next > offset && next < data.total_size).then_some(next);
    let mut candidates = Vec::new();
    if featured
        || ["python", "debugpy", "python debugger", PYTHON_DEBUGGER_ID]
            .iter()
            .any(|value| value.eq_ignore_ascii_case(query.trim()))
    {
        candidates.push((
            PYTHON_DEBUGGER_ID.to_owned(),
            Some(PYTHON_DEBUGGER_VERSION.to_owned()),
        ));
    }
    candidates.extend(data.extensions.iter().filter_map(|record| {
        stable_version(&record.version)?;
        Some((record.id().ok()?, Some(record.version.clone())))
    }));
    if featured {
        candidates.extend(
            PREVIEW_RECOMMENDATIONS
                .iter()
                .map(|id| ((*id).to_owned(), None)),
        );
    }
    let checks = stream::iter(candidates)
        .map(|(id, version)| async move {
            tokio::time::timeout(
                Duration::from_secs(6),
                installable_item(client, &id, version.as_deref()),
            )
            .await
            .map_err(|_| NETWORK.to_owned())?
        })
        .buffered(8);
    tokio::pin!(checks);
    let mut items = Vec::new();
    let mut ids = HashSet::new();
    let mut failure = None;
    while let Some(check) = checks.next().await {
        match check {
            Ok(Some(item)) if ids.insert(item.id.clone()) => items.push(item),
            Err(error) => failure = Some(error),
            _ => {}
        }
        if featured && items.len() == FEATURED_SIZE as usize {
            break;
        }
    }
    if items.is_empty()
        && let Some(error) = failure
    {
        return Err(error);
    }
    Ok(CatalogPage { items, next_offset })
}

fn catalog_url(query: &str, offset: u32) -> Url {
    let mut url = api_url(&["-", "search"]);
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("query", query);
        if query.is_empty() {
            // Match the featured row on the registry homepage.
            params
                .append_pair("size", &FEATURED_SIZE.to_string())
                .append_pair("offset", "0")
                .append_pair("sortBy", "relevance")
                .append_pair("sortOrder", "desc");
        } else {
            params
                .append_pair("size", &SEARCH_SIZE.to_string())
                .append_pair("offset", &offset.to_string())
                .append_pair("targetPlatform", "universal");
        }
    }
    url
}

#[tauri::command]
pub(crate) async fn detail_code_open_vsx(
    handle: AppHandle,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
    project_id: Uuid,
    id: String,
    version: Option<String>,
) -> Result<CatalogDetail, String> {
    state.project(project_id)?;
    let (record, compatibility) = while_online(&app, async {
        let client = client()?;
        let record = release(&client, &id, version.as_deref())
            .await?
            .ok_or(UNAVAILABLE)?;
        let compatibility = declared_compatibility(&client, &record).await?;
        Ok((record, compatibility))
    })
    .await?;
    let capability = compatibility.as_ref().map(|result| result.capability);
    let remote_version = record.version.clone();
    let can_update = with_storage_read(handle, &state, project_id, move |root, key| {
        let path = root.join(id);
        if !path.exists() {
            return Ok(false);
        }
        let installed = installation(&path, key)?;
        Ok(newer(&remote_version, &installed.version)
            && capability
                .is_none_or(|capability| compatible_update(installed.capability, capability)))
    })
    .await?;
    Ok(CatalogDetail {
        item: record.catalog_item()?,
        versions: record.versions(),
        license: record.license.clone(),
        engine: record.engines.get("vscode").cloned(),
        capability,
        incompatibility: compatibility.and_then(|result| result.incompatibility),
        downloadable: record.can_download(),
        can_update,
    })
}

#[tauri::command]
pub(crate) async fn check_code_open_vsx_updates(
    handle: AppHandle,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
    project_id: Uuid,
) -> Result<CatalogUpdates, String> {
    online(&app).await?;
    let installed = with_storage_read(handle, &state, project_id, |root, key| {
        Ok(installed_paths(root)?
            .into_iter()
            .filter_map(|path| installation(&path, key).ok())
            .collect::<Vec<_>>())
    })
    .await?;
    while_online(&app, async {
        let client = client()?;
        let mut checks = stream::iter(installed.into_iter().map(|item| {
            let client = client.clone();
            async move {
                let release = release(&client, &item.id, None).await?;
                if let Some(record) = release
                    .filter(|record| record.can_download() && newer(&record.version, &item.version))
                    && declared_compatibility(&client, &record)
                        .await?
                        .is_none_or(|result| compatible_update(item.capability, result.capability))
                {
                    return Ok::<_, String>(Some(CatalogUpdate {
                        id: item.id,
                        version: record.version,
                        installed_sha256: item.receipt.sha256,
                    }));
                }
                Ok(None)
            }
        }))
        .buffer_unordered(4);
        let mut result = CatalogUpdates {
            updates: Vec::new(),
            failed: 0,
        };
        while let Some(check) = checks.next().await {
            match check {
                Ok(Some(update)) => result.updates.push(update),
                Ok(None) => {}
                Err(_) => result.failed += 1,
            }
        }
        Ok(result)
    })
    .await
}

fn checksum(text: &[u8]) -> Option<String> {
    let value = std::str::from_utf8(text).ok()?.trim();
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

async fn download(client: &Client, input: &CatalogInstall) -> Result<(Vec<u8>, Receipt), String> {
    let record = release(client, &input.id, Some(&input.version))
        .await?
        .ok_or(UNAVAILABLE)?;
    if !record.can_download() {
        return Err(UNAVAILABLE.into());
    }
    let url = record.file_url("download").ok_or(UNAVAILABLE)?;
    let file_name = format!("{}-{}.vsix", record.id()?, record.version);
    let checksum_url = record.file_url("sha256").ok_or(UNAVAILABLE)?;
    let expected = checksum(
        &get(client, checksum_url, 256, INTEGRITY)
            .await?
            .ok_or(INTEGRITY)?,
    )
    .ok_or(INTEGRITY)?;
    if input.id == PYTHON_DEBUGGER_ID
        && (input.version != PYTHON_DEBUGGER_VERSION || expected != PYTHON_DEBUGGER_SHA256)
    {
        return Err(INTEGRITY.into());
    }
    let source = get(client, url, MAX_ARCHIVE, super::LIMIT)
        .await?
        .ok_or(UNAVAILABLE)?;
    let (source, sha256) = tokio::task::spawn_blocking(move || {
        let sha256 = format!("{:x}", Sha256::digest(&source));
        (source, sha256)
    })
    .await
    .map_err(|_| INTEGRITY)?;
    if sha256 != expected {
        return Err(INTEGRITY.into());
    }
    Ok((
        source,
        Receipt {
            file_name,
            sha256,
            source: PackageSource::OpenVsx,
        },
    ))
}

#[tauri::command]
pub(crate) async fn install_code_open_vsx(
    handle: AppHandle,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
    project_id: Uuid,
    input: CatalogInstall,
) -> Result<Extension, String> {
    let project = state.project(project_id)?;
    let (bytes, receipt) = while_online(&app, async { download(&client()?, &input).await }).await?;
    online(&app).await?;
    tokio::task::spawn_blocking(move || {
        project.directory()?;
        let root = super::storage(&handle)?;
        let key = project.key();
        let (staged_package, incoming) = stage_package(&root, &bytes, &receipt, key)?;
        if incoming.id != input.id || incoming.version != input.version {
            return Err(INTEGRITY.into());
        }
        let _lock = super::STORAGE_LOCK.write().map_err(|_| super::STORAGE)?;
        let destination = root.join(&incoming.id);
        if let Some(previous) = input.installed_sha256 {
            let replaced = replace_staged(
                staged_package.path(),
                &destination,
                key,
                &incoming,
                &previous,
            )?;
            if incoming.id == super::ESLINT_ID || incoming.capability == Capability::Eslint {
                project.eslint.revoke_extension();
            }
            return Ok(replaced);
        }
        let installed = install_staged(&root, staged_package.path(), key, incoming)?;
        let _ = staged_package.keep();
        Ok(installed)
    })
    .await
    .map_err(|_| super::STORAGE)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn featured_matches_the_registry_homepage_ranking() {
        let featured = catalog_url("", 42);
        assert!(allowed_url(&featured));
        assert_eq!(featured.path(), "/api/-/search");
        assert_eq!(
            featured.query(),
            Some("query=&size=7&offset=0&sortBy=relevance&sortOrder=desc")
        );
        let search = catalog_url("language tools", 20);
        assert_eq!(
            search.query(),
            Some("query=language+tools&size=20&offset=20&targetPlatform=universal")
        );
    }

    #[test]
    fn identifies_the_debugger_requirement_in_an_unsupported_manifest() {
        let manifest = parse_manifest(
            br#"{
            "name": "debugpy",
            "publisher": "ms-python",
            "version": "2026.7.0",
            "engines": {"vscode": "^1.92.0"},
            "main": "./dist/extension.js",
            "extensionDependencies": ["ms-python.python"],
            "contributes": {"debuggers": [{"type": "debugpy"}]}
        }"#,
        )
        .unwrap();
        let compatibility = CatalogCompatibility::from_manifest(&manifest);
        assert!(compatibility.capability == Capability::Unsupported);
        assert!(matches!(
            compatibility.incompatibility,
            Some(CatalogIncompatibility::Debugger)
        ));
    }
}
