//! Project review and file actions backed by user-selected directories.
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use git2::{Delta, Diff, DiffFindOptions, DiffOptions, FileMode, Oid, RepositoryOpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snapshot_store::LocalSnapshotStore;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::definition::{
    DefinitionRequest, DefinitionResult, Definitions, DocumentHighlightRange,
    DocumentOutlineRequest, DocumentOutlineResult, LanguageServiceStatus, SourcePosition,
    warmup_sources,
};
use super::files::{
    MAX_FILE_BYTES, Repository, RootIdentity, open_nested_directory, read_nested,
    review_relative_path,
};
#[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
use super::finder::{FinderAction, FinderTarget, LocatedItem, PasteResult, clipboard_paths};
use super::projects::{
    PROJECT_UNAVAILABLE, ProjectCatalog, ProjectCatalogInfo, ProjectGroupAction, SavedProject,
};
use crate::file_access::{SelectionKind, pick_workspace_path_from};
use crate::{AppState, effective_settings};

const MAX_ENTRIES: usize = 2_000;
const MAX_COMPACT_SEGMENTS: usize = 16;
const MAX_COMPACT_LOOKAHEAD: usize = 256;
const MAX_CHANGES: usize = 1_000;
pub(super) const MAX_QUICK_OPEN_ENTRIES: usize = 30_000;
pub(super) const UNAVAILABLE: &str = "codeReviewUnavailable";
const STALE: &str = "codeReviewStale";
const LANGUAGE_OFFLINE: &str = "codeReviewLanguageOffline";

#[derive(Default)]
pub(crate) struct ReviewState(Mutex<ReviewSession>);

static CATALOG_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn close_on_exit(app: &AppHandle) {
    if let Ok(mut session) = app.state::<ReviewState>().0.lock() {
        session.close_project();
    }
}

pub(crate) async fn reset_local_data(app: &AppHandle, review: &ReviewState) {
    if let Ok(mut session) = review.0.lock() {
        session.close_project();
        session.language_grants.clear();
    }
    let Ok(file) = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("code-review-projects.json"))
    else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || {
        let Ok(_lock) = CATALOG_LOCK.lock() else {
            return;
        };
        if let Ok(catalog) = ProjectCatalog::load(&file) {
            for root in catalog.roots() {
                let _ = crate::file_access::forget(&root);
            }
        }
        let _ = std::fs::remove_file(&file);
    })
    .await;
}

#[derive(Default)]
struct ReviewSession {
    project: Option<Arc<Project>>,
    language_grants: HashMap<(PathBuf, RootIdentity), Arc<AtomicBool>>,
}

pub(super) struct Project {
    info: ProjectInfo,
    pub(super) root: PathBuf,
    language_root: Option<PathBuf>,
    identity: RootIdentity,
    baseline: Option<Oid>,
    changes: Mutex<BTreeMap<String, Change>>,
    languages: Mutex<ProjectLanguages>,
    pub(super) search: super::search::SearchSession,
    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    pub(super) eslint: super::eslint::EslintSession,
    #[cfg(all(
        target_os = "macos",
        feature = "code-extensions-preview",
        not(feature = "mac-app-store")
    ))]
    pub(super) debugger: super::python_debug::DebugSession,
}

#[derive(Default)]
struct ProjectLanguages {
    definitions: Arc<Definitions>,
    warmup: Option<tokio::task::JoinHandle<()>>,
    watch: Option<tokio::task::JoinHandle<()>>,
    closed: bool,
}

impl ProjectLanguages {
    fn stop(&mut self) {
        self.definitions.stopped.cancel();
        if let Some(task) = self.warmup.take() {
            task.abort();
        }
        if let Some(task) = self.watch.take() {
            task.abort();
        }
        self.definitions = Arc::new(Definitions::with_grant(Arc::clone(
            &self.definitions.enabled,
        )));
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInfo {
    id: Uuid,
    saved_project_id: Option<Uuid>,
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
        Ok(self.0.lock().map_err(|_| UNAVAILABLE)?.project.clone())
    }

    pub(super) fn project(&self, id: Uuid) -> Result<Arc<Project>, String> {
        self.current()?
            .filter(|project| project.info.id == id)
            .ok_or_else(|| STALE.into())
    }
}

impl ReviewSession {
    fn activate(&mut self, mut project: Project) -> Arc<Project> {
        self.close_project();
        if let Some(root) = &project.language_root {
            self.language_grants
                .retain(|_, grant| grant.load(Ordering::Relaxed));
            let grant = self
                .language_grants
                .entry((root.clone(), project.identity.clone()))
                .or_default();
            project.languages = Mutex::new(ProjectLanguages {
                definitions: Arc::new(Definitions::with_grant(Arc::clone(grant))),
                ..ProjectLanguages::default()
            });
        }
        let project = Arc::new(project);
        self.project = Some(Arc::clone(&project));
        project
    }

    fn close_project(&mut self) {
        if let Some(old) = self.project.take() {
            if let Ok(mut languages) = old.languages.lock() {
                languages.closed = true;
                languages.stop();
            }
            old.search.cancel();
            #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
            old.eslint.close();
            #[cfg(all(
                target_os = "macos",
                feature = "code-extensions-preview",
                not(feature = "mac-app-store")
            ))]
            old.debugger.close();
        }
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        if let Ok(languages) = self.languages.get_mut() {
            languages.stop();
        }
    }
}

impl Project {
    #[cfg(all(
        target_os = "macos",
        feature = "code-extensions-preview",
        not(feature = "mac-app-store")
    ))]
    pub(super) fn key(&self) -> &str {
        &self.info.key
    }

    pub(super) fn open(root: PathBuf) -> Result<Self, String> {
        Self::open_directory(root, None)
    }

    fn open_directory(root: PathBuf, identity: Option<&RootIdentity>) -> Result<Self, String> {
        let (directory, identity) = Repository::open_directory(&root, identity)?;
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
        let language_root = if cfg!(feature = "mac-app-store") {
            None
        } else {
            root.canonicalize().ok()
        };
        let info = ProjectInfo {
            id: Uuid::new_v4(),
            saved_project_id: None,
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
            language_root,
            identity,
            baseline,
            changes: Mutex::default(),
            languages: Mutex::default(),
            search: super::search::SearchSession::default(),
            #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
            eslint: super::eslint::EslintSession::default(),
            #[cfg(all(
                target_os = "macos",
                feature = "code-extensions-preview",
                not(feature = "mac-app-store")
            ))]
            debugger: super::python_debug::DebugSession::default(),
        })
    }

    fn registered(mut self, saved: SavedProject) -> Self {
        self.info.saved_project_id = Some(saved.id);
        self.info.key = saved.review_key;
        self
    }

    pub(super) fn directory(&self) -> Result<Repository, String> {
        Repository::open_directory(&self.root, Some(&self.identity)).map(|(directory, _)| directory)
    }

    fn resume_language_services(self: &Arc<Self>, app: &AppHandle) {
        if !self
            .languages
            .lock()
            .is_ok_and(|languages| languages.definitions.is_enabled())
        {
            return;
        }
        let app_state = app.state::<AppState>();
        let store = app_state.store.clone();
        let offline_rx = app_state.subscribe_offline();
        let project = Arc::clone(self);
        tokio::spawn(async move {
            let _ = project
                .language_access(&store, Some(offline_rx), false)
                .await;
        });
    }

    async fn language_access(
        self: &Arc<Self>,
        store: &LocalSnapshotStore,
        offline_rx: Option<tokio::sync::watch::Receiver<bool>>,
        authorizing: bool,
    ) -> Result<Option<Arc<Definitions>>, String> {
        if cfg!(feature = "mac-app-store") {
            let languages = self.languages.lock().map_err(|_| UNAVAILABLE)?;
            if languages.closed {
                return Err(STALE.into());
            }
            return Ok(Some(Arc::clone(&languages.definitions)));
        }
        let offline = effective_settings(store, None)
            .await?
            .app
            .privacy
            .offline_mode;
        let mut languages = self.languages.lock().map_err(|_| UNAVAILABLE)?;
        if languages.closed {
            return Err(STALE.into());
        }
        if offline {
            if languages.watch.is_some() {
                languages.stop();
            }
            return Ok(None);
        }
        let definitions = Arc::clone(&languages.definitions);
        if languages.watch.is_none() && (authorizing || definitions.is_enabled()) {
            let project = Arc::downgrade(self);
            let store = store.clone();
            let watched = Arc::downgrade(&definitions);
            languages.watch = Some(tokio::spawn(async move {
                if let Some(mut rx) = offline_rx {
                    if rx.wait_for(|offline| *offline).await.is_err() {
                        return;
                    }
                } else {
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        if effective_settings(&store, None)
                            .await
                            .is_ok_and(|settings| !settings.app.privacy.offline_mode)
                        {
                            continue;
                        }
                        break;
                    }
                }
                if let Some(project) = project.upgrade()
                    && let Ok(mut languages) = project.languages.lock()
                    && std::sync::Weak::ptr_eq(&watched, &Arc::downgrade(&languages.definitions))
                {
                    languages.stop();
                }
            }));
        }
        drop(languages);
        self.start_language_services(&definitions);
        Ok(Some(definitions))
    }

    fn start_language_services(self: &Arc<Self>, definitions: &Arc<Definitions>) {
        if !definitions.is_enabled() {
            return;
        }
        let Ok(mut languages) = self.languages.lock() else {
            return;
        };
        if languages.closed
            || languages.warmup.is_some()
            || !Arc::ptr_eq(definitions, &languages.definitions)
        {
            return;
        }
        let project = Arc::downgrade(self);
        let definitions = Arc::clone(definitions);
        languages.warmup = Some(tokio::spawn(async move {
            let sources = tokio::task::spawn_blocking(move || {
                let project = project.upgrade()?;
                let directory = project.directory().ok()?;
                let root = project.root.canonicalize().ok()?;
                let paths = project_paths(&project).ok()?.paths;
                let sources = warmup_sources(&root, &directory, paths);
                Some((root, sources))
            })
            .await
            .ok()
            .flatten();
            definitions.prewarm(sources).await;
        }));
    }

    fn refresh(&self) -> Result<Changes, String> {
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
        *self.changes.lock().map_err(|_| UNAVAILABLE)? = changes;
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
    app: AppHandle,
    relocate_id: Option<Uuid>,
) -> Result<Option<ProjectInfo>, String> {
    let current = app
        .state::<ReviewState>()
        .current()?
        .map(|project| project.root.clone());
    let Some(root) =
        pick_workspace_path_from(app.clone(), SelectionKind::CodeReviewFolder, current).await?
    else {
        return Ok(None);
    };
    let project = with_project_catalog(app.clone(), move |state, file, mut catalog| {
        let project = Project::open(PathBuf::from(root))?;
        let saved = catalog.register(
            &project.root,
            &project.identity,
            &project.info.key,
            relocate_id,
        )?;
        catalog.save(file)?;
        let mut session = state.0.lock().map_err(|_| UNAVAILABLE)?;
        Ok(session.activate(project.registered(saved)))
    })
    .await?;
    project.resume_language_services(&app);
    Ok(Some(project.info.clone()))
}

async fn with_project_catalog<T: Send + 'static>(
    app: AppHandle,
    operation: impl FnOnce(&ReviewState, &Path, ProjectCatalog) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|_| UNAVAILABLE)?
        .join("code-review-projects.json");
    tokio::task::spawn_blocking(move || {
        let _catalog_lock = CATALOG_LOCK.lock().map_err(|_| UNAVAILABLE)?;
        let state = app.state::<ReviewState>();
        let catalog = ProjectCatalog::load(&file)?;
        operation(&state, &file, catalog)
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn list_code_review_projects(
    app: AppHandle,
) -> Result<ProjectCatalogInfo, String> {
    with_project_catalog(app, |_, _, catalog| Ok(catalog.info())).await
}

#[tauri::command]
pub(crate) async fn edit_code_review_project_groups(
    app: AppHandle,
    input: ProjectGroupAction,
) -> Result<(), String> {
    with_project_catalog(app, move |_, file, mut catalog| {
        catalog.edit_groups(input)?;
        catalog.save(file)
    })
    .await
}

#[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
#[tauri::command]
pub(crate) async fn code_review_finder_action(
    app: AppHandle,
    target: FinderTarget,
    action: FinderAction,
) -> Result<PasteResult, String> {
    let item = match target {
        FinderTarget::Project { id } => {
            with_project_catalog(app.clone(), move |_, _, catalog| {
                let saved = catalog.get(id)?;
                let (directory, _) = Repository::open_directory(&saved.root, Some(&saved.identity))
                    .map_err(|_| PROJECT_UNAVAILABLE)?;
                LocatedItem::locate(saved.root.clone(), directory, "")
            })
            .await?
        }
        FinderTarget::Entry { project_id, path } => {
            let project = app.state::<ReviewState>().project(project_id)?;
            tokio::task::spawn_blocking(move || {
                LocatedItem::locate(project.root.clone(), project.directory()?, &path)
            })
            .await
            .map_err(|_| UNAVAILABLE)??
        }
    };
    item.act(&app, action).await
}

#[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
#[tauri::command]
pub(crate) async fn paste_code_review_projects(app: AppHandle) -> Result<PasteResult, String> {
    let paths = clipboard_paths(&app).await?;
    with_project_catalog(app, move |_, file, mut catalog| {
        let mut result = PasteResult::default();
        for path in paths {
            if let Ok(project) = Project::open(path) {
                catalog.register(&project.root, &project.identity, &project.info.key, None)?;
                result.added += 1;
            } else {
                result.skipped += 1;
            }
        }
        if result.added > 0 {
            catalog.save(file)?;
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_saved_code_review_project(
    app: AppHandle,
    id: Uuid,
) -> Result<ProjectInfo, String> {
    let project = with_project_catalog(app.clone(), move |state, file, mut catalog| {
        if let Some(current) = state
            .current()?
            .filter(|project| project.info.saved_project_id == Some(id))
        {
            return Ok(current);
        }
        let saved = catalog.get(id)?.clone();
        let project = Project::open_directory(saved.root.clone(), Some(&saved.identity))
            .map_err(|_| PROJECT_UNAVAILABLE)?;
        catalog.select(id)?;
        catalog.save(file)?;
        let mut session = state.0.lock().map_err(|_| UNAVAILABLE)?;
        Ok(session.activate(project.registered(saved)))
    })
    .await?;
    project.resume_language_services(&app);
    Ok(project.info.clone())
}

#[tauri::command]
pub(crate) async fn pin_code_review_project(
    app: AppHandle,
    id: Uuid,
    pinned: bool,
) -> Result<(), String> {
    with_project_catalog(app, move |_, file, mut catalog| {
        catalog.pin(id, pinned)?;
        catalog.save(file)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_code_review_project(
    app: AppHandle,
    id: Uuid,
) -> Result<Option<ProjectInfo>, String> {
    with_project_catalog(app, move |state, file, mut catalog| {
        let removed = catalog.remove(id)?;
        catalog.save(file)?;
        let _ = crate::file_access::forget(&removed.root);
        let mut session = state.0.lock().map_err(|_| UNAVAILABLE)?;
        if session
            .project
            .as_ref()
            .is_some_and(|project| project.info.saved_project_id == Some(id))
        {
            session.close_project();
        }
        Ok(session.project.as_ref().map(|project| project.info.clone()))
    })
    .await
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
    let Ok(root_dir) = directory.dir.try_clone() else {
        return ProjectPaths {
            paths,
            limited: true,
        };
    };
    let mut folders = vec![(root_dir, String::new())];
    let mut visited = 0;
    let mut limited = false;
    'scan: while let Some((folder, prefix)) = folders.pop() {
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
                if let Ok(child) = folder.open_dir_nofollow(&name) {
                    folders.push((child, path));
                } else {
                    limited = true;
                }
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

async fn open_language_context(project: &Arc<Project>) -> Result<(Repository, PathBuf), String> {
    let project = Arc::clone(project);
    tokio::task::spawn_blocking(move || {
        let directory = project.directory()?;
        let root = project.root.canonicalize().map_err(|_| UNAVAILABLE)?;
        Ok((directory, root))
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn find_code_definition(
    project_id: Uuid,
    input: DefinitionRequest,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<DefinitionResult, String> {
    let project = state.project(project_id)?;
    let (directory, root) = open_language_context(&project).await?;
    let Some(services) = project
        .language_access(&app.store, Some(app.subscribe_offline()), input.enable)
        .await?
    else {
        return Ok(DefinitionResult::Offline);
    };
    let result = services
        .while_running(services.lookup(root, directory, input))
        .await
        .unwrap_or(DefinitionResult::Unavailable);
    project.start_language_services(&services);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn find_code_document_highlights(
    project_id: Uuid,
    input: SourcePosition,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<Vec<DocumentHighlightRange>, String> {
    let project = state.project(project_id)?;
    let (directory, root) = open_language_context(&project).await?;
    let Some(services) = project
        .language_access(&app.store, Some(app.subscribe_offline()), false)
        .await?
    else {
        return Ok(Vec::new());
    };
    Ok(services
        .while_running(services.highlights(&root, &directory, input))
        .await
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn get_code_document_outline(
    project_id: Uuid,
    input: DocumentOutlineRequest,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<DocumentOutlineResult, String> {
    let project = state.project(project_id)?;
    let (directory, root) = open_language_context(&project).await?;
    let Some(services) = project
        .language_access(&app.store, Some(app.subscribe_offline()), input.enable)
        .await?
    else {
        return Ok(DocumentOutlineResult::Offline);
    };
    let result = services
        .while_running(services.outline(&root, &directory, input))
        .await
        .unwrap_or(DocumentOutlineResult::Unavailable);
    project.start_language_services(&services);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn get_code_language_status(
    project_id: Uuid,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<LanguageServiceStatus, String> {
    let project = state.project(project_id)?;
    let Some(services) = project
        .language_access(&app.store, Some(app.subscribe_offline()), false)
        .await?
    else {
        return Ok(LanguageServiceStatus::Offline);
    };
    Ok(services
        .while_running(services.status())
        .await
        .unwrap_or(LanguageServiceStatus::Offline))
}

#[tauri::command]
pub(crate) async fn enable_code_language_services(
    project_id: Uuid,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<(), String> {
    if cfg!(feature = "mac-app-store") {
        return Err(UNAVAILABLE.into());
    }
    let project = state.project(project_id)?;
    let check = Arc::clone(&project);
    tokio::task::spawn_blocking(move || check.directory())
        .await
        .map_err(|_| UNAVAILABLE)??;
    let services = project
        .language_access(&app.store, Some(app.subscribe_offline()), true)
        .await?
        .ok_or(LANGUAGE_OFFLINE)?;
    services.enabled.store(true, Ordering::Relaxed);
    project.start_language_services(&services);
    Ok(())
}

#[tauri::command]
pub(crate) async fn read_code_definition_source(
    project_id: Uuid,
    source_id: Uuid,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<String, String> {
    let project = state.project(project_id)?;
    let (directory, root) = open_language_context(&project).await?;
    let services = project
        .language_access(&app.store, Some(app.subscribe_offline()), false)
        .await?
        .ok_or(LANGUAGE_OFFLINE)?;
    services
        .while_running(services.source(&root, &directory, source_id))
        .await
        .ok_or(UNAVAILABLE)?
        .map_err(str::to_owned)
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn switching_projects_cancels_languages_and_preserves_grants() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = ReviewState::default();
        let select = |path: &Path| {
            state
                .0
                .lock()
                .unwrap()
                .activate(Project::open(path.to_path_buf()).unwrap())
        };
        let definitions =
            |project: &Arc<Project>| Arc::clone(&project.languages.lock().unwrap().definitions);

        let project = select(first.path());
        let first_services = definitions(&project);
        assert!(matches!(
            first_services.status().await,
            LanguageServiceStatus::Disabled
        ));
        project.start_language_services(&first_services);
        assert!(project.languages.lock().unwrap().warmup.is_none());
        first_services.enabled.store(true, Ordering::Relaxed);
        project.start_language_services(&first_services);
        assert!(project.languages.lock().unwrap().warmup.is_some());

        let other = select(second.path());
        project.start_language_services(&first_services);
        assert!(project.languages.lock().unwrap().warmup.is_none());
        assert!(other.languages.lock().unwrap().warmup.is_none());
        assert_eq!(first_services.while_running(async { true }).await, None);

        let reopened = select(&first.path().join("."));
        assert_ne!(reopened.info.id, project.info.id);
        let reopened_services = definitions(&reopened);
        assert!(reopened_services.is_enabled());
        reopened.start_language_services(&reopened_services);
        assert!(reopened.languages.lock().unwrap().warmup.is_some());
    }

    #[tokio::test]
    async fn offline_mode_prevents_startup_and_cancels_active_language_work() {
        let directory = tempfile::tempdir().unwrap();
        let project =
            ReviewSession::default().activate(Project::open(directory.path().into()).unwrap());
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let mut settings = crate::AppSettings::default();
        settings.privacy.offline_mode = true;
        store.save_app_settings(&settings).await.unwrap();
        assert!(
            project
                .language_access(&store, None, true)
                .await
                .unwrap()
                .is_none()
        );

        settings.privacy.offline_mode = false;
        store.save_app_settings(&settings).await.unwrap();
        let online = project
            .language_access(&store, None, true)
            .await
            .unwrap()
            .unwrap();
        online.enabled.store(true, Ordering::Relaxed);
        project.start_language_services(&online);
        assert!(project.languages.lock().unwrap().warmup.is_some());

        settings.privacy.offline_mode = true;
        store.save_app_settings(&settings).await.unwrap();
        let cancelled = tokio::time::timeout(
            Duration::from_secs(4),
            online.while_running(std::future::pending::<()>()),
        )
        .await
        .unwrap();
        assert_eq!(cancelled, None);
        assert!(
            project
                .language_access(&store, None, false)
                .await
                .unwrap()
                .is_none()
        );
        assert!(project.languages.lock().unwrap().warmup.is_none());

        settings.privacy.offline_mode = false;
        store.save_app_settings(&settings).await.unwrap();
        let resumed = project
            .language_access(&store, None, false)
            .await
            .unwrap()
            .unwrap();
        assert!(resumed.is_enabled());
        assert!(project.languages.lock().unwrap().warmup.is_some());
    }

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
