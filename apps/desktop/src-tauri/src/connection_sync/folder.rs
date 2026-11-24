//! Personal connection sync over a folder managed by the user's file provider.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use chrono::Utc;
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use schema_model::DataSourceProfile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snapshot_store::LocalSnapshotStore;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use std::{fs, path::Path};

use super::{
    MAX_PROFILES, MergeAction, NONCE_LEN, PortableConnection, PreviewRow, SyncEntry, SyncError,
    VERSION, open_password, open_payload, publish_file, read_file, seal_password, seal_payload,
    validate_passphrase,
};
use crate::{
    AppState,
    file_access::{SelectionKind, connection_sync_access},
};

const LIBRARY_DIR: &str = "Nodal Studio Connections";
const LIBRARY_MAGIC: &[u8] = b"NODAL-LIBRARY";
const REVISION_MAGIC: &[u8] = b"NODAL-REVISION";
const KEYRING_SERVICE: &str = "com.claycosmos.nodalstudio.connection-sync";
const EXTENSION: &str = ".nodalconnections";
const MAX_REVISION_BYTES: usize = 64 * 1024;
const MAX_UNSEEN_REVISIONS: usize = 10_000;
const MAX_PENDING_BYTES: usize = 32 * 1024 * 1024;
type LibraryKey = Arc<Zeroizing<[u8; 32]>>;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderProvider {
    ICloud,
    GoogleDrive,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Library {
    id: Uuid,
    key: [u8; 32],
}

impl Drop for Library {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revision {
    library: Uuid,
    id: Uuid,
    parent: Option<Uuid>,
    entry: SyncEntry,
}

#[derive(Clone, Serialize, Deserialize)]
struct Link {
    revision: Uuid,
    origin: Uuid,
    digest: String,
}

#[derive(Serialize, Deserialize)]
struct QueuedRevision {
    profile: Uuid,
    link: Link,
    sealed: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct Binding {
    path: String,
    provider: FolderProvider,
    library: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unlock_slot: Option<Uuid>,
    manifest_digest: String,
    known_libraries: BTreeSet<Uuid>,
    paused: bool,
    links: BTreeMap<Uuid, Link>,
    seen: BTreeSet<Uuid>,
    outbox: Vec<QueuedRevision>,
    last_write: Option<String>,
}

impl Binding {
    fn new(path: String, provider: FolderProvider, library: Uuid, manifest_digest: String) -> Self {
        Self {
            path,
            provider,
            library,
            unlock_slot: Some(Uuid::new_v4()),
            manifest_digest,
            known_libraries: BTreeSet::from([library]),
            paused: false,
            links: BTreeMap::new(),
            seen: BTreeSet::new(),
            outbox: Vec::new(),
            last_write: None,
        }
    }

    fn queued(&self, local: &[DataSourceProfile]) -> Result<usize, SyncError> {
        Ok(self.outbox.len() + unpublished(self, local)?.len())
    }
}

struct StoredBinding {
    json: String,
    binding: Binding,
}

async fn load(store: &LocalSnapshotStore) -> Result<Option<StoredBinding>, SyncError> {
    store
        .connection_folder_state()
        .await
        .map_err(|_| SyncError::Unavailable)?
        .map(|json| {
            let binding = serde_json::from_str(&json).map_err(|_| SyncError::Unavailable)?;
            Ok(StoredBinding { json, binding })
        })
        .transpose()
}

async fn commit(
    store: &LocalSnapshotStore,
    previous: Option<&str>,
    binding: &Binding,
    local: Option<&[DataSourceProfile]>,
    added: &[DataSourceProfile],
    updated: &[DataSourceProfile],
) -> Result<String, SyncError> {
    let json = serde_json::to_string(binding).map_err(|_| SyncError::Unavailable)?;
    if !store
        .commit_connection_folder(previous, &json, local, added, updated)
        .await
        .map_err(|_| SyncError::Unavailable)?
    {
        return Err(SyncError::StalePreview);
    }
    Ok(json)
}

fn exact_id(name: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(name).ok()?;
    (name.len() == 32 && !id.is_nil()).then_some(id)
}

fn manifest_name(id: Uuid) -> String {
    format!("library-{}{EXTENSION}", id.simple())
}

fn revision_name(library: Uuid, revision: Uuid) -> String {
    format!(
        "revision-{}-{}{EXTENSION}",
        library.simple(),
        revision.simple()
    )
}

struct Catalog {
    root: PathBuf,
    libraries: BTreeSet<Uuid>,
    revisions: BTreeMap<Uuid, BTreeSet<Uuid>>,
}

fn catalog(path: &Path) -> Result<Catalog, SyncError> {
    if !path.is_dir() {
        return Err(SyncError::CannotRead);
    }
    let root = if path.file_name().is_some_and(|name| name == LIBRARY_DIR) {
        path.to_path_buf()
    } else {
        path.join(LIBRARY_DIR)
    };
    let mut result = Catalog {
        root,
        libraries: BTreeSet::new(),
        revisions: BTreeMap::new(),
    };
    match fs::symlink_metadata(&result.root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Ok(metadata) if metadata.is_dir() => {}
        _ => return Err(SyncError::CannotRead),
    }
    for entry in fs::read_dir(&result.root).map_err(|_| SyncError::CannotRead)? {
        let entry = entry.map_err(|_| SyncError::CannotRead)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let name = name
            .strip_prefix('.')
            .and_then(|name| name.strip_suffix(".icloud"))
            .unwrap_or(&name);
        let Some(stem) = name.strip_suffix(EXTENSION) else {
            continue;
        };
        if let Some(id) = stem.strip_prefix("library-") {
            result
                .libraries
                .insert(exact_id(id).ok_or(SyncError::InvalidFile)?);
        } else if let Some(ids) = stem.strip_prefix("revision-") {
            let (library, revision) = ids.split_once('-').ok_or(SyncError::InvalidFile)?;
            result
                .revisions
                .entry(exact_id(library).ok_or(SyncError::InvalidFile)?)
                .or_default()
                .insert(exact_id(revision).ok_or(SyncError::InvalidFile)?);
        }
    }
    if result
        .revisions
        .keys()
        .any(|id| !result.libraries.contains(id))
    {
        return Err(SyncError::FolderWaiting);
    }
    Ok(result)
}

fn read_managed(path: &Path) -> Result<Vec<u8>, SyncError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        #[cfg(target_os = "macos")]
        request_icloud_download(path);
        SyncError::FolderWaiting
    })?;
    if !metadata.is_file() {
        return Err(SyncError::InvalidFile);
    }
    if metadata.len() == 0 {
        #[cfg(target_os = "macos")]
        request_icloud_download(path);
        return Err(SyncError::FolderWaiting);
    }
    if metadata.len() > MAX_REVISION_BYTES as u64 {
        return Err(SyncError::TooLarge);
    }
    let bytes = read_file(path).map_err(|error| match error {
        SyncError::CannotRead => SyncError::FolderWaiting,
        other => other,
    })?;
    if bytes.len() > MAX_REVISION_BYTES {
        return Err(SyncError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn request_icloud_download(path: &Path) {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    if let Some(path) = path.to_str() {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let _ = NSFileManager::defaultManager().startDownloadingUbiquitousItemAtURL_error(&url);
    }
}

fn hash<T: Serialize + ?Sized>(data: &T) -> Result<String, SyncError> {
    let mut digest = Sha256::new();
    serde_json::to_writer(&mut digest, data).map_err(|_| SyncError::Unavailable)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn key_from_bytes(key: &[u8; 32]) -> aead::LessSafeKey {
    aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).expect("AES-256 key length is fixed"),
    )
}

fn seal_revision(revision: &Revision, key: &LibraryKey) -> Result<Vec<u8>, SyncError> {
    let mut nonce = [0; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| SyncError::Unavailable)?;
    let mut header = REVISION_MAGIC.to_vec();
    header.push(VERSION);
    header.extend_from_slice(&nonce);
    let payload = Zeroizing::new(serde_json::to_vec(revision).map_err(|_| SyncError::Unavailable)?);
    if header.len() + payload.len() + aead::MAX_TAG_LEN > MAX_REVISION_BYTES {
        return Err(SyncError::TooLarge);
    }
    seal_payload(&key_from_bytes(key), header, &nonce, payload)
}

fn open_revision(file: &[u8], key: &LibraryKey) -> Result<Revision, SyncError> {
    let prefix = REVISION_MAGIC.len() + 1;
    let header_len = prefix + NONCE_LEN;
    if file.len() < header_len + aead::MAX_TAG_LEN || !file.starts_with(REVISION_MAGIC) {
        return Err(SyncError::InvalidFile);
    }
    if file[prefix - 1] != VERSION {
        return Err(SyncError::UnsupportedVersion);
    }
    let (header, payload) = file.split_at(header_len);
    open_payload(&key_from_bytes(key), header, &header[prefix..], payload)
}

fn scan(
    folder: &Catalog,
    binding: &Binding,
    key: &LibraryKey,
) -> Result<BTreeMap<Uuid, Revision>, SyncError> {
    let queued: BTreeSet<_> = binding
        .outbox
        .iter()
        .map(|item| item.link.revision)
        .collect();
    let mut pending = BTreeMap::new();
    let mut pending_bytes = 0;
    for id in folder.revisions.get(&binding.library).into_iter().flatten() {
        if binding.seen.contains(id) || queued.contains(id) {
            continue;
        }
        let path = folder.root.join(revision_name(binding.library, *id));
        let bytes = read_managed(&path)?;
        pending_bytes += bytes.len();
        if pending.len() >= MAX_UNSEEN_REVISIONS || pending_bytes > MAX_PENDING_BYTES {
            return Err(SyncError::TooLarge);
        }
        let record = open_revision(&bytes, key)?;
        if record.id != *id
            || record.library != binding.library
            || record.entry.origin_id.is_nil()
            || !record.entry.connection.is_valid()
        {
            return Err(SyncError::InvalidFile);
        }
        pending.insert(*id, record);
    }
    if pending.values().any(|item| {
        item.parent.is_some_and(|parent| {
            !pending.contains_key(&parent)
                && !binding.seen.contains(&parent)
                && !queued.contains(&parent)
        })
    }) {
        return Err(SyncError::FolderWaiting);
    }
    if pending.values().any(|item| {
        item.parent
            .and_then(|parent| pending.get(&parent))
            .is_some_and(|parent| parent.entry.origin_id != item.entry.origin_id)
    }) {
        return Err(SyncError::InvalidFile);
    }
    Ok(pending)
}

fn unpublished(
    binding: &Binding,
    local: &[DataSourceProfile],
) -> Result<Vec<(Uuid, SyncEntry, String)>, SyncError> {
    let mut outgoing = Vec::new();
    for profile in local {
        let entry = SyncEntry::from_profile(profile);
        if !entry.connection.is_valid() {
            continue;
        }
        let digest = hash(&entry.connection)?;
        let linked = binding
            .links
            .get(&profile.id)
            .is_some_and(|link| link.digest == digest);
        let queued = binding
            .outbox
            .iter()
            .any(|item| item.profile == profile.id && item.link.digest == digest);
        if !linked && !queued {
            outgoing.push((profile.id, entry, digest));
        }
    }
    Ok(outgoing)
}

fn stage(
    binding: &mut Binding,
    local: &[DataSourceProfile],
    key: &LibraryKey,
) -> Result<(), SyncError> {
    for (profile, mut entry, digest) in unpublished(binding, local)? {
        let linked = binding.links.get(&profile);
        if let Some(link) = linked {
            entry.origin_id = link.origin;
        }
        let id = Uuid::new_v4();
        let revision = Revision {
            library: binding.library,
            id,
            parent: linked.map(|link| link.revision),
            entry,
        };
        let link = Link {
            revision: id,
            origin: revision.entry.origin_id,
            digest,
        };
        let sealed = seal_revision(&revision, key)?;
        binding.outbox.push(QueuedRevision {
            profile,
            link,
            sealed,
        });
    }
    Ok(())
}

fn ancestry(id: Uuid, pending: &BTreeMap<Uuid, Revision>) -> impl Iterator<Item = Uuid> + '_ {
    std::iter::successors(Some(id), |id| pending.get(id)?.parent).take(pending.len() + 1)
}

#[derive(Default)]
struct Merge {
    rows: Vec<PreviewRow>,
    added: Vec<DataSourceProfile>,
    updated: Vec<DataSourceProfile>,
}

impl Merge {
    fn outgoing(&self, binding: &Binding, local: &[DataSourceProfile]) -> Result<usize, SyncError> {
        let mut result = local.to_vec();
        for profile in &self.updated {
            if let Some(previous) = result.iter_mut().find(|previous| previous.id == profile.id) {
                *previous = profile.clone();
            }
        }
        binding.queued(&result)
    }
}

fn review(
    binding: &mut Binding,
    pending: &BTreeMap<Uuid, Revision>,
    local: &[DataSourceProfile],
) -> Result<Merge, SyncError> {
    let parents: BTreeSet<_> = pending
        .values()
        .filter_map(|record| record.parent)
        .collect();
    let mut covered = BTreeSet::new();
    let mut proposed = Merge::default();
    let mut candidates = local.to_vec();
    for head in pending
        .values()
        .filter(|record| !parents.contains(&record.id))
    {
        if proposed.rows.len() >= MAX_PROFILES {
            return Err(SyncError::TooLarge);
        }
        let ancestors: BTreeSet<_> = ancestry(head.id, pending).collect();
        covered.extend(
            ancestors
                .iter()
                .filter(|id| pending.contains_key(id))
                .copied(),
        );
        let entry = &head.entry;
        let digest = hash(&entry.connection)?;
        let linked_base = candidates.iter().find(|profile| {
            binding.links.get(&profile.id).is_some_and(|link| {
                link.origin == entry.origin_id && ancestors.contains(&link.revision)
            })
        });
        let existing = linked_base.or_else(|| {
            candidates.iter().find(|profile| {
                let previous = SyncEntry::from_profile(profile);
                binding
                    .links
                    .get(&profile.id)
                    .map_or(previous.origin_id, |link| link.origin)
                    == entry.origin_id
                    || previous
                        .connection
                        .display_name
                        .eq_ignore_ascii_case(&entry.connection.display_name)
            })
        });
        let existing_config = existing.map(|profile| SyncEntry::from_profile(profile).connection);
        let identical = candidates
            .iter()
            .find(|profile| SyncEntry::from_profile(profile).connection == entry.connection);
        let link = Link {
            revision: head.id,
            origin: entry.origin_id,
            digest,
        };
        let action = if let Some(profile) =
            linked_base.filter(|profile| safe_name_update(binding, profile, &entry.connection))
        {
            let mut saved = profile.clone();
            saved
                .display_name
                .clone_from(&entry.connection.display_name);
            saved.updated_at = Utc::now();
            binding.links.insert(saved.id, link);
            if let Some(previous) = candidates
                .iter_mut()
                .find(|previous| previous.id == saved.id)
            {
                *previous = saved.clone();
            }
            proposed.updated.push(saved);
            MergeAction::Update
        } else if let Some(profile) = identical {
            // Keep an existing unrelated lineage when two sources happen to converge.
            if binding
                .links
                .get(&profile.id)
                .is_none_or(|old| ancestors.contains(&old.revision))
            {
                binding.links.insert(profile.id, link);
            }
            MergeAction::Unchanged
        } else {
            let added = entry.clone().into_pending_profile();
            binding.links.insert(added.id, link);
            candidates.push(added.clone());
            proposed.added.push(added);
            if existing_config.is_some() {
                MergeAction::Conflict
            } else {
                MergeAction::Add
            }
        };
        proposed.rows.push(PreviewRow {
            connection: entry.connection.clone(),
            action,
            existing: existing_config,
        });
    }
    if covered.len() != pending.len() {
        return Err(SyncError::InvalidFile);
    }
    binding.seen.extend(covered);
    Ok(proposed)
}

fn safe_name_update(
    binding: &Binding,
    profile: &DataSourceProfile,
    incoming: &PortableConnection,
) -> bool {
    let mut current = SyncEntry::from_profile(profile).connection;
    if current.display_name == incoming.display_name {
        return false;
    }
    let unchanged = hash(&current).is_ok_and(|digest| {
        binding
            .links
            .get(&profile.id)
            .is_some_and(|link| digest == link.digest)
    });
    current.display_name.clone_from(&incoming.display_name);
    unchanged && current == *incoming
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    folder: Option<String>,
    provider: Option<FolderProvider>,
    library: Option<Uuid>,
    paused: bool,
    queued: usize,
    pending: usize,
    pending_id: Option<String>,
    last_write: Option<String>,
    last_check: Option<String>,
    problem: Option<SyncError>,
}

impl FolderStatus {
    fn from_binding(binding: &Binding) -> Self {
        Self {
            folder: Some(binding.path.clone()),
            provider: Some(binding.provider),
            library: Some(binding.library),
            paused: binding.paused,
            last_write: binding.last_write.clone(),
            ..Self::default()
        }
    }
}

#[derive(Default)]
pub struct FolderRuntime {
    gate: Mutex<()>,
    key: RwLock<Option<(Uuid, LibraryKey)>>,
    status: RwLock<FolderStatus>,
}

async fn background<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, SyncError> + Send + 'static,
) -> Result<T, SyncError> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| SyncError::Unavailable)?
}

fn keyring(library: Uuid) -> Result<keyring::Entry, SyncError> {
    keyring::Entry::new(KEYRING_SERVICE, &library.to_string()).map_err(|_| SyncError::Locked)
}

async fn load_key(runtime: &FolderRuntime, binding: &Binding) -> Result<LibraryKey, SyncError> {
    let id = binding.unlock_slot.unwrap_or(binding.library);
    if let Some((cached, key)) = &*runtime.key.read().await
        && *cached == id
    {
        return Ok(Arc::clone(key));
    }
    let key = background(move || {
        let raw = Zeroizing::new(keyring(id)?.get_secret().map_err(|_| SyncError::Locked)?);
        let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| SyncError::Locked)?;
        Ok(Arc::new(Zeroizing::new(bytes)))
    })
    .await?;
    *runtime.key.write().await = Some((id, Arc::clone(&key)));
    Ok(key)
}

fn delete_unlock_key(id: Uuid) -> Result<(), SyncError> {
    match keyring(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(SyncError::Locked),
    }
}

pub(crate) async fn prepare_factory_reset<'a>(
    runtime: &'a FolderRuntime,
    store: &LocalSnapshotStore,
) -> Result<tokio::sync::MutexGuard<'a, ()>, String> {
    let guard = runtime
        .gate
        .try_lock()
        .map_err(|_| "Wait for the connection sync operation to finish before resetting.")?;
    if let Some(id) = load(store)
        .await
        .map_err(|_| "Unable to load local connection sync settings.")?
        .and_then(|saved| saved.binding.unlock_slot)
    {
        background(move || delete_unlock_key(id)).await.map_err(
            |_| "Unable to remove the local connection sync key from the system credential store.",
        )?;
    }
    *runtime.key.write().await = None;
    *runtime.status.write().await = FolderStatus::default();
    Ok(guard)
}

async fn require_online(store: &LocalSnapshotStore) -> Result<(), SyncError> {
    let settings = crate::effective_settings(store, None)
        .await
        .map_err(|_| SyncError::Unavailable)?;
    if settings.app.privacy.offline_mode {
        return Err(SyncError::Offline);
    }
    Ok(())
}

fn check_catalog(folder: &Catalog, binding: &Binding) -> Result<(), SyncError> {
    if !folder.libraries.contains(&binding.library) {
        return Err(SyncError::FolderChanged);
    }
    if !folder.libraries.is_subset(&binding.known_libraries) {
        return Err(SyncError::ChooseLibrary);
    }
    let bytes = read_managed(&folder.root.join(manifest_name(binding.library)))?;
    if format!("{:x}", Sha256::digest(&bytes)) != binding.manifest_digest {
        return Err(SyncError::FolderChanged);
    }
    Ok(())
}

fn publish_outbox(folder: &Catalog, binding: &Binding) -> Result<(), SyncError> {
    for item in &binding.outbox {
        let name = revision_name(binding.library, item.link.revision);
        let path = folder.root.join(&name);
        if folder
            .revisions
            .get(&binding.library)
            .is_some_and(|ids| ids.contains(&item.link.revision))
        {
            if read_managed(&path)? != item.sealed {
                return Err(SyncError::InvalidFile);
            }
        } else {
            publish_file(&folder.root, &name, &item.sealed)?;
        }
    }
    Ok(())
}

async fn flush_queued(
    store: &LocalSnapshotStore,
    mut saved: StoredBinding,
    key: LibraryKey,
    local: Vec<DataSourceProfile>,
) -> Result<StoredBinding, SyncError> {
    // Preserve any batch interrupted between its local commit and file publication.
    let (mut saved_after_stage, reviewed, discarded) = background(move || {
        let path = Path::new(&saved.binding.path);
        let _scope = crate::file_access::access(path).map_err(|_| SyncError::InvalidSelection)?;
        let folder = catalog(path)?;
        check_catalog(&folder, &saved.binding)?;
        let discarded = discard_deleted_drafts(&mut saved.binding, &folder, &local);
        if saved.binding.outbox.is_empty() {
            stage(&mut saved.binding, &local, &key)?;
        }
        Ok((saved, local, discarded))
    })
    .await?;
    if saved_after_stage.binding.outbox.is_empty() && !discarded {
        return Ok(saved_after_stage);
    }
    saved_after_stage.json = commit(
        store,
        Some(&saved_after_stage.json),
        &saved_after_stage.binding,
        Some(&reviewed),
        &[],
        &[],
    )
    .await?;
    if saved_after_stage.binding.outbox.is_empty() {
        return Ok(saved_after_stage);
    }
    require_online(store).await?;
    if store
        .connection_folder_state()
        .await
        .map_err(|_| SyncError::Unavailable)?
        .as_deref()
        != Some(&saved_after_stage.json)
    {
        return Err(SyncError::StalePreview);
    }
    saved = background(move || {
        let path = Path::new(&saved_after_stage.binding.path);
        let _scope = crate::file_access::access(path).map_err(|_| SyncError::InvalidSelection)?;
        let folder = catalog(path)?;
        check_catalog(&folder, &saved_after_stage.binding)?;
        publish_outbox(&folder, &saved_after_stage.binding)?;
        Ok(saved_after_stage)
    })
    .await?;
    for item in saved.binding.outbox.drain(..) {
        saved.binding.seen.insert(item.link.revision);
        saved.binding.links.insert(item.profile, item.link);
    }
    saved.binding.last_write = Some(Utc::now().to_rfc3339());
    saved.json = commit(store, Some(&saved.json), &saved.binding, None, &[], &[]).await?;
    Ok(saved)
}

fn discard_deleted_drafts(
    binding: &mut Binding,
    folder: &Catalog,
    local: &[DataSourceProfile],
) -> bool {
    let current_ids: BTreeSet<_> = local.iter().map(|profile| profile.id).collect();
    let published = folder.revisions.get(&binding.library);
    let previous_count = binding.outbox.len();
    binding.outbox.retain(|item| {
        if current_ids.contains(&item.profile)
            || published.is_some_and(|ids| ids.contains(&item.link.revision))
        {
            return true;
        }
        // A published copy that arrives later must not resurrect a locally deleted source.
        binding.seen.insert(item.link.revision);
        false
    });
    binding.outbox.len() != previous_count
}

fn scan_bound(binding: &Binding, key: &LibraryKey) -> Result<BTreeMap<Uuid, Revision>, SyncError> {
    let path = Path::new(&binding.path);
    let _scope = crate::file_access::access(path).map_err(|_| SyncError::InvalidSelection)?;
    let folder = catalog(path)?;
    check_catalog(&folder, binding)?;
    scan(&folder, binding, key)
}

async fn refresh(
    runtime: &FolderRuntime,
    store: &LocalSnapshotStore,
) -> Result<FolderStatus, SyncError> {
    let Some(saved) = load(store).await? else {
        *runtime.status.write().await = FolderStatus::default();
        return Ok(FolderStatus::default());
    };
    let mut status = FolderStatus::from_binding(&saved.binding);
    let last_check = {
        let previous = runtime.status.read().await;
        previous
            .last_check
            .clone()
            .filter(|_| previous.library == status.library)
    };
    let local = store
        .list_data_sources()
        .await
        .map_err(|_| SyncError::Unavailable)?;
    status.queued = saved.binding.queued(&local)?;
    if !saved.binding.paused {
        let result = async {
            require_online(store).await?;
            let key = load_key(runtime, &saved.binding).await?;
            let saved = flush_queued(store, saved, Arc::clone(&key), local.clone()).await?;
            status = FolderStatus::from_binding(&saved.binding);
            status.queued = saved.binding.queued(&local)?;
            let (pending, count) = background(move || {
                let mut binding = saved.binding;
                let pending = scan_bound(&binding, &key)?;
                let merge = review(&mut binding, &pending, &local)?;
                let pending_id = (!pending.is_empty())
                    .then(|| hash(&pending.keys().collect::<Vec<_>>()))
                    .transpose()?;
                Ok((pending_id, merge.rows.len()))
            })
            .await?;
            status.pending = count;
            status.pending_id = pending;
            status.last_check = Some(Utc::now().to_rfc3339());
            Ok::<(), SyncError>(())
        }
        .await;
        status.problem = result.err();
    }
    if status.last_check.is_none() {
        status.last_check = last_check;
    }
    if let Some(current) = load(store).await?
        && current.binding.paused
    {
        status.paused = true;
        status.problem = None;
        status.pending = 0;
        status.pending_id = None;
    }
    *runtime.status.write().await = status.clone();
    Ok(status)
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if !crate::purchase::can_use_paid_features(
                &app.state::<crate::purchase::PurchaseState>(),
            ) {
                continue;
            }
            let runtime = app.state::<FolderRuntime>();
            let Ok(_operation) = runtime.gate.try_lock() else {
                continue;
            };
            let _ = refresh(&runtime, &app.state::<AppState>().store).await;
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    libraries: BTreeSet<Uuid>,
}

#[tauri::command]
pub async fn inspect_connection_folder(
    folder: String,
    app: State<'_, AppState>,
) -> Result<FolderInspection, SyncError> {
    require_online(&app.store).await?;
    background(move || {
        let path = Path::new(&folder);
        let _scope = connection_sync_access(path, SelectionKind::ConnectionSyncFolder)
            .map_err(|_| SyncError::InvalidSelection)?;
        Ok(FolderInspection {
            libraries: catalog(path)?.libraries,
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInput {
    folder: String,
    provider: FolderProvider,
    library: Option<Uuid>,
    passphrase: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreview {
    token: String,
    rows: Vec<PreviewRow>,
    outgoing: usize,
    creates_library: bool,
    deferred_incoming: bool,
}

struct SetupPlan {
    binding: Binding,
    key: LibraryKey,
    new_manifest: Option<Zeroizing<Vec<u8>>>,
    previous: Option<String>,
    previous_slot: Option<Uuid>,
    local: Vec<DataSourceProfile>,
    merge: Merge,
    token: String,
}

struct LibrarySelection {
    id: Uuid,
    digest: String,
    key: LibraryKey,
    new_manifest: Option<Zeroizing<Vec<u8>>>,
}

fn select_library(
    found: &Catalog,
    library: Option<Uuid>,
    passphrase: &str,
    create_manifest: bool,
) -> Result<LibrarySelection, SyncError> {
    let (manifest, ciphertext, is_new) = if let Some(id) = library {
        if !found.libraries.contains(&id) {
            return Err(SyncError::FolderChanged);
        }
        let ciphertext = read_managed(&found.root.join(manifest_name(id)))?;
        let manifest: Library = open_password(LIBRARY_MAGIC, &ciphertext, passphrase)?;
        if manifest.id != id {
            return Err(SyncError::InvalidFile);
        }
        (manifest, ciphertext, false)
    } else {
        if !found.libraries.is_empty() {
            return Err(SyncError::ChooseLibrary);
        }
        let mut manifest = Library {
            id: Uuid::new_v4(),
            key: [0; 32],
        };
        SystemRandom::new()
            .fill(&mut manifest.key)
            .map_err(|_| SyncError::Unavailable)?;
        let ciphertext = if create_manifest {
            seal_password(LIBRARY_MAGIC, &manifest, passphrase)?
        } else {
            Vec::new()
        };
        (manifest, ciphertext, true)
    };
    let digest = format!("{:x}", Sha256::digest(&ciphertext));
    Ok(LibrarySelection {
        id: manifest.id,
        digest,
        key: Arc::new(Zeroizing::new(manifest.key)),
        new_manifest: is_new.then(|| Zeroizing::new(ciphertext)),
    })
}

async fn setup_plan(
    input: SetupInput,
    store: &LocalSnapshotStore,
    create_manifest: bool,
) -> Result<SetupPlan, SyncError> {
    let SetupInput {
        folder,
        provider,
        library,
        passphrase,
    } = input;
    let passphrase = Zeroizing::new(passphrase);
    require_online(store).await?;
    let existing = load(store).await?;
    let local = store
        .list_data_sources()
        .await
        .map_err(|_| SyncError::Unavailable)?;
    background(move || {
        validate_passphrase(&passphrase)?;
        let path = Path::new(&folder);
        let _scope = connection_sync_access(path, SelectionKind::ConnectionSyncFolder)
            .map_err(|_| SyncError::InvalidSelection)?;
        let found = catalog(path)?;
        let LibrarySelection {
            id: library,
            digest: manifest_digest,
            key,
            new_manifest,
        } = select_library(&found, library, &passphrase, create_manifest)?;
        let (previous, current) = existing.map_or((None, None), |stored| {
            (Some(stored.json), Some(stored.binding))
        });
        let previous_slot = current.as_ref().and_then(|binding| binding.unlock_slot);
        let mut binding = if let Some(current) = current.filter(|value| value.library == library) {
            if current.manifest_digest != manifest_digest {
                return Err(SyncError::FolderChanged);
            }
            Binding {
                path: folder.clone(),
                provider,
                paused: false,
                ..current
            }
        } else {
            Binding::new(folder.clone(), provider, library, manifest_digest)
        };
        binding.unlock_slot.get_or_insert_with(Uuid::new_v4);
        binding
            .known_libraries
            .extend(found.libraries.iter().copied());
        // During reauthorization, recover our previous writes before reviewing remote descendants.
        // Otherwise confirming a remote rename can advance a link that the outbox later rewinds.
        let incoming = if binding.outbox.is_empty() {
            scan(&found, &binding, &key)?
        } else {
            BTreeMap::new()
        };
        // A new workspace has no persisted ID or salt until setup is committed.
        let selected = new_manifest
            .is_none()
            .then_some((library, &binding.manifest_digest));
        let token = hash(&(
            &folder,
            provider,
            selected,
            &found.libraries,
            &incoming,
            &local,
            &previous,
        ))?;
        let merge = review(&mut binding, &incoming, &local)?;
        Ok(SetupPlan {
            binding,
            key,
            new_manifest,
            previous,
            previous_slot,
            local,
            merge,
            token,
        })
    })
    .await
}

#[tauri::command]
pub async fn preview_connection_folder_setup(
    input: SetupInput,
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderPreview, SyncError> {
    let _operation = runtime.gate.try_lock().map_err(|_| SyncError::Busy)?;
    let plan = setup_plan(input, &app.store, false).await?;
    Ok(FolderPreview {
        token: plan.token,
        outgoing: plan.merge.outgoing(&plan.binding, &plan.local)?,
        creates_library: plan.new_manifest.is_some(),
        deferred_incoming: !plan.binding.outbox.is_empty(),
        rows: plan.merge.rows,
    })
}

#[tauri::command]
pub async fn enable_connection_folder(
    input: SetupInput,
    token: String,
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderStatus, SyncError> {
    let _operation = runtime.gate.try_lock().map_err(|_| SyncError::Busy)?;
    let plan = setup_plan(input, &app.store, true).await?;
    if plan.token != token {
        return Err(SyncError::StalePreview);
    }
    require_online(&app.store).await?;
    let folder = plan.binding.path.clone();
    let library = plan.binding.library;
    let unlock_slot = plan.binding.unlock_slot.ok_or(SyncError::Unavailable)?;
    let new_slot = plan.previous_slot != Some(unlock_slot);
    let key = Arc::clone(&plan.key);
    let provisioned = background(move || {
        let path = Path::new(&folder);
        let _scope = connection_sync_access(path, SelectionKind::ConnectionSyncFolder)
            .map_err(|_| SyncError::InvalidSelection)?;
        crate::file_access::remember(path).map_err(|_| SyncError::InvalidSelection)?;
        keyring(unlock_slot)?
            .set_secret(key.as_ref().as_ref())
            .map_err(|_| SyncError::Locked)?;
        if let Some(manifest) = plan.new_manifest {
            let found = catalog(path)?;
            if !found.libraries.is_empty() {
                return Err(SyncError::StalePreview);
            }
            match fs::create_dir(&found.root) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(SyncError::CannotWrite),
            }
            // Verify the managed directory again after creation.
            let found = catalog(path)?;
            if !found.libraries.is_empty() {
                return Err(SyncError::StalePreview);
            }
            publish_file(&found.root, &manifest_name(library), &manifest)?;
        }
        Ok(())
    })
    .await;
    let result = async {
        provisioned?;
        commit(
            &app.store,
            plan.previous.as_deref(),
            &plan.binding,
            Some(&plan.local),
            &plan.merge.added,
            &plan.merge.updated,
        )
        .await
    }
    .await;
    if let Err(error) = result {
        if new_slot {
            let _ = background(move || delete_unlock_key(unlock_slot)).await;
        }
        return Err(error);
    }
    *runtime.key.write().await = Some((unlock_slot, plan.key));
    if let Some(previous_slot) = plan.previous_slot.filter(|id| *id != unlock_slot) {
        let _ = background(move || delete_unlock_key(previous_slot)).await;
    }
    refresh(&runtime, &app.store).await
}

#[tauri::command]
pub async fn get_connection_folder_status(
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderStatus, SyncError> {
    let status = runtime.status.read().await.clone();
    if status.folder.is_some() {
        return Ok(status);
    }
    Ok(load(&app.store)
        .await?
        .map_or(status, |saved| FolderStatus::from_binding(&saved.binding)))
}

#[tauri::command]
pub async fn check_connection_folder(
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderStatus, SyncError> {
    let _operation = runtime.gate.try_lock().map_err(|_| SyncError::Busy)?;
    refresh(&runtime, &app.store).await
}

#[tauri::command]
pub async fn set_connection_folder_paused(
    paused: bool,
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderStatus, SyncError> {
    let Some(mut saved) = load(&app.store).await? else {
        return Err(SyncError::InvalidSelection);
    };
    saved.binding.paused = paused;
    commit(
        &app.store,
        Some(&saved.json),
        &saved.binding,
        None,
        &[],
        &[],
    )
    .await?;
    if !paused && let Ok(_operation) = runtime.gate.try_lock() {
        return refresh(&runtime, &app.store).await;
    }
    let mut status = runtime.status.write().await;
    if status.library != Some(saved.binding.library) {
        *status = FolderStatus::from_binding(&saved.binding);
    }
    status.paused = paused;
    status.pending = 0;
    status.pending_id = None;
    status.problem = None;
    Ok(status.clone())
}

struct PendingPlan {
    preview: FolderPreview,
    saved: StoredBinding,
    local: Vec<DataSourceProfile>,
    added: Vec<DataSourceProfile>,
    updated: Vec<DataSourceProfile>,
}

async fn pending_plan(
    store: &LocalSnapshotStore,
    runtime: &FolderRuntime,
) -> Result<PendingPlan, SyncError> {
    require_online(store).await?;
    let Some(mut saved) = load(store).await? else {
        return Err(SyncError::InvalidSelection);
    };
    if saved.binding.paused {
        return Err(SyncError::Paused);
    }
    if !saved.binding.outbox.is_empty() {
        return Err(SyncError::Busy);
    }
    let key = load_key(runtime, &saved.binding).await?;
    let local = store
        .list_data_sources()
        .await
        .map_err(|_| SyncError::Unavailable)?;
    background(move || {
        let incoming = scan_bound(&saved.binding, &key)?;
        let token = hash(&(&saved.json, &local, &incoming))?;
        let merge = review(&mut saved.binding, &incoming, &local)?;
        let outgoing = merge.outgoing(&saved.binding, &local)?;
        let preview = FolderPreview {
            token,
            rows: merge.rows,
            outgoing,
            creates_library: false,
            deferred_incoming: false,
        };
        Ok(PendingPlan {
            preview,
            saved,
            local,
            added: merge.added,
            updated: merge.updated,
        })
    })
    .await
}

#[tauri::command]
pub async fn preview_connection_folder_updates(
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderPreview, SyncError> {
    let _operation = runtime.gate.try_lock().map_err(|_| SyncError::Busy)?;
    Ok(pending_plan(&app.store, &runtime).await?.preview)
}

#[tauri::command]
pub async fn apply_connection_folder_updates(
    token: String,
    app: State<'_, AppState>,
    runtime: State<'_, FolderRuntime>,
) -> Result<FolderStatus, SyncError> {
    let _operation = runtime.gate.try_lock().map_err(|_| SyncError::Busy)?;
    let plan = pending_plan(&app.store, &runtime).await?;
    if plan.preview.token != token {
        return Err(SyncError::StalePreview);
    }
    commit(
        &app.store,
        Some(&plan.saved.json),
        &plan.saved.binding,
        Some(&plan.local),
        &plan.added,
        &plan.updated,
    )
    .await?;
    refresh(&runtime, &app.store).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{
        ConnectionSecurity, DatabaseType, SshAuthentication, SshConfig, SslMode, TlsConfig,
    };

    const PASSPHRASE: &str = "a test-only folder passphrase";

    fn profile() -> DataSourceProfile {
        let now = Utc::now();
        DataSourceProfile {
            server_source_id: None,
            id: Uuid::new_v4(),
            display_name: "Warehouse".into(),
            host: "private.internal.example".into(),
            port: 5432,
            database: "warehouse".into(),
            username: "reader".into(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::VerifyFull,
            sqlite: None,
            connection_sync: None,
            security: ConnectionSecurity {
                tls: TlsConfig {
                    ca_certificate: Some("/local/trust/ca.pem".into()),
                    client_certificate: Some("/local/keys/cert.pem".into()),
                    client_key: Some("/local/keys/client.pem".into()),
                },
                ssh: Some(SshConfig {
                    host: "jump.example".into(),
                    port: 22,
                    username: "ssh".into(),
                    authentication: SshAuthentication::PrivateKey,
                    private_key: Some("/local/keys/ssh".into()),
                    known_hosts: Some("/local/keys/known_hosts".into()),
                }),
            },
            created_at: now,
            updated_at: now,
        }
    }

    fn binding_for(path: &Path, selected: &LibrarySelection) -> Binding {
        Binding::new(
            path.to_string_lossy().into_owned(),
            FolderProvider::ICloud,
            selected.id,
            selected.digest.clone(),
        )
    }

    fn create_library(path: &Path) -> LibrarySelection {
        let found = catalog(path).unwrap();
        let chosen = select_library(&found, None, PASSPHRASE, true).unwrap();
        fs::create_dir(&found.root).unwrap();
        publish_file(
            &found.root,
            &manifest_name(chosen.id),
            chosen.new_manifest.as_deref().unwrap(),
        )
        .unwrap();
        chosen
    }

    fn write_local_version(
        binding: &mut Binding,
        source: DataSourceProfile,
        key: &LibraryKey,
    ) -> Uuid {
        stage(binding, &[source], key).unwrap();
        let found = catalog(Path::new(&binding.path)).unwrap();
        publish_outbox(&found, binding).unwrap();
        let item = binding.outbox.pop().unwrap();
        let id = item.link.revision;
        binding.seen.insert(id);
        binding.links.insert(item.profile, item.link);
        id
    }

    #[tokio::test]
    async fn two_installations_migrate_review_keep_conflicts_and_do_not_echo() {
        let folder = tempfile::tempdir().unwrap();
        let library = create_library(folder.path());
        let mut first = binding_for(folder.path(), &library);
        let a_store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let b_store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let a = profile();
        a_store.save_data_source(&a).await.unwrap();
        let initial_id = write_local_version(&mut first, a.clone(), &library.key);

        let found = catalog(folder.path()).unwrap();
        let joined = select_library(&found, Some(library.id), PASSPHRASE, false).unwrap();
        assert!(matches!(
            select_library(&found, Some(library.id), "an incorrect passphrase", false),
            Err(SyncError::CannotDecrypt)
        ));
        let sealed = read_managed(&found.root.join(revision_name(library.id, initial_id))).unwrap();
        assert!(
            !sealed
                .windows(a.host.len())
                .any(|bytes| bytes == a.host.as_bytes())
        );
        let raw = serde_json::to_string(&open_revision(&sealed, &joined.key).unwrap()).unwrap();
        assert!(!raw.contains("/local/"));
        assert!(!raw.contains("clientKey"));
        assert!(!raw.contains("knownHosts"));
        let mut second = binding_for(folder.path(), &joined);
        let incoming = scan(&found, &second, &joined.key).unwrap();
        let merge = review(&mut second, &incoming, &[]).unwrap();
        assert_eq!(merge.rows[0].action, MergeAction::Add);
        assert!(b_store.list_data_sources().await.unwrap().is_empty());
        let b = merge.added[0].clone();
        let b_state = commit(&b_store, None, &second, Some(&[]), &merge.added, &[])
            .await
            .unwrap();
        assert_eq!(b_store.list_data_sources().await.unwrap(), vec![b.clone()]);
        assert!(b.connection_sync.unwrap().pending);
        assert!(b.security.tls.client_key.is_none());
        assert!(b.security.ssh.as_ref().unwrap().private_key.is_none());
        assert_eq!(second.queued(std::slice::from_ref(&b)).unwrap(), 0);

        let mut edited_a = a.clone();
        edited_a.host = "other-a.example".into();
        a_store.save_data_source(&edited_a).await.unwrap();
        write_local_version(&mut first, edited_a.clone(), &library.key);
        let mut edited_b = b;
        edited_b.host = "other-b.example".into();
        b_store.save_data_source(&edited_b).await.unwrap();
        write_local_version(&mut second, edited_b.clone(), &library.key);

        let found = catalog(folder.path()).unwrap();
        let incoming = scan(&found, &second, &joined.key).unwrap();
        let merge = review(&mut second, &incoming, std::slice::from_ref(&edited_b)).unwrap();
        assert_eq!(merge.rows[0].action, MergeAction::Conflict);
        assert_eq!(
            merge.rows[0].existing.as_ref().unwrap().host,
            "other-b.example"
        );
        assert_eq!(
            b_store.list_data_sources().await.unwrap(),
            vec![edited_b.clone()]
        );
        commit(
            &b_store,
            Some(&b_state),
            &second,
            Some(std::slice::from_ref(&edited_b)),
            &merge.added,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(b_store.list_data_sources().await.unwrap().len(), 2);
        assert!(scan(&found, &second, &joined.key).unwrap().is_empty());
        assert_eq!(
            second
                .queued(&b_store.list_data_sources().await.unwrap())
                .unwrap(),
            0
        );

        // A newly joined device sees both branch tips, without recreating their common ancestor.
        let mut third = binding_for(folder.path(), &joined);
        let incoming = scan(&found, &third, &joined.key).unwrap();
        let merge = review(&mut third, &incoming, &[]).unwrap();
        assert_eq!(merge.added.len(), 2);
        assert_eq!(third.seen.len(), 3);
    }

    #[test]
    fn creates_empty_library_and_retries_a_partially_published_batch() {
        let folder = tempfile::tempdir().unwrap();
        assert!(catalog(folder.path()).unwrap().libraries.is_empty());
        let library = create_library(folder.path());
        let mut state = binding_for(folder.path(), &library);
        let second = binding_for(folder.path(), &library);
        assert_ne!(state.unlock_slot, second.unlock_slot);
        let found = catalog(folder.path()).unwrap();
        assert_eq!(catalog(&found.root).unwrap().libraries, found.libraries);
        assert!(scan(&found, &state, &library.key).unwrap().is_empty());
        stage(&mut state, &[], &library.key).unwrap();
        assert!(state.outbox.is_empty());

        stage(&mut state, &[profile()], &library.key).unwrap();
        let item = &state.outbox[0];
        let name = revision_name(state.library, item.link.revision);
        publish_file(&found.root, &name, &item.sealed).unwrap();
        let after_restart: Binding =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        let found = catalog(folder.path()).unwrap();
        publish_outbox(&found, &after_restart).unwrap();
        assert_eq!(found.revisions[&library.id].len(), 1);
        assert!(
            scan(&found, &after_restart, &library.key)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn discards_unpublished_drafts_for_deleted_sources_and_retains_published_entries() {
        let folder = tempfile::tempdir().unwrap();
        let library = create_library(folder.path());
        let mut binding = binding_for(folder.path(), &library);
        let pending = profile();
        let published = profile();
        stage(&mut binding, &[pending, published], &library.key).unwrap();
        let pending_revision = binding.outbox[0].link.revision;
        let published_revision = &binding.outbox[1];
        let found = catalog(folder.path()).unwrap();
        publish_file(
            &found.root,
            &revision_name(binding.library, published_revision.link.revision),
            &published_revision.sealed,
        )
        .unwrap();
        let published_id = published_revision.link.revision;
        let found = catalog(folder.path()).unwrap();
        assert!(discard_deleted_drafts(&mut binding, &found, &[]));
        assert_eq!(binding.outbox.len(), 1);
        assert_eq!(binding.outbox[0].link.revision, published_id);
        assert!(binding.seen.contains(&pending_revision));
        publish_outbox(&found, &binding).unwrap();
        let found = catalog(folder.path()).unwrap();
        assert_eq!(found.revisions[&library.id], BTreeSet::from([published_id]));
    }

    #[tokio::test]
    async fn legacy_bindings_keep_their_unlock_lookup_and_reset_waits_for_sync() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let library = Uuid::new_v4();
        let mut legacy = Binding::new(
            "/legacy".into(),
            FolderProvider::ICloud,
            library,
            String::new(),
        );
        legacy.unlock_slot = None;
        commit(&store, None, &legacy, None, &[], &[]).await.unwrap();
        let runtime = FolderRuntime::default();
        let key = Arc::new(Zeroizing::new([7; 32]));
        *runtime.key.write().await = Some((library, Arc::clone(&key)));
        let saved = load(&store).await.unwrap().unwrap();
        assert!(Arc::ptr_eq(
            &load_key(&runtime, &saved.binding).await.unwrap(),
            &key
        ));
        let sync = runtime.gate.lock().await;
        assert!(prepare_factory_reset(&runtime, &store).await.is_err());
        assert!(runtime.key.read().await.is_some());
        drop(sync);
        let _reset = prepare_factory_reset(&runtime, &store).await.unwrap();
        assert!(runtime.key.read().await.is_none());
        assert!(runtime.gate.try_lock().is_err());
    }

    #[cfg(not(feature = "mac-app-store"))]
    #[tokio::test]
    async fn worker_restores_a_binding_and_defers_mutations_until_review() {
        let folder = tempfile::tempdir().unwrap();
        let library = create_library(folder.path());
        let db_path = folder.path().join("local.sqlite3");
        let db = LocalSnapshotStore::open_path(&db_path).await.unwrap();
        let mut binding = binding_for(folder.path(), &library);
        let slot = binding.unlock_slot.unwrap();
        let local = profile();
        db.save_data_source(&local).await.unwrap();
        stage(&mut binding, std::slice::from_ref(&local), &library.key).unwrap();
        commit(&db, None, &binding, None, &[], &[]).await.unwrap();
        let mut settings = db.get_app_settings().await.unwrap();
        settings.privacy.offline_mode = true;
        db.save_app_settings(&settings).await.unwrap();
        db.close().await;

        let db = LocalSnapshotStore::open_path(&db_path).await.unwrap();
        let runtime = FolderRuntime::default();
        *runtime.key.write().await = Some((slot, Arc::clone(&library.key)));
        let offline = refresh(&runtime, &db).await.unwrap();
        assert_eq!(offline.problem, Some(SyncError::Offline));
        assert_eq!(offline.queued, 1);
        assert!(catalog(folder.path()).unwrap().revisions.is_empty());

        settings.privacy.offline_mode = false;
        db.save_app_settings(&settings).await.unwrap();
        assert!(matches!(
            pending_plan(&db, &runtime).await,
            Err(SyncError::Busy)
        ));
        let found = catalog(folder.path()).unwrap();
        let pending_child = Revision {
            id: Uuid::new_v4(),
            library: library.id,
            parent: Some(Uuid::new_v4()),
            entry: SyncEntry::from_profile(&profile()),
        };
        let child_name = revision_name(library.id, pending_child.id);
        publish_file(
            &found.root,
            &child_name,
            &seal_revision(&pending_child, &library.key).unwrap(),
        )
        .unwrap();
        let online = refresh(&runtime, &db).await.unwrap();
        assert_eq!(online.problem, Some(SyncError::FolderWaiting));
        assert_eq!(online.queued, 0);
        assert!(online.last_write.is_some());
        assert_eq!(
            catalog(folder.path()).unwrap().revisions[&library.id].len(),
            2
        );
        fs::remove_file(found.root.join(child_name)).unwrap();

        let mut another_device = binding_for(folder.path(), &library);
        let mut incoming = profile();
        incoming.host = "other-installation.example".into();
        write_local_version(&mut another_device, incoming, &library.key);
        let status = refresh(&runtime, &db).await.unwrap();
        assert_eq!(status.pending, 1);
        assert_eq!(db.list_data_sources().await.unwrap(), vec![local]);

        let plan = pending_plan(&db, &runtime).await.unwrap();
        assert_eq!(plan.preview.rows[0].action, MergeAction::Conflict);
        commit(
            &db,
            Some(&plan.saved.json),
            &plan.saved.binding,
            Some(&plan.local),
            &plan.added,
            &plan.updated,
        )
        .await
        .unwrap();
        assert_eq!(refresh(&runtime, &db).await.unwrap().pending, 0);
        assert_eq!(db.list_data_sources().await.unwrap().len(), 2);
    }

    #[test]
    fn waits_for_parent_and_detects_additional_library_without_overwriting() {
        let folder = tempfile::tempdir().unwrap();
        let library = create_library(folder.path());
        let state = binding_for(folder.path(), &library);
        let found = catalog(folder.path()).unwrap();
        let revision = Revision {
            id: Uuid::new_v4(),
            library: state.library,
            parent: Some(Uuid::new_v4()),
            entry: SyncEntry::from_profile(&profile()),
        };
        publish_file(
            &found.root,
            &revision_name(state.library, revision.id),
            &seal_revision(&revision, &library.key).unwrap(),
        )
        .unwrap();
        let found = catalog(folder.path()).unwrap();
        assert!(matches!(
            scan(&found, &state, &library.key),
            Err(SyncError::FolderWaiting)
        ));
        publish_file(
            &found.root,
            &manifest_name(Uuid::new_v4()),
            b"other library",
        )
        .unwrap();
        assert_eq!(
            check_catalog(&catalog(folder.path()).unwrap(), &state),
            Err(SyncError::ChooseLibrary)
        );
    }

    #[tokio::test]
    async fn name_only_update_keeps_the_local_binding_and_rejects_a_stale_review() {
        let folder = tempfile::tempdir().unwrap();
        let library = create_library(folder.path());
        let mut first = binding_for(folder.path(), &library);
        let local = profile();
        let parent = write_local_version(&mut first, local.clone(), &library.key);
        let mut other = local.clone();
        other.display_name = "Remote rename".into();
        let mut unrelated = other.clone();
        unrelated.id = Uuid::new_v4();
        let child = Revision {
            id: Uuid::new_v4(),
            library: first.library,
            parent: Some(parent),
            entry: SyncEntry::from_profile(&other),
        };
        let db = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        db.save_data_source(&local).await.unwrap();
        db.save_data_source(&unrelated).await.unwrap();
        write_local_version(&mut first, unrelated.clone(), &library.key);
        let original_state = commit(&db, None, &first, None, &[], &[]).await.unwrap();
        let pending = BTreeMap::from([(child.id, child)]);
        let snapshot = db.list_data_sources().await.unwrap();
        let merge = review(&mut first, &pending, &snapshot).unwrap();
        assert_eq!(merge.rows[0].action, MergeAction::Update);
        assert!(merge.added.is_empty());
        assert_eq!(merge.updated[0].id, local.id);
        assert_eq!(merge.updated[0].security, local.security);
        assert_eq!(merge.outgoing(&first, &snapshot).unwrap(), 0);
        let mut edited = local;
        edited.display_name = "Local concurrent edit".into();
        db.save_data_source(&edited).await.unwrap();
        assert_eq!(
            commit(
                &db,
                Some(&original_state),
                &first,
                Some(&snapshot),
                &[],
                &merge.updated
            )
            .await,
            Err(SyncError::StalePreview)
        );
        let current = db.list_data_sources().await.unwrap();
        assert!(current.contains(&edited));
        assert!(current.contains(&unrelated));
    }
}
