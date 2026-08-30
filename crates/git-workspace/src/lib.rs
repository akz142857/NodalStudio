//! Deterministic, split-file Git workspaces for collaborative schema semantics.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use extension_model::{ChangeProvenance, CodeLineageLink};
use schema_model::{
    DatabaseSnapshot, LogicalRelationship, ObjectKey, ObjectKind, RelationshipCardinality,
    RelationshipEndpoint,
};
use semantic_model::{DomainGroup, ObjectAnnotation, SavedView};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const FORMAT_VERSION: u16 = 1;
const WORKSPACE_DIRECTORY: &str = ".nodalstudio";
const LEGACY_WORKSPACE_DIRECTORY: &str = ".sqlaieditor";

#[derive(Debug, Error)]
pub enum GitWorkspaceError {
    #[error("Git workspace path must be an existing directory")]
    InvalidRoot,
    #[error("workspace file path is unsafe: {0}")]
    UnsafePath(String),
    #[error("workspace I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("workspace JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("semantic documents refer to different objects")]
    ObjectMismatch,
    #[error("logical relationship document is invalid")]
    InvalidRelationship,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceManifest {
    pub format_version: u16,
    pub database_name: String,
    pub database_type: schema_model::DatabaseType,
    pub database_version: String,
    pub schema_fingerprint: String,
    pub managed_files: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticValue {
    pub description: Option<String>,
    pub tags: BTreeSet<String>,
    pub owner: Option<String>,
    pub is_core: bool,
}

impl From<&ObjectAnnotation> for SemanticValue {
    fn from(annotation: &ObjectAnnotation) -> Self {
        Self {
            description: annotation.description.clone(),
            tags: annotation.tags.iter().cloned().collect(),
            owner: annotation.owner.clone(),
            is_core: annotation.is_core,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticDocument {
    pub object: ObjectKey,
    #[serde(flatten)]
    pub value: SemanticValue,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub members: BTreeMap<String, SemanticValue>,
}

impl SemanticDocument {
    fn empty(object: ObjectKey) -> Self {
        Self {
            object,
            value: SemanticValue::default(),
            members: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainDocument {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub tables: Vec<ObjectKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDocument {
    pub id: Uuid,
    pub name: String,
    pub roots: Vec<ObjectKey>,
    pub relationship_depth: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceDocument {
    pub change_set_id: Uuid,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub pull_request_url: Option<String>,
    pub migration_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipDocument {
    pub version: u16,
    pub name: String,
    pub from: RelationshipEndpoint,
    pub to: RelationshipEndpoint,
    pub cardinality: RelationshipCardinality,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceFiles {
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedWorkspace {
    pub manifest: GitWorkspaceManifest,
    pub semantics: Vec<SemanticDocument>,
    pub domain_groups: Vec<DomainDocument>,
    pub saved_views: Vec<ViewDocument>,
    pub provenance: Vec<ProvenanceDocument>,
    pub lineage: Vec<CodeLineageLink>,
    pub relationships: Vec<RelationshipDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReceipt {
    pub workspace_path: PathBuf,
    pub written_files: usize,
    pub removed_stale_files: usize,
    pub schema_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePreview {
    pub added_files: usize,
    pub modified_files: usize,
    pub unchanged_files: usize,
    pub removed_files: usize,
    pub schema_fingerprint: String,
}

pub struct WorkspaceInput<'a> {
    pub snapshot: &'a DatabaseSnapshot,
    pub annotations: &'a [ObjectAnnotation],
    pub domain_groups: &'a [DomainGroup],
    pub saved_views: &'a [SavedView],
    pub provenance: &'a [ChangeProvenance],
    pub lineage: &'a [CodeLineageLink],
    pub relationships: &'a [LogicalRelationship],
}

/// Renders a deterministic whitelist of Git-friendly files.
///
/// Capture timestamps, local source IDs, layouts, credentials, row data, and
/// snapshot bodies are deliberately absent.
///
/// # Errors
///
/// Returns an error if a rendered document cannot be serialized.
pub fn render_workspace(input: &WorkspaceInput<'_>) -> Result<WorkspaceFiles, GitWorkspaceError> {
    let mut files = BTreeMap::new();
    render_semantics(&mut files, input.annotations)?;
    render_domains(&mut files, input.domain_groups)?;
    render_views(&mut files, input.saved_views)?;
    render_provenance(&mut files, input.provenance)?;
    render_lineage(&mut files, input.lineage)?;
    render_relationships(&mut files, input.relationships)?;
    files.insert(".gitignore".into(), gitignore_content().into());
    files.insert(".gitattributes".into(), gitattributes_content().into());
    files.insert("README.md".into(), readme_content().into());

    let mut managed_files: Vec<_> = files.keys().cloned().collect();
    managed_files.push("project.json".into());
    managed_files.sort();
    let manifest = GitWorkspaceManifest {
        format_version: FORMAT_VERSION,
        database_name: input.snapshot.database.name.clone(),
        database_type: input.snapshot.database.database_type,
        database_version: input.snapshot.database.version.clone(),
        schema_fingerprint: input.snapshot.fingerprint.clone(),
        managed_files,
    };
    files.insert("project.json".into(), pretty_json(&manifest)?);
    Ok(WorkspaceFiles { files })
}

/// Writes only managed files below `<repository>/.nodalstudio` and removes
/// files listed by the previous manifest that are no longer rendered.
///
/// # Errors
///
/// Returns an error for invalid roots, unsafe manifest paths, or failed I/O.
pub fn write_workspace(
    repository_root: &Path,
    workspace: &WorkspaceFiles,
) -> Result<ExportReceipt, GitWorkspaceError> {
    if !repository_root.is_absolute() || !repository_root.is_dir() {
        return Err(GitWorkspaceError::InvalidRoot);
    }
    let root = repository_root.join(WORKSPACE_DIRECTORY);
    let legacy_root = repository_root.join(LEGACY_WORKSPACE_DIRECTORY);
    if !root.exists() && legacy_root.is_dir() {
        fs::rename(&legacy_root, &root)?;
    }
    fs::create_dir_all(&root)?;
    let previous = read_previous_manifest(&root)?;
    let current: BTreeSet<_> = workspace.files.keys().cloned().collect();
    let mut removed_stale_files = 0;
    if let Some(previous) = previous {
        for relative in previous.managed_files {
            if current.contains(&relative) || relative == "project.json" {
                continue;
            }
            let path = safe_join(&root, &relative)?;
            if path.is_file() {
                fs::remove_file(path)?;
                removed_stale_files += 1;
            }
        }
    }
    for (relative, contents) in &workspace.files {
        let path = safe_join(&root, relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, contents)?;
    }
    let manifest: GitWorkspaceManifest = serde_json::from_str(
        workspace
            .files
            .get("project.json")
            .ok_or_else(|| GitWorkspaceError::UnsafePath("missing project.json".into()))?,
    )?;
    Ok(ExportReceipt {
        workspace_path: root,
        written_files: workspace.files.len(),
        removed_stale_files,
        schema_fingerprint: manifest.schema_fingerprint,
    })
}

/// Compares the deterministic workspace with files currently on disk without
/// changing the repository.
///
/// # Errors
///
/// Returns an error for invalid roots, unsafe previous manifests, or I/O errors.
pub fn preview_workspace(
    repository_root: &Path,
    workspace: &WorkspaceFiles,
) -> Result<WorkspacePreview, GitWorkspaceError> {
    if !repository_root.is_absolute() || !repository_root.is_dir() {
        return Err(GitWorkspaceError::InvalidRoot);
    }
    let root = workspace_root_for_read(repository_root);
    let previous = read_previous_manifest(&root)?;
    let current: BTreeSet<_> = workspace.files.keys().cloned().collect();
    let mut added_files = 0;
    let mut modified_files = 0;
    let mut unchanged_files = 0;
    for (relative, expected) in &workspace.files {
        let path = safe_join(&root, relative)?;
        match fs::read_to_string(path) {
            Ok(actual) if actual == *expected => unchanged_files += 1,
            Ok(_) => modified_files += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => added_files += 1,
            Err(error) => return Err(error.into()),
        }
    }
    let mut removed_files = 0;
    if let Some(previous) = previous {
        for relative in previous.managed_files {
            if current.contains(&relative) || relative == "project.json" {
                continue;
            }
            if safe_join(&root, &relative)?.is_file() {
                removed_files += 1;
            }
        }
    }
    let manifest: GitWorkspaceManifest = serde_json::from_str(
        workspace
            .files
            .get("project.json")
            .ok_or_else(|| GitWorkspaceError::UnsafePath("missing project.json".into()))?,
    )?;
    Ok(WorkspacePreview {
        added_files,
        modified_files,
        unchanged_files,
        removed_files,
        schema_fingerprint: manifest.schema_fingerprint,
    })
}

/// Reads only files declared by a Git workspace manifest and recognized by the
/// current format. Local caches, layouts, snapshots, and arbitrary files are ignored.
///
/// # Errors
///
/// Returns an error for invalid roots, unsafe manifest paths, missing manifests,
/// or malformed managed JSON.
pub fn read_workspace(repository_root: &Path) -> Result<ImportedWorkspace, GitWorkspaceError> {
    if !repository_root.is_absolute() || !repository_root.is_dir() {
        return Err(GitWorkspaceError::InvalidRoot);
    }
    let root = workspace_root_for_read(repository_root);
    let manifest = read_previous_manifest(&root)?.ok_or(GitWorkspaceError::InvalidRoot)?;
    let mut semantics = Vec::new();
    let mut domain_groups = Vec::new();
    let mut saved_views = Vec::new();
    let mut provenance = Vec::new();
    let mut lineage = Vec::new();
    let mut relationships = Vec::new();
    for relative in &manifest.managed_files {
        let path = safe_join(&root, relative)?;
        if !path.is_file() {
            continue;
        }
        let contents = fs::read_to_string(path)?;
        let is_json = Path::new(relative)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
        if relative.starts_with("semantics/") && is_json {
            semantics.push(serde_json::from_str(&contents)?);
        } else if relative.starts_with("domains/") && is_json {
            domain_groups.push(serde_json::from_str(&contents)?);
        } else if relative.starts_with("views/") && is_json {
            saved_views.push(serde_json::from_str(&contents)?);
        } else if relative.starts_with("provenance/") && is_json {
            provenance.push(serde_json::from_str(&contents)?);
        } else if relative.starts_with("lineage/") && is_json {
            let mut links: Vec<CodeLineageLink> = serde_json::from_str(&contents)?;
            lineage.append(&mut links);
        } else if relative.starts_with("relationships/") && is_json {
            if contents.len() > 64 * 1024 {
                return Err(GitWorkspaceError::InvalidRelationship);
            }
            let document: RelationshipDocument = serde_json::from_str(&contents)?;
            if !valid_relationship_document(&document) {
                return Err(GitWorkspaceError::InvalidRelationship);
            }
            relationships.push(document);
        }
    }
    Ok(ImportedWorkspace {
        manifest,
        semantics,
        domain_groups,
        saved_views,
        provenance,
        lineage,
        relationships,
    })
}

fn valid_relationship_document(document: &RelationshipDocument) -> bool {
    let endpoint_valid = |endpoint: &RelationshipEndpoint| {
        !endpoint.schema.trim().is_empty()
            && !endpoint.table.trim().is_empty()
            && !endpoint.columns.is_empty()
            && endpoint.schema.len() <= 128
            && endpoint.table.len() <= 128
            && endpoint
                .columns
                .iter()
                .all(|column| !column.trim().is_empty() && column.len() <= 128)
    };
    document.version == FORMAT_VERSION
        && !document.name.trim().is_empty()
        && document.name.len() <= 160
        && document
            .note
            .as_ref()
            .is_none_or(|note| note.len() <= 2_000)
        && endpoint_valid(&document.from)
        && endpoint_valid(&document.to)
        && document.from != document.to
        && document.from.columns.len() == document.to.columns.len()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub path: String,
    pub ours: serde_json::Value,
    pub theirs: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticMergeResult {
    pub document: SemanticDocument,
    pub conflicts: Vec<MergeConflict>,
}

/// Performs a field-aware three-way merge. Independent edits merge
/// automatically, tags use set union, and ambiguous edits produce a structured
/// conflict while preserving the local value in the result.
///
/// # Errors
///
/// Returns an error when the three documents do not describe the same object.
pub fn merge_semantic_documents(
    base: &SemanticDocument,
    ours: &SemanticDocument,
    theirs: &SemanticDocument,
) -> Result<SemanticMergeResult, GitWorkspaceError> {
    if base.object != ours.object || base.object != theirs.object {
        return Err(GitWorkspaceError::ObjectMismatch);
    }
    let mut conflicts = Vec::new();
    let value = merge_semantic_value(
        "object",
        &base.value,
        &ours.value,
        &theirs.value,
        &mut conflicts,
    );
    let keys: BTreeSet<_> = base
        .members
        .keys()
        .chain(ours.members.keys())
        .chain(theirs.members.keys())
        .cloned()
        .collect();
    let mut members = BTreeMap::new();
    for key in keys {
        if let Some(value) = merge_member(
            &format!("members.{key}"),
            base.members.get(&key),
            ours.members.get(&key),
            theirs.members.get(&key),
            &mut conflicts,
        ) {
            members.insert(key, value);
        }
    }
    Ok(SemanticMergeResult {
        document: SemanticDocument {
            object: base.object.clone(),
            value,
            members,
        },
        conflicts,
    })
}

fn render_semantics(
    files: &mut BTreeMap<String, String>,
    annotations: &[ObjectAnnotation],
) -> Result<(), GitWorkspaceError> {
    let mut documents: BTreeMap<ObjectKey, SemanticDocument> = BTreeMap::new();
    for annotation in annotations {
        let value = SemanticValue::from(annotation);
        if annotation.object_key.kind == ObjectKind::Column {
            if let Some((schema, table)) = annotation.object_key.schema.rsplit_once('.') {
                let parent = ObjectKey::table(schema, table);
                documents
                    .entry(parent.clone())
                    .or_insert_with(|| SemanticDocument::empty(parent))
                    .members
                    .insert(format!("column:{}", annotation.object_key.name), value);
            }
        } else {
            documents
                .entry(annotation.object_key.clone())
                .or_insert_with(|| SemanticDocument::empty(annotation.object_key.clone()))
                .value = value;
        }
    }
    for (key, document) in documents {
        files.insert(
            format!("semantics/{}.json", object_filename(&key)),
            pretty_json(&document)?,
        );
    }
    Ok(())
}

fn render_domains(
    files: &mut BTreeMap<String, String>,
    groups: &[DomainGroup],
) -> Result<(), GitWorkspaceError> {
    for group in groups {
        let mut tables = group.table_keys.clone();
        tables.sort();
        files.insert(
            format!("domains/{}.json", group.id),
            pretty_json(&DomainDocument {
                id: group.id,
                name: group.name.clone(),
                description: group.description.clone(),
                color: group.color.clone(),
                tables,
            })?,
        );
    }
    Ok(())
}

fn render_views(
    files: &mut BTreeMap<String, String>,
    views: &[SavedView],
) -> Result<(), GitWorkspaceError> {
    for view in views {
        let mut roots = view.root_table_keys.clone();
        roots.sort();
        files.insert(
            format!("views/{}.json", view.id),
            pretty_json(&ViewDocument {
                id: view.id,
                name: view.name.clone(),
                roots,
                relationship_depth: view.relationship_depth,
            })?,
        );
    }
    Ok(())
}

fn render_provenance(
    files: &mut BTreeMap<String, String>,
    provenance: &[ChangeProvenance],
) -> Result<(), GitWorkspaceError> {
    for item in provenance {
        let mut migrations = item.migration_files.clone();
        migrations.sort();
        migrations.dedup();
        files.insert(
            format!("provenance/{}.json", item.change_set_id),
            pretty_json(&ProvenanceDocument {
                change_set_id: item.change_set_id,
                branch: item.branch.clone(),
                commit_sha: item.commit_sha.clone(),
                pull_request_url: item.pull_request_url.clone(),
                migration_files: migrations,
            })?,
        );
    }
    Ok(())
}

fn render_lineage(
    files: &mut BTreeMap<String, String>,
    lineage: &[CodeLineageLink],
) -> Result<(), GitWorkspaceError> {
    let mut grouped: BTreeMap<ObjectKey, Vec<CodeLineageLink>> = BTreeMap::new();
    for link in lineage {
        grouped
            .entry(link.object_key.clone())
            .or_default()
            .push(link.clone());
    }
    for (key, mut links) in grouped {
        links.sort_by(|left, right| {
            left.file_path
                .cmp(&right.file_path)
                .then_with(|| left.symbol.cmp(&right.symbol))
        });
        files.insert(
            format!("lineage/{}.json", object_filename(&key)),
            pretty_json(&links)?,
        );
    }
    Ok(())
}

fn render_relationships(
    files: &mut BTreeMap<String, String>,
    relationships: &[LogicalRelationship],
) -> Result<(), GitWorkspaceError> {
    for relationship in relationships {
        if matches!(
            relationship.status,
            schema_model::LogicalRelationshipStatus::Disabled
                | schema_model::LogicalRelationshipStatus::Orphaned
                | schema_model::LogicalRelationshipStatus::SupersededByPhysical
        ) {
            continue;
        }
        let filename = relationship_filename(&relationship.source, &relationship.target);
        files.insert(
            format!("relationships/{filename}.json"),
            pretty_json(&RelationshipDocument {
                version: FORMAT_VERSION,
                name: relationship.name.clone(),
                from: relationship.source.clone(),
                to: relationship.target.clone(),
                cardinality: relationship.cardinality,
                note: relationship.note.clone(),
            })?,
        );
    }
    Ok(())
}

fn relationship_filename(source: &RelationshipEndpoint, target: &RelationshipEndpoint) -> String {
    fn safe(value: &str) -> String {
        value
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                    character
                } else {
                    '_'
                }
            })
            .collect()
    }
    safe(&format!(
        "{}.{}.{}--{}.{}.{}",
        source.schema,
        source.table,
        source.columns.join("_"),
        target.schema,
        target.table,
        target.columns.join("_")
    ))
}

fn merge_semantic_value(
    path: &str,
    base: &SemanticValue,
    ours: &SemanticValue,
    theirs: &SemanticValue,
    conflicts: &mut Vec<MergeConflict>,
) -> SemanticValue {
    SemanticValue {
        description: merge_scalar(
            &format!("{path}.description"),
            &base.description,
            &ours.description,
            &theirs.description,
            conflicts,
        ),
        tags: ours.tags.union(&theirs.tags).cloned().collect(),
        owner: merge_scalar(
            &format!("{path}.owner"),
            &base.owner,
            &ours.owner,
            &theirs.owner,
            conflicts,
        ),
        is_core: merge_scalar(
            &format!("{path}.isCore"),
            &base.is_core,
            &ours.is_core,
            &theirs.is_core,
            conflicts,
        ),
    }
}

fn merge_member(
    path: &str,
    base: Option<&SemanticValue>,
    ours: Option<&SemanticValue>,
    theirs: Option<&SemanticValue>,
    conflicts: &mut Vec<MergeConflict>,
) -> Option<SemanticValue> {
    match (base, ours, theirs) {
        (_, Some(ours), Some(theirs)) if ours == theirs => Some(ours.clone()),
        (Some(base), Some(ours), Some(theirs)) => {
            Some(merge_semantic_value(path, base, ours, theirs, conflicts))
        }
        (None, Some(ours), None) => Some(ours.clone()),
        (None, None, Some(theirs)) => Some(theirs.clone()),
        (Some(base), Some(ours), None) if ours == base => None,
        (Some(base), None, Some(theirs)) if theirs == base => None,
        (Some(_), Some(ours), None) => {
            record_conflict(path, ours, &serde_json::Value::Null, conflicts);
            Some(ours.clone())
        }
        (Some(_), None, Some(theirs)) => {
            record_conflict(path, &serde_json::Value::Null, theirs, conflicts);
            Some(theirs.clone())
        }
        (None, Some(ours), Some(theirs)) => Some(merge_semantic_value(
            path,
            &SemanticValue::default(),
            ours,
            theirs,
            conflicts,
        )),
        (Some(_) | None, None, None) => None,
    }
}

fn merge_scalar<T>(
    path: &str,
    base: &T,
    ours: &T,
    theirs: &T,
    conflicts: &mut Vec<MergeConflict>,
) -> T
where
    T: Clone + PartialEq + Serialize,
{
    if ours == theirs || theirs == base {
        return ours.clone();
    }
    if ours == base {
        return theirs.clone();
    }
    record_conflict(path, ours, theirs, conflicts);
    ours.clone()
}

fn record_conflict(
    path: &str,
    ours: &impl Serialize,
    theirs: &impl Serialize,
    conflicts: &mut Vec<MergeConflict>,
) {
    // A conflict report is what a human reads to resolve the merge, so a value
    // that failed to serialise must not land as null — indistinguishable from a
    // field that genuinely is null. The semantic types cannot fail to serialise
    // today; this keeps that from becoming silent if they ever do.
    fn describe(value: &impl Serialize) -> serde_json::Value {
        serde_json::to_value(value)
            .unwrap_or_else(|error| serde_json::json!({ "serializationError": error.to_string() }))
    }
    conflicts.push(MergeConflict {
        path: path.into(),
        ours: describe(ours),
        theirs: describe(theirs),
    });
}

fn workspace_root_for_read(repository_root: &Path) -> PathBuf {
    let root = repository_root.join(WORKSPACE_DIRECTORY);
    if root.is_dir() {
        root
    } else {
        repository_root.join(LEGACY_WORKSPACE_DIRECTORY)
    }
}

fn read_previous_manifest(root: &Path) -> Result<Option<GitWorkspaceManifest>, GitWorkspaceError> {
    let path = root.join("project.json");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&fs::read_to_string(path)?)?))
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, GitWorkspaceError> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(GitWorkspaceError::UnsafePath(relative.into()));
    }
    Ok(root.join(relative_path))
}

fn object_filename(key: &ObjectKey) -> String {
    format!(
        "{}.{}.{}",
        kind_name(key.kind),
        safe_fragment(&key.schema),
        safe_fragment(&key.name)
    )
}

const fn kind_name(kind: ObjectKind) -> &'static str {
    match kind {
        ObjectKind::Schema => "schema",
        ObjectKind::Table => "table",
        ObjectKind::View => "view",
        ObjectKind::Enum => "enum",
        ObjectKind::Column => "column",
        ObjectKind::PrimaryKey => "primary-key",
        ObjectKind::ForeignKey => "foreign-key",
        ObjectKind::Index => "index",
        ObjectKind::Constraint => "constraint",
    }
}

fn safe_fragment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn pretty_json(value: &impl Serialize) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(value).map(|mut json| {
        json.push('\n');
        json
    })
}

const fn gitignore_content() -> &'static str {
    "# Machine-local and generated data\nlocal/\ncache/\nlayouts/\nsnapshots/\n*.nodalmodel\n"
}

const fn gitattributes_content() -> &'static str {
    "semantics/*.json merge=nodalstudio-semantic\n"
}

const fn readme_content() -> &'static str {
    "# Nodal Studio Git Workspace\n\nThis directory contains reviewable team semantics and model-only logical relationships. Schema snapshots, personal layouts, credentials, row data, and caches are intentionally excluded. Logical relationships do not create database constraints. The database schema remains derived from migrations and the live database.\n"
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use schema_model::{DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition};

    use super::*;

    fn snapshot() -> DatabaseSnapshot {
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![TableDefinition::empty("public", "users")],
                views: vec![],
                enums: vec![],
            }],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }

    fn annotation(key: ObjectKey, description: &str) -> ObjectAnnotation {
        ObjectAnnotation {
            source_id: Uuid::new_v4(),
            object_key: key,
            description: Some(description.into()),
            tags: vec!["identity".into()],
            owner: None,
            is_core: false,
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn renders_split_deterministic_files_without_local_state() {
        let snapshot = snapshot();
        let annotations = vec![
            annotation(ObjectKey::table("public", "users"), "Accounts"),
            annotation(
                ObjectKey::table("public", "users").child(ObjectKind::Column, "email"),
                "Login address",
            ),
        ];
        let input = WorkspaceInput {
            snapshot: &snapshot,
            annotations: &annotations,
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: &[],
        };
        let first = render_workspace(&input).unwrap();
        let second = render_workspace(&input).unwrap();

        assert_eq!(first, second);
        let semantic = first
            .files
            .get("semantics/table.public.users.json")
            .unwrap();
        assert!(semantic.contains("column:email"));
        assert!(!semantic.contains("sourceId"));
        assert!(!semantic.contains("updatedAt"));
        assert!(!first.files.keys().any(|path| path.starts_with("layouts/")));
        assert!(
            !first
                .files
                .keys()
                .any(|path| path.starts_with("snapshots/"))
        );
    }

    #[test]
    fn exports_and_reads_one_file_per_logical_relationship() {
        let snapshot = snapshot();
        let now = Utc::now();
        let relationship = LogicalRelationship {
            id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            name: "orders_owner".into(),
            source: RelationshipEndpoint::new("public", "orders", vec!["user_id".into()]),
            target: RelationshipEndpoint::new("public", "users", vec!["id".into()]),
            cardinality: RelationshipCardinality::ManyToOne,
            status: schema_model::LogicalRelationshipStatus::Active,
            origin: schema_model::LogicalRelationshipOrigin::Manual,
            note: Some("Order owner".into()),
            evidence: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        let rendered = render_workspace(&WorkspaceInput {
            snapshot: &snapshot,
            annotations: &[],
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: std::slice::from_ref(&relationship),
        })
        .unwrap();
        let path = "relationships/public.orders.user_id--public.users.id.json";
        assert!(rendered.files.contains_key(path));
        assert!(!rendered.files[path].contains(&relationship.id.to_string()));
        assert!(!rendered.files[path].contains("createdAt"));

        let root = std::env::temp_dir().join(format!("nodalstudio-relations-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        write_workspace(&root, &rendered).unwrap();
        let imported = read_workspace(&root).unwrap();
        assert_eq!(imported.relationships.len(), 1);
        assert_eq!(imported.relationships[0].name, "orders_owner");
        std::fs::write(
            root.join(".nodalstudio").join(path),
            "{\"version\":2,\"name\":\"unsupported\",\"from\":{},\"to\":{}}",
        )
        .unwrap();
        assert!(matches!(
            read_workspace(&root),
            Err(GitWorkspaceError::InvalidRelationship | GitWorkspaceError::Json(_))
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merges_independent_members_and_unions_tags() {
        let object = ObjectKey::table("public", "users");
        let mut base = SemanticDocument::empty(object);
        base.value.tags.insert("identity".into());
        let mut ours = base.clone();
        ours.value.tags.insert("core".into());
        ours.members.insert(
            "column:email".into(),
            SemanticValue {
                description: Some("Login address".into()),
                ..SemanticValue::default()
            },
        );
        let mut theirs = base.clone();
        theirs.members.insert(
            "column:status".into(),
            SemanticValue {
                description: Some("Lifecycle state".into()),
                ..SemanticValue::default()
            },
        );

        let result = merge_semantic_documents(&base, &ours, &theirs).unwrap();

        assert!(result.conflicts.is_empty());
        assert_eq!(result.document.members.len(), 2);
        assert_eq!(
            result.document.value.tags,
            BTreeSet::from(["core".into(), "identity".into()])
        );
    }

    #[test]
    fn reports_ambiguous_same_field_edits() {
        let object = ObjectKey::table("public", "users");
        let base = SemanticDocument::empty(object);
        let mut ours = base.clone();
        ours.value.description = Some("User accounts".into());
        let mut theirs = base.clone();
        theirs.value.description = Some("Customer identities".into());

        let result = merge_semantic_documents(&base, &ours, &theirs).unwrap();

        assert_eq!(result.document.value.description, ours.value.description);
        assert_eq!(result.conflicts[0].path, "object.description");
        // The report is what a human reads to resolve the merge, so it has to
        // carry both sides rather than just naming the field.
        assert_eq!(result.conflicts[0].ours, serde_json::json!("User accounts"));
        assert_eq!(
            result.conflicts[0].theirs,
            serde_json::json!("Customer identities")
        );
    }

    #[test]
    fn removes_only_files_managed_by_the_previous_manifest() {
        let snapshot = snapshot();
        let repository =
            std::env::temp_dir().join(format!("nodalstudio-git-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&repository).unwrap();
        let annotations = vec![annotation(ObjectKey::table("public", "users"), "Accounts")];
        let first = render_workspace(&WorkspaceInput {
            snapshot: &snapshot,
            annotations: &annotations,
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: &[],
        })
        .unwrap();
        write_workspace(&repository, &first).unwrap();
        let imported = read_workspace(&repository).unwrap();
        assert_eq!(imported.semantics.len(), 1);
        assert_eq!(imported.manifest.schema_fingerprint, snapshot.fingerprint);
        let unmanaged = repository.join(".nodalstudio/keep-me.txt");
        fs::write(&unmanaged, "user content").unwrap();

        let second = render_workspace(&WorkspaceInput {
            snapshot: &snapshot,
            annotations: &[],
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: &[],
        })
        .unwrap();
        let receipt = write_workspace(&repository, &second).unwrap();

        assert_eq!(receipt.removed_stale_files, 1);
        assert!(unmanaged.is_file());
        assert!(
            !repository
                .join(".nodalstudio/semantics/table.public.users.json")
                .exists()
        );
        fs::remove_dir_all(repository).unwrap();
    }

    #[test]
    fn reads_and_migrates_legacy_workspace_directory() {
        let snapshot = snapshot();
        let repository =
            std::env::temp_dir().join(format!("nodalstudio-legacy-workspace-{}", Uuid::new_v4()));
        let legacy_root = repository.join(LEGACY_WORKSPACE_DIRECTORY);
        fs::create_dir_all(&legacy_root).unwrap();
        let workspace = render_workspace(&WorkspaceInput {
            snapshot: &snapshot,
            annotations: &[],
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: &[],
        })
        .unwrap();
        for (relative, contents) in &workspace.files {
            let path = legacy_root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, contents).unwrap();
        }

        assert_eq!(
            read_workspace(&repository)
                .unwrap()
                .manifest
                .schema_fingerprint,
            snapshot.fingerprint
        );
        write_workspace(&repository, &workspace).unwrap();

        assert!(repository.join(WORKSPACE_DIRECTORY).is_dir());
        assert!(!legacy_root.exists());
        fs::remove_dir_all(repository).unwrap();
    }

    #[test]
    fn previews_workspace_changes_without_writing() {
        let snapshot = snapshot();
        let repository =
            std::env::temp_dir().join(format!("nodalstudio-git-preview-{}", Uuid::new_v4()));
        fs::create_dir_all(&repository).unwrap();
        let annotations = vec![annotation(ObjectKey::table("public", "users"), "Accounts")];
        let workspace = render_workspace(&WorkspaceInput {
            snapshot: &snapshot,
            annotations: &annotations,
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: &[],
        })
        .unwrap();

        let before = preview_workspace(&repository, &workspace).unwrap();
        assert_eq!(before.added_files, workspace.files.len());
        assert_eq!(before.modified_files, 0);
        assert!(!repository.join(".nodalstudio").exists());

        write_workspace(&repository, &workspace).unwrap();
        let after = preview_workspace(&repository, &workspace).unwrap();
        assert_eq!(after.unchanged_files, workspace.files.len());
        assert_eq!(
            after.added_files + after.modified_files + after.removed_files,
            0
        );
        fs::remove_dir_all(repository).unwrap();
    }
}
