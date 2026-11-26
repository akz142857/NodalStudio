//! The earlier SQL prototype still contains validation for persisted Query drafts.
#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::{Arc, LazyLock},
};

use chrono::{DateTime, Utc};
use extension_model::CodeLineageLink;
use schema_model::{DataSourceProfile, DatabaseSnapshot, DatabaseType, ObjectKey, ObjectKind};
use semantic_model::ontology::{ConfirmedDefinition, PaidOrdersDefinition};
use serde::{Deserialize, Serialize};
use snapshot_store::ontology::{DefinitionRevision, DraftOntologyInput, OntologyScope};
use tauri::State;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    analysis::{self, StatementAnalysis, analyze, digest},
    files::{self, GitVersion, Repository, RootIdentity},
};
use crate::{AppState, file_access, safe_store_error};

const MAX_INDEX_BYTES: usize = 12 * 1024 * 1024;
const MAX_FILES: usize = 500;
const MAX_LINKS_PER_PAGE: usize = 80;
const CHANGED: &str = "The project or database context changed. Reopen the project and scan again.";
const STALE: &str = "The file changed after the scan. Scan again to refresh its references.";
const UNSUPPORTED: &str = "Choose a MySQL data source with a current database snapshot.";
const SNAPSHOT_MISMATCH: &str =
    "The database snapshot does not match the current MySQL connection.";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    id: Uuid,
    root: String,
    root_identity: RootIdentity,
    directories: Vec<String>,
    connection: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectScope {
    source_id: Uuid,
    binding_id: Uuid,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileSelection {
    #[serde(flatten)]
    project: ProjectScope,
    path: String,
    index_version: Uuid,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatementSelection {
    #[serde(flatten)]
    file: FileSelection,
    start: usize,
    digest: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryHandoff {
    source_id: Uuid,
    binding_id: Uuid,
    database: String,
    connection: String,
    profile_revision: DateTime<Utc>,
    snapshot_id: Uuid,
    path: String,
    statement_digest: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedDefinition {
    id: Uuid,
    revision: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManualLink {
    binding_id: Uuid,
    path: String,
    statement_digest: String,
    file_digest: String,
    start: usize,
    snapshot_fingerprint: String,
    object: Option<ObjectKey>,
    definition: Option<LinkedDefinition>,
    generated: bool,
}

#[derive(Clone)]
struct IndexedFile {
    digest: String,
    statements: Vec<StatementAnalysis>,
    diagnostic: Option<&'static str>,
}

#[derive(Clone)]
struct Scan {
    binding_id: Uuid,
    version: Uuid,
    generation: Uuid,
    snapshot_id: Uuid,
    git: GitVersion,
    at: DateTime<Utc>,
    files: BTreeMap<String, IndexedFile>,
    skipped: usize,
    partial_update: bool,
    read_errors: BTreeSet<String>,
}

#[derive(Default)]
struct IndexState {
    scan: Option<Arc<Scan>>,
    job: Option<(Uuid, CancellationToken)>,
    stale: bool,
}

#[derive(Default)]
struct SourceRuntime {
    index: Mutex<IndexState>,
    mutation: Mutex<()>,
}

static SOURCES: LazyLock<Mutex<HashMap<Uuid, Arc<SourceRuntime>>>> = LazyLock::new(Mutex::default);

async fn runtime(source_id: Uuid) -> Arc<SourceRuntime> {
    SOURCES.lock().await.entry(source_id).or_default().clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectSummary {
    id: Uuid,
    name: String,
    directories: Vec<String>,
    can_open_external_editor: bool,
    database: String,
    connection_name: String,
    snapshot_id: Uuid,
    snapshot_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedMatch {
    line: u64,
    start: usize,
    evidence: &'static str,
    stale: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectAssociation {
    object: ObjectKey,
    evidence: &'static str,
    stale: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSummary {
    path: String,
    diagnostic: Option<&'static str>,
    matches: Vec<IndexedMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    version: Uuid,
    generation: Uuid,
    at: DateTime<Utc>,
    git: GitVersion,
    skipped: usize,
    diagnostic_count: usize,
    partial_update: bool,
    file_count: usize,
    total_matching: usize,
    files: Vec<FileSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectPage {
    project: Option<ProjectSummary>,
    scan: Option<ScanSummary>,
    scanning: bool,
    stale: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectPageRequest {
    source_id: Uuid,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    search: String,
    object: Option<ObjectKey>,
    #[serde(default)]
    check_files: bool,
}

async fn current_binding(state: &AppState, source_id: Uuid) -> Result<Option<Binding>, String> {
    state
        .store
        .code_view_binding(source_id)
        .await
        .map_err(safe_store_error)?
        .map(|payload| {
            serde_json::from_str(&payload)
                .map_err(|_| "The project binding could not be read.".to_owned())
        })
        .transpose()
}

async fn database_context(
    state: &AppState,
    source_id: Uuid,
) -> Result<(DataSourceProfile, DatabaseSnapshot), String> {
    let profile = state
        .store
        .get_data_source(source_id)
        .await
        .map_err(safe_store_error)?
        .filter(|profile| {
            profile.database_type == DatabaseType::MySql && !profile.database.is_empty()
        })
        .ok_or(UNSUPPORTED)?;
    let snapshot = state
        .store
        .latest_snapshot(source_id)
        .await
        .map_err(safe_store_error)?
        .filter(|snapshot| snapshot.database.database_type == DatabaseType::MySql)
        .ok_or(UNSUPPORTED)?;
    if snapshot.database.name != profile.database
        || !snapshot
            .schemas
            .iter()
            .any(|schema| schema.name == profile.database)
    {
        return Err(SNAPSHOT_MISMATCH.into());
    }
    state
        .store
        .validate_code_view_snapshot(&snapshot)
        .await
        .map_err(safe_store_error)?;
    Ok((profile, snapshot))
}

fn connection_identity(profile: &DataSourceProfile) -> String {
    digest(
        serde_json::to_vec(&(
            &profile.host,
            profile.port,
            &profile.database,
            &profile.username,
            profile.database_type,
            profile.ssl_mode,
            &profile.security,
        ))
        .unwrap_or_default(),
    )
}

async fn live_project(
    state: &AppState,
    scope: &ProjectScope,
) -> Result<(Binding, DataSourceProfile, DatabaseSnapshot), String> {
    let binding = current_binding(state, scope.source_id)
        .await?
        .filter(|binding| binding.id == scope.binding_id)
        .ok_or(CHANGED)?;
    let (profile, snapshot) = database_context(state, scope.source_id).await?;
    if connection_identity(&profile) != binding.connection {
        return Err(CHANGED.into());
    }
    Ok((binding, profile, snapshot))
}

fn project_summary(
    binding: &Binding,
    profile: &DataSourceProfile,
    snapshot: &DatabaseSnapshot,
) -> ProjectSummary {
    ProjectSummary {
        id: binding.id,
        name: Path::new(&binding.root)
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
        directories: binding.directories.clone(),
        can_open_external_editor: cfg!(any(target_os = "macos", windows)),
        database: snapshot.database.name.clone(),
        connection_name: profile.display_name.clone(),
        snapshot_id: snapshot.id,
        snapshot_at: snapshot.captured_at,
    }
}

fn open_repository(binding: &Binding) -> Result<Repository, String> {
    Repository::open(Path::new(&binding.root), Some(&binding.root_identity)).map(|(repo, _)| repo)
}

#[tauri::command]
pub(super) async fn choose_code_view_project(
    app: tauri::AppHandle,
    source_id: Uuid,
    directories: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Option<ProjectSummary>, String> {
    let (expected, _) = database_context(&state, source_id).await?;
    if directories.is_empty() || directories.len() > 16 {
        return Err("Select the project root or up to 16 SQL directories.".into());
    }
    for directory in &directories {
        files::relative_path(directory, true)
            .map_err(|_| "Enter repository-relative directory names.")?;
    }
    let settings = state
        .store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    let suggested_path = std::path::PathBuf::from(settings.git.repository_path);
    let Some(root) = file_access::pick_workspace_path_from(
        app,
        file_access::SelectionKind::Repository,
        Some(suggested_path),
    )
    .await?
    else {
        return Ok(None);
    };
    let runtime = runtime(source_id).await;
    let _mutation = runtime.mutation.lock().await;
    let (profile, snapshot) = database_context(&state, source_id).await?;
    if expected.updated_at != profile.updated_at
        || connection_identity(&expected) != connection_identity(&profile)
    {
        return Err(CHANGED.into());
    }
    let connection = connection_identity(&profile);
    let binding = tokio::task::spawn_blocking(move || {
        let (repository, root_identity) = Repository::open(Path::new(&root), None)?;
        repository
            .validate_roots(&directories)
            .map_err(|_| "A selected SQL directory is missing, ignored, or inaccessible.")?;
        Ok::<_, String>(Binding {
            id: Uuid::new_v4(),
            root,
            root_identity,
            directories,
            connection,
        })
    })
    .await
    .map_err(|_| "Unable to open the repository folder.")??;
    let payload =
        serde_json::to_string(&binding).map_err(|_| "Unable to serialize the project binding.")?;
    state
        .store
        .save_code_view_binding(source_id, binding.id, &payload)
        .await
        .map_err(safe_store_error)?;
    reset(&runtime).await;
    Ok(Some(project_summary(&binding, &profile, &snapshot)))
}

#[tauri::command]
pub(super) async fn remove_code_view_project(
    input: ProjectScope,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = runtime(input.source_id).await;
    let _mutation = runtime.mutation.lock().await;
    if current_binding(&state, input.source_id)
        .await?
        .is_none_or(|binding| binding.id != input.binding_id)
    {
        return Err(CHANGED.into());
    }
    state
        .store
        .remove_code_view_binding(input.source_id, input.binding_id)
        .await
        .map_err(safe_store_error)?;
    reset(&runtime).await;
    Ok(())
}

async fn reset(runtime: &SourceRuntime) {
    let mut index = runtime.index.lock().await;
    if let Some((_, job)) = index.job.take() {
        job.cancel();
    }
    *index = IndexState::default();
}

fn indexed_match(
    statement: &StatementAnalysis,
    evidence: &'static str,
    stale: bool,
) -> IndexedMatch {
    IndexedMatch {
        line: statement.line,
        start: statement.start,
        evidence,
        stale,
    }
}

fn indexed_matches(
    file: &IndexedFile,
    path: &str,
    object: Option<&ObjectKey>,
    binding: &Binding,
    snapshot: &DatabaseSnapshot,
    manual: &[ManualLink],
    legacy: &[CodeLineageLink],
) -> Vec<IndexedMatch> {
    let mut matches: Vec<_> = file
        .statements
        .iter()
        .filter(|statement| object.is_none_or(|object| statement.references.contains(object)))
        .map(|statement| indexed_match(statement, "static", false))
        .collect();
    let Some(object) = object else { return matches };
    for link in manual
        .iter()
        .filter(|link| link.path == path && link.object.as_ref() == Some(object))
    {
        if let Some((statement, stale)) = manual_evidence(file, binding, snapshot, link) {
            matches.push(indexed_match(statement, "manual", stale));
        }
    }
    for link in legacy
        .iter()
        .filter(|link| link.file_path == path && &link.object_key == object)
    {
        if let Some(statement) = legacy_position(file, link) {
            matches.push(indexed_match(statement, "legacy", true));
        }
    }
    matches.sort_by_key(|item| (item.start, item.stale, item.evidence));
    matches.dedup_by_key(|item| (item.start, item.evidence, item.stale));
    matches
}

fn manual_evidence<'a>(
    file: &'a IndexedFile,
    binding: &Binding,
    snapshot: &DatabaseSnapshot,
    link: &ManualLink,
) -> Option<(&'a StatementAnalysis, bool)> {
    let mut exact = file
        .statements
        .iter()
        .filter(|entry| entry.digest == link.statement_digest);
    let first = exact.next();
    let unique = first.is_some() && exact.next().is_none();
    let at_position = file
        .statements
        .iter()
        .find(|entry| entry.start == link.start);
    let position = if file.digest == link.file_digest {
        at_position
    } else if unique {
        first
    } else {
        at_position
    };
    let statement = position?;
    let stale = link.binding_id != binding.id
        || link.snapshot_fingerprint != snapshot.fingerprint
        || statement.digest != link.statement_digest
        || (file.digest != link.file_digest && !unique);
    Some((statement, stale))
}

fn legacy_position<'a>(
    file: &'a IndexedFile,
    link: &CodeLineageLink,
) -> Option<&'a StatementAnalysis> {
    let imported_line = link.line.map(u64::from);
    file.statements
        .iter()
        .rev()
        .find(|statement| imported_line.is_some_and(|line| statement.line <= line))
        .or_else(|| file.statements.first())
}

fn project_page(
    binding: &Binding,
    project: ProjectSummary,
    snapshot: &DatabaseSnapshot,
    index: &IndexState,
    needs_refresh: bool,
    request: &ProjectPageRequest,
    associations: (&[ManualLink], &[CodeLineageLink]),
) -> ProjectPage {
    let search = request.search.trim().to_lowercase();
    let (manual, legacy) = associations;
    let summary = index
        .scan
        .as_deref()
        .filter(|scan| scan.binding_id == binding.id)
        .map(|scan| {
            let mut matching = scan.files.iter().filter_map(|(path, file)| {
                if !path.to_lowercase().contains(&search) {
                    return None;
                }
                let matches = indexed_matches(
                    file,
                    path,
                    request.object.as_ref(),
                    binding,
                    snapshot,
                    manual,
                    legacy,
                );
                if request.object.is_some() && matches.is_empty() {
                    return None;
                }
                Some(FileSummary {
                    path: path.clone(),
                    diagnostic: file.diagnostic,
                    matches,
                })
            });
            let matching = matching.by_ref().collect::<Vec<_>>();
            let total_matching = matching.len();
            let files = matching
                .into_iter()
                .skip(request.offset)
                .take(MAX_LINKS_PER_PAGE)
                .collect();
            ScanSummary {
                version: scan.version,
                generation: scan.generation,
                at: scan.at,
                git: scan.git.clone(),
                skipped: scan.skipped,
                partial_update: scan.partial_update,
                file_count: scan.files.len(),
                total_matching,
                diagnostic_count: scan
                    .files
                    .values()
                    .filter(|file| {
                        file.diagnostic.is_some()
                            || file
                                .statements
                                .iter()
                                .any(|statement| !statement.diagnostics.is_empty())
                    })
                    .count(),
                files,
            }
        });
    ProjectPage {
        project: Some(project),
        scan: summary,
        scanning: index.job.is_some(),
        stale: needs_refresh,
    }
}

#[tauri::command]
pub(super) async fn get_code_view(
    input: ProjectPageRequest,
    state: State<'_, AppState>,
) -> Result<ProjectPage, String> {
    let Some(binding) = current_binding(&state, input.source_id).await? else {
        return Ok(ProjectPage {
            project: None,
            scan: None,
            scanning: false,
            stale: false,
        });
    };
    let (profile, snapshot) = database_context(&state, input.source_id).await?;
    let runtime = runtime(input.source_id).await;
    if input.check_files {
        let scan = runtime.index.lock().await.scan.clone();
        if let Some(scan) = scan {
            let check = scan.clone();
            let project = binding.clone();
            let unchanged = tokio::task::spawn_blocking(move || check_scan(&project, &check))
                .await
                .unwrap_or(false);
            let mut index = runtime.index.lock().await;
            if index
                .scan
                .as_ref()
                .is_some_and(|current| current.version == scan.version)
            {
                index.stale |= !unchanged;
            }
        }
    }
    let (manual, legacy) = if input.object.is_some() {
        tokio::try_join!(
            manual_links(&state, input.source_id),
            legacy_links(&state, input.source_id)
        )?
    } else {
        (Vec::new(), Vec::new())
    };
    let index = runtime.index.lock().await;
    let needs_refresh = index.stale
        || connection_identity(&profile) != binding.connection
        || index
            .scan
            .as_ref()
            .is_some_and(|scan| scan.snapshot_id != snapshot.id);
    Ok(project_page(
        &binding,
        project_summary(&binding, &profile, &snapshot),
        &snapshot,
        &index,
        needs_refresh,
        &input,
        (&manual, &legacy),
    ))
}

fn read_index_file(
    repository: &Repository,
    path: &str,
    binding: &Binding,
    snapshot: &DatabaseSnapshot,
    previous: Option<&IndexedFile>,
) -> Result<(IndexedFile, usize), String> {
    let sql = repository
        .read(path, &binding.directories)
        .map_err(|_| "The SQL file is inaccessible or exceeds the size limit.")?;
    let fingerprint = digest(&sql);
    if let Some(previous) = previous.filter(|file| file.digest == fingerprint) {
        return Ok((previous.clone(), sql.len()));
    }
    let (statements, diagnostic) = analyze(&sql, snapshot);
    Ok((
        IndexedFile {
            digest: fingerprint,
            statements,
            diagnostic,
        },
        sql.len(),
    ))
}

fn collect_scan(
    binding: &Binding,
    snapshot: &DatabaseSnapshot,
    generation: Uuid,
    cancellation: &CancellationToken,
    previous: Option<&Scan>,
) -> Result<Scan, String> {
    let repository = open_repository(binding)?;
    let previous =
        previous.filter(|scan| scan.binding_id == binding.id && scan.snapshot_id == snapshot.id);
    let mut entries = BTreeMap::new();
    let mut bytes = 0;
    let mut read_errors = BTreeSet::new();
    let skipped = repository.walk(&binding.directories, |path| {
        if cancellation.is_cancelled() || entries.len() >= MAX_FILES || bytes >= MAX_INDEX_BYTES {
            return false;
        }
        if let Ok((file, size)) = read_index_file(
            &repository,
            &path,
            binding,
            snapshot,
            previous.and_then(|scan| scan.files.get(&path)),
        ) {
            if size > MAX_INDEX_BYTES.saturating_sub(bytes) {
                return false;
            }
            bytes += size;
            entries.insert(path, file);
        } else {
            read_errors.insert(path);
        }
        true
    });
    if cancellation.is_cancelled() {
        return Err("Project scan cancelled.".into());
    }
    Ok(Scan {
        binding_id: binding.id,
        version: Uuid::new_v4(),
        generation,
        snapshot_id: snapshot.id,
        git: repository.git_version(),
        at: Utc::now(),
        files: entries,
        skipped: skipped + read_errors.len(),
        partial_update: false,
        read_errors,
    })
}

fn check_scan(binding: &Binding, scan: &Scan) -> bool {
    if scan.binding_id != binding.id {
        return false;
    }
    let Ok(repository) = open_repository(binding) else {
        return false;
    };
    if repository.git_version() != scan.git {
        return false;
    }
    if scan.partial_update {
        return scan.files.iter().all(|(path, indexed)| {
            repository
                .read(path, &binding.directories)
                .is_ok_and(|sql| digest(sql) == indexed.digest)
        });
    }
    let mut checked = 0;
    let mut bytes = 0;
    let mut errors = BTreeSet::new();
    let mut equal = true;
    let skipped = repository.walk(&binding.directories, |path| {
        if checked >= MAX_FILES || bytes >= MAX_INDEX_BYTES {
            return false;
        }
        if let Ok(sql) = repository.read(&path, &binding.directories) {
            if sql.len() > MAX_INDEX_BYTES.saturating_sub(bytes) {
                return false;
            }
            equal = scan
                .files
                .get(&path)
                .is_some_and(|indexed| digest(&sql) == indexed.digest);
            bytes += sql.len();
            checked += 1;
        } else {
            equal = scan.read_errors.contains(&path);
            errors.insert(path);
        }
        equal
    });
    equal
        && checked == scan.files.len()
        && errors == scan.read_errors
        && skipped + errors.len() == scan.skipped
}

#[tauri::command]
pub(super) async fn scan_code_view(
    input: ProjectScope,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (binding, profile, snapshot) = live_project(&state, &input).await?;
    let snapshot_id = snapshot.id;
    let generation = Uuid::new_v4();
    let cancellation = CancellationToken::new();
    let runtime = runtime(input.source_id).await;
    let previous = {
        let mut index = runtime.index.lock().await;
        if let Some((_, job)) = index.job.replace((generation, cancellation.clone())) {
            job.cancel();
        }
        index.scan.clone()
    };
    let initial_version = previous.as_ref().map(|scan| scan.version);
    let result = tokio::task::spawn_blocking(move || {
        collect_scan(
            &binding,
            &snapshot,
            generation,
            &cancellation,
            previous.as_deref(),
        )
    })
    .await
    .map_err(|_| "The project scan could not be completed.".to_owned())
    .and_then(|result| result);
    let current = live_project(&state, &input).await;
    let mut index = runtime.index.lock().await;
    if index.job.as_ref().is_none_or(|(id, _)| *id != generation) {
        return Err(CHANGED.into());
    }
    if index
        .job
        .take()
        .is_some_and(|(_, token)| token.is_cancelled())
    {
        return Err("Project scan cancelled.".into());
    }
    if !current.is_ok_and(|(_, new_profile, snapshot)| {
        new_profile.updated_at == profile.updated_at && snapshot.id == snapshot_id
    }) || index.scan.as_ref().map(|scan| scan.version) != initial_version
    {
        index.stale = true;
        return Err(CHANGED.into());
    }
    match result {
        Ok(result) => {
            index.scan = Some(Arc::new(result));
            index.stale = false;
            Ok(())
        }
        Err(error) => {
            index.stale = index.scan.is_some();
            Err(error)
        }
    }
}

#[tauri::command]
pub(super) async fn cancel_code_view_scan(
    input: ProjectScope,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if current_binding(&state, input.source_id)
        .await?
        .is_some_and(|binding| binding.id == input.binding_id)
        && let Some((_, cancellation)) = &runtime(input.source_id).await.index.lock().await.job
    {
        cancellation.cancel();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OntologyReference {
    id: Uuid,
    name: String,
    revision: u32,
    evidence: &'static str,
    stale: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodeFile {
    path: String,
    contents: String,
    statements: Vec<StatementAnalysis>,
    diagnostic: Option<&'static str>,
    ontology: BTreeMap<usize, Vec<OntologyReference>>,
    associations: BTreeMap<usize, Vec<ObjectAssociation>>,
}

async fn indexed_file(
    state: &AppState,
    input: &FileSelection,
) -> Result<
    (
        Binding,
        DataSourceProfile,
        DatabaseSnapshot,
        Arc<Scan>,
        IndexedFile,
    ),
    String,
> {
    let (binding, profile, snapshot) = live_project(state, &input.project).await?;
    let runtime = runtime(input.project.source_id).await;
    let index = runtime.index.lock().await;
    let scan = index
        .scan
        .as_ref()
        .filter(|scan| {
            scan.binding_id == binding.id
                && scan.version == input.index_version
                && scan.snapshot_id == snapshot.id
        })
        .ok_or(CHANGED)?
        .clone();
    let file = scan.files.get(&input.path).ok_or(CHANGED)?.clone();
    Ok((binding, profile, snapshot, scan, file))
}

async fn read_checked(
    binding: &Binding,
    path: &str,
    expected: &IndexedFile,
    runtime: &SourceRuntime,
) -> Result<String, String> {
    let binding = binding.clone();
    let path = path.to_owned();
    let sql = tokio::task::spawn_blocking(move || {
        open_repository(&binding)?
            .read(&path, &binding.directories)
            .map_err(|_| STALE.to_owned())
    })
    .await
    .map_err(|_| STALE)?;
    if let Ok(sql) = sql
        && digest(&sql) == expected.digest
    {
        return Ok(sql);
    }
    runtime.index.lock().await.stale = true;
    Err(STALE.into())
}

fn definition_objects(definition: &PaidOrdersDefinition) -> BTreeSet<ObjectKey> {
    [
        definition
            .order
            .table
            .child(ObjectKind::Column, &definition.order.id_column),
        definition
            .payment
            .table
            .child(ObjectKind::Column, &definition.payment.order_id_column),
        definition
            .payment
            .table
            .child(ObjectKind::Column, &definition.payment.status_column),
        definition
            .payment
            .table
            .child(ObjectKind::Column, &definition.payment.paid_at_column),
    ]
    .into_iter()
    .collect()
}

async fn definitions(
    state: &AppState,
    snapshot: &DatabaseSnapshot,
) -> Result<Vec<ConfirmedDefinition>, String> {
    state
        .store
        .list_ontology(&OntologyScope {
            source_id: snapshot.source_id,
            snapshot_id: snapshot.id,
        })
        .await
        .map_err(safe_store_error)
}

async fn manual_links(state: &AppState, source_id: Uuid) -> Result<Vec<ManualLink>, String> {
    state
        .store
        .code_view_links(source_id)
        .await
        .map_err(safe_store_error)
        .map(|links| {
            links
                .into_iter()
                .filter_map(|link| serde_json::from_str(&link).ok())
                .collect()
        })
}

async fn legacy_links(state: &AppState, source_id: Uuid) -> Result<Vec<CodeLineageLink>, String> {
    state
        .store
        .list_lineage(source_id)
        .await
        .map_err(safe_store_error)
}

fn reference(
    definition: &ConfirmedDefinition,
    evidence: &'static str,
    stale: bool,
) -> OntologyReference {
    OntologyReference {
        id: definition.id,
        name: definition.definition.name.clone(),
        revision: definition.revision,
        evidence,
        stale: stale || !definition.impacts.is_empty() || definition.source_change_id.is_some(),
    }
}

#[tauri::command]
pub(super) async fn read_code_view_file(
    input: FileSelection,
    state: State<'_, AppState>,
) -> Result<CodeFile, String> {
    let (binding, _, snapshot, _, file) = indexed_file(&state, &input).await?;
    let runtime = runtime(input.project.source_id).await;
    let contents = read_checked(&binding, &input.path, &file, &runtime).await?;
    let definitions = definitions(&state, &snapshot).await?;
    let (links, legacy) = tokio::try_join!(
        manual_links(&state, input.project.source_id),
        legacy_links(&state, input.project.source_id),
    )?;
    let statements = file.statements.clone();
    let mut ontology = BTreeMap::new();
    let mut associations: BTreeMap<usize, Vec<ObjectAssociation>> = BTreeMap::new();
    for statement in &statements {
        let entries: Vec<_> = definitions
            .iter()
            .filter(|definition| {
                !statement
                    .references
                    .is_disjoint(&definition_objects(&definition.definition))
            })
            .map(|definition| reference(definition, "field", false))
            .collect();
        if !entries.is_empty() {
            ontology.insert(statement.start, entries);
        }
    }
    for link in links.iter().filter(|link| link.path == input.path) {
        let Some((statement, needs_review)) = manual_evidence(&file, &binding, &snapshot, link)
        else {
            continue;
        };
        if let Some(object) = &link.object {
            associations
                .entry(statement.start)
                .or_default()
                .push(ObjectAssociation {
                    object: object.clone(),
                    evidence: "manual",
                    stale: needs_review || !object_exists(&snapshot, object),
                });
        }
        if let Some(revision) = &link.definition
            && let Some(definition) = definitions
                .iter()
                .find(|definition| definition.id == revision.id)
        {
            let mut entry = reference(
                definition,
                if link.generated {
                    "generated"
                } else {
                    "confirmed"
                },
                needs_review || definition.revision != revision.revision,
            );
            entry.revision = revision.revision;
            ontology.entry(statement.start).or_default().push(entry);
        }
    }
    for link in legacy.iter().filter(|link| link.file_path == input.path) {
        if let Some(statement) = legacy_position(&file, link) {
            associations
                .entry(statement.start)
                .or_default()
                .push(ObjectAssociation {
                    object: link.object_key.clone(),
                    evidence: "legacy",
                    stale: true,
                });
        }
    }
    for entries in ontology.values_mut() {
        entries.sort_by_key(|entry| {
            (
                entry.id,
                entry.evidence,
                entry.stale,
                std::cmp::Reverse(entry.revision),
            )
        });
        entries.dedup_by_key(|entry| (entry.id, entry.evidence));
    }
    Ok(CodeFile {
        path: input.path,
        contents,
        statements,
        diagnostic: file.diagnostic,
        ontology,
        associations,
    })
}

#[tauri::command]
pub(super) async fn open_code_view_file_in_editor(
    input: FileSelection,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = runtime(input.project.source_id).await;
    let _mutation = runtime.mutation.lock().await;
    let (binding, _, _, _, file) = indexed_file(&state, &input).await?;
    let path = input.path;
    let result = tokio::task::spawn_blocking(move || {
        let repository = open_repository(&binding)?;
        let contents = repository
            .read(&path, &binding.directories)
            .map_err(|_| STALE.to_owned())?;
        if digest(contents) != file.digest {
            return Err(STALE.into());
        }
        let relative = files::relative_path(&path, false).map_err(|_| STALE.to_owned())?;
        files::open_in_default_editor(&Path::new(&binding.root).join(relative))
    })
    .await
    .map_err(|_| "Unable to open the project SQL file.")?;
    if result.as_ref().is_err_and(|error| error == STALE) {
        runtime.index.lock().await.stale = true;
    }
    result
}

fn object_exists(snapshot: &DatabaseSnapshot, object: &ObjectKey) -> bool {
    snapshot.schemas.iter().any(|schema| {
        schema.views.iter().any(|view| &view.key == object)
            || schema.tables.iter().any(|table| {
                &table.key == object
                    || (object.kind == ObjectKind::Column
                        && table.key.child(ObjectKind::Column, &object.name) == *object
                        && table
                            .columns
                            .iter()
                            .any(|column| column.name == object.name))
            })
    })
}

fn find_statement<'a>(
    input: &StatementSelection,
    file: &'a IndexedFile,
) -> Result<&'a StatementAnalysis, String> {
    file.statements
        .iter()
        .find(|statement| statement.start == input.start && statement.digest == input.digest)
        .ok_or(STALE.into())
}

#[tauri::command]
pub(super) async fn prepare_code_view_query(
    input: StatementSelection,
    state: State<'_, AppState>,
) -> Result<(String, QueryHandoff), String> {
    let (binding, profile, snapshot, _, file) = indexed_file(&state, &input.file).await?;
    let statement = find_statement(&input, &file)?;
    if !statement.open_query {
        return Err(
            "This statement cannot be opened as a read-only query in this database.".into(),
        );
    }
    let runtime = runtime(input.file.project.source_id).await;
    let sql = read_checked(&binding, &input.file.path, &file, &runtime).await?;
    Ok((
        sql[statement.start..statement.end].to_owned(),
        QueryHandoff {
            source_id: profile.id,
            binding_id: binding.id,
            database: profile.database.clone(),
            connection: binding.connection,
            profile_revision: profile.updated_at,
            snapshot_id: snapshot.id,
            path: input.file.path,
            statement_digest: statement.digest.clone(),
        },
    ))
}

pub(crate) async fn validate_query_handoff(
    state: &AppState,
    profile: &DataSourceProfile,
    handoff: &QueryHandoff,
    sql: &str,
) -> Result<(), String> {
    if profile.id != handoff.source_id
        || profile.updated_at != handoff.profile_revision
        || profile.database != handoff.database
        || connection_identity(profile) != handoff.connection
    {
        return Err(CHANGED.into());
    }
    let (binding, current, snapshot) = live_project(
        state,
        &ProjectScope {
            source_id: profile.id,
            binding_id: handoff.binding_id,
        },
    )
    .await?;
    if binding.connection != handoff.connection
        || current.updated_at != profile.updated_at
        || snapshot.id != handoff.snapshot_id
    {
        return Err(CHANGED.into());
    }
    if sql.len() as u64 > files::MAX_FILE_BYTES {
        return Err("The query exceeds the project SQL size limit.".into());
    }
    let (statements, diagnostic) = analyze(sql, &snapshot);
    if diagnostic.is_some() || !matches!(statements.as_slice(), [statement] if statement.open_query)
    {
        return Err("This query no longer matches the project database context.".into());
    }
    Ok(())
}

impl QueryHandoff {
    pub(crate) fn database(&self) -> &str {
        &self.database
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveProjectSql {
    #[serde(flatten)]
    project: ProjectScope,
    path: String,
    sql: String,
    generated_from: Option<LinkedDefinition>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveProjectReceipt {
    association_saved: Option<bool>,
}

#[tauri::command]
pub(super) async fn save_code_view_sql(
    input: SaveProjectSql,
    state: State<'_, AppState>,
) -> Result<SaveProjectReceipt, String> {
    let runtime = runtime(input.project.source_id).await;
    let _mutation = runtime.mutation.lock().await;
    let (binding, _, snapshot) = live_project(&state, &input.project).await?;
    if input.sql.trim().is_empty() {
        return Err("Enter SQL before saving a project file.".into());
    }
    let binding_id = binding.id;
    let path = input.path;
    let snapshot_id = snapshot.id;
    let (path, sql, git) = tokio::task::spawn_blocking(move || {
        let project = open_repository(&binding)?;
        project
            .write(&path, &binding.directories, &input.sql)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => "A project file already uses that name.",
                _ => "Unable to create a new SQL file in the selected project directory.",
            })?;
        Ok::<_, String>((path, input.sql, project.git_version()))
    })
    .await
    .map_err(|_| "Unable to save the project SQL file.")??;
    let association_saved = if let Some(definition) = input.generated_from {
        Some(
            persist_generated_link(&state, binding_id, &snapshot, &path, &sql, definition)
                .await
                .is_ok(),
        )
    } else {
        None
    };
    let (statements, diagnostic) = analyze(&sql, &snapshot);
    let file = IndexedFile {
        digest: digest(sql),
        statements,
        diagnostic,
    };
    let mut index = runtime.index.lock().await;
    let version = Uuid::new_v4();
    let mut scan = index
        .scan
        .as_ref()
        .filter(|scan| scan.binding_id == binding_id && scan.snapshot_id == snapshot_id)
        .map_or_else(
            || Scan {
                binding_id,
                version,
                generation: version,
                snapshot_id,
                git,
                at: Utc::now(),
                files: BTreeMap::new(),
                skipped: 0,
                partial_update: true,
                read_errors: BTreeSet::new(),
            },
            |scan| (**scan).clone(),
        );
    scan.files.insert(path, file);
    scan.version = version;
    index.scan = Some(Arc::new(scan));
    // A full scan started before the write could have observed either side.
    if let Some((_, job)) = index.job.take() {
        job.cancel();
    }
    Ok(SaveProjectReceipt { association_saved })
}

async fn persist_generated_link(
    state: &AppState,
    binding_id: Uuid,
    snapshot: &DatabaseSnapshot,
    path: &str,
    sql: &str,
    definition: LinkedDefinition,
) -> Result<(), String> {
    let draft = state
        .store
        .draft_ontology_last_month(&DraftOntologyInput {
            scope: OntologyScope {
                source_id: snapshot.source_id,
                snapshot_id: snapshot.id,
            },
            target: DefinitionRevision {
                id: definition.id,
                revision: definition.revision,
            },
        })
        .await
        .map_err(safe_store_error)?;
    if draft.sql != sql {
        return Err("The file no longer matches this ontology draft.".into());
    }
    let (statements, diagnostic) = analyze(sql, snapshot);
    let [statement] = statements.as_slice() else {
        return Err("The file does not contain a single supported ontology statement.".into());
    };
    if diagnostic.is_some() {
        return Err("The SQL file cannot be verified.".into());
    }
    let link = ManualLink {
        binding_id,
        path: path.to_owned(),
        statement_digest: statement.digest.clone(),
        file_digest: digest(sql),
        start: statement.start,
        snapshot_fingerprint: snapshot.fingerprint.clone(),
        object: None,
        definition: Some(definition),
        generated: true,
    };
    if !persist_link(state, snapshot.source_id, &link).await? {
        return Err(CHANGED.into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RetryCodeAssociation {
    #[serde(flatten)]
    project: ProjectScope,
    path: String,
    generated_from: LinkedDefinition,
}

#[tauri::command]
pub(super) async fn retry_code_view_association(
    input: RetryCodeAssociation,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = runtime(input.project.source_id).await;
    let _mutation = runtime.mutation.lock().await;
    let (binding, _, snapshot) = live_project(&state, &input.project).await?;
    let binding_id = binding.id;
    let path = input.path.clone();
    let sql = tokio::task::spawn_blocking(move || {
        open_repository(&binding)?
            .read(&path, &binding.directories)
            .map_err(|_| "The project SQL file could not be read.".to_owned())
    })
    .await
    .map_err(|_| "The project SQL file could not be read.")??;
    persist_generated_link(
        &state,
        binding_id,
        &snapshot,
        &input.path,
        &sql,
        input.generated_from,
    )
    .await
}

async fn persist_link(
    state: &AppState,
    source_id: Uuid,
    link: &ManualLink,
) -> Result<bool, String> {
    let payload =
        serde_json::to_string(link).map_err(|_| "Unable to serialize the code association.")?;
    let identity = serde_json::to_vec(&(
        &link.binding_id,
        &link.path,
        &link.statement_digest,
        link.start,
        &link.object,
        &link.definition,
        link.generated,
    ))
    .map_err(|_| "Unable to identify the code association.")?;
    state
        .store
        .save_code_view_link(source_id, link.binding_id, &digest(identity), &payload)
        .await
        .map_err(safe_store_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfirmCodeLink {
    selection: StatementSelection,
    object: Option<ObjectKey>,
    definition: Option<LinkedDefinition>,
}

#[tauri::command]
pub(super) async fn confirm_code_view_link(
    input: ConfirmCodeLink,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = runtime(input.selection.file.project.source_id).await;
    let _mutation = runtime.mutation.lock().await;
    let (binding, _, snapshot, scan, file) = indexed_file(&state, &input.selection.file).await?;
    let statement = find_statement(&input.selection, &file)?;
    if input.object.is_some() == input.definition.is_some() {
        return Err("Choose a data object or ontology definition.".into());
    }
    if input
        .object
        .as_ref()
        .is_some_and(|key| !object_exists(&snapshot, key))
    {
        return Err(CHANGED.into());
    }
    if let Some(target) = &input.definition
        && !definitions(&state, &snapshot)
            .await?
            .iter()
            .any(|definition| {
                definition.id == target.id
                    && definition.revision == target.revision
                    && definition.impacts.is_empty()
                    && definition.source_change_id.is_none()
            })
    {
        return Err("The ontology definition needs review.".into());
    }
    read_checked(&binding, &input.selection.file.path, &file, &runtime).await?;
    let index = runtime.index.lock().await;
    if index.stale
        || index
            .scan
            .as_ref()
            .is_none_or(|current| current.version != scan.version)
    {
        return Err(CHANGED.into());
    }
    let link = ManualLink {
        binding_id: binding.id,
        path: input.selection.file.path,
        statement_digest: statement.digest.clone(),
        file_digest: file.digest.clone(),
        start: statement.start,
        snapshot_fingerprint: snapshot.fingerprint,
        object: input.object,
        definition: input.definition,
        generated: false,
    };
    if !persist_link(&state, snapshot.source_id, &link).await? {
        return Err(CHANGED.into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservedChange {
    #[serde(flatten)]
    change: analysis::Change,
    before_observed: Option<bool>,
    after_observed: Option<bool>,
}

impl ObservedChange {
    fn in_snapshot(change: &analysis::Change, snapshot: &DatabaseSnapshot) -> Self {
        let observed =
            |column: &str| object_exists(snapshot, &change.table.child(ObjectKind::Column, column));
        Self {
            before_observed: change.before.as_deref().map(observed),
            after_observed: if change.action == "createTable" {
                Some(object_exists(snapshot, &change.table))
            } else {
                change.after.as_deref().map(observed)
            },
            change: change.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MigrationImpact {
    baseline_id: Option<Uuid>,
    baseline_at: Option<DateTime<Utc>>,
    linked_baseline_id: Option<Uuid>,
    linked_baseline_at: Option<DateTime<Utc>>,
    current_at: DateTime<Utc>,
    scan_at: DateTime<Utc>,
    missing_baseline: bool,
    partial: bool,
    changes: Vec<ObservedChange>,
    files: Vec<FileSummary>,
    ontology: Vec<OntologyReference>,
}

fn impacted_objects(
    statement: &StatementAnalysis,
    baseline: &DatabaseSnapshot,
) -> (BTreeSet<ObjectKey>, bool) {
    let mut impacted = BTreeSet::new();
    let mut missing = false;
    for change in &statement.changes {
        if let Some(old) = &change.before {
            let key = change.table.child(ObjectKind::Column, old);
            if object_exists(baseline, &key) {
                impacted.insert(key);
            } else {
                missing = true;
            }
        } else if change.action == "add" && object_exists(baseline, &change.table) {
            impacted.insert(change.table.clone());
        }
    }
    (impacted, missing)
}

async fn compare_baseline(
    state: &AppState,
    current: &DatabaseSnapshot,
    id: Uuid,
) -> Result<Option<DatabaseSnapshot>, String> {
    Ok(state
        .store
        .get_snapshot(id)
        .await
        .map_err(safe_store_error)?
        .filter(|baseline| {
            baseline.source_id == current.source_id
                && baseline.database.name == current.database.name
                && baseline.database.database_type == current.database.database_type
                && baseline.captured_at <= current.captured_at
        }))
}

async fn linked_migration_baseline(
    state: &AppState,
    current: &DatabaseSnapshot,
    path: &str,
    git: &GitVersion,
) -> Result<Option<DatabaseSnapshot>, String> {
    let (provenance, changes) = tokio::try_join!(
        state.store.list_change_provenance(current.source_id),
        state.store.change_sets_for_snapshot(current.id),
    )
    .map_err(safe_store_error)?;
    let baselines: BTreeSet<_> = provenance
        .iter()
        .filter(|entry| {
            entry.migration_files.iter().any(|file| file == path)
                && entry
                    .commit_sha
                    .as_ref()
                    .is_none_or(|sha| git.commit.as_ref() == Some(sha))
                && entry
                    .branch
                    .as_ref()
                    .is_none_or(|branch| git.branch.as_ref() == Some(branch))
        })
        .filter_map(|entry| {
            changes
                .iter()
                .find(|change| change.id == entry.change_set_id)
        })
        .map(|change| change.before_snapshot_id)
        .collect();
    if baselines.len() == 1
        && let Some(id) = baselines.first()
    {
        return compare_baseline(state, current, *id).await;
    }
    Ok(None)
}

#[tauri::command]
pub(super) async fn code_view_migration_impact(
    input: StatementSelection,
    baseline_id: Option<Uuid>,
    state: State<'_, AppState>,
) -> Result<MigrationImpact, String> {
    let (binding, _, current, scan, file) = indexed_file(&state, &input.file).await?;
    let statement = find_statement(&input, &file)?.clone();
    let runtime = runtime(current.source_id).await;
    read_checked(&binding, &input.file.path, &file, &runtime).await?;
    if statement.kind != "migration" {
        return Err("Choose a supported migration statement.".into());
    }
    let linked = linked_migration_baseline(&state, &current, &input.file.path, &scan.git).await?;
    let baseline = if let Some(id) = baseline_id {
        compare_baseline(&state, &current, id).await?
    } else {
        Some(current.clone())
    };
    let mut result = MigrationImpact {
        baseline_id: baseline.as_ref().map(|baseline| baseline.id),
        baseline_at: baseline.as_ref().map(|baseline| baseline.captured_at),
        linked_baseline_id: linked.as_ref().map(|baseline| baseline.id),
        linked_baseline_at: linked.as_ref().map(|baseline| baseline.captured_at),
        current_at: current.captured_at,
        scan_at: scan.at,
        missing_baseline: baseline.is_none(),
        partial: scan.partial_update || scan.skipped > 0 || !statement.diagnostics.is_empty(),
        changes: statement
            .changes
            .iter()
            .map(|change| ObservedChange::in_snapshot(change, &current))
            .collect(),
        files: Vec::new(),
        ontology: Vec::new(),
    };
    let Some(baseline) = baseline else {
        return Ok(result);
    };
    let (impacted, missing) = impacted_objects(&statement, &baseline);
    result.missing_baseline = missing;
    result.ontology = definitions(&state, &current)
        .await?
        .iter()
        .filter(|definition| !definition_objects(&definition.definition).is_disjoint(&impacted))
        .map(|definition| reference(definition, "field", false))
        .collect();
    let binding = binding.clone();
    let path = input.file.path;
    let (matches, partial) = tokio::task::spawn_blocking(move || {
        let project = open_repository(&binding)?;
        let mut files = Vec::new();
        let mut partial = false;
        for (name, indexed) in &scan.files {
            if *name == path {
                continue;
            }
            let Ok(contents) = project.read(name, &binding.directories) else {
                partial = true;
                continue;
            };
            if digest(&contents) != indexed.digest {
                partial = true;
                continue;
            }
            let (statements, diagnostic) = analyze(&contents, &baseline);
            partial |= diagnostic.is_some()
                || statements
                    .iter()
                    .any(|statement| !statement.diagnostics.is_empty());
            let matches: Vec<_> = statements
                .iter()
                .filter(|statement| {
                    statement.kind == "query" && !statement.references.is_disjoint(&impacted)
                })
                .map(|statement| indexed_match(statement, "static", false))
                .collect();
            if !matches.is_empty() {
                if files.len() >= MAX_LINKS_PER_PAGE {
                    partial = true;
                    break;
                }
                files.push(FileSummary {
                    path: name.clone(),
                    diagnostic,
                    matches,
                });
            }
        }
        Ok::<_, String>((files, partial))
    })
    .await
    .map_err(|_| "Unable to compare migration evidence.")??;
    result.partial |= partial;
    result.files = matches;
    Ok(result)
}
