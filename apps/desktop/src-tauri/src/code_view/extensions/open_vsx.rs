//! Public Open VSX catalog and exact-version package downloads.
use std::{collections::BTreeMap, future::Future, time::Duration};

use futures_util::{StreamExt, stream};
use reqwest::{Client, StatusCode, Url, redirect};
use semver::Version;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::{
    Capability, Extension, MAX_ARCHIVE, MAX_ENTRY, PackageSource, Receipt, ReviewState,
    UNSUPPORTED, capabilities, compatible_update, has_valid_id, install_staged, installation,
    installed_paths, newer, package_id, parse_manifest, replace_staged, stage_package,
    with_storage,
};
use crate::{AppState, effective_settings};

const REGISTRY: &str = "open-vsx.org";
const CDN: &str = "openvsx.eclipsecontent.org";
const NETWORK: &str = "openVsxNetwork";
const OFFLINE: &str = "openVsxOffline";
const RESPONSE: &str = "openVsxResponse";
const UNAVAILABLE: &str = "openVsxUnavailable";
const INTEGRITY: &str = "openVsxIntegrity";
const MAX_JSON: usize = 2 * 1024 * 1024;
const SEARCH_SIZE: u32 = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
    downloadable: bool,
    can_update: bool,
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
        .map_err(|_| NETWORK.into())
}

async fn get(
    client: &Client,
    url: Url,
    max: usize,
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
    if response
        .content_length()
        .is_some_and(|size| size > max as u64)
    {
        return Err(size_error.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK)? {
        if chunk.len() > max - body.len() {
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

async fn declared_capability(client: &Client, record: &Record) -> Option<Capability> {
    let asset = record.file_url("manifest")?;
    let bytes = get(client, asset, MAX_ENTRY as usize, RESPONSE)
        .await
        .ok()??;
    let manifest = parse_manifest(&bytes).ok()?;
    if package_id(&manifest.publisher, &manifest.name).ok()? != record.id().ok()?
        || manifest.version != record.version
    {
        return None;
    }
    Some(capabilities(&manifest, None).0)
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
    let wait_for_offline = async {
        loop {
            tokio::time::sleep(Duration::from_millis(350)).await;
            if let Err(reason) = online(app).await {
                return reason;
            }
        }
    };
    tokio::select! {
        result = request => result,
        reason = wait_for_offline => Err(reason),
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
    if query.is_empty() || query.chars().count() > 160 {
        return Err(RESPONSE.into());
    }
    while_online(&app, async {
        let mut url = api_url(&["-", "search"]);
        url.query_pairs_mut()
            .append_pair("query", query)
            .append_pair("size", &SEARCH_SIZE.to_string())
            .append_pair("offset", &offset.to_string())
            .append_pair("targetPlatform", "universal");
        let data = json::<SearchResponse>(&client()?, url)
            .await?
            .ok_or(RESPONSE)?;
        let count = data.extensions.len() as u32;
        let next = offset.saturating_add(count);
        Ok(CatalogPage {
            items: data
                .extensions
                .iter()
                .filter_map(|record| record.catalog_item().ok())
                .collect(),
            next_offset: (count > 0 && next > offset && next < data.total_size).then_some(next),
        })
    })
    .await
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
    let (record, capability) = while_online(&app, async {
        let client = client()?;
        let record = release(&client, &id, version.as_deref())
            .await?
            .ok_or(UNAVAILABLE)?;
        let capability = declared_capability(&client, &record).await;
        Ok((record, capability))
    })
    .await?;
    let remote_version = record.version.clone();
    let can_update = with_storage(handle, &state, project_id, move |root, key| {
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
    let installed = with_storage(handle, &state, project_id, |root, key| {
        installed_paths(root)?
            .into_iter()
            .map(|path| installation(&path, key))
            .collect::<Result<Vec<_>, _>>()
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
                    && declared_capability(&client, &record)
                        .await
                        .is_none_or(|capability| compatible_update(item.capability, capability))
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
    let source = get(client, url, MAX_ARCHIVE as usize, super::LIMIT)
        .await?
        .ok_or(UNAVAILABLE)?;
    let sha256 = format!("{:x}", Sha256::digest(&source));
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
    state.project(project_id)?;
    let (bytes, receipt) = while_online(&app, async { download(&client()?, &input).await }).await?;
    online(&app).await?;
    with_storage(handle, &state, project_id, move |root, key| {
        let (stage, incoming) = stage_package(root, &bytes, &receipt, key)?;
        if incoming.id != input.id || incoming.version != input.version {
            return Err(INTEGRITY.into());
        }
        if incoming.capability == Capability::Unsupported {
            return Err(UNSUPPORTED.into());
        }
        let destination = root.join(&incoming.id);
        if let Some(previous) = input.installed_sha256 {
            return replace_staged(stage.path(), &destination, key, &incoming, &previous);
        }
        install_staged(root, stage.path(), &destination)?;
        Ok(incoming)
    })
    .await
}
