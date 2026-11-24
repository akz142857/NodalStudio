//! Encrypted, credential-free snapshots for manual transfer between installations.
pub mod folder;
use std::{
    fs::{self, File},
    io::{Read, Write},
    num::NonZeroU32,
    path::Path,
};

use chrono::Utc;
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use schema_model::{
    ConnectionSecurity, ConnectionSyncIdentity, DataSourceProfile, DatabaseType, SshAuthentication,
    SshConfig, SslMode, TlsConfig,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    AppState,
    file_access::{SelectionKind, connection_sync_access},
};

const MAGIC: &[u8] = b"NODAL-CONNECTIONS";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
#[cfg(test)]
const PREFIX_LEN: usize = MAGIC.len() + 1;
#[cfg(test)]
const HEADER_LEN: usize = PREFIX_LEN + SALT_LEN + NONCE_LEN;
const KDF_ITERATIONS: NonZeroU32 = NonZeroU32::new(600_000).unwrap();
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROFILES: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncError {
    PassphraseLength,
    NoConnections,
    InvalidFile,
    UnsupportedVersion,
    CannotDecrypt,
    CannotRead,
    CannotWrite,
    InvalidSelection,
    TooLarge,
    StalePreview,
    Unavailable,
    Busy,
    FolderWaiting,
    FolderChanged,
    ChooseLibrary,
    Locked,
    Offline,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableSsh {
    host: String,
    port: u16,
    username: String,
    authentication: SshAuthentication,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableConnection {
    display_name: String,
    database_type: DatabaseType,
    database: String,
    host: String,
    port: u16,
    username: String,
    ssl_mode: SslMode,
    ssh: Option<PortableSsh>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncEntry {
    origin_id: Uuid,
    connection: PortableConnection,
}

impl SyncEntry {
    fn from_profile(profile: &DataSourceProfile) -> Self {
        let sqlite = profile.database_type == DatabaseType::Sqlite;
        let database = if sqlite {
            profile
                .database
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .to_owned()
        } else {
            profile.database.clone()
        };
        // Explicit allowlist. Never serialize DataSourceProfile or read the keychain for export.
        let connection = PortableConnection {
            display_name: profile.display_name.clone(),
            database_type: profile.database_type,
            database,
            host: if sqlite {
                String::new()
            } else {
                profile.host.clone()
            },
            port: if sqlite { 0 } else { profile.port },
            username: if sqlite {
                String::new()
            } else {
                profile.username.clone()
            },
            ssl_mode: if sqlite {
                SslMode::Disable
            } else {
                profile.ssl_mode
            },
            ssh: profile
                .security
                .ssh
                .as_ref()
                .filter(|_| !sqlite)
                .map(|ssh| PortableSsh {
                    host: ssh.host.clone(),
                    port: ssh.port,
                    username: ssh.username.clone(),
                    authentication: ssh.authentication,
                }),
        };
        Self {
            origin_id: profile
                .connection_sync
                .map_or(profile.id, |identity| identity.origin_id),
            connection,
        }
    }

    fn into_pending_profile(self) -> DataSourceProfile {
        let connection = self.connection;
        let now = Utc::now();
        DataSourceProfile {
            id: Uuid::new_v4(),
            connection_sync: Some(ConnectionSyncIdentity {
                origin_id: self.origin_id,
                pending: true,
            }),
            display_name: connection.display_name,
            database_type: connection.database_type,
            database: connection.database,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            ssl_mode: connection.ssl_mode,
            sqlite: None,
            security: ConnectionSecurity {
                tls: TlsConfig::default(),
                ssh: connection.ssh.map(|ssh| SshConfig {
                    host: ssh.host,
                    port: ssh.port,
                    username: ssh.username,
                    authentication: ssh.authentication,
                    private_key: None,
                    known_hosts: None,
                }),
            },
            created_at: now,
            updated_at: now,
        }
    }
}

fn valid_host(host: &str) -> bool {
    !host.is_empty() && !host.contains(['/', '\\', '@']) && !host.chars().any(char::is_whitespace)
}

impl PortableConnection {
    fn is_valid(&self) -> bool {
        if self.display_name.trim().is_empty() || self.database.trim().is_empty() {
            return false;
        }
        if self.database_type == DatabaseType::Sqlite {
            return !self.database.contains(['/', '\\'])
                && self.host.is_empty()
                && self.username.is_empty()
                && self.port == 0
                && self.ssh.is_none()
                && self.ssl_mode == SslMode::Disable;
        }
        valid_host(&self.host)
            && self.port != 0
            && !self.username.trim().is_empty()
            && self.ssh.as_ref().is_none_or(|ssh| {
                valid_host(&ssh.host) && ssh.port != 0 && !ssh.username.trim().is_empty()
            })
    }
}

fn validate_passphrase(passphrase: &str) -> Result<(), SyncError> {
    if passphrase.len() > 1024 || passphrase.trim().is_empty() || passphrase.chars().count() < 12 {
        return Err(SyncError::PassphraseLength);
    }
    Ok(())
}

fn derive_key(salt: &[u8], passphrase: &str) -> aead::LessSafeKey {
    let mut key_bytes = Zeroizing::new([0; 32]);
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        KDF_ITERATIONS,
        salt,
        passphrase.as_bytes(),
        key_bytes.as_mut(),
    );
    aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes.as_ref())
            .expect("AES-256 key length is fixed"),
    )
}

fn encrypt(entries: &[SyncEntry], passphrase: &str) -> Result<Vec<u8>, SyncError> {
    validate_passphrase(passphrase)?;
    if entries.is_empty() {
        return Err(SyncError::NoConnections);
    }
    if entries.len() > MAX_PROFILES {
        return Err(SyncError::TooLarge);
    }
    seal_password(MAGIC, entries, passphrase)
}

fn seal_password<T: Serialize + ?Sized>(
    magic: &[u8],
    data: &T,
    passphrase: &str,
) -> Result<Vec<u8>, SyncError> {
    let payload = Zeroizing::new(serde_json::to_vec(data).map_err(|_| SyncError::Unavailable)?);
    if payload.len() + magic.len() + 1 + SALT_LEN + NONCE_LEN + aead::MAX_TAG_LEN > MAX_FILE_BYTES {
        return Err(SyncError::TooLarge);
    }

    let mut random = [0; SALT_LEN + NONCE_LEN];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| SyncError::Unavailable)?;
    let (salt, nonce) = random.split_at(SALT_LEN);
    let mut file = Vec::new();
    file.extend_from_slice(magic);
    file.push(VERSION);
    file.extend_from_slice(&random);
    seal_payload(&derive_key(salt, passphrase), file, nonce, payload)
}

fn seal_payload(
    key: &aead::LessSafeKey,
    mut file: Vec<u8>,
    nonce: &[u8],
    mut payload: Zeroizing<Vec<u8>>,
) -> Result<Vec<u8>, SyncError> {
    let tag = key
        .seal_in_place_separate_tag(
            aead::Nonce::try_assume_unique_for_key(nonce).map_err(|_| SyncError::Unavailable)?,
            aead::Aad::from(&file),
            &mut payload,
        )
        .map_err(|_| SyncError::Unavailable)?;
    file.extend_from_slice(&payload);
    file.extend_from_slice(tag.as_ref());
    Ok(file)
}

fn decrypt(file: &[u8], passphrase: &str) -> Result<Vec<SyncEntry>, SyncError> {
    validate_passphrase(passphrase)?;
    let entries: Vec<SyncEntry> = open_password(MAGIC, file, passphrase)?;
    if entries.is_empty()
        || entries.len() > MAX_PROFILES
        || entries
            .iter()
            .any(|entry| entry.origin_id.is_nil() || !entry.connection.is_valid())
    {
        return Err(SyncError::InvalidFile);
    }
    Ok(entries)
}

fn open_password<T: serde::de::DeserializeOwned>(
    magic: &[u8],
    file: &[u8],
    passphrase: &str,
) -> Result<T, SyncError> {
    if file.len() > MAX_FILE_BYTES {
        return Err(SyncError::TooLarge);
    }
    if !file.starts_with(magic) {
        return Err(SyncError::InvalidFile);
    }
    match file.get(magic.len()) {
        Some(&VERSION) => {}
        Some(_) => return Err(SyncError::UnsupportedVersion),
        None => return Err(SyncError::InvalidFile),
    }
    let prefix_len = magic.len() + 1;
    let header_len = prefix_len + SALT_LEN + NONCE_LEN;
    if file.len() < header_len + aead::MAX_TAG_LEN {
        return Err(SyncError::InvalidFile);
    }
    let (header, payload) = file.split_at(header_len);
    let (salt, nonce) = header[prefix_len..].split_at(SALT_LEN);
    open_payload(&derive_key(salt, passphrase), header, nonce, payload)
}

fn open_payload<T: serde::de::DeserializeOwned>(
    key: &aead::LessSafeKey,
    header: &[u8],
    nonce: &[u8],
    payload: &[u8],
) -> Result<T, SyncError> {
    let mut payload = Zeroizing::new(payload.to_vec());
    let plaintext = key
        .open_in_place(
            aead::Nonce::try_assume_unique_for_key(nonce).map_err(|_| SyncError::InvalidFile)?,
            aead::Aad::from(header),
            &mut payload,
        )
        .map_err(|_| SyncError::CannotDecrypt)?;
    serde_json::from_slice(plaintext).map_err(|_| SyncError::InvalidFile)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum MergeAction {
    Add,
    Update,
    Unchanged,
    Conflict,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRow {
    connection: PortableConnection,
    action: MergeAction,
    existing: Option<PortableConnection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    token: String,
    rows: Vec<PreviewRow>,
}

fn merge(
    entries: Vec<SyncEntry>,
    local: &[DataSourceProfile],
) -> (Vec<PreviewRow>, Vec<DataSourceProfile>) {
    let mut candidates: Vec<SyncEntry> = local.iter().map(SyncEntry::from_profile).collect();
    let mut rows = Vec::with_capacity(entries.len());
    let mut added = Vec::new();
    for entry in entries {
        let same_name = |candidate: &SyncEntry| {
            candidate.connection.display_name.to_lowercase()
                == entry.connection.display_name.to_lowercase()
        };
        let existing = candidates
            .iter()
            .find(|candidate| candidate.origin_id == entry.origin_id)
            .or_else(|| candidates.iter().find(|candidate| same_name(candidate)));
        let (action, existing) = if candidates
            .iter()
            .any(|candidate| candidate.connection == entry.connection)
        {
            (MergeAction::Unchanged, None)
        } else if let Some(existing) = existing {
            (MergeAction::Conflict, Some(existing.connection.clone()))
        } else {
            (MergeAction::Add, None)
        };
        let connection = entry.connection.clone();
        if action != MergeAction::Unchanged {
            candidates.push(SyncEntry {
                origin_id: entry.origin_id,
                connection: connection.clone(),
            });
            added.push(entry.into_pending_profile());
        }
        rows.push(PreviewRow {
            connection,
            action,
            existing,
        });
    }
    (rows, added)
}

fn write_file(folder: &Path, encrypted: &[u8]) -> Result<String, SyncError> {
    let file_name = format!(
        "nodal-connections-{}-{}.nodalconnections",
        Utc::now().format("%Y%m%d-%H%M%S"),
        Uuid::new_v4().simple()
    );
    publish_file(folder, &file_name, encrypted)?;
    Ok(file_name)
}

fn publish_file(folder: &Path, file_name: &str, encrypted: &[u8]) -> Result<(), SyncError> {
    let mut file = tempfile::NamedTempFile::new_in(folder).map_err(|_| SyncError::CannotWrite)?;
    file.write_all(encrypted)
        .map_err(|_| SyncError::CannotWrite)?;
    file.as_file()
        .sync_all()
        .map_err(|_| SyncError::CannotWrite)?;
    file.persist_noclobber(folder.join(file_name))
        .map_err(|_| SyncError::CannotWrite)?;
    Ok(())
}

fn read_file(path: &Path) -> Result<Vec<u8>, SyncError> {
    if path
        .extension()
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("nodalconnections"))
    {
        return Err(SyncError::InvalidFile);
    }
    // Also reject pipes, devices and directories before opening.
    let metadata = fs::symlink_metadata(path).map_err(|_| SyncError::CannotRead)?;
    if !metadata.is_file() {
        return Err(SyncError::CannotRead);
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(SyncError::TooLarge);
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| SyncError::CannotRead)?
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SyncError::CannotRead)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(SyncError::TooLarge);
    }
    Ok(bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExportReceipt {
    file_name: String,
    count: usize,
    skipped: usize,
}

#[tauri::command]
pub async fn export_connection_sync(
    folder: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<SyncExportReceipt, SyncError> {
    let passphrase = Zeroizing::new(passphrase);
    let profiles = state
        .store
        .list_data_sources()
        .await
        .map_err(|_| SyncError::Unavailable)?;
    tokio::task::spawn_blocking(move || {
        let folder = Path::new(&folder);
        let _scope = connection_sync_access(folder, SelectionKind::ConnectionSyncFolder)
            .map_err(|_| SyncError::InvalidSelection)?;
        let entries: Vec<_> = profiles
            .iter()
            .map(SyncEntry::from_profile)
            .filter(|entry| entry.connection.is_valid())
            .collect();
        let encrypted = encrypt(&entries, &passphrase)?;
        Ok(SyncExportReceipt {
            file_name: write_file(folder, &encrypted)?,
            count: entries.len(),
            skipped: profiles.len() - entries.len(),
        })
    })
    .await
    .map_err(|_| SyncError::Unavailable)?
}

struct ImportPlan {
    preview: SyncPreview,
    local: Vec<DataSourceProfile>,
    added: Vec<DataSourceProfile>,
}

async fn plan_import(
    path: String,
    passphrase: Zeroizing<String>,
    state: &AppState,
) -> Result<ImportPlan, SyncError> {
    let (entries, file_digest) = tokio::task::spawn_blocking(move || {
        let path = Path::new(&path);
        let _scope = connection_sync_access(path, SelectionKind::OpenConnectionSync)
            .map_err(|_| SyncError::InvalidSelection)?;
        let bytes = read_file(path)?;
        Ok((decrypt(&bytes, &passphrase)?, Sha256::digest(&bytes)))
    })
    .await
    .map_err(|_| SyncError::Unavailable)??;
    let local = state
        .store
        .list_data_sources()
        .await
        .map_err(|_| SyncError::Unavailable)?;
    let mut digest = Sha256::new();
    digest.update(file_digest);
    // Include the full local state so concurrent edits or setup changes invalidate the preview.
    serde_json::to_writer(&mut digest, &local).map_err(|_| SyncError::Unavailable)?;
    let token = format!("{:x}", digest.finalize());
    let (rows, added) = merge(entries, &local);
    Ok(ImportPlan {
        preview: SyncPreview { token, rows },
        local,
        added,
    })
}

#[tauri::command]
pub async fn preview_connection_sync(
    path: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<SyncPreview, SyncError> {
    Ok(plan_import(path, Zeroizing::new(passphrase), &state)
        .await?
        .preview)
}

#[tauri::command]
pub async fn import_connection_sync(
    path: String,
    passphrase: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<Vec<DataSourceProfile>, SyncError> {
    let plan = plan_import(path, Zeroizing::new(passphrase), &state).await?;
    if plan.preview.token != token
        || !state
            .store
            .insert_connection_sync_profiles(&plan.local, &plan.added)
            .await
            .map_err(|_| SyncError::Unavailable)?
    {
        return Err(SyncError::StalePreview);
    }
    Ok(plan.added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::SqliteFile;
    use snapshot_store::LocalSnapshotStore;

    const PASSPHRASE: &str = "test passphrase for these files";

    fn network() -> DataSourceProfile {
        let now = Utc::now();
        DataSourceProfile {
            id: Uuid::new_v4(),
            connection_sync: None,
            display_name: "Production test".into(),
            host: "db.example".into(),
            port: 5432,
            database: "app".into(),
            username: "reader".into(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::VerifyFull,
            sqlite: None,
            security: ConnectionSecurity {
                tls: TlsConfig {
                    ca_certificate: Some("/local/ca.pem".into()),
                    client_certificate: Some("/local/tls-cert.pem".into()),
                    client_key: Some("/local/tls-key.pem".into()),
                },
                ssh: Some(SshConfig {
                    host: "jump.example".into(),
                    port: 22,
                    username: "ssh-user".into(),
                    authentication: SshAuthentication::PrivateKey,
                    private_key: Some("/local/ssh-key".into()),
                    known_hosts: Some("/local/known_hosts".into()),
                }),
            },
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn encrypts_only_portable_fields_and_authenticates_the_file() {
        let network = network();
        let mut sqlite = network.clone();
        sqlite.id = Uuid::new_v4();
        sqlite.display_name = "Local SQLite".into();
        sqlite.database_type = DatabaseType::Sqlite;
        sqlite.database = r"C:\private\example.sqlite".into();
        sqlite.sqlite = Some(SqliteFile {
            path: sqlite.database.clone(),
            access_directory: Some(r"C:\private".into()),
        });
        let entries = [
            SyncEntry::from_profile(&network),
            SyncEntry::from_profile(&sqlite),
        ];
        let payload = serde_json::to_value(&entries).unwrap();
        assert_eq!(
            payload[0]["connection"]["ssh"]["authentication"],
            "privateKey"
        );
        assert_eq!(payload[1]["connection"]["database"], "example.sqlite");
        let payload = payload.to_string();
        for omitted in [
            "/local/",
            "private\\\\",
            "clientKey",
            "knownHosts",
            "password",
            "sqliteFile",
        ] {
            assert!(!payload.contains(omitted), "{omitted}");
        }

        let mut bytes = encrypt(&entries, PASSPHRASE).unwrap();
        let other = encrypt(&entries, PASSPHRASE).unwrap();
        assert_ne!(
            &bytes[PREFIX_LEN..HEADER_LEN],
            &other[PREFIX_LEN..HEADER_LEN]
        );
        assert!(
            !bytes
                .windows(network.host.len())
                .any(|window| window == network.host.as_bytes())
        );
        let decrypted = decrypt(&bytes, PASSPHRASE).unwrap();
        assert_eq!(entries[0].connection, decrypted[0].connection);
        assert_eq!(entries[1].connection, decrypted[1].connection);

        assert_eq!(
            decrypt(&bytes, "incorrect passphrase").unwrap_err(),
            SyncError::CannotDecrypt
        );
        bytes[PREFIX_LEN] ^= 1;
        assert_eq!(
            decrypt(&bytes, PASSPHRASE).unwrap_err(),
            SyncError::CannotDecrypt
        );
        bytes[MAGIC.len()] = VERSION + 1;
        assert_eq!(
            decrypt(&bytes, PASSPHRASE).unwrap_err(),
            SyncError::UnsupportedVersion
        );
    }

    #[test]
    fn uses_distinct_complete_files_and_bounds_reads() {
        let folder = tempfile::tempdir().unwrap();
        let bytes = b"encrypted content";
        let first = write_file(folder.path(), bytes).unwrap();
        let second = write_file(folder.path(), bytes).unwrap();
        assert_ne!(first, second);
        assert_eq!(read_file(&folder.path().join(first)).unwrap(), bytes);
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 2);
        let oversized = folder.path().join("large.nodalconnections");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_FILE_BYTES as u64 + 1)
            .unwrap();
        assert_eq!(read_file(&oversized).unwrap_err(), SyncError::TooLarge);
    }

    #[tokio::test]
    async fn previews_conflicts_appends_only_and_rejects_concurrent_changes() {
        let db = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let local = network();
        db.save_data_source(&local).await.unwrap();
        let mut incoming = SyncEntry::from_profile(&local);
        incoming.connection.host = "other.example".into();
        let mut unrelated = SyncEntry::from_profile(&network());
        unrelated.connection.display_name = "Other connection".into();

        let original_state = db.list_data_sources().await.unwrap();
        let (rows, added) = merge(vec![incoming, unrelated], &original_state);
        assert_eq!(rows[0].action, MergeAction::Conflict);
        assert_eq!(rows[0].existing.as_ref().unwrap().host, "db.example");
        assert_eq!(rows[1].action, MergeAction::Add);
        assert_eq!(db.list_data_sources().await.unwrap(), original_state);
        assert_ne!(added[0].id, local.id);
        assert_eq!(added[0].connection_sync.unwrap().origin_id, local.id);
        assert!(crate::connection_credentials::require_binding(&added[0]).is_err());
        assert!(
            added[0]
                .security
                .ssh
                .as_ref()
                .unwrap()
                .private_key
                .is_none()
        );
        assert!(added[0].security.tls.client_key.is_none());

        let mut edited = local.clone();
        edited.display_name = "Updated locally".into();
        db.save_data_source(&edited).await.unwrap();
        assert!(
            !db.insert_connection_sync_profiles(&original_state, &added)
                .await
                .unwrap()
        );
        let current = db.list_data_sources().await.unwrap();
        assert_eq!(current, vec![edited.clone()]);

        let invalid_batch = [added[0].clone(), edited.clone()];
        assert!(
            db.insert_connection_sync_profiles(&current, &invalid_batch)
                .await
                .is_err()
        );
        assert_eq!(db.list_data_sources().await.unwrap(), current);
        assert!(
            db.insert_connection_sync_profiles(&current, &added)
                .await
                .unwrap()
        );

        let after_import = db.list_data_sources().await.unwrap();
        assert_eq!(after_import.len(), 3);
        assert_eq!(db.get_data_source(local.id).await.unwrap(), Some(edited));
        let (rows, duplicates) = merge(
            added.iter().map(SyncEntry::from_profile).collect(),
            &after_import,
        );
        assert!(rows.iter().all(|row| row.action == MergeAction::Unchanged));
        assert!(duplicates.is_empty());
    }

    #[test]
    fn identifies_conflicts_for_separately_created_connections_with_the_same_name() {
        let local = network();
        let mut other = network();
        other.port = 5433;
        let (rows, added) = merge(vec![SyncEntry::from_profile(&other)], &[local]);
        assert_eq!(rows[0].action, MergeAction::Conflict);
        assert_eq!(added[0].port, 5433);
        assert_eq!(added[0].connection_sync.unwrap().origin_id, other.id);
    }
}
