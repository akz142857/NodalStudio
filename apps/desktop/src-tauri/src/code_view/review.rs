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
    MAX_FILE_BYTES, NewEntryKind, Repository, RootIdentity, create_review_entry,
    open_nested_directory, read_nested, review_relative_path,
};
#[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
use super::finder::clipboard_paths;
#[cfg(target_os = "macos")]
use super::finder::{FinderAction, FinderTarget, LocatedItem, PasteResult};
use super::projects::{
    PROJECT_UNAVAILABLE, ProjectCatalog, ProjectCatalogInfo, ProjectGroupAction, SavedProject,
};
use super::review_index;
use crate::file_access::{SelectionKind, pick_workspace_path_from};
use crate::{AppState, effective_settings};

const MAX_ENTRIES: usize = 2_000;
const MAX_COMPACT_SEGMENTS: usize = 16;
const MAX_COMPACT_LOOKAHEAD: usize = 256;
const MAX_CHANGES: usize = 1_000;
pub(super) const MAX_QUICK_OPEN_ENTRIES: usize = 30_000;
pub(super) const UNAVAILABLE: &str = "codeReviewUnavailable";
pub(super) const STALE: &str = "codeReviewStale";
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
        session.worktree_baselines.clear();
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
    worktree_baselines: HashMap<(PathBuf, RootIdentity), (String, GitHead)>,
    language_grants: HashMap<(PathBuf, RootIdentity), Arc<AtomicBool>>,
}

pub(super) struct Project {
    info: ProjectInfo,
    pub(super) root: PathBuf,
    language_root: Option<PathBuf>,
    identity: RootIdentity,
    changes: Mutex<ReviewChanges>,
    languages: Mutex<ProjectLanguages>,
    pub(super) search: super::search::SearchSession,
    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    pub(super) eslint: super::eslint::EslintSession,
    #[cfg(all(
        target_os = "macos",
        feature = "code-extensions",
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
    #[serde(skip_serializing_if = "Option::is_none")]
    comparison: Option<Comparison>,
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

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Comparison {
    Staged,
    Unstaged,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct GitHead {
    branch_ref: Option<String>,
    commit: Option<Oid>,
}

impl GitHead {
    fn load(repo: &git2::Repository) -> Result<Self, git2::Error> {
        let reference = repo.find_reference("HEAD")?;
        let branch_ref = reference.symbolic_target()?.map(str::to_owned);
        let commit = match reference.resolve() {
            Ok(head) => Some(head.peel_to_commit()?.id()),
            Err(error)
                if branch_ref.is_some()
                    && matches!(
                        error.code(),
                        git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch
                    ) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        Ok(Self { branch_ref, commit })
    }

    fn branch(&self) -> Option<String> {
        self.branch_ref
            .as_deref()
            .and_then(|name| name.strip_prefix("refs/heads/"))
            .map(str::to_owned)
    }
}

#[derive(Default)]
struct ReviewChanges {
    baseline: GitHead,
    index_head: GitHead,
    files: BTreeMap<String, Change>,
    staged: BTreeMap<String, Change>,
    unstaged: BTreeMap<String, Change>,
    previous: Option<PreviousReview>,
    committed: Option<CommittedReview>,
}

struct PreviousReview {
    files: ChangeMap,
    staged: ChangeMap,
    limited: bool,
}

impl ReviewChanges {
    fn get(&self, path: &str, comparison: Option<Comparison>, previous: bool) -> Option<&Change> {
        let historical = self.previous.as_ref().filter(|_| previous);
        let changes = match comparison {
            Some(Comparison::Staged) => historical.map_or(&self.staged, |review| &review.staged),
            Some(Comparison::Unstaged) => &self.unstaged,
            None => historical.map_or(&self.files, |review| &review.files),
        };
        changes.get(path)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitComparison {
    branch: Option<String>,
    head: Option<String>,
    baseline: Option<String>,
    baseline_changed: bool,
    index_revision: String,
    worktrees: Vec<ReviewWorktree>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewWorktree {
    path: String,
    name: String,
    branch: Option<String>,
    head: Option<String>,
    primary: bool,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchChanges {
    target: String,
    base: String,
    head: String,
    files: Vec<Change>,
    limited: bool,
}

struct CommittedReview {
    head: Oid,
    base: Oid,
    target: String,
    files: ChangeMap,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Changes {
    files: Vec<Change>,
    limited: bool,
    local_limited: bool,
    git: Option<GitComparison>,
    staged: Vec<Change>,
    unstaged: Vec<Change>,
    previous_files: Option<Vec<Change>>,
    previous_staged: Option<Vec<Change>>,
    previous_limited: bool,
    #[serde(rename = "branchChanges")]
    branch: Option<BranchChanges>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexChange {
    path: String,
    comparison: Comparison,
    evidence: String,
    index_revision: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    executable_changed_to: Option<bool>,
    #[serde(skip)]
    worktree_mode: Option<u32>,
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
    fn switch_worktree(
        &mut self,
        current: &Project,
        mut next: Project,
    ) -> Result<Arc<Project>, String> {
        if self
            .project
            .as_ref()
            .is_none_or(|project| project.info.id != current.info.id)
        {
            return Err(STALE.into());
        }
        let baseline = current
            .changes
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .baseline
            .clone();
        let current_root = current.root.canonicalize().map_err(|_| UNAVAILABLE)?;
        self.worktree_baselines.insert(
            (current_root, current.identity.clone()),
            (current.info.key.clone(), baseline),
        );
        next.info.saved_project_id = current.info.saved_project_id;
        if let Some((key, baseline)) = self
            .worktree_baselines
            .remove(&(next.root.clone(), next.identity.clone()))
        {
            let changes = next.changes.get_mut().map_err(|_| UNAVAILABLE)?;
            next.info.key = key;
            next.info.baseline = baseline.commit.map(|id| id.to_string());
            changes.baseline = baseline;
        }
        Ok(self.activate(next))
    }

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
                feature = "code-extensions",
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
        any(feature = "code-extensions", feature = "code-syntax-only")
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
            Err(err) if err.kind() == ErrorKind::NotFound => (GitState::Folder, GitHead::default()),
            _ => match open_git(&directory, &root)
                .and_then(|repo| GitHead::load(&repo).map_err(|_| UNAVAILABLE.into()))
            {
                Ok(head) if head.commit.is_some() => (GitState::Ready, head),
                Ok(head) => (GitState::NoBaseline, head),
                Err(_) => (GitState::Unavailable, GitHead::default()),
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
            baseline: baseline.commit.map(|id| id.to_string()),
            git,
        };
        Ok(Self {
            info,
            root,
            language_root,
            identity,
            changes: Mutex::new(ReviewChanges {
                baseline,
                ..ReviewChanges::default()
            }),
            languages: Mutex::default(),
            search: super::search::SearchSession::default(),
            #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
            eslint: super::eslint::EslintSession::default(),
            #[cfg(all(
                target_os = "macos",
                feature = "code-extensions",
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
        self.refresh_changes(false)
    }

    fn git_revision(&self) -> Result<String, String> {
        let directory = self.directory()?;
        let repo = open_git(&directory, &self.root)?;
        let head = GitHead::load(&repo).map_err(|_| UNAVAILABLE)?;
        let index = repo.index().map_err(|_| UNAVAILABLE)?;
        Ok(review_index_revision(
            &review_index::revision(&index),
            &head,
        ))
    }

    fn refresh_changes(&self, use_current_head: bool) -> Result<Changes, String> {
        let directory = self.directory()?;
        if matches!(self.info.git, GitState::Folder | GitState::Unavailable) {
            return Ok(Changes {
                files: Vec::new(),
                limited: false,
                local_limited: false,
                git: None,
                staged: Vec::new(),
                unstaged: Vec::new(),
                previous_files: None,
                previous_staged: None,
                previous_limited: false,
                branch: None,
            });
        }
        let repo = open_git(&directory, &self.root)?;
        let mut previous = self.changes.lock().map_err(|_| UNAVAILABLE)?;
        let head = GitHead::load(&repo).map_err(|_| UNAVAILABLE)?;
        let baseline = if use_current_head {
            head.clone()
        } else {
            previous.baseline.clone()
        };
        let index = repo.index().map_err(|_| UNAVAILABLE)?;
        let (mut staged, mut unstaged, scoped_limited) =
            collect_comparisons(&repo, &index, head.commit).map_err(|_| UNAVAILABLE)?;
        for change in staged.values_mut().chain(unstaged.values_mut()) {
            change.evidence = compare_scoped(&directory, &repo, change).evidence;
        }
        let (files, limited) =
            collect_combined(&directory, &repo, head.commit).map_err(|_| UNAVAILABLE)?;
        let historical = if baseline == head {
            None
        } else {
            collect_previous_review(&directory, &repo, &index, baseline.commit).ok()
        };
        let git = GitComparison {
            branch: head.branch(),
            head: head.commit.map(|commit| commit.to_string()),
            baseline: baseline.commit.map(|id| id.to_string()),
            baseline_changed: baseline != head,
            index_revision: review_index_revision(&review_index::revision(&index), &head),
            worktrees: review_worktrees(&repo),
        };
        let branch = head
            .commit
            .and_then(|id| collect_branch_changes(&repo, id).ok().flatten());
        let (branch, committed) = branch.unzip();
        let result = Changes {
            files: files.values().cloned().collect(),
            staged: staged.values().cloned().collect(),
            unstaged: unstaged.values().cloned().collect(),
            limited: scoped_limited || limited,
            local_limited: scoped_limited,
            git: Some(git),
            previous_files: historical
                .as_ref()
                .map(|review| review.files.values().cloned().collect()),
            previous_staged: historical
                .as_ref()
                .map(|review| review.staged.values().cloned().collect()),
            previous_limited: historical
                .as_ref()
                .is_some_and(|review| review.limited || scoped_limited),
            branch,
        };
        *previous = ReviewChanges {
            baseline,
            index_head: head,
            files,
            staged,
            unstaged,
            previous: historical,
            committed,
        };
        Ok(result)
    }

    fn change_index(&self, input: &IndexChange) -> Result<(), String> {
        let relative = review_relative_path(&input.path, false).map_err(|_| STALE)?;
        let directory = self.directory()?;
        let repo = open_git(&directory, &self.root)?;
        let (baseline, change) = {
            let state = self.changes.lock().map_err(|_| UNAVAILABLE)?;
            (
                state.index_head.clone(),
                state
                    .get(&input.path, Some(input.comparison), false)
                    .cloned()
                    .ok_or(STALE)?,
            )
        };
        if matches!(change.kind, ChangeKind::Conflict) {
            return Err("codeReviewIndexConflict".into());
        }
        if change.evidence.as_deref() != Some(&input.evidence) {
            return Err(STALE.into());
        }
        let require_current_head = || -> Result<(), String> {
            if GitHead::load(&repo).as_ref().ok() != Some(&baseline) {
                return Err(STALE.into());
            }
            Ok(())
        };
        let index = repo.index().map_err(|_| STALE)?;
        let revision = review_index::revision(&index);
        if review_index_revision(&revision, &baseline) != input.index_revision {
            return Err(STALE.into());
        }
        review_index::update(
            &repo,
            &directory,
            &revision,
            |index| {
                require_current_head()?;
                if !index_matches(index, &relative, &change) {
                    return Err(STALE.into());
                }
                let document = compare_scoped(&directory, &repo, &change);
                if document.evidence != change.evidence {
                    return Err(STALE.into());
                }
                match input.comparison {
                    Comparison::Unstaged => {
                        if change.before.is_none()
                            && repo.status_should_ignore(&relative).map_err(|_| STALE)?
                        {
                            return Err(STALE.into());
                        }
                        let target = match document.after {
                            FileVersion::Text(text) => {
                                let id = review_index::blob_for_stage(&repo, &relative, &text)?;
                                Some((id, document.worktree_mode.ok_or(STALE)?))
                            }
                            FileVersion::Missing => None,
                            _ => return Err(review_index::UNSUPPORTED.into()),
                        };
                        review_index::set_entry(index, &input.path, target)
                    }
                    Comparison::Staged => {
                        let target = change
                            .before
                            .map(|version| (version.id, u32::from(version.mode)));
                        if let Some(previous) = &change.previous_path {
                            review_index::set_entry(index, &input.path, None)?;
                            review_index::set_entry(index, previous, target)
                        } else {
                            review_index::set_entry(index, &input.path, target)
                        }
                    }
                }
            },
            || {
                require_current_head()?;
                if matches!(input.comparison, Comparison::Unstaged)
                    && compare_scoped(&directory, &repo, &change).evidence != change.evidence
                {
                    return Err(STALE.into());
                }
                Ok(())
            },
        )
    }

    fn read_branch_file(&self, path: &str) -> Result<Document, String> {
        let directory = self.directory()?;
        let repo = open_git(&directory, &self.root)?;
        let state = self.changes.lock().map_err(|_| UNAVAILABLE)?;
        let review = state.committed.as_ref().ok_or(STALE)?;
        let head = GitHead::load(&repo)
            .map_err(|_| STALE)?
            .commit
            .ok_or(STALE)?;
        if head != review.head
            || branch_base(&repo, head).as_ref() != Some(&(review.target.clone(), review.base))
        {
            return Err(STALE.into());
        }
        let change = review.files.get(path).cloned().ok_or(STALE)?;
        drop(state);
        let executable_changed_to = match (
            change.before.map(|blob| blob.mode),
            change.index.map(|blob| blob.mode),
        ) {
            (Some(FileMode::Blob), Some(FileMode::BlobExecutable)) => Some(true),
            (Some(FileMode::BlobExecutable), Some(FileMode::Blob)) => Some(false),
            _ => None,
        };
        Ok(Document {
            before: Some(read_blob(&repo, change.before)),
            after: read_blob(&repo, change.index),
            evidence: change.evidence,
            index_only: false,
            executable_changed_to,
            worktree_mode: None,
        })
    }

    #[cfg(all(test, not(feature = "mac-app-store")))]
    fn read(&self, path: &str, compare_file: bool) -> Result<Document, String> {
        self.read_comparison(path, compare_file, None)
    }

    #[cfg(all(not(feature = "mac-app-store"), any(target_os = "macos", test)))]
    pub(super) fn read_comparison(
        &self,
        path: &str,
        compare_file: bool,
        comparison: Option<Comparison>,
    ) -> Result<Document, String> {
        self.read_review_file(path, compare_file, comparison, false)
    }

    fn read_review_file(
        &self,
        path: &str,
        compare_file: bool,
        comparison: Option<Comparison>,
        previous: bool,
    ) -> Result<Document, String> {
        let relative = review_relative_path(path, false).map_err(|_| UNAVAILABLE)?;
        let directory = self.directory()?;
        if compare_file {
            let (change, head) = {
                let changes = self.changes.lock().map_err(|_| UNAVAILABLE)?;
                if previous && changes.previous.is_none() {
                    return Err(STALE.into());
                }
                (
                    changes
                        .get(path, comparison, previous)
                        .cloned()
                        .ok_or(STALE)?,
                    changes.index_head.clone(),
                )
            };
            let repo = open_git(&directory, &self.root)?;
            if !previous && GitHead::load(&repo).as_ref().ok() != Some(&head) {
                return Err(STALE.into());
            }
            let document = if comparison.is_some() {
                let index = repo.index().map_err(|_| STALE)?;
                if !index_matches(&index, &relative, &change) {
                    return Err(STALE.into());
                }
                compare_scoped(&directory, &repo, &change)
            } else {
                compare(&directory, &repo, &change)
            };
            if comparison.is_none() && document.index_only {
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
            executable_changed_to: None,
            worktree_mode: None,
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

type ChangeMap = BTreeMap<String, Change>;

fn review_index_revision(index_revision: &str, head: &GitHead) -> String {
    format!(
        "{}:{}:{}",
        index_revision,
        head.branch_ref.as_deref().unwrap_or_default(),
        head.commit.map(|id| id.to_string()).unwrap_or_default()
    )
}

fn review_worktrees(repo: &git2::Repository) -> Vec<ReviewWorktree> {
    let Some(current) = repo.workdir().and_then(|path| path.canonicalize().ok()) else {
        return Vec::new();
    };
    let Some(common) = repo.commondir().canonicalize().ok() else {
        return Vec::new();
    };
    let item = |candidate: &git2::Repository| -> Option<ReviewWorktree> {
        let path = candidate.workdir()?.canonicalize().ok()?;
        if candidate.commondir().canonicalize().ok()? != common {
            return None;
        }
        let head = GitHead::load(candidate).ok()?;
        Some(ReviewWorktree {
            path: path.to_str()?.to_owned(),
            name: path.file_name()?.to_string_lossy().into_owned(),
            branch: head.branch(),
            head: head.commit.map(|id| id.to_string()),
            primary: !candidate.is_worktree(),
            current: path == current,
        })
    };
    let mut entries = item(repo).into_iter().collect::<Vec<_>>();
    let other = |root: &Path| -> Option<ReviewWorktree> {
        let root = root.canonicalize().ok()?;
        if root == current {
            return None;
        }
        let (directory, _) = Repository::open_directory(&root, None).ok()?;
        item(&open_git(&directory, &root).ok()?)
    };
    if repo.is_worktree()
        && let Ok(primary) = git2::Repository::open(&common)
        && let Some(entry) = primary.workdir().and_then(other)
    {
        entries.push(entry);
    }
    if let Ok(names) = repo.worktrees() {
        for name in names.iter().filter_map(|name| name.ok().flatten()) {
            if let Ok(worktree) = repo.find_worktree(name)
                && worktree.validate().is_ok()
                && let Some(entry) = other(worktree.path())
            {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|left, right| {
        right
            .primary
            .cmp(&left.primary)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
    entries.dedup_by(|left, right| left.path == right.path);
    entries
}

fn branch_base(repo: &git2::Repository, head: Oid) -> Option<(String, Oid)> {
    let default = repo.find_reference("refs/remotes/origin/HEAD").ok();
    let target = default
        .as_ref()
        .and_then(|reference| reference.symbolic_target().ok().flatten());
    let resolve = |name: &str| {
        repo.find_reference(name)
            .ok()?
            .peel_to_commit()
            .ok()
            .map(|commit| (name.to_owned(), commit.id()))
    };
    let unambiguous = |prefix: &str| match (
        resolve(&format!("{prefix}main")),
        resolve(&format!("{prefix}master")),
    ) {
        (Some(branch), None) | (None, Some(branch)) => Some(branch),
        _ => None,
    };
    let (reference, target_commit) = if let Some(target) = target {
        resolve(target).or_else(|| {
            let branch = target.strip_prefix("refs/remotes/origin/")?;
            resolve(&format!("refs/heads/{branch}"))
        })?
    } else {
        unambiguous("refs/remotes/origin/").or_else(|| unambiguous("refs/heads/"))?
    };
    let target = reference
        .strip_prefix("refs/remotes/")
        .or_else(|| reference.strip_prefix("refs/heads/"))?;
    Some((
        target.to_owned(),
        repo.merge_base(head, target_commit).ok()?,
    ))
}

fn collect_branch_changes(
    repo: &git2::Repository,
    head: Oid,
) -> Result<Option<(BranchChanges, CommittedReview)>, git2::Error> {
    let Some((target, base)) = branch_base(repo, head) else {
        return Ok(None);
    };
    let before = repo.find_commit(base)?.tree()?;
    let after = repo.find_commit(head)?.tree()?;
    let mut diff = repo.diff_tree_to_tree(
        Some(&before),
        Some(&after),
        Some(
            DiffOptions::new()
                .ignore_submodules(true)
                .skip_binary_check(true),
        ),
    )?;
    if diff.deltas().len() <= MAX_CHANGES {
        diff.find_similar(Some(DiffFindOptions::new().renames(true).rename_limit(100)))?;
    }
    let (mut files, limited) = change_list(&diff, true);
    for change in files.values_mut() {
        change.staged = false;
        change.index_only = false;
        let stamp = |blob: Option<BlobVersion>| {
            blob.map(|blob| (blob.id.to_string(), u32::from(blob.mode)))
        };
        let mut hash = Sha256::new();
        hash.update(format!(
            "{:?}",
            (
                &change.path,
                &change.previous_path,
                stamp(change.before),
                stamp(change.index)
            )
        ));
        change.evidence = Some(format!("{:x}", hash.finalize()));
    }
    Ok(Some((
        BranchChanges {
            target: target.clone(),
            base: base.to_string(),
            head: head.to_string(),
            files: files.values().cloned().collect(),
            limited,
        },
        CommittedReview {
            head,
            base,
            target,
            files,
        },
    )))
}

fn collect_staged(
    repo: &git2::Repository,
    index: &git2::Index,
    baseline: Option<Oid>,
) -> Result<(ChangeMap, bool), git2::Error> {
    let tree = baseline
        .map(|id| repo.find_commit(id).and_then(|commit| commit.tree()))
        .transpose()?;
    let mut options = DiffOptions::new();
    options.ignore_submodules(true).skip_binary_check(true);
    let mut staged = repo.diff_tree_to_index(tree.as_ref(), Some(index), Some(&mut options))?;
    if staged.deltas().len() <= MAX_CHANGES {
        staged.find_similar(Some(DiffFindOptions::new().renames(true).rename_limit(100)))?;
    }
    let (mut staged, limited) = change_list(&staged, true);
    for change in staged.values_mut() {
        change.comparison = Some(Comparison::Staged);
    }
    Ok((staged, limited))
}

fn collect_comparisons(
    repo: &git2::Repository,
    index: &git2::Index,
    baseline: Option<Oid>,
) -> Result<(ChangeMap, ChangeMap, bool), git2::Error> {
    let (staged, staged_limited) = collect_staged(repo, index, baseline)?;
    let mut options = DiffOptions::new();
    options.ignore_submodules(true).skip_binary_check(true);
    let unstaged = repo.diff_index_to_workdir(
        Some(index),
        Some(options.include_untracked(true).recurse_untracked_dirs(true)),
    )?;
    let (mut unstaged, unstaged_limited) = change_list(&unstaged, false);
    for change in unstaged.values_mut() {
        change.comparison = Some(Comparison::Unstaged);
    }
    Ok((staged, unstaged, staged_limited || unstaged_limited))
}

fn index_matches(index: &git2::Index, path: &Path, change: &Change) -> bool {
    let is_conflict = |path: &Path| (1..=3).any(|stage| index.get_path(path, stage).is_some());
    if matches!(change.kind, ChangeKind::Conflict) {
        return is_conflict(path);
    }
    let expected = if change.index_only {
        change.index
    } else {
        change.before
    };
    !is_conflict(path)
        && index.get_path(path, 0).map(|entry| (entry.id, entry.mode))
            == expected.map(|version| (version.id, u32::from(version.mode)))
        && change.previous_path.as_ref().is_none_or(|old| {
            let old = Path::new(old);
            !is_conflict(old) && index.get_path(old, 0).is_none()
        })
}

fn compare_scoped(directory: &Repository, repo: &git2::Repository, change: &Change) -> Document {
    let before = read_blob(repo, change.before);
    let (after, mode) = if change.index_only {
        (
            read_blob(repo, change.index),
            change.index.map(|blob| u32::from(blob.mode)),
        )
    } else {
        let path = Path::new(&change.path);
        let after = read_worktree(directory, path);
        let mode = if matches!(after, FileVersion::Text(_)) {
            review_index::worktree_mode(
                repo,
                directory,
                path,
                change.before.map(|blob| u32::from(blob.mode)),
            )
            .ok()
        } else {
            None
        };
        (after, mode)
    };
    let before_mode = change.before.map(|blob| u32::from(blob.mode));
    let executable_changed_to = match (before_mode, mode) {
        (Some(0o100_644 | 0o100_664), Some(0o100_755)) => Some(true),
        (Some(0o100_755), Some(0o100_644 | 0o100_664)) => Some(false),
        _ => None,
    };
    let evidence = if matches!(change.kind, ChangeKind::Conflict)
        || (matches!(after, FileVersion::Text(_)) && mode.is_none())
    {
        None
    } else {
        file_evidence(change, &before, &after, false).map(|evidence| {
            let mut hash = Sha256::new();
            hash.update(evidence);
            hash.update(before_mode.unwrap_or(0).to_le_bytes());
            hash.update(mode.unwrap_or(0).to_le_bytes());
            format!("{:x}", hash.finalize())
        })
    };
    Document {
        before: Some(before),
        after,
        evidence,
        index_only: change.index_only,
        executable_changed_to,
        worktree_mode: mode,
    }
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

fn collect_combined(
    directory: &Repository,
    repo: &git2::Repository,
    base: Option<Oid>,
) -> Result<(ChangeMap, bool), git2::Error> {
    let (mut files, limited) = collect_changes(repo, base)?;
    for change in files.values_mut() {
        change.evidence = compare(directory, repo, change).evidence;
    }
    Ok((files, limited))
}

fn collect_previous_review(
    directory: &Repository,
    repo: &git2::Repository,
    index: &git2::Index,
    base: Option<Oid>,
) -> Result<PreviousReview, git2::Error> {
    let (files, limited) = collect_combined(directory, repo, base)?;
    let (mut staged, staged_limited) = collect_staged(repo, index, base)?;
    for change in staged.values_mut() {
        change.evidence = compare_scoped(directory, repo, change).evidence;
    }
    Ok(PreviousReview {
        files,
        staged,
        limited: limited || staged_limited,
    })
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
                comparison: None,
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
        executable_changed_to: None,
        worktree_mode: None,
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

#[cfg(target_os = "macos")]
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
                LocatedItem::locate(saved.root.clone(), directory, "", action)
            })
            .await?
        }
        FinderTarget::Entry { project_id, path } => {
            let project = app.state::<ReviewState>().project(project_id)?;
            tokio::task::spawn_blocking(move || {
                LocatedItem::locate(project.root.clone(), project.directory()?, &path, action)
            })
            .await
            .map_err(|_| UNAVAILABLE)??
        }
        FinderTarget::Worktree { project_id, path } if matches!(action, FinderAction::Reveal) => {
            let project = app.state::<ReviewState>().project(project_id)?;
            tokio::task::spawn_blocking(move || {
                let directory = project.directory()?;
                let repo = open_git(&directory, &project.root)?;
                let authorized = review_worktrees(&repo)
                    .into_iter()
                    .find(|worktree| worktree.path == path)
                    .ok_or(UNAVAILABLE)?;
                let root = PathBuf::from(authorized.path);
                let (directory, _) = Repository::open_directory(&root, None)?;
                let candidate = open_git(&directory, &root)?;
                if candidate
                    .commondir()
                    .canonicalize()
                    .map_err(|_| UNAVAILABLE)?
                    != repo.commondir().canonicalize().map_err(|_| UNAVAILABLE)?
                {
                    return Err(UNAVAILABLE.into());
                }
                LocatedItem::locate(root, directory, "", action)
            })
            .await
            .map_err(|_| UNAVAILABLE)??
        }
        FinderTarget::Dependency {
            project_id,
            source_id,
        } if matches!(action, FinderAction::Reveal) => {
            let project = app.state::<ReviewState>().project(project_id)?;
            let state = app.state::<AppState>();
            let services = project
                .language_access(&state.store, Some(state.subscribe_offline()), false)
                .await?
                .ok_or(LANGUAGE_OFFLINE)?;
            let path = services
                .while_running(services.local_dependency_file(source_id))
                .await
                .flatten()
                .ok_or(UNAVAILABLE)?;
            return super::finder::reveal(&app, &path, false).await;
        }
        _ => return Err(UNAVAILABLE.into()),
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
        let saved = catalog.get(id)?.clone();
        if let Some(current) = state.current()?.filter(|project| {
            project.info.saved_project_id == Some(id) && project.root == saved.root
        }) {
            return Ok(current);
        }
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
pub(crate) async fn code_review_git_revision(
    project_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<String, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project.git_revision())
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn switch_code_review_worktree(
    app: AppHandle,
    project_id: Uuid,
    path: String,
) -> Result<ProjectInfo, String> {
    let project = with_project_catalog(app.clone(), move |state, _, catalog| {
        let current = state.project(project_id)?;
        let current_directory = current.directory()?;
        let repo = open_git(&current_directory, &current.root)?;
        let worktree = review_worktrees(&repo)
            .into_iter()
            .find(|worktree| worktree.path == path)
            .ok_or(UNAVAILABLE)?;
        if worktree.current {
            return Ok(current);
        }
        let mut next = Project::open(PathBuf::from(worktree.path))?;
        let directory = next.directory()?;
        let candidate = open_git(&directory, &next.root)?;
        if candidate
            .commondir()
            .canonicalize()
            .map_err(|_| UNAVAILABLE)?
            != repo.commondir().canonicalize().map_err(|_| UNAVAILABLE)?
        {
            return Err(UNAVAILABLE.into());
        }
        if let Some(key) = catalog.review_key(&next.identity) {
            key.clone_into(&mut next.info.key);
        }
        state
            .0
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .switch_worktree(&current, next)
    })
    .await?;
    project.resume_language_services(&app);
    Ok(project.info.clone())
}

#[tauri::command]
pub(crate) async fn read_code_review_branch_file(
    project_id: Uuid,
    path: String,
    state: State<'_, ReviewState>,
) -> Result<Document, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project.read_branch_file(&path))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn update_code_review_baseline(
    project_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<Changes, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project.refresh_changes(true))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn change_code_review_index(
    project_id: Uuid,
    input: IndexChange,
    state: State<'_, ReviewState>,
) -> Result<(), String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || project.change_index(&input))
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

#[tauri::command]
pub(crate) async fn create_code_review_entry(
    project_id: Uuid,
    directory: String,
    name: String,
    kind: NewEntryKind,
    state: State<'_, ReviewState>,
) -> Result<String, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || {
        let root = project.directory()?;
        create_review_entry(&root.dir, &directory, &name, kind)
    })
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
    comparison: Option<Comparison>,
    previous: Option<bool>,
    state: State<'_, ReviewState>,
) -> Result<Document, String> {
    let project = state.project(project_id)?;
    tokio::task::spawn_blocking(move || {
        project.read_review_file(
            &path,
            compare_file,
            comparison,
            previous.unwrap_or_default(),
        )
    })
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
        assert_eq!(project.changes.lock().unwrap().baseline.commit, Some(base));
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
        assert_eq!(
            project.read("service.go", true).err().as_deref(),
            Some(STALE)
        );
        let previous = project
            .read_review_file("service.go", true, None, true)
            .unwrap();
        assert!(
            matches!(previous.before, Some(FileVersion::Text(text)) if text == "package old\n")
        );
    }

    fn index_request(changes: &Changes, comparison: Comparison, path: &str) -> IndexChange {
        let files = match comparison {
            Comparison::Staged => &changes.staged,
            Comparison::Unstaged => &changes.unstaged,
        };
        let change = files.iter().find(|change| change.path == path).unwrap();
        IndexChange {
            path: path.into(),
            comparison,
            evidence: change.evidence.clone().unwrap(),
            index_revision: changes.git.as_ref().unwrap().index_revision.clone(),
        }
    }

    fn index_text(repo: &git2::Repository, path: &str) -> Option<String> {
        let mut index = repo.index().unwrap();
        index.read(true).unwrap();
        let entry = index.get_path(Path::new(path), 0)?;
        Some(String::from_utf8(repo.find_blob(entry.id).unwrap().content().to_vec()).unwrap())
    }

    #[cfg(target_os = "macos")]
    fn git_diff(root: &Path, staged: bool) -> String {
        let mut command = std::process::Command::new("/usr/bin/git");
        command
            .current_dir(root)
            .args(["diff", "--no-color", "--no-ext-diff", "--no-textconv"]);
        if staged {
            command.arg("--cached");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    fn compares_partial_staging_and_writes_only_the_reviewed_git_index() {
        let root = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        let file = root.path().join("orders.sql");
        fs::write(&file, "base\n").unwrap();
        let base = commit(&repo, &["orders.sql"]);
        fs::write(&file, "staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("orders.sql")).unwrap();
        index.write().unwrap();
        fs::write(&file, "working\n").unwrap();
        let project = Project::open(root.path().into()).unwrap();
        let changes = project.refresh().unwrap();
        let staged = project
            .read_comparison("orders.sql", true, Some(Comparison::Staged))
            .unwrap();
        let unstaged = project
            .read_comparison("orders.sql", true, Some(Comparison::Unstaged))
            .unwrap();
        assert!(matches!(staged.before, Some(FileVersion::Text(text)) if text == "base\n"));
        assert!(matches!(staged.after, FileVersion::Text(text) if text == "staged\n"));
        assert!(matches!(unstaged.before, Some(FileVersion::Text(text)) if text == "staged\n"));
        assert!(matches!(unstaged.after, FileVersion::Text(text) if text == "working\n"));

        project
            .change_index(&index_request(&changes, Comparison::Unstaged, "orders.sql"))
            .unwrap();
        assert_eq!(
            index_text(&repo, "orders.sql").as_deref(),
            Some("working\n")
        );
        #[cfg(target_os = "macos")]
        {
            assert!(git_diff(root.path(), true).contains("+working"));
            assert!(git_diff(root.path(), false).is_empty());
        }
        let changes = project.refresh().unwrap();
        project
            .change_index(&index_request(&changes, Comparison::Staged, "orders.sql"))
            .unwrap();
        assert_eq!(index_text(&repo, "orders.sql").as_deref(), Some("base\n"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "working\n");
        assert_eq!(repo.head().unwrap().target(), Some(base));
        #[cfg(target_os = "macos")]
        {
            assert!(git_diff(root.path(), true).is_empty());
            assert!(git_diff(root.path(), false).contains("+working"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn executable_bit_is_visible_before_and_after_staging() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        let script = root.path().join("run.sh");
        fs::write(&script, "echo demo\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644)).unwrap();
        commit(&repo, &["run.sh"]);
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let project = Project::open(root.path().into()).unwrap();

        let current = project.refresh().unwrap();
        let working = project
            .read_comparison("run.sh", true, Some(Comparison::Unstaged))
            .unwrap();
        assert_eq!(working.executable_changed_to, Some(true));
        assert!(matches!(working.after, FileVersion::Text(text) if text == "echo demo\n"));
        project
            .change_index(&index_request(&current, Comparison::Unstaged, "run.sh"))
            .unwrap();
        let current = project.refresh().unwrap();
        let staged = project
            .read_comparison("run.sh", true, Some(Comparison::Staged))
            .unwrap();
        assert_eq!(staged.executable_changed_to, Some(true));
        assert_eq!(working.evidence, staged.evidence);
        project
            .change_index(&index_request(&current, Comparison::Staged, "run.sh"))
            .unwrap();
        assert_eq!(
            fs::metadata(script).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn unstaging_preserves_other_git_index_flags_for_the_file() {
        let root = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        let path = Path::new("orders.sql");
        let worktree = root.path().join(path);
        fs::write(&worktree, "original\n").unwrap();
        commit(&repo, &["orders.sql"]);
        fs::write(&worktree, "staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(path).unwrap();
        let mut entry = index.get_path(path, 0).unwrap();
        // CE_VALID (assume-unchanged) and CE_SKIP_WORKTREE are user-managed.
        entry.flags |= 0x8000;
        entry.flags_extended |= 1 << 14;
        index.add(&entry).unwrap();
        index.write().unwrap();
        index.read(true).unwrap();
        let original = index.get_path(path, 0).unwrap();
        assert_eq!(original.flags & 0x8000, 0x8000);
        assert_eq!(original.flags_extended & (1 << 14), 1 << 14);

        let project = Project::open(root.path().into()).unwrap();
        let changes = project.refresh().unwrap();
        project
            .change_index(&index_request(&changes, Comparison::Staged, "orders.sql"))
            .unwrap();
        index.read(true).unwrap();
        let unstaged = index.get_path(path, 0).unwrap();
        assert_eq!(unstaged.flags & 0x8000, 0x8000);
        assert_eq!(unstaged.flags_extended & (1 << 14), 1 << 14);
        assert_eq!(
            index_text(&repo, "orders.sql").as_deref(),
            Some("original\n")
        );
        assert_eq!(fs::read_to_string(worktree).unwrap(), "staged\n");
    }

    #[test]
    fn rejects_stale_worktree_index_and_head_and_keeps_external_changes() {
        let root = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        let file = root.path().join("main.rs");
        let other = root.path().join("other");
        fs::write(&file, "base").unwrap();
        fs::write(&other, "base").unwrap();
        commit(&repo, &["main.rs", "other"]);
        let project = Project::open(root.path().into()).unwrap();
        fs::write(&file, "reviewed").unwrap();
        let changes = project.refresh().unwrap();
        let request = index_request(&changes, Comparison::Unstaged, "main.rs");
        let index_path = repo.path().join("index");
        let bytes = fs::read(&index_path).unwrap();
        fs::write(&file, "newer").unwrap();
        assert_eq!(project.change_index(&request).unwrap_err(), STALE);
        assert_eq!(fs::read(&index_path).unwrap(), bytes);
        fs::write(&file, "reviewed").unwrap();

        fs::write(repo.path().join("index.lock"), "another Git process").unwrap();
        assert_eq!(
            project.change_index(&request).unwrap_err(),
            "codeReviewIndexLocked"
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("index.lock")).unwrap(),
            "another Git process"
        );
        fs::remove_file(repo.path().join("index.lock")).unwrap();

        fs::write(&other, "external").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("other")).unwrap();
        index.write().unwrap();
        let bytes = fs::read(&index_path).unwrap();
        assert_eq!(project.change_index(&request).unwrap_err(), STALE);
        assert_eq!(fs::read(&index_path).unwrap(), bytes);

        let changes = project.refresh().unwrap();
        let request = index_request(&changes, Comparison::Unstaged, "main.rs");
        let new_head = commit(&repo, &["other"]);
        assert!(project.refresh().unwrap().git.unwrap().baseline_changed);
        assert_eq!(project.change_index(&request).unwrap_err(), STALE);
        let current = project.refresh_changes(true).unwrap().git.unwrap();
        assert!(!current.baseline_changed);
        assert_eq!(current.baseline.unwrap(), new_head.to_string());
        assert_eq!(index_text(&repo, "other").as_deref(), Some("external"));
    }

    #[test]
    fn switches_registered_worktrees_and_keeps_commit_diffs_separate_from_the_index() {
        let root = tempfile::tempdir().unwrap();
        let primary = root.path().join("main");
        let linked = root.path().join("task");
        let repo = git2::Repository::init(&primary).unwrap();
        fs::write(primary.join("base.txt"), "base").unwrap();
        let base = commit(&repo, &["base.txt"]);
        repo.worktree("task", &linked, None).unwrap();
        let linked_repo = git2::Repository::open(&linked).unwrap();
        fs::write(primary.join("upstream.txt"), "upstream").unwrap();
        let upstream = commit(&repo, &["upstream.txt"]);
        repo.reference("refs/remotes/origin/main", upstream, false, "fixture")
            .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            false,
            "fixture",
        )
        .unwrap();

        let mut session = ReviewSession::default();
        let main = session.activate(Project::open(primary.clone()).unwrap());
        let task = session
            .switch_worktree(
                &main,
                Project::open(linked.canonicalize().unwrap()).unwrap(),
            )
            .unwrap();
        fs::write(linked.join("base.txt"), "committed").unwrap();
        let head = commit(&linked_repo, &["base.txt"]);
        fs::write(linked.join("base.txt"), "working").unwrap();
        let main_index = fs::read(repo.path().join("index")).unwrap();
        let snapshot = task.refresh().unwrap();
        let worktrees = &snapshot.git.as_ref().unwrap().worktrees;
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].primary && !worktrees[0].current);
        assert!(worktrees[1].current && !worktrees[1].primary);
        assert_eq!(worktrees[1].branch.as_deref(), Some("task"));
        let branch = snapshot.branch.as_ref().unwrap();
        assert_eq!(branch.target, "origin/main");
        assert_eq!(branch.base, base.to_string());
        assert_eq!(branch.head, head.to_string());
        assert_eq!(branch.files.len(), 1);
        let document = task.read_branch_file("base.txt").unwrap();
        assert!(matches!(document.before, Some(FileVersion::Text(text)) if text == "base"));
        assert!(matches!(document.after, FileVersion::Text(text) if text == "committed"));
        assert!(snapshot.staged.is_empty());
        assert_eq!(snapshot.previous_staged.as_ref().unwrap().len(), 1);
        let local = task.read("base.txt", true).unwrap();
        assert!(matches!(local.before, Some(FileVersion::Text(text)) if text == "committed"));
        assert!(matches!(local.after, FileVersion::Text(text) if text == "working"));

        task.change_index(&index_request(&snapshot, Comparison::Unstaged, "base.txt"))
            .unwrap();
        let linked_index = fs::read(linked_repo.path().join("index")).unwrap();
        let main_again = session
            .switch_worktree(
                &task,
                Project::open(primary.canonicalize().unwrap()).unwrap(),
            )
            .unwrap();
        let task_again = session
            .switch_worktree(
                &main_again,
                Project::open(linked.canonicalize().unwrap()).unwrap(),
            )
            .unwrap();
        let returned = task_again.refresh().unwrap();
        assert_eq!(
            returned.git.unwrap().baseline.as_deref(),
            Some(base.to_string().as_str())
        );
        assert_eq!(returned.staged.len(), 1);
        assert!(returned.unstaged.is_empty());
        assert_eq!(main_index, fs::read(repo.path().join("index")).unwrap());
        assert_eq!(
            linked_index,
            fs::read(linked_repo.path().join("index")).unwrap()
        );
        assert_eq!(repo.head().unwrap().target(), Some(upstream));
        assert_eq!(linked_repo.head().unwrap().target(), Some(head));

        task_again.changes.lock().unwrap().baseline.commit = Some(Oid::ZERO_SHA1);
        let without_previous_base = task_again.refresh().unwrap();
        assert!(without_previous_base.previous_files.is_none());
        assert!(without_previous_base.previous_staged.is_none());
        assert_eq!(without_previous_base.staged.len(), 1);
        assert!(without_previous_base.branch.is_some());

        repo.reference("refs/heads/trunk", upstream, false, "fixture")
            .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
            true,
            "fixture",
        )
        .unwrap();
        let branch = task_again.refresh().unwrap().branch.unwrap();
        assert_eq!(branch.target, "trunk");
        assert_eq!(branch.base, base.to_string());
    }

    #[test]
    fn stages_additions_and_deletions_in_a_linked_worktree() {
        let root = tempfile::tempdir().unwrap();
        let primary = root.path().join("main");
        let linked = root.path().join("task");
        let repo = git2::Repository::init(&primary).unwrap();
        fs::write(primary.join("old.sql"), "old").unwrap();
        commit(&repo, &["old.sql"]);
        repo.worktree("task", &linked, None).unwrap();
        let linked_repo = git2::Repository::open(&linked).unwrap();
        let project = Project::open(linked.clone()).unwrap();
        fs::remove_file(linked.join("old.sql")).unwrap();
        fs::write(linked.join("new.sql"), "new").unwrap();

        for path in ["old.sql", "new.sql"] {
            let changes = project.refresh().unwrap();
            project
                .change_index(&index_request(&changes, Comparison::Unstaged, path))
                .unwrap();
        }
        assert_eq!(index_text(&linked_repo, "new.sql").as_deref(), Some("new"));
        assert!(index_text(&linked_repo, "old.sql").is_none());
        assert!(index_text(&repo, "new.sql").is_none());
        assert_eq!(index_text(&repo, "old.sql").as_deref(), Some("old"));
    }

    #[test]
    fn git_revision_tracks_external_staging_and_commits_in_the_active_worktree() {
        let root = tempfile::tempdir().unwrap();
        let primary = root.path().join("main");
        let linked = root.path().join("task");
        let repo = git2::Repository::init(&primary).unwrap();
        fs::write(primary.join("file.txt"), "base").unwrap();
        commit(&repo, &["file.txt"]);
        repo.worktree("task", &linked, None).unwrap();
        let linked_repo = git2::Repository::open(&linked).unwrap();
        let project = Project::open(linked.clone()).unwrap();
        let primary_project = Project::open(primary).unwrap();
        let primary_revision = primary_project.git_revision().unwrap();
        let original = project.refresh().unwrap().git.unwrap().index_revision;
        assert_eq!(project.git_revision().unwrap(), original);

        fs::write(linked.join("file.txt"), "new").unwrap();
        let mut index = linked_repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let staged = project.git_revision().unwrap();
        assert_ne!(staged, original);
        let snapshot = project.refresh().unwrap();
        assert_eq!(snapshot.git.unwrap().index_revision, staged);
        assert_eq!(snapshot.staged.len(), 1);

        commit(&linked_repo, &[]);
        let committed = project.git_revision().unwrap();
        assert_ne!(committed, staged);
        let snapshot = project.refresh().unwrap();
        assert_eq!(snapshot.git.unwrap().index_revision, committed);
        assert!(snapshot.staged.is_empty());
        assert_eq!(primary_project.git_revision().unwrap(), primary_revision);
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
