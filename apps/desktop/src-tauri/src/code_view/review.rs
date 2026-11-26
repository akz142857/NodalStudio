//! Read-only project review backed by a user-selected directory.
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use git2::{Delta, Diff, DiffFindOptions, DiffOptions, FileMode, Oid, RepositoryOpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

use super::definition::{
    DefinitionRequest, DefinitionResult, Definitions, DocumentHighlightRange,
    DocumentOutlineRequest, DocumentOutlineResult, SourcePosition,
};
use super::files::{
    MAX_FILE_BYTES, Repository, RootIdentity, open_nested_directory, read_nested,
    review_relative_path,
};
use crate::file_access::{SelectionKind, pick_workspace_path_from};

const MAX_ENTRIES: usize = 2_000;
const MAX_COMPACT_SEGMENTS: usize = 16;
const MAX_COMPACT_LOOKAHEAD: usize = 256;
const MAX_CHANGES: usize = 1_000;
pub(super) const MAX_QUICK_OPEN_ENTRIES: usize = 30_000;
pub(super) const UNAVAILABLE: &str = "codeReviewUnavailable";
const STALE: &str = "codeReviewStale";

#[derive(Default)]
pub(crate) struct ReviewState(Mutex<Option<Arc<Project>>>);

pub(super) struct Project {
    info: ProjectInfo,
    pub(super) root: PathBuf,
    identity: RootIdentity,
    baseline: Option<Oid>,
    changes: Mutex<BTreeMap<String, Change>>,
    definitions: Definitions,
    pub(super) search: super::search::SearchSession,
    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    pub(super) eslint: super::eslint::EslintSession,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInfo {
    id: Uuid,
    key: String,
    name: String,
    baseline: Option<String>,
    git: GitState,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum GitState {
    Folder,
    Ready,
    NoBaseline,
    Unavailable,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Conflict,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    path: String,
    previous_path: Option<String>,
    kind: ChangeKind,
    staged: bool,
    index_only: bool,
    evidence: Option<String>,
    #[serde(skip)]
    before: Option<BlobVersion>,
    #[serde(skip)]
    index: Option<BlobVersion>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct BlobVersion {
    id: Oid,
    mode: FileMode,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Changes {
    files: Vec<Change>,
    limited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    directory: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    compact_segments: Vec<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CompactFolders {
    Visible,
    All,
}

impl CompactFolders {
    fn includes(self, name: &str) -> bool {
        !name.eq_ignore_ascii_case(".git") && (matches!(self, Self::All) || !name.starts_with('.'))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Directory {
    entries: Vec<Entry>,
    limited: bool,
}

#[derive(Serialize)]
#[serde(tag = "state", content = "text", rename_all = "camelCase")]
pub(super) enum FileVersion {
    Text(String),
    Missing,
    Binary,
    Encoding,
    TooLarge,
    Unreadable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    before: Option<FileVersion>,
    pub(super) after: FileVersion,
    pub(super) evidence: Option<String>,
    pub(super) index_only: bool,
}

impl ReviewState {
    pub(super) fn current(&self) -> Result<Option<Arc<Project>>, String> {
        Ok(self.0.lock().map_err(|_| UNAVAILABLE)?.clone())
    }

    pub(super) fn project(&self, id: Uuid) -> Result<Arc<Project>, String> {
        self.current()?
            .filter(|project| project.info.id == id)
            .ok_or_else(|| STALE.into())
    }
}

impl Project {
    pub(super) fn open(root: PathBuf) -> Result<Self, String> {
        let (directory, identity) = Repository::open_directory(&root, None)?;
        let (git, baseline) = match directory.dir.symlink_metadata(".git") {
            Err(err) if err.kind() == ErrorKind::NotFound => (GitState::Folder, None),
            _ => match open_git(&directory, &root) {
                Ok(repo) => match repo.head().and_then(|head| head.peel_to_commit()) {
                    Ok(commit) => (GitState::Ready, Some(commit.id())),
                    Err(err) if err.code() == git2::ErrorCode::UnbornBranch => {
                        (GitState::NoBaseline, None)
                    }
                    Err(_) => (GitState::Unavailable, None),
                },
                Err(_) => (GitState::Unavailable, None),
            },
        };
        let key_data = serde_json::to_vec(&(&root, &identity)).map_err(|_| UNAVAILABLE)?;
        let info = ProjectInfo {
            id: Uuid::new_v4(),
            key: format!("{:x}", Sha256::digest(key_data)),
            name: root
                .file_name()
                .ok_or(UNAVAILABLE)?
                .to_string_lossy()
                .into_owned(),
            baseline: baseline.map(|id| id.to_string()),
            git,
        };
        Ok(Self {
            info,
            root,
            identity,
            baseline,
            changes: Mutex::default(),
            definitions: Definitions::default(),
            search: super::search::SearchSession::default(),
            #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
            eslint: super::eslint::EslintSession::default(),
        })
    }

    pub(super) fn directory(&self) -> Result<Repository, String> {
        Repository::open_directory(&self.root, Some(&self.identity)).map(|(directory, _)| directory)
    }

    fn refresh(&self) -> Result<Changes, String> {
        let mut state = self.changes.lock().map_err(|_| UNAVAILABLE)?;
        let directory = self.directory()?;
        if matches!(self.info.git, GitState::Folder | GitState::Unavailable) {
            return Ok(Changes {
                files: Vec::new(),
                limited: false,
            });
        }
        let repo = open_git(&directory, &self.root)?;
        let (mut changes, limited) =
            collect_changes(&repo, self.baseline).map_err(|_| UNAVAILABLE)?;
        for change in changes.values_mut() {
            change.evidence = compare(&directory, &repo, change).evidence;
        }
        let files = changes.values().cloned().collect();
        *state = changes;
        Ok(Changes { files, limited })
    }

    pub(super) fn read(&self, path: &str, compare_file: bool) -> Result<Document, String> {
        let relative = review_relative_path(path, false).map_err(|_| UNAVAILABLE)?;
        let directory = self.directory()?;
        if compare_file {
            let change = self
                .changes
                .lock()
                .map_err(|_| UNAVAILABLE)?
                .get(path)
                .cloned()
                .ok_or(STALE)?;
            let repo = open_git(&directory, &self.root)?;
            let document = compare(&directory, &repo, &change);
            if document.index_only {
                let index = repo.index().map_err(|_| STALE)?;
                let current = index
                    .get_path(&relative, 0)
                    .map(|entry| (entry.id, entry.mode));
                if current
                    != change
                        .index
                        .map(|version| (version.id, u32::from(version.mode)))
                {
                    return Err(STALE.into());
                }
            }
            if document.evidence != change.evidence {
                return Err(STALE.into());
            }
            return Ok(document);
        }
        Ok(Document {
            before: None,
            after: read_worktree(&directory, &relative),
            evidence: None,
            index_only: false,
        })
    }
}

pub(super) fn open_git(directory: &Repository, root: &Path) -> Result<git2::Repository, String> {
    let marker = directory
        .dir
        .symlink_metadata(".git")
        .map_err(|_| UNAVAILABLE)?;
    if !marker.is_dir() && !marker.is_file() {
        return Err(UNAVAILABLE.into());
    }
    let repo = git2::Repository::open_ext(root, RepositoryOpenFlags::NO_SEARCH, &[] as &[&OsStr])
        .map_err(|_| UNAVAILABLE)?;
    let expected = root.canonicalize().map_err(|_| UNAVAILABLE)?;
    if repo
        .workdir()
        .and_then(|workdir| workdir.canonicalize().ok())
        .as_ref()
        != Some(&expected)
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(repo)
}

fn collect_changes(
    repo: &git2::Repository,
    baseline: Option<Oid>,
) -> Result<(BTreeMap<String, Change>, bool), git2::Error> {
    let tree = baseline
        .map(|id| repo.find_commit(id).and_then(|commit| commit.tree()))
        .transpose()?;
    let mut options = DiffOptions::new();
    options.ignore_submodules(true).skip_binary_check(true);
    let mut index = repo.diff_tree_to_index(tree.as_ref(), None, Some(&mut options))?;
    if index.deltas().len() <= MAX_CHANGES {
        index.find_similar(Some(DiffFindOptions::new().renames(true).rename_limit(100)))?;
    }
    let worktree = repo.diff_tree_to_workdir_with_index(
        tree.as_ref(),
        Some(options.include_untracked(true).recurse_untracked_dirs(true)),
    )?;
    let (mut files, mut limited) = change_list(&worktree, false);
    let (staged, limited_index) = change_list(&index, true);
    limited |= limited_index;
    for (path, change) in staged {
        if files.contains_key(&path) {
            let old = change.previous_path.as_ref().filter(|previous| {
                files
                    .get(*previous)
                    .is_some_and(|entry| matches!(entry.kind, ChangeKind::Deleted))
            });
            let renamed = old.is_some_and(|previous| files.remove(previous).is_some());
            if let Some(current) = files.get_mut(&path) {
                current.staged = true;
                current.index = change.index;
                if renamed {
                    current.previous_path = change.previous_path;
                    current.before = change.before;
                    current.kind = ChangeKind::Renamed;
                }
            }
        } else if files.len() < MAX_CHANGES {
            files.insert(path, change);
        } else {
            limited = true;
        }
    }
    Ok((files, limited))
}

fn change_list(diff: &Diff<'_>, index_only: bool) -> (BTreeMap<String, Change>, bool) {
    let mut files = BTreeMap::new();
    let mut limited = false;
    for delta in diff.deltas() {
        let kind = match delta.status() {
            Delta::Added | Delta::Untracked => ChangeKind::Added,
            Delta::Deleted => ChangeKind::Deleted,
            Delta::Renamed => ChangeKind::Renamed,
            Delta::Conflicted => ChangeKind::Conflict,
            _ => ChangeKind::Modified,
        };
        let before = delta.old_file();
        let after = delta.new_file();
        let Some(path) = after
            .path_bytes()
            .or_else(|| before.path_bytes())
            .and_then(|path| std::str::from_utf8(path).ok())
            .filter(|path| review_relative_path(path, false).is_ok())
        else {
            limited = true;
            continue;
        };
        let previous_path = before
            .path_bytes()
            .and_then(|path| std::str::from_utf8(path).ok())
            .filter(|old| *old != path && review_relative_path(old, false).is_ok())
            .map(str::to_owned);
        let blob = |file: git2::DiffFile<'_>| {
            (!file.id().is_zero()).then(|| BlobVersion {
                id: file.id(),
                mode: file.mode(),
            })
        };
        if files.len() == MAX_CHANGES {
            limited = true;
            break;
        }
        files.insert(
            path.to_owned(),
            Change {
                path: path.to_owned(),
                previous_path,
                kind,
                staged: index_only,
                index_only,
                evidence: None,
                before: blob(before),
                index: if index_only { blob(after) } else { None },
            },
        );
    }
    (files, limited)
}

fn compare(directory: &Repository, repo: &git2::Repository, change: &Change) -> Document {
    let before = read_blob(repo, change.before);
    let worktree = read_worktree(directory, Path::new(&change.path));
    let index = change.staged.then(|| read_blob(repo, change.index));
    let index_only = change.index_only
        || (same_version(&before, &worktree)
            && index
                .as_ref()
                .is_some_and(|index| !same_version(&before, index)));
    let after = if index_only {
        index.unwrap_or(FileVersion::Unreadable)
    } else {
        worktree
    };
    let evidence = file_evidence(change, &before, &after, index_only);
    Document {
        before: Some(before),
        after,
        evidence,
        index_only,
    }
}

fn same_version(before: &FileVersion, after: &FileVersion) -> bool {
    match (before, after) {
        (FileVersion::Text(before), FileVersion::Text(after)) => before == after,
        (FileVersion::Missing, FileVersion::Missing) => true,
        _ => false,
    }
}

fn file_evidence(
    change: &Change,
    before: &FileVersion,
    after: &FileVersion,
    index_only: bool,
) -> Option<String> {
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&(change.kind, &change.previous_path, index_only)).ok()?);
    for version in [before, after] {
        match version {
            FileVersion::Text(text) => {
                digest.update([1]);
                digest.update(Sha256::digest(text.as_bytes()));
            }
            FileVersion::Missing => digest.update([0]),
            _ => return None,
        }
    }
    Some(format!("{:x}", digest.finalize()))
}

fn read_blob(repo: &git2::Repository, version: Option<BlobVersion>) -> FileVersion {
    let Some(version) = version else {
        return FileVersion::Missing;
    };
    if !matches!(
        version.mode,
        FileMode::Blob | FileMode::BlobExecutable | FileMode::BlobGroupWritable
    ) {
        return FileVersion::Unreadable;
    }
    match repo.odb().and_then(|odb| odb.read_header(version.id)) {
        Ok((size, _)) if size as u64 > MAX_FILE_BYTES => return FileVersion::TooLarge,
        Err(_) => return FileVersion::Unreadable,
        _ => {}
    }
    let Ok(blob) = repo.find_blob(version.id) else {
        return FileVersion::Unreadable;
    };
    match std::str::from_utf8(blob.content()) {
        _ if blob.content().contains(&0) => FileVersion::Binary,
        Ok(text) => FileVersion::Text(text.into()),
        Err(_) => FileVersion::Encoding,
    }
}

pub(super) fn read_worktree(directory: &Repository, path: &Path) -> FileVersion {
    match read_nested(&directory.dir, path, MAX_FILE_BYTES) {
        Ok(text) if text.contains('\0') => FileVersion::Binary,
        Ok(text) => FileVersion::Text(text),
        Err(err) => match err.kind() {
            ErrorKind::NotFound => FileVersion::Missing,
            ErrorKind::FileTooLarge => FileVersion::TooLarge,
            ErrorKind::InvalidData => FileVersion::Encoding,
            _ => FileVersion::Unreadable,
        },
    }
}

#[tauri::command]
pub(crate) async fn choose_code_review_project(
    app: tauri::AppHandle,
    state: State<'_, ReviewState>,
) -> Result<Option<ProjectInfo>, String> {
    let current = state.current()?.map(|project| project.root.clone());
    let Some(root) =
        pick_workspace_path_from(app, SelectionKind::CodeReviewFolder, current).await?
    else {
        return Ok(None);
    };
    let project = tokio::task::spawn_blocking(move || Project::open(PathBuf::from(root)))
        .await
        .map_err(|_| UNAVAILABLE)??;
    let info = project.info.clone();
    let old = state
        .0
        .lock()
        .map_err(|_| UNAVAILABLE)?
        .replace(Arc::new(project));
    if let Some(old) = old {
        old.search.cancel();
        #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
        old.eslint.close();
    }
    Ok(Some(info))
}

#[tauri::command]
pub(crate) async fn get_code_review_project(
    state: State<'_, ReviewState>,
) -> Result<Option<ProjectInfo>, String> {
    Ok(state.current()?.map(|project| project.info.clone()))
}

#[tauri::command]
pub(crate) async fn refresh_code_review(
    project_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<Changes, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project.refresh())
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn list_code_review_directory(
    project_id: Uuid,
    path: String,
    compact: Option<CompactFolders>,
    state: State<'_, ReviewState>,
) -> Result<Directory, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || read_review_directory(&project, &path, compact))
        .await
        .map_err(|_| UNAVAILABLE)?
}

fn read_review_directory(
    project: &Project,
    path: &str,
    compact: Option<CompactFolders>,
) -> Result<Directory, String> {
    let relative = review_relative_path(path, true).map_err(|_| UNAVAILABLE)?;
    let root = project.directory()?;
    let directory = open_nested_directory(&root.dir, &relative).map_err(|_| UNAVAILABLE)?;
    let mut entries = Vec::new();
    let mut limited = false;
    for entry in directory.entries().map_err(|_| UNAVAILABLE)? {
        let Ok(entry) = entry else {
            limited = true;
            continue;
        };
        let Ok(name) = entry.file_name().into_string() else {
            limited = true;
            continue;
        };
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let relative = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        let Ok(kind) = entry.file_type() else {
            limited = true;
            continue;
        };
        if (!kind.is_file() && !kind.is_dir()) || review_relative_path(&relative, false).is_err() {
            limited = true;
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            limited = true;
            break;
        }
        entries.push(Entry {
            name,
            path: relative,
            directory: kind.is_dir(),
            compact_segments: Vec::new(),
        });
    }
    entries.sort_unstable_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    if let Some(visibility) = compact {
        let mut remaining = MAX_COMPACT_LOOKAHEAD;
        for entry in entries.iter_mut().take_while(|entry| entry.directory) {
            if remaining == 0 {
                break;
            }
            if visibility.includes(&entry.name) {
                entry.compact_segments =
                    compact_folder_segments(&directory, entry, visibility, &mut remaining);
            }
        }
    }
    Ok(Directory { entries, limited })
}

fn compact_folder_segments(
    parent: &Dir,
    entry: &Entry,
    visibility: CompactFolders,
    remaining: &mut usize,
) -> Vec<String> {
    let mut segments = Vec::new();
    let mut path = entry.path.clone();
    *remaining -= 1;
    let Ok(mut folder) = parent.open_dir_nofollow(&entry.name) else {
        return segments;
    };
    while segments.len() < MAX_COMPACT_SEGMENTS {
        let Some(name) = only_child_directory(&folder, &path, visibility, remaining) else {
            break;
        };
        let Ok(child) = folder.open_dir_nofollow(&name) else {
            break;
        };
        path.push('/');
        path.push_str(&name);
        segments.push(name);
        folder = child;
    }
    segments
}

fn only_child_directory(
    folder: &Dir,
    path: &str,
    visibility: CompactFolders,
    remaining: &mut usize,
) -> Option<String> {
    *remaining = remaining.checked_sub(1)?;
    let mut child = None;
    for entry in folder.entries().ok()? {
        *remaining = remaining.checked_sub(1)?;
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        if !visibility.includes(&name) {
            continue;
        }
        if child.is_some()
            || !entry.file_type().ok()?.is_dir()
            || review_relative_path(&format!("{path}/{name}"), false).is_err()
        {
            return None;
        }
        child = Some(name);
    }
    child
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPaths {
    pub(super) paths: Vec<String>,
    pub(super) limited: bool,
}

fn project_paths(project: &Project) -> Result<ProjectPaths, String> {
    let directory = project.directory()?;
    if let Ok(repo) = open_git(&directory, &project.root)
        && let Ok(index) = repo.index()
        && !index.is_empty()
    {
        return Ok(indexed_paths(&index));
    }
    Ok(walk_project_paths(&directory))
}

pub(super) fn indexed_paths(index: &git2::Index) -> ProjectPaths {
    let mut paths = Vec::new();
    for entry in index.iter().take(MAX_QUICK_OPEN_ENTRIES) {
        if matches!(entry.mode, 0o100_644 | 0o100_755 | 0o100_664)
            && let Ok(path) = std::str::from_utf8(&entry.path)
            && review_relative_path(path, false).is_ok()
        {
            paths.push(path.to_owned());
        }
    }
    paths.dedup();
    ProjectPaths {
        paths,
        limited: index.len() > MAX_QUICK_OPEN_ENTRIES,
    }
}

pub(super) fn walk_project_paths(directory: &Repository) -> ProjectPaths {
    let mut paths = Vec::new();
    let mut folders = vec![String::new()];
    let mut visited = 0;
    let mut limited = false;
    'scan: while let Some(prefix) = folders.pop() {
        let Ok(folder) = open_nested_directory(&directory.dir, Path::new(&prefix)) else {
            limited = true;
            continue;
        };
        let Ok(entries) = folder.entries() else {
            limited = true;
            continue;
        };
        for entry in entries {
            visited += 1;
            if visited > MAX_QUICK_OPEN_ENTRIES {
                limited = true;
                break 'scan;
            }
            let Ok(entry) = entry else {
                limited = true;
                continue;
            };
            let Ok(name) = entry.file_name().into_string() else {
                limited = true;
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if review_relative_path(&path, false).is_err() {
                limited = true;
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                limited = true;
                continue;
            };
            if kind.is_file() {
                paths.push(path);
            } else if kind.is_dir()
                && !matches!(name.as_str(), "node_modules" | "target" | "__pycache__")
            {
                folders.push(path);
            }
        }
    }
    paths.sort_unstable();
    ProjectPaths { paths, limited }
}

#[tauri::command]
pub(crate) async fn list_code_review_paths(
    project_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<ProjectPaths, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project_paths(&project))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn read_code_review_file(
    project_id: Uuid,
    path: String,
    compare_file: bool,
    state: State<'_, ReviewState>,
) -> Result<Document, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project.read(&path, compare_file))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn find_code_definition(
    project_id: Uuid,
    input: DefinitionRequest,
    state: State<'_, ReviewState>,
) -> Result<DefinitionResult, String> {
    let project = state.project(project_id)?;
    let directory = project.directory()?;
    let root = project.root.canonicalize().map_err(|_| UNAVAILABLE)?;
    Ok(project.definitions.lookup(root, directory, input).await)
}

#[tauri::command]
pub(crate) async fn find_code_document_highlights(
    project_id: Uuid,
    input: SourcePosition,
    state: State<'_, ReviewState>,
) -> Result<Vec<DocumentHighlightRange>, String> {
    let project = state.project(project_id)?;
    let directory = project.directory()?;
    let root = project.root.canonicalize().map_err(|_| UNAVAILABLE)?;
    Ok(project
        .definitions
        .highlights(&root, &directory, input)
        .await)
}

#[tauri::command]
pub(crate) async fn get_code_document_outline(
    project_id: Uuid,
    input: DocumentOutlineRequest,
    state: State<'_, ReviewState>,
) -> Result<DocumentOutlineResult, String> {
    let project = state.project(project_id)?;
    let directory = project.directory()?;
    let root = project.root.canonicalize().map_err(|_| UNAVAILABLE)?;
    Ok(project.definitions.outline(&root, &directory, input).await)
}

#[tauri::command]
pub(crate) async fn read_code_definition_source(
    project_id: Uuid,
    source_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<String, String> {
    let project = state.project(project_id)?;
    let directory = project.directory()?;
    let root = project.root.canonicalize().map_err(|_| UNAVAILABLE)?;
    project
        .definitions
        .source(&root, &directory, source_id)
        .await
        .map_err(str::to_owned)
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn compact_directory_listing_respects_visible_siblings_and_probe_limits() {
        let temp = tempfile::tempdir().unwrap();
        for path in [
            "src/test/java/com/wahool/erp/web/feign",
            "src/test/java/com/wahool/erp/web/gateway",
            "src/test/resources",
        ] {
            fs::create_dir_all(temp.path().join(path)).unwrap();
        }
        fs::write(temp.path().join("src/test/java/.keep"), "").unwrap();
        let project = Project::open(temp.path().to_owned()).unwrap();
        let read = |compact| read_review_directory(&project, "src/test", compact).unwrap();
        let folder = read(Some(CompactFolders::Visible));
        assert_eq!(folder.entries[0].path, "src/test/java");
        assert_eq!(
            folder.entries[0].compact_segments,
            ["com", "wahool", "erp", "web"]
        );
        assert_eq!(folder.entries[1].name, "resources");
        assert!(folder.entries[1].compact_segments.is_empty());
        assert!(
            read(Some(CompactFolders::All)).entries[0]
                .compact_segments
                .is_empty()
        );
        assert!(read(None).entries[0].compact_segments.is_empty());

        fs::write(temp.path().join("src/test/java/com/readme.md"), "").unwrap();
        assert_eq!(
            read(Some(CompactFolders::Visible)).entries[0].compact_segments,
            ["com"]
        );
        let root = project.directory().unwrap();
        let parent = open_nested_directory(&root.dir, Path::new("src/test")).unwrap();
        let mut remaining = 1;
        assert!(
            compact_folder_segments(
                &parent,
                &folder.entries[0],
                CompactFolders::Visible,
                &mut remaining
            )
            .is_empty()
        );
        assert_eq!(remaining, 0);
    }

    fn commit(repo: &git2::Repository, paths: &[&str]) -> Oid {
        let mut index = repo.index().unwrap();
        for path in paths {
            index.add_path(Path::new(path)).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Review Fixture", "fixture@example.invalid").unwrap();
        let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Fixture baseline",
            &tree,
            &parent.iter().collect::<Vec<_>>(),
        )
        .unwrap()
    }

    #[test]
    fn review_pinned_baseline_staged_untracked_modified_removed_and_stale_files() {
        let temp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(temp.path()).unwrap();
        for (path, content) in [
            ("service.go", "package old\n"),
            ("drop.php", "<?php\n"),
            ("stage.py", "original = True\n"),
            ("old.java", "public class CodeReviewFixture {}\n"),
        ] {
            fs::write(temp.path().join(path), content).unwrap();
        }
        let base = commit(&repo, &["service.go", "drop.php", "stage.py", "old.java"]);
        let project = Project::open(temp.path().to_owned()).unwrap();
        assert_eq!(project.baseline, Some(base));
        let index_paths = project_paths(&project).unwrap();
        assert_eq!(
            index_paths.paths,
            ["drop.php", "old.java", "service.go", "stage.py"]
        );
        assert!(!index_paths.limited);
        fs::write(temp.path().join("service.go"), "package newer\n").unwrap();
        fs::write(temp.path().join("stage.py"), "original = False\n").unwrap();
        fs::rename(temp.path().join("old.java"), temp.path().join("new.java")).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("stage.py")).unwrap();
        index.remove_path(Path::new("old.java")).unwrap();
        index.add_path(Path::new("new.java")).unwrap();
        index.write().unwrap();
        fs::write(temp.path().join("stage.py"), "original = True\n").unwrap();
        fs::remove_file(temp.path().join("drop.php")).unwrap();
        fs::create_dir(temp.path().join("models")).unwrap();
        fs::write(
            temp.path().join("models/orders.sql"),
            "select paid_at from orders;\n",
        )
        .unwrap();

        let index_at_start = fs::read(repo.path().join("index")).unwrap();
        let changes = project.refresh().unwrap();
        assert!(!changes.limited);
        let find = |path| {
            changes
                .files
                .iter()
                .find(|entry| entry.path == path)
                .unwrap()
        };
        assert!(matches!(find("service.go").kind, ChangeKind::Modified));
        assert!(matches!(find("drop.php").kind, ChangeKind::Deleted));
        assert!(matches!(find("models/orders.sql").kind, ChangeKind::Added));
        assert!(matches!(find("new.java").kind, ChangeKind::Renamed));
        assert_eq!(find("new.java").previous_path.as_deref(), Some("old.java"));
        assert!(!changes.files.iter().any(|entry| entry.path == "old.java"));
        let deleted = project.read("drop.php", true).unwrap();
        assert!(matches!(deleted.before, Some(FileVersion::Text(_))));
        assert!(matches!(deleted.after, FileVersion::Missing));
        let staged = project.read("stage.py", true).unwrap();
        assert!(staged.index_only);
        assert!(matches!(staged.after, FileVersion::Text(text) if text.contains("False")));
        let added = project.read("models/orders.sql", true).unwrap();
        assert!(matches!(added.before, Some(FileVersion::Missing)));
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), index_at_start);
        assert_eq!(repo.head().unwrap().target(), Some(base));
        fs::write(temp.path().join("service.go"), "package newest\n").unwrap();
        assert_eq!(
            project.read("service.go", true).err().as_deref(),
            Some(STALE)
        );
        project.refresh().unwrap();
        assert_ne!(
            project.read("service.go", true).unwrap().evidence,
            find("service.go").evidence
        );
        let newer = commit(&repo, &["service.go", "models/orders.sql"]);
        assert_ne!(newer, base);
        project.refresh().unwrap();
        assert!(
            matches!(project.read("service.go", true).unwrap().before, Some(FileVersion::Text(text)) if text == "package old\n")
        );
    }

    #[test]
    fn opens_regular_projects_and_handles_unborn_repositories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        let project = Project::open(root.to_owned()).unwrap();
        assert!(matches!(project.info.git, GitState::Folder));
        assert!(matches!(
            project.read("main.rs", false).unwrap().after,
            FileVersion::Text(_)
        ));
        assert!(matches!(
            project.read("binary", false).unwrap().after,
            FileVersion::Binary
        ));
        assert!(project.read("../main.rs", false).is_err());
        assert!(project.read(".git/config", false).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("main.rs"), root.join("link")).unwrap();
            assert!(matches!(
                project.read("link", false).unwrap().after,
                FileVersion::Unreadable
            ));
        }
        let _repo = git2::Repository::init(root).unwrap();
        let unborn = Project::open(root.to_owned()).unwrap();
        assert!(matches!(unborn.info.git, GitState::NoBaseline));
        assert!(
            unborn
                .refresh()
                .unwrap()
                .files
                .iter()
                .any(|entry| entry.path == "main.rs")
        );
    }
}
