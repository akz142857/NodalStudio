//! Explicit single-file changes to a Git worktree's index.
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions, Permissions},
};
use git2::{AttrCheckFlags, Index, IndexEntry, IndexTime, Oid, Repository};
use sha2::{Digest, Sha256};

use super::files;
use super::review::STALE;

const LOCK_NAME: &str = "index.lock";
const ASSUME_UNCHANGED: u16 = 0x8000;
const SKIP_WORKTREE: u16 = 1 << 14;
const INDEX_NAME: &str = "index";
const LOCKED: &str = "codeReviewIndexLocked";
const UNAVAILABLE: &str = "codeReviewIndexUnavailable";
pub(super) const UNSUPPORTED: &str = "codeReviewIndexUnsupported";

pub(super) fn revision(index: &Index) -> String {
    let mut hash = Sha256::new();
    for entry in index.iter() {
        hash.update((entry.path.len() as u64).to_le_bytes());
        hash.update(&entry.path);
        hash.update(entry.id.as_bytes());
        hash.update(entry.mode.to_le_bytes());
        hash.update(entry.flags.to_le_bytes());
        hash.update(entry.flags_extended.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn metadata_directory(
    repo: &Repository,
    directory: &files::Repository,
) -> Result<(PathBuf, Dir), String> {
    let metadata = repo.path().canonicalize().map_err(|_| UNAVAILABLE)?;
    let root = repo
        .workdir()
        .ok_or(UNAVAILABLE)?
        .canonicalize()
        .map_err(|_| UNAVAILABLE)?;
    let git_marker = root.join(".git");
    if metadata == git_marker {
        let dir = directory
            .dir
            .open_dir_nofollow(".git")
            .map_err(|_| UNAVAILABLE)?;
        return Ok((metadata, dir));
    }

    // A linked worktree uses its own index inside the shared Git directory.
    // Require Git's backlink and the conventional worktrees metadata location.
    let common = repo.commondir().canonicalize().map_err(|_| UNAVAILABLE)?;
    if !repo.is_worktree() || metadata.parent() != Some(common.join("worktrees").as_path()) {
        return Err(UNSUPPORTED.into());
    }
    let dir = Dir::open_ambient_dir(&metadata, ambient_authority()).map_err(|_| UNAVAILABLE)?;
    let marker = files::read_file(&dir, Path::new("gitdir"), 4_096).map_err(|_| UNAVAILABLE)?;
    if Path::new(marker.trim_end()).canonicalize().as_ref().ok() != Some(&git_marker) {
        return Err(UNSUPPORTED.into());
    }
    Ok((metadata, dir))
}

struct IndexLock {
    dir: Dir,
    file: Option<cap_std::fs::File>,
    committed: bool,
}

impl IndexLock {
    fn acquire(dir: Dir) -> Result<Self, String> {
        let file = dir
            .open_with(
                LOCK_NAME,
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .follow(FollowSymlinks::No),
            )
            .map_err(|error| {
                if matches!(error.kind(), io::ErrorKind::AlreadyExists) {
                    LOCKED
                } else {
                    UNAVAILABLE
                }
            })?;
        Ok(Self {
            dir,
            file: Some(file),
            committed: false,
        })
    }

    fn commit(
        mut self,
        draft: &Path,
        permissions: Option<Permissions>,
        validate: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut output = self.file.take().ok_or(UNAVAILABLE)?;
        let mut input = File::open(draft).map_err(|_| UNAVAILABLE)?;
        io::copy(&mut input, &mut output).map_err(|_| UNAVAILABLE)?;
        if let Some(permissions) = permissions {
            output
                .set_permissions(permissions)
                .map_err(|_| UNAVAILABLE)?;
        }
        output
            .flush()
            .and_then(|()| output.sync_all())
            .map_err(|_| UNAVAILABLE)?;
        drop(output);
        validate()?;
        self.dir
            .rename(LOCK_NAME, &self.dir, INDEX_NAME)
            .map_err(|_| UNAVAILABLE)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        if !self.committed {
            drop(self.file.take());
            let _ = self.dir.remove_file(LOCK_NAME);
        }
    }
}

/// Lock the real index before opening the scratch copy. The scratch index is
/// written with libgit2, then published by renaming our Git-compatible lock file.
pub(super) fn update(
    repo: &Repository,
    directory: &files::Repository,
    expected_revision: &str,
    edit: impl FnOnce(&mut Index) -> Result<(), String>,
    validate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let (metadata, dir) = metadata_directory(repo, directory)?;
    let lock = IndexLock::acquire(dir)?;
    let permissions = match lock.dir.symlink_metadata(INDEX_NAME) {
        Ok(metadata) if metadata.is_file() => Some(metadata.permissions()),
        Ok(_) => return Err(UNSUPPORTED.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => return Err(UNAVAILABLE.into()),
    };
    let scratch = tempfile::tempdir_in(metadata).map_err(|_| UNAVAILABLE)?;
    let draft = scratch.path().join(INDEX_NAME);
    if permissions.is_some() {
        let mut current = lock
            .dir
            .open_with(
                INDEX_NAME,
                OpenOptions::new().read(true).follow(FollowSymlinks::No),
            )
            .map_err(|_| UNAVAILABLE)?;
        let mut copy = fs::File::create(&draft).map_err(|_| UNAVAILABLE)?;
        io::copy(&mut current, &mut copy).map_err(|_| UNAVAILABLE)?;
    }
    let mut index = Index::open_ext(&draft, repo.object_format()).map_err(|_| UNSUPPORTED)?;
    if revision(&index) != expected_revision {
        return Err(STALE.into());
    }
    if index.has_conflicts() {
        return Err("codeReviewIndexConflict".into());
    }
    edit(&mut index)?;
    index.write().map_err(|_| UNAVAILABLE)?;
    lock.commit(&draft, permissions, validate)
}

pub(super) fn set_entry(
    index: &mut Index,
    path: &str,
    target: Option<(Oid, u32)>,
) -> Result<(), String> {
    if let Some((id, mode)) = target {
        let (flags, flags_extended) = index
            .get_path(Path::new(path), 0)
            .map(|entry| {
                (
                    entry.flags & ASSUME_UNCHANGED,
                    entry.flags_extended & SKIP_WORKTREE,
                )
            })
            .unwrap_or_default();
        // Force Git to recheck worktree metadata on the next status, including
        // after cancelling a stage where the working version remains different.
        let entry = IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode,
            uid: 0,
            gid: 0,
            file_size: 0,
            id,
            flags,
            flags_extended,
            path: path.as_bytes().to_vec(),
        };
        index.add(&entry).map_err(|_| UNAVAILABLE)?;
    } else if index.get_path(Path::new(path), 0).is_some() {
        index
            .remove_path(Path::new(path))
            .map_err(|_| UNAVAILABLE)?;
    }
    Ok(())
}

pub(super) fn blob_for_stage(repo: &Repository, path: &Path, text: &str) -> Result<Oid, String> {
    for attribute in ["filter", "working-tree-encoding"] {
        let attribute = repo
            .get_attr_bytes(path, attribute, AttrCheckFlags::FILE_THEN_INDEX)
            .map_err(|_| UNSUPPORTED)?;
        if !matches!(
            git2::AttrValue::from_bytes(attribute),
            git2::AttrValue::Unspecified | git2::AttrValue::False
        ) {
            return Err(UNSUPPORTED.into());
        }
    }
    let mut writer = repo.blob_writer(Some(path)).map_err(|_| UNAVAILABLE)?;
    writer.write_all(text.as_bytes()).map_err(|_| UNAVAILABLE)?;
    writer.commit().map_err(|_| UNAVAILABLE.into())
}

pub(super) fn worktree_mode(
    repo: &Repository,
    directory: &files::Repository,
    path: &Path,
    previous: Option<u32>,
) -> Result<u32, String> {
    let parent = files::open_nested_directory(&directory.dir, path.parent().ok_or(STALE)?)
        .map_err(|_| STALE)?;
    let metadata = parent
        .symlink_metadata(path.file_name().ok_or(STALE)?)
        .map_err(|_| STALE)?;
    if !metadata.is_file() {
        return Err(UNSUPPORTED.into());
    }
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        if repo
            .config()
            .and_then(|config| config.get_bool("core.filemode"))
            .unwrap_or(true)
        {
            return Ok(if metadata.permissions().mode() & 0o100 == 0 {
                0o100_644
            } else {
                0o100_755
            });
        }
    }
    #[cfg(not(unix))]
    let _ = repo;
    Ok(if previous == Some(0o100_755) {
        0o100_755
    } else {
        0o100_644
    })
}
