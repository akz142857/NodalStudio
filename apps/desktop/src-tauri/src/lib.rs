#[cfg(all(feature = "mac-app-store", feature = "code-extensions"))]
compile_error!("Mac App Store builds support syntax data only and cannot enable code-extensions.");
#[cfg(all(not(target_os = "macos"), feature = "code-extensions"))]
compile_error!("The full Code extension host is supported only on macOS.");

mod schema_ddl;
mod sqlite_source;
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::Path,
    process::Command,
    sync::Arc,
    time::Duration,
};

use ai_context::{
    AiProvider, ContextPolicy, Explanation, OfflineSchemaProvider, SchemaContext, change_context,
    domain_context,
};
use chrono::Utc;
use extension_model::{
    ChangeProvenance, CodeLineageLink, DriftReport, EnvironmentSnapshot, EventTriggerPlan,
    compare_environments,
};
use git_workspace::{
    DomainDocument, ExportReceipt, ProvenanceDocument, SemanticDocument, SemanticValue,
    ViewDocument, WorkspaceFiles, WorkspaceInput, WorkspacePreview, preview_workspace,
    read_workspace, render_workspace, write_workspace,
};
use mysql_adapter::{
    MySqlConnectionOptions, inspect_schema as inspect_mysql_schema,
    test_connection as test_mysql_connection,
};
use postgres_adapter::{
    PostgresConnectionOptions, PostgresSslMode, inspect_schema, test_connection,
};
use query_engine::{ExecuteQueryRequest, QueryError, QueryExecutionResult, execute_postgres_query};
use schema_diff::{SchemaChangeSet, diff_snapshots};
use schema_model::{
    DataSourceProfile, DatabaseInfo, DatabaseSnapshot, DatabaseType, IgnoredRelationshipInference,
    LogicalRelationship, LogicalRelationshipOrigin, LogicalRelationshipStatus,
    RelationshipCardinality, RelationshipEndpoint, SslMode,
};
use semantic_model::{
    CanvasLayout, CanvasPosition, DomainGroup, ObjectAnnotation, SavedView, reattach_semantics,
};
use serde::{Deserialize, Serialize};
use settings_model::{
    AiProviderKind, AppSettings, ConflictStrategy, DataSourceSettings, EffectiveSettings,
    MergeDriverStatus, OrganizationPolicy, ProjectSettings, SecurityStatus, SettingsExportBundle,
    StorageUsage, apply_policy, apply_settings_layers,
};
use sha2::{Digest, Sha256};
use snapshot_store::{
    ExternalAccessRecord, LocalSnapshotStore, QueryHistoryEntry, SnapshotSummary, SourceDataImpact,
    SyncQueueItem,
};
use sqlx::{
    Row,
    mysql::MySqlSslMode,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tauri::{Manager, State};

mod ai_chat;
mod connection_credentials;
mod connection_diagnostics;
mod connection_tests;
use connection_diagnostics::ConnectionFailure;
mod connection_security;
mod connection_sessions;
use connection_sessions::{ConnectionSessions, DatabasePool};
mod connection_sync;
mod database_server;
mod file_access;
pub use connection_security::run_askpass_helper;
mod change_review;
mod code_view;
mod database_export;
#[cfg(target_os = "macos")]
mod desktop_menu;
mod diagram_export;
mod discovery;
mod export_file;
mod git_readiness;
mod github_releases;
mod knowledge;
mod ontology;
mod postgres_export;
mod purchase;
mod query_export;
mod relationship_batches;
mod schema_report;
#[cfg(not(mobile))]
mod startup_window;
mod storage_errors;
#[cfg(target_os = "macos")]
mod system_appearance;
mod table_ddl;
mod table_row_counts;
mod table_understanding;
mod updates;

#[tauri::command]
async fn save_schema_report(
    app: tauri::AppHandle,
    input: schema_report::SchemaReportExportInput,
) -> Result<schema_report::SchemaReportExportReceipt, String> {
    let directory = file_access::export_directory(&app).await?;
    tokio::task::spawn_blocking(move || schema_report::save(&input, &directory))
        .await
        .map_err(|_| "Unable to finish the schema report export.".to_owned())?
}

#[tauri::command]
async fn save_diagram_export(
    app: tauri::AppHandle,
    input: diagram_export::DiagramExportInput,
) -> Result<diagram_export::DiagramExportReceipt, String> {
    let directory = file_access::export_directory(&app).await?;
    tokio::task::spawn_blocking(move || diagram_export::save(&input, &directory))
        .await
        .map_err(|_| "Unable to finish the diagram export.".to_owned())?
}
// Raw IPC avoids millions of JSON number values for a single generated image.
#[tauri::command]
async fn save_diagram_export_binary(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<diagram_export::DiagramExportReceipt, String> {
    let input = diagram_export::from_binary(request.body(), request.headers())?;
    let directory = file_access::export_directory(&app).await?;
    tokio::task::spawn_blocking(move || diagram_export::save(&input, &directory))
        .await
        .map_err(|_| "Unable to finish the diagram export.".to_owned())?
}
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.claycosmos.nodalstudio.datasource";
const CLOUD_KEYRING_SERVICE: &str = "com.claycosmos.nodalstudio.cloud";
const CLOUD_REFRESH_KEYRING_SERVICE: &str = "com.claycosmos.nodalstudio.cloud.refresh";
const AI_KEYRING_SERVICE: &str = "com.claycosmos.nodalstudio.ai";
const RETIRED_MODEL_KEYRING_SERVICE: &str = "com.claycosmos.nodalstudio.model";

#[derive(Clone)]
struct AppState {
    store: LocalSnapshotStore,
    ai_limiter: Arc<Semaphore>,
    snapshot_captures: Arc<Mutex<HashMap<Uuid, Arc<Semaphore>>>>,
    cloud_operations: Arc<Mutex<HashMap<Uuid, Arc<Semaphore>>>>,
    active_queries: Arc<Mutex<HashMap<Uuid, (Uuid, CancellationToken)>>>,
    sessions: ConnectionSessions,
}

fn offline_watch_sender() -> &'static tokio::sync::watch::Sender<bool> {
    static WATCH: std::sync::OnceLock<tokio::sync::watch::Sender<bool>> =
        std::sync::OnceLock::new();
    WATCH.get_or_init(|| tokio::sync::watch::channel(false).0)
}

impl AppState {
    #[allow(clippy::unused_self)]
    pub(crate) fn notify_offline(&self, offline: bool) {
        let _ = offline_watch_sender().send_if_modified(|current| {
            if *current == offline {
                false
            } else {
                *current = offline;
                true
            }
        });
    }

    #[allow(clippy::unused_self)]
    pub(crate) fn subscribe_offline(&self) -> tokio::sync::watch::Receiver<bool> {
        offline_watch_sender().subscribe()
    }
}

async fn acquire_cloud_operation(
    state: &AppState,
    source_id: Uuid,
) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    let gate = {
        let mut operations = state.cloud_operations.lock().await;
        Arc::clone(
            operations
                .entry(source_id)
                .or_insert_with(|| Arc::new(Semaphore::new(1))),
        )
    };
    gate.acquire_owned()
        .await
        .map_err(|_| "The source metadata operation gate is unavailable.".to_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    local_eslint: bool,
    code_extensions: CodeExtensions,
    code_finder_actions: bool,
    distribution: &'static str,
    kind: &'static str,
    label: &'static str,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum CodeExtensions {
    Disabled,
    Syntax,
    Full,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticInfo {
    app_version: String,
    rust_version: &'static str,
    target: &'static str,
    data_directory: String,
    log_directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevealDirectoryInput {
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTestResult {
    database: DatabaseInfo,
    ssl_active: Option<bool>,
    server_read_only: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyAndRefreshResult {
    profile: DataSourceProfile,
    connection: ConnectionTestResult,
    capture: CaptureSnapshotResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDataSourceInput {
    #[serde(default)]
    sqlite: Option<schema_model::SqliteFile>,
    id: Option<Uuid>,
    display_name: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    #[serde(default)]
    ssh_password: Option<String>,
    #[serde(default)]
    ssh_key_passphrase: Option<String>,
    database_type: DatabaseType,
    ssl_mode: SslMode,
    #[serde(default)]
    security: schema_model::ConnectionSecurity,
}

impl SaveDataSourceInput {
    fn is_server_connection(&self) -> bool {
        matches!(
            self.database_type,
            DatabaseType::MySql | DatabaseType::PostgreSql
        ) && self.database.trim().is_empty()
    }

    fn ssh_secret(&self) -> Option<&str> {
        match self.security.ssh.as_ref()?.authentication {
            schema_model::SshAuthentication::Password => self.ssh_password.as_deref(),
            schema_model::SshAuthentication::PrivateKey => self.ssh_key_passphrase.as_deref(),
            schema_model::SshAuthentication::Agent => None,
        }
    }

    fn resolve_ssh_secret(&mut self) -> Result<(), String> {
        let secret =
            connection_credentials::resolve_ssh(self.id, &self.security, self.ssh_secret())?;
        if self
            .security
            .ssh
            .as_ref()
            .is_some_and(|ssh| ssh.authentication == schema_model::SshAuthentication::PrivateKey)
        {
            self.ssh_key_passphrase = secret;
        } else {
            self.ssh_password = secret;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSnapshotInput {
    source_id: Uuid,
    trigger: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteReadonlyQueryInput {
    query_id: Uuid,
    source_id: Uuid,
    sql: String,
    row_limit: u32,
    timeout_ms: u64,
    #[serde(default)]
    table_browse: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryIdInput {
    query_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryHistoryInput {
    source_id: Uuid,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteQueryHistoryInput {
    source_id: Uuid,
    history_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryCommandError {
    query_id: Uuid,
    kind: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInput {
    snapshot_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompareSnapshotsInput {
    before_snapshot_id: Uuid,
    after_snapshot_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompareEnvironmentsInput {
    from_snapshot_id: Uuid,
    from_environment: String,
    to_snapshot_id: Uuid,
    to_environment: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProvenanceInput {
    change_set_id: Uuid,
    branch: Option<String>,
    commit_sha: Option<String>,
    pull_request_url: Option<String>,
    migration_files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLineageInput {
    source_id: Uuid,
    links: Vec<CodeLineageLink>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportGitWorkspaceInput {
    source_id: Uuid,
    repository_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportGitWorkspaceResult {
    imported_annotations: usize,
    imported_domain_groups: usize,
    imported_saved_views: usize,
    imported_provenance: usize,
    imported_lineage_links: usize,
    imported_logical_relationships: usize,
    fingerprint_matches: bool,
    workspace_fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitImportPreview {
    annotations: usize,
    domain_groups: usize,
    saved_views: usize,
    provenance: usize,
    lineage_links: usize,
    logical_relationships: usize,
    relationship_conflicts: Vec<String>,
    fingerprint_matches: bool,
    workspace_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceInput {
    source_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSourceInput {
    source_id: Uuid,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInput {
    source_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretInput {
    source_id: Uuid,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearCredentialsInput {
    source_id: Uuid,
    database: bool,
    ai: bool,
    cloud: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFileInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictReportInput {
    repository_path: String,
    report_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFileReceipt {
    path: String,
    source_settings: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFilePreview {
    format_version: u16,
    exported_at: String,
    source_settings: usize,
    replaces_app_settings: bool,
    credentials_included: bool,
}

type PortableBackup = snapshot_store::PortableModelBackup;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupReceipt {
    path: String,
    snapshots: usize,
    annotations: usize,
    saved_views: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupPreview {
    format_version: u16,
    exported_at: String,
    source_id: Uuid,
    source_label: Option<String>,
    database_name: Option<String>,
    database_type: Option<DatabaseType>,
    snapshots: usize,
    annotations: usize,
    saved_views: usize,
    will_update_existing_source: bool,
    conflict_strategy: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileInput {
    source_id: Option<Uuid>,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSourceDataInput {
    source_id: Uuid,
    selection: DeleteSourceSelection,
    remove_database_credential: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSourceSelection {
    connection: bool,
    history: bool,
    semantics: bool,
}

#[derive(Deserialize)]
struct FactoryResetInput {
    confirmation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncDiagnostic {
    id: Uuid,
    event_kind: String,
    attempts: u32,
    state: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProviderTestResult {
    provider: String,
    model: Option<String>,
    tested_at: String,
    network_used: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAnnotationInput {
    source_id: Uuid,
    object_key: schema_model::ObjectKey,
    description: Option<String>,
    tags: Vec<String>,
    owner: Option<String>,
    is_core: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDomainGroupInput {
    id: Option<Uuid>,
    source_id: Uuid,
    name: String,
    description: Option<String>,
    color: String,
    table_keys: Vec<schema_model::ObjectKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveViewInput {
    id: Option<Uuid>,
    source_id: Uuid,
    name: String,
    root_table_keys: Vec<schema_model::ObjectKey>,
    relationship_depth: u8,
    positions: Option<std::collections::BTreeMap<String, CanvasPosition>>,
    viewport: Option<semantic_model::CanvasViewport>,
    snapshot_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLayoutInput {
    source_id: Uuid,
    view_id: Option<Uuid>,
    positions: std::collections::BTreeMap<String, CanvasPosition>,
    viewport: Option<semantic_model::CanvasViewport>,
    snapshot_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLogicalRelationshipInput {
    id: Option<Uuid>,
    source_id: Uuid,
    name: String,
    source: RelationshipEndpoint,
    target: RelationshipEndpoint,
    cardinality: RelationshipCardinality,
    origin: Option<LogicalRelationshipOrigin>,
    note: Option<String>,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    allow_type_mismatch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteLogicalRelationshipInput {
    source_id: Uuid,
    relationship_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateLogicalRelationshipInput {
    source_id: Uuid,
    source: RelationshipEndpoint,
    target: RelationshipEndpoint,
    relationship_id: Option<Uuid>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
struct RelationshipValidation {
    valid: bool,
    compatible: bool,
    duplicate: bool,
    physical_exists: bool,
    suggested_cardinality: RelationshipCardinality,
    status: LogicalRelationshipStatus,
    messages: Vec<String>,
    message_codes: Vec<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IgnoreRelationshipInferenceInput {
    source_id: Uuid,
    relationship_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplainSchemaInput {
    snapshot_id: Uuid,
    target_type: String,
    #[allow(dead_code)]
    object_key: Option<schema_model::ObjectKey>,
    domain_group: Option<DomainGroup>,
    change_set: Option<SchemaChangeSet>,
    question: Option<String>,
    #[allow(dead_code)]
    relationship_depth: u8,
    ai_enabled: bool,
    remote_consent: Option<RemoteAiConsent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAiConsent {
    endpoint: String,
    model: String,
    include_comments: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncProjectInput {
    source_id: Uuid,
    project_id: Uuid,
    api_url: String,
    access_token: String,
    base_version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudBootstrapInput {
    source_id: Uuid,
    email: String,
    display_name: String,
    team_name: String,
    bootstrap_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudProjectInput {
    source_id: Uuid,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudShareInput {
    source_id: Uuid,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudShareActionInput {
    source_id: Uuid,
    share_id: Uuid,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudAuthSession {
    team_id: Uuid,
    access_token: String,
    access_expires_at: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct CloudProjectRecord {
    id: Uuid,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAccountResult {
    account_label: String,
    team_id: String,
    access_expires_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudShareRecord {
    id: Uuid,
    token: String,
    permission: String,
    expires_at: String,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudShareSummary {
    id: Uuid,
    permission: String,
    expires_at: String,
    created_at: String,
    revoked_at: Option<String>,
    last_access_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProjectResult {
    version: i64,
    fingerprint: String,
    deduplicated: bool,
    uploaded_events: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudSyncBundle {
    project_id: Uuid,
    source_id: Uuid,
    source_label: String,
    fingerprint: String,
    snapshot: Option<DatabaseSnapshot>,
    change_set: Option<SchemaChangeSet>,
    annotations: Vec<ObjectAnnotation>,
    domain_groups: Vec<DomainGroup>,
    saved_views: Vec<SavedView>,
    #[serde(default)]
    logical_relationships: Vec<LogicalRelationship>,
    layout: Option<CanvasLayout>,
    project_settings: Option<ProjectSettings>,
    base_version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudBundleReceipt {
    fingerprint: String,
    version: i64,
    deduplicated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudBundleEnvelope {
    version: i64,
    bundle: CloudSyncBundle,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAuditEntry {
    action: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticBundle {
    knowledge: Vec<semantic_model::knowledge::KnowledgeState>,
    annotations: Vec<ObjectAnnotation>,
    orphaned_annotations: Vec<ObjectAnnotation>,
    view_layouts: Vec<CanvasLayout>,
    domain_groups: Vec<DomainGroup>,
    saved_views: Vec<SavedView>,
    layout: Option<CanvasLayout>,
    logical_relationships: Vec<LogicalRelationship>,
    ignored_relationship_inferences: Vec<IgnoredRelationshipInference>,
}

type CaptureSnapshotResult = snapshot_store::StoredSnapshotCapture;

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_runtime_info(app: tauri::AppHandle) -> RuntimeInfo {
    RuntimeInfo {
        local_eslint: cfg!(all(target_os = "macos", not(feature = "mac-app-store"))),
        code_finder_actions: cfg!(all(target_os = "macos", not(feature = "mac-app-store"))),
        code_extensions: if cfg!(all(target_os = "macos", feature = "mac-app-store")) {
            CodeExtensions::Syntax
        } else if cfg!(all(target_os = "macos", feature = "code-extensions")) {
            CodeExtensions::Full
        } else {
            CodeExtensions::Disabled
        },
        kind: "desktop",
        label: "Tauri desktop runtime",
        distribution: if purchase::IS_MAS {
            "macAppStore"
        } else {
            "community"
        },
        version: app.package_info().version.to_string(),
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn get_system_accent(app: tauri::AppHandle) -> Option<[[f64; 3]; 2]> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(system_appearance::accent_colors());
    })
    .ok()?;
    receiver.await.ok().flatten()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_diagnostic_info(app: tauri::AppHandle) -> Result<DiagnosticInfo, String> {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Unable to locate the application data directory.".to_owned())?;
    let log_directory = app
        .path()
        .app_log_dir()
        .map_err(|_| "Unable to locate the application log directory.".to_owned())?;
    Ok(DiagnosticInfo {
        app_version: app.package_info().version.to_string(),
        rust_version: env!("CARGO_PKG_RUST_VERSION"),
        target: std::env::consts::OS,
        data_directory: data_directory.to_string_lossy().into_owned(),
        log_directory: log_directory.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn reveal_app_directory(input: RevealDirectoryInput, app: tauri::AppHandle) -> Result<(), String> {
    let path = match input.kind.as_str() {
        "data" => app
            .path()
            .app_data_dir()
            .map_err(|_| "Unable to locate the application data directory.".to_owned())?,
        "logs" => app
            .path()
            .app_log_dir()
            .map_err(|_| "Unable to locate the application log directory.".to_owned())?,
        _ => return Err("Unsupported application directory.".into()),
    };
    fs::create_dir_all(&path)
        .map_err(|_| "Unable to create the application directory.".to_owned())?;
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(&path).status();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(&path).status();
    if status.is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err("Unable to reveal the application directory.".into())
    }
}

#[tauri::command]
async fn list_data_sources(state: State<'_, AppState>) -> Result<Vec<DataSourceProfile>, String> {
    state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn save_data_source(
    input: SaveDataSourceInput,
    state: State<'_, AppState>,
) -> Result<DataSourceProfile, String> {
    save_data_source_using(input, &state).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MappedDataSource {
    profile: DataSourceProfile,
    capture: CaptureSnapshotResult,
}

#[tauri::command]
async fn save_and_map_data_source(
    input: SaveDataSourceInput,
    source_id: Uuid,
    state: State<'_, AppState>,
) -> Result<MappedDataSource, String> {
    let _operation = acquire_cloud_operation(&state, source_id).await?;
    if input.id.is_some() || input.is_server_connection() {
        return Err("Choose a new database or SQLite file to map.".into());
    }
    validate_connection_profile_input(&input)?;
    if input.database_type != DatabaseType::Sqlite && input.password.is_empty() {
        return Err("A database password is required for a new data source.".into());
    }
    let now = Utc::now();
    let profile = data_source_profile_from_input(&input, source_id, now, now);
    if let Some(saved) = state
        .store
        .get_data_source(source_id)
        .await
        .map_err(safe_store_error)?
    {
        if saved
            != (DataSourceProfile {
                created_at: saved.created_at,
                updated_at: saved.updated_at,
                ..profile.clone()
            })
        {
            return Err(
                "This connection was already saved. Open it from the data source list.".into(),
            );
        }
        let snapshot = state
            .store
            .latest_snapshot(source_id)
            .await
            .map_err(safe_store_error)?
            .ok_or("The saved connection has no structure snapshot.")?;
        return Ok(MappedDataSource {
            profile: saved,
            capture: CaptureSnapshotResult {
                snapshot,
                stored: false,
                change_set: None,
            },
        });
    }
    let capture = capture_snapshot_using(
        CaptureSnapshotInput {
            source_id,
            trigger: None,
        },
        &state,
        Some((&profile, &input)),
    )
    .await?;
    Ok(MappedDataSource { profile, capture })
}

async fn save_data_source_using(
    mut input: SaveDataSourceInput,
    state: &AppState,
) -> Result<DataSourceProfile, String> {
    let now = Utc::now();
    let id = input.id.unwrap_or_else(Uuid::new_v4);
    let _operation = acquire_cloud_operation(state, id).await?;
    let existing = state
        .store
        .get_data_source(id)
        .await
        .map_err(safe_store_error)?;
    if existing.as_ref().is_some_and(|profile| {
        profile.is_server_connection() != input.is_server_connection()
            || (profile.is_server_connection() && profile.database_type != input.database_type)
    }) {
        return Err(
            "Save a separate connection to change between server and database scope.".into(),
        );
    }
    if input.database_type == DatabaseType::Sqlite {
        if let Some(previous) = existing.as_ref().filter(|previous| {
            previous.database_type == DatabaseType::Sqlite && previous.sqlite == input.sqlite
        }) {
            if input.display_name.trim().is_empty() {
                return Err("A data source name is required.".into());
            }
            // A name edit also works for an imported model with no local file binding.
            let mut profile = previous.clone();
            profile.display_name = input.display_name.trim().to_owned();
            profile.updated_at = now;
            state
                .store
                .save_data_source(&profile)
                .await
                .map_err(safe_store_error)?;
            return Ok(profile);
        }
        validate_connection_profile_input(&input)?;
        let mut profile = data_source_profile_from_input(
            &input,
            id,
            existing.as_ref().map_or(now, |p| p.created_at),
            now,
        );
        profile.connection_sync = bound_sync_identity(existing.as_ref());
        capture_snapshot_using(
            CaptureSnapshotInput {
                source_id: id,
                trigger: None,
            },
            state,
            Some((&profile, &input)),
        )
        .await?;
        return Ok(profile);
    }
    let pending = existing
        .as_ref()
        .is_some_and(|profile| profile.connection_sync.is_some_and(|sync| sync.pending));
    if pending && !input.is_server_connection() {
        return Err("Use Verify & Refresh to finish setting up this imported connection.".into());
    }
    connection_credentials::prepare_imported_binding(&mut input, existing.as_ref())?;
    if pending {
        let resolved = connection_input_with_resolved_password(input)?;
        test_database_connection_with_progress(&resolved, None, &state.sessions)
            .await
            .map_err(|error| error.to_string())?;
        input = resolved;
    } else {
        validate_connection_profile_input(&input)?;
    }
    if existing.is_none() && input.password.is_empty() {
        return Err("A database password is required for a new data source.".into());
    }
    let created_at = existing.as_ref().map_or(now, |profile| profile.created_at);
    let previous = connection_credentials::save(id, &input)?;
    let mut profile = data_source_profile_from_input(&input, id, created_at, now);
    profile.connection_sync = bound_sync_identity(existing.as_ref());
    profile.server_source_id = database_server::parent_for_edit(&profile, existing.as_ref());
    if let Err(error) = state.store.save_data_source(&profile).await {
        previous.rollback()?;
        return Err(safe_store_error(error));
    }
    Ok(profile)
}

#[tauri::command]
async fn test_postgres_connection(
    mut input: SaveDataSourceInput,
    test_id: Option<Uuid>,
    on_progress: tauri::ipc::Channel<connection_tests::ConnectionTestProgress>,
    tests: State<'_, connection_tests::ConnectionTests>,
    state: State<'_, AppState>,
) -> Result<ConnectionTestResult, ConnectionFailure> {
    let existing = if let Some(id) = input.id {
        state.store.get_data_source(id).await.map_err(|_| {
            ConnectionFailure::new("configuration", "Unable to load the local connection.")
        })?
    } else {
        None
    };
    connection_credentials::prepare_imported_binding(&mut input, existing.as_ref()).map_err(
        |message| ConnectionFailure::new("configuration", message).with_code("passwordRequired"),
    )?;
    let operation = tests.start(test_id.unwrap_or_else(Uuid::new_v4))?;
    // The first event acknowledges registration; clients may now safely cancel.
    connection_tests::progress(Some(&on_progress), "configuration", false);
    operation
        .run(async {
            // Keychain APIs may block. Cancellation must remain responsive while they finish.
            let input = tokio::task::spawn_blocking(move || prepare_connection_test(input))
                .await
                .map_err(|_| {
                    ConnectionFailure::new(
                        "configuration",
                        "Unable to prepare the connection test.",
                    )
                })??;
            test_database_connection_with_progress(&input, Some(&on_progress), &state.sessions)
                .await
        })
        .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state is passed by value"
)]
fn cancel_connection_test(
    test_id: Uuid,
    tests: State<'_, connection_tests::ConnectionTests>,
) -> bool {
    tests.cancel(test_id)
}

fn prepare_connection_test(
    input: SaveDataSourceInput,
) -> Result<SaveDataSourceInput, ConnectionFailure> {
    let mut input = input;
    if input.database_type == DatabaseType::Sqlite {
        validate_connection_profile_input(&input)
            .map_err(|m| ConnectionFailure::new("configuration", m))?;
        return Ok(input);
    }
    let mut tls = input.security.clone();
    tls.ssh = None;
    connection_security::validate(&tls, input.ssl_mode)
        .map_err(|message| ConnectionFailure::new("tls", message))?;
    let mut ssh = input.security.clone();
    ssh.tls = schema_model::TlsConfig::default();
    connection_security::validate(&ssh, SslMode::Disable).map_err(|message| {
        if message == connection_security::MAS_KNOWN_HOSTS_REQUIRED {
            ConnectionFailure::new("configuration", message).with_code("sshKnownHostsRequired")
        } else {
            ConnectionFailure::new("ssh", message)
        }
    })?;
    validate_connection_profile_input(&input)
        .map_err(|message| ConnectionFailure::new("configuration", message))?;
    if input.password.is_empty() {
        let id = input.id.ok_or_else(|| {
            ConnectionFailure::new("database", "Enter the database password before testing.")
                .with_code("passwordRequired")
        })?;
        input.password = credential_entry(id)
            .and_then(|entry| {
                entry.get_password().map_err(|_| {
                    "Unable to read the database password from the system keychain.".into()
                })
            })
            .map_err(|message| ConnectionFailure::new("database", message))?;
    }
    input
        .resolve_ssh_secret()
        .map_err(|message| ConnectionFailure::new("ssh", message))?;
    Ok(input)
}

#[cfg(test)]
async fn test_database_connection(
    input: &SaveDataSourceInput,
) -> Result<ConnectionTestResult, ConnectionFailure> {
    test_database_connection_with_progress(input, None, &ConnectionSessions::default()).await
}

async fn test_database_connection_with_progress(
    input: &SaveDataSourceInput,
    progress: Option<&tauri::ipc::Channel<connection_tests::ConnectionTestProgress>>,
    sessions: &ConnectionSessions,
) -> Result<ConnectionTestResult, ConnectionFailure> {
    const TEST_PHASE_TIMEOUT: Duration = Duration::from_secs(15);
    if input.database_type == DatabaseType::Sqlite {
        connection_tests::progress(progress, "file", false);
        let now = Utc::now();
        let profile =
            data_source_profile_from_input(input, input.id.unwrap_or_else(Uuid::new_v4), now, now);
        let database = sqlite_source::test(profile)
            .await
            .map_err(|m| ConnectionFailure::new("file", m))?;
        connection_tests::progress(progress, "metadata", false);
        return Ok(ConnectionTestResult {
            database,
            ssl_active: None,
            server_read_only: Some(true),
        });
    }
    connection_tests::progress(progress, "ssh", false);
    let now = Utc::now();
    let profile = data_source_profile_from_input(input, Uuid::nil(), now, now);
    let ssh_connected = input.security.ssh.is_some();
    let testing = sessions.provisional();
    let session = testing
        .open(
            &profile,
            &input.password,
            input.ssh_secret(),
            TEST_PHASE_TIMEOUT,
            || connection_tests::progress(progress, "handshake", ssh_connected),
        )
        .await?;
    let read_metadata = async {
        match &session.pool {
            DatabasePool::Postgres(pool) => test_postgres_target(input, pool, progress).await,
            DatabasePool::MySql(pool) => test_mysql_target(input, pool, progress).await,
        }
    };
    let result = tokio::time::timeout(TEST_PHASE_TIMEOUT, read_metadata)
        .await
        .map_err(|_| {
            ConnectionFailure::new("timeout", "Connected, but the server took too long to respond. Check the network or server load and try again.")
                .with_code("connectionMetadataTimeout")
                .after_ssh(ssh_connected)
        })?;
    if result.is_ok() {
        sessions.retain_verified(&testing).await;
    }
    result
}

async fn test_mysql_target(
    input: &SaveDataSourceInput,
    pool: &sqlx::MySqlPool,
    progress: Option<&tauri::ipc::Channel<connection_tests::ConnectionTestProgress>>,
) -> Result<ConnectionTestResult, ConnectionFailure> {
    let ssh_connected = input.security.ssh.is_some();
    connection_tests::progress(progress, "metadata", ssh_connected);
    let database = if input.is_server_connection() {
        database_server::test_mysql_server(pool).await
    } else {
        test_mysql_connection(pool).await
    }
    .map_err(|error| connection_diagnostics::mysql(error).after_ssh(ssh_connected))?;
    let server_read_only = sqlx::query_scalar::<_, i64>("SELECT @@global.read_only")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|value| value != 0);
    connection_tests::progress(progress, "tls", ssh_connected);
    let ssl_active = sqlx::query("SHOW STATUS LIKE 'Ssl_cipher'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>(1).ok())
        .map(|cipher| !cipher.is_empty());
    Ok(ConnectionTestResult {
        database,
        ssl_active,
        server_read_only,
    })
}

async fn test_postgres_target(
    input: &SaveDataSourceInput,
    pool: &sqlx::PgPool,
    progress: Option<&tauri::ipc::Channel<connection_tests::ConnectionTestProgress>>,
) -> Result<ConnectionTestResult, ConnectionFailure> {
    let ssh_connected = input.security.ssh.is_some();
    let server = input.is_server_connection();
    connection_tests::progress(progress, "metadata", ssh_connected);
    let mut database = test_connection(pool)
        .await
        .map_err(|error| connection_diagnostics::postgres(error).after_ssh(ssh_connected))?;
    if server {
        database.name.clear();
    }
    let server_read_only = sqlx::query_scalar::<_, String>("SHOW transaction_read_only")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|value| value == "on");
    connection_tests::progress(progress, "tls", ssh_connected);
    let ssl_active = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    Ok(ConnectionTestResult {
        database,
        ssl_active,
        server_read_only,
    })
}

fn connection_input_with_resolved_password(
    mut input: SaveDataSourceInput,
) -> Result<SaveDataSourceInput, String> {
    validate_connection_profile_input(&input)?;
    if input.database_type == DatabaseType::Sqlite {
        return Ok(input);
    }
    if input.password.is_empty() {
        let source_id = input.id.ok_or_else(|| {
            "A database password is required to verify a new connection.".to_owned()
        })?;
        input.password = credential_entry(source_id)?
            .get_password()
            .map_err(|_| "Unable to read the database password from the keychain.".to_owned())?;
    }
    input.resolve_ssh_secret()?;
    Ok(input)
}

fn data_source_profile_from_input(
    input: &SaveDataSourceInput,
    id: Uuid,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
) -> DataSourceProfile {
    DataSourceProfile {
        server_source_id: None,
        sqlite: input.sqlite.clone(),
        connection_sync: None,
        id,
        display_name: input.display_name.trim().to_owned(),
        host: if input.database_type == DatabaseType::Sqlite {
            String::new()
        } else {
            input.host.trim().to_owned()
        },
        port: if input.database_type == DatabaseType::Sqlite {
            0
        } else {
            input.port
        },
        database: if input.database_type == DatabaseType::Sqlite {
            input
                .sqlite
                .as_ref()
                .and_then(|f| std::path::Path::new(&f.path).file_name())
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
        } else {
            input.database.trim().to_owned()
        },
        username: if input.database_type == DatabaseType::Sqlite {
            String::new()
        } else {
            input.username.trim().to_owned()
        },
        database_type: input.database_type,
        ssl_mode: input.ssl_mode,
        security: if input.database_type == DatabaseType::Sqlite {
            schema_model::ConnectionSecurity::default()
        } else {
            input.security.clone()
        },
        created_at,
        updated_at,
    }
}

fn bound_sync_identity(
    profile: Option<&DataSourceProfile>,
) -> Option<schema_model::ConnectionSyncIdentity> {
    profile
        .and_then(|profile| profile.connection_sync)
        .map(|mut identity| {
            identity.pending = false;
            identity
        })
}

#[tauri::command]
async fn verify_and_refresh_data_source(
    mut input: SaveDataSourceInput,
    state: State<'_, AppState>,
) -> Result<VerifyAndRefreshResult, String> {
    let source_id = input
        .id
        .ok_or_else(|| "Verify and refresh requires an existing data source.".to_owned())?;
    let _operation = acquire_cloud_operation(&state, source_id).await?;
    let previous_profile = state
        .store
        .get_data_source(source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected data source no longer exists.".to_owned())?;
    if previous_profile.is_server_connection() || input.is_server_connection() {
        return Err("Open a database on the server to view its structure.".into());
    }
    connection_credentials::prepare_imported_binding(&mut input, Some(&previous_profile))?;
    let resolved = connection_input_with_resolved_password(input)?;
    validate_connection_input(&resolved)?;
    let connection = test_database_connection_with_progress(&resolved, None, &state.sessions)
        .await
        .map_err(|error| error.to_string())?;
    let mut profile = data_source_profile_from_input(
        &resolved,
        source_id,
        previous_profile.created_at,
        Utc::now(),
    );
    profile.connection_sync = bound_sync_identity(Some(&previous_profile));
    profile.server_source_id = database_server::parent_for_edit(&profile, Some(&previous_profile));

    let capture = capture_snapshot_using(
        CaptureSnapshotInput {
            source_id,
            trigger: None,
        },
        &state,
        Some((&profile, &resolved)),
    )
    .await?;

    Ok(VerifyAndRefreshResult {
        profile,
        connection,
        capture,
    })
}

#[tauri::command]
async fn capture_postgres_snapshot(
    input: CaptureSnapshotInput,
    state: State<'_, AppState>,
) -> Result<CaptureSnapshotResult, String> {
    capture_snapshot(input, &state).await
}

#[allow(clippy::too_many_lines)]
async fn capture_snapshot(
    input: CaptureSnapshotInput,
    state: &AppState,
) -> Result<CaptureSnapshotResult, String> {
    let source = input.source_id;
    let result = capture_snapshot_using(input, state, None).await;
    if result.is_err() {
        state
            .store
            .record_review_capture_failure(source)
            .await
            .map_err(safe_store_error)?;
    }
    result
}

async fn snapshot_capture_gate(state: &AppState, source_id: Uuid) -> Arc<Semaphore> {
    let mut captures = state.snapshot_captures.lock().await;
    Arc::clone(
        captures
            .entry(source_id)
            .or_insert_with(|| Arc::new(Semaphore::new(1))),
    )
}

#[allow(clippy::too_many_lines)]
async fn capture_snapshot_using(
    input: CaptureSnapshotInput,
    state: &AppState,
    verified: Option<(&DataSourceProfile, &SaveDataSourceInput)>,
) -> Result<CaptureSnapshotResult, String> {
    let _capture_permit = snapshot_capture_gate(state, input.source_id)
        .await
        .try_acquire_owned()
        .map_err(|_| "A snapshot capture is already running for this data source.".to_owned())?;
    let source_settings = state
        .store
        .get_data_source_settings(input.source_id)
        .await
        .map_err(safe_store_error)?;
    if source_settings.storage.capture_policy == settings_model::CapturePolicy::Manual
        && input.trigger.as_deref() == Some("background")
    {
        let snapshot = state
            .store
            .latest_snapshot(input.source_id)
            .await
            .map_err(safe_store_error)?
            .ok_or_else(|| "Manual snapshot mode requires an initial capture.".to_owned())?;
        return Ok(CaptureSnapshotResult {
            snapshot,
            stored: false,
            change_set: None,
        });
    }
    let sqlite_profile = if let Some((profile, _)) = verified {
        Some(profile.clone())
    } else {
        state
            .store
            .get_data_source(input.source_id)
            .await
            .map_err(safe_store_error)?
    };
    if let Some(profile) = sqlite_profile.filter(|p| p.database_type == DatabaseType::Sqlite) {
        let snapshot = sqlite_source::capture(
            profile.clone(),
            Duration::from_secs(u64::from(
                source_settings.refresh.introspection_timeout_seconds,
            )),
        )
        .await?;
        return if verified.is_some() {
            state
                .store
                .save_verified_source(&profile, &snapshot)
                .await
                .map_err(safe_store_error)
        } else {
            state
                .store
                .save_captured_snapshot_for(&profile, &snapshot)
                .await
                .map_err(safe_store_error)
        };
    }
    let (profile, password) = if let Some((profile, resolved)) = verified {
        (profile.clone(), resolved.password.clone())
    } else {
        let profile = state
            .store
            .get_data_source(input.source_id)
            .await
            .map_err(safe_store_error)?
            .ok_or("The selected data source no longer exists.")?;
        // macOS may wait for an unlock or authorization dialog here. Keep that
        // synchronous wait off Tokio workers so local storage and settings remain usable.
        connection_credentials::require_binding(&profile)?;
        if profile.is_server_connection() {
            return Err("Open a database on the server to view its structure.".into());
        }
        let source_id = profile.id;
        let password = tokio::task::spawn_blocking(move || {
            credential_entry(source_id)?
                .get_password()
                .map_err(|_| "Unable to read the database password from the keychain.".to_owned())
        })
        .await
        .map_err(|_| "Unable to read the database password from the keychain.".to_owned())??;
        (profile, password)
    };
    connection_security::validate(&profile.security, profile.ssl_mode)?;
    let ssh_secret = match verified {
        Some((_, input)) => input.ssh_secret().map(str::to_owned),
        None => connection_credentials::resolve_ssh(Some(profile.id), &profile.security, None)?,
    };
    let session = state
        .sessions
        .open(
            &profile,
            &password,
            ssh_secret.as_deref(),
            Duration::from_secs(u64::from(
                source_settings.refresh.connection_timeout_seconds,
            )),
            || {},
        )
        .await
        .map_err(|failure| failure.message)?;
    let timeout = Duration::from_secs(u64::from(
        source_settings.refresh.introspection_timeout_seconds,
    ));
    let snapshot = match &session.pool {
        DatabasePool::Postgres(pool) => {
            tokio::time::timeout(timeout, inspect_schema(pool, profile.id))
                .await
                .map_err(|_| "PostgreSQL introspection timed out.".to_owned())?
                .map_err(safe_connection_error)?
        }
        DatabasePool::MySql(pool) => {
            tokio::time::timeout(timeout, inspect_mysql_schema(pool, profile.id))
                .await
                .map_err(|_| "MySQL introspection timed out.".to_owned())?
                .map_err(safe_mysql_error)?
        }
    };
    if let Some((_, resolved)) = verified {
        let previous = connection_credentials::save(profile.id, resolved)?;
        match state.store.save_verified_source(&profile, &snapshot).await {
            Ok(capture) => return Ok(capture),
            Err(error) => {
                previous.rollback()?;
                return Err(safe_store_error(error));
            }
        }
    }
    state
        .store
        .save_captured_snapshot_for(&profile, &snapshot)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn list_snapshots(
    input: CaptureSnapshotInput,
    state: State<'_, AppState>,
) -> Result<Vec<SnapshotSummary>, String> {
    state
        .store
        .list_snapshots(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn list_recent_snapshot_ids(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<Uuid>, String> {
    state
        .store
        .list_recent_snapshot_ids(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn get_snapshot(
    input: SnapshotInput,
    state: State<'_, AppState>,
) -> Result<DatabaseSnapshot, String> {
    state
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected snapshot no longer exists.".to_owned())
}

#[tauri::command]
async fn compare_snapshots(
    input: CompareSnapshotsInput,
    state: State<'_, AppState>,
) -> Result<SchemaChangeSet, String> {
    let before = state
        .store
        .get_snapshot(input.before_snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The before snapshot no longer exists.".to_owned())?;
    let after = state
        .store
        .get_snapshot(input.after_snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The after snapshot no longer exists.".to_owned())?;
    if before.source_id != after.source_id {
        return Err("Snapshots from different data sources cannot be compared.".into());
    }
    Ok(diff_snapshots(&before, &after))
}

#[tauri::command]
async fn compare_environment_snapshots(
    input: CompareEnvironmentsInput,
    state: State<'_, AppState>,
) -> Result<DriftReport, String> {
    let from = state
        .store
        .get_snapshot(input.from_snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The source environment snapshot no longer exists.".to_owned())?;
    let to = state
        .store
        .get_snapshot(input.to_snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The target environment snapshot no longer exists.".to_owned())?;
    Ok(compare_environments(
        &EnvironmentSnapshot {
            environment: input.from_environment,
            snapshot: from,
        },
        &EnvironmentSnapshot {
            environment: input.to_environment,
            snapshot: to,
        },
    ))
}

#[tauri::command]
async fn save_change_provenance(
    input: SaveProvenanceInput,
    state: State<'_, AppState>,
) -> Result<ChangeProvenance, String> {
    let mut provenance = ChangeProvenance {
        change_set_id: input.change_set_id,
        branch: input.branch,
        commit_sha: input.commit_sha,
        pull_request_url: input.pull_request_url,
        migration_files: input.migration_files,
        recorded_at: Utc::now(),
    };
    provenance.canonicalize();
    state
        .store
        .save_change_provenance(&provenance)
        .await
        .map_err(safe_store_error)?;
    Ok(provenance)
}

#[tauri::command]
async fn save_code_lineage(
    input: SaveLineageInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .replace_lineage(input.source_id, &input.links)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn get_semantics(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<SemanticBundle, String> {
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?;
    // Derived relationship status can invalidate knowledge. Refresh it before reading
    // description/confirmation pairs, which must come from one storage transaction.
    let logical_relationships = validate_logical_relationships_for_snapshot(
        &state.store,
        input.source_id,
        snapshot.as_ref(),
    )
    .await?;
    let (annotations, knowledge) = state
        .store
        .annotation_knowledge(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let groups = state
        .store
        .list_domain_groups(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let saved_views = state
        .store
        .list_views(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let layout = state
        .store
        .get_layout(input.source_id, None)
        .await
        .map_err(safe_store_error)?;
    let (annotations, orphaned_annotations, domain_groups) = if let Some(snapshot) = snapshot {
        let result = reattach_semantics(&snapshot, annotations, groups);
        (
            result.attached_annotations,
            result.orphaned_annotations,
            result.attached_groups,
        )
    } else {
        (Vec::new(), annotations, groups)
    };
    Ok(SemanticBundle {
        view_layouts: state
            .store
            .list_layouts(input.source_id)
            .await
            .map_err(safe_store_error)?,
        knowledge,
        annotations,
        orphaned_annotations,
        domain_groups,
        saved_views,
        layout,
        logical_relationships,
        ignored_relationship_inferences: state
            .store
            .list_ignored_relationship_inferences(input.source_id)
            .await
            .map_err(safe_store_error)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
async fn sync_project(
    input: SyncProjectInput,
    state: State<'_, AppState>,
) -> Result<SyncProjectResult, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    let cloud = effective
        .source
        .as_ref()
        .map(|settings| &settings.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    if effective.app.privacy.offline_mode || !cloud.enabled {
        return Err("Cloud sync is disabled by Settings or completely offline mode.".into());
    }
    if cloud.endpoint.trim_end_matches('/') != input.api_url.trim_end_matches('/')
        || cloud.project_id != input.project_id.to_string()
        || cloud.base_version != input.base_version
    {
        return Err("Cloud target does not match the saved Settings configuration.".into());
    }
    let sync_event_ids = state
        .store
        .pending_sync()
        .await
        .map_err(safe_store_error)?
        .into_iter()
        .filter(|event| event.source_id == input.source_id)
        .map(|event| event.id)
        .collect::<Vec<_>>();
    let endpoint = cloud_sync_endpoint(&input)?;
    let access_token = cloud_access_token(&input)?;
    let mut bundle = build_cloud_bundle(&state.store, &input, cloud).await?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let client = cloud_http_client()?;
    if cloud_requires_sqlite_support(&bundle) {
        let capability_url = format!("{}/v1/capabilities", input.api_url.trim_end_matches('/'));
        let capabilities = client
            .get(capability_url)
            .send()
            .await
            .map_err(|_| "Unable to verify Cloud SQLite support; nothing was uploaded.")?
            .error_for_status()
            .map_err(|_| "Update the Cloud server to support SQLite before publishing.")?
            .json::<serde_json::Value>()
            .await
            .map_err(|_| "Cloud capability response is invalid.")?;
        if !capabilities["databaseTypes"]
            .as_array()
            .is_some_and(|types| types.iter().any(|kind| kind == "sqlite"))
        {
            return Err("This Cloud server does not support SQLite; nothing was uploaded.".into());
        }
    }
    let response = client
        .put(endpoint.clone())
        .bearer_auth(&access_token)
        .json(&bundle)
        .send()
        .await
        .map_err(|_| "Cloud API is unreachable; metadata remains queued locally.".to_owned())?;
    if response.status() == reqwest::StatusCode::CONFLICT {
        let has_semantic_changes = state
            .store
            .pending_sync()
            .await
            .map_err(safe_store_error)?
            .iter()
            .any(|item| {
                item.source_id == input.source_id
                    && (item.event_kind == "annotation.save" || item.event_kind == "domain.save")
            });
        if cloud.conflict_strategy == ConflictStrategy::Ask || has_semantic_changes {
            update_source_sync_events(&state.store, input.source_id, "conflict").await?;
            return Err(
                "Cloud metadata changed; semantic conflicts always require review in Settings."
                    .into(),
            );
        }
        let remote = client
            .get(endpoint.clone())
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|_| "Cloud conflict details are unreachable.".to_owned())?
            .error_for_status()
            .map_err(|_| "Cloud conflict details could not be loaded.".to_owned())?
            .json::<CloudBundleEnvelope>()
            .await
            .map_err(|_| "Cloud returned invalid conflict details.".to_owned())?;
        match cloud.conflict_strategy {
            ConflictStrategy::KeepLocal => {
                bundle.base_version = remote.version;
                let retry = client
                    .put(endpoint)
                    .bearer_auth(&access_token)
                    .json(&bundle)
                    .send()
                    .await
                    .map_err(|_| {
                        "Cloud retry is unreachable; metadata remains queued.".to_owned()
                    })?;
                if !retry.status().is_success() {
                    update_source_sync_events(&state.store, input.source_id, "conflict").await?;
                    return Err("Cloud changed again while keeping local metadata.".into());
                }
                return finish_cloud_sync(
                    &state.store,
                    input.source_id,
                    &sync_event_ids,
                    retry
                        .json::<CloudBundleReceipt>()
                        .await
                        .map_err(|_| "Cloud returned an invalid sync receipt.".to_owned())?,
                )
                .await;
            }
            ConflictStrategy::KeepRemote => {
                apply_remote_cloud_bundle(&state.store, input.source_id, &remote.bundle).await?;
                return finish_cloud_sync(
                    &state.store,
                    input.source_id,
                    &sync_event_ids,
                    CloudBundleReceipt {
                        fingerprint: remote.bundle.fingerprint,
                        version: remote.version,
                        deduplicated: true,
                    },
                )
                .await;
            }
            ConflictStrategy::Ask => unreachable!("ask conflicts return before loading remote"),
        }
    }
    if !response.status().is_success() {
        return Err("Cloud rejected the metadata sync request.".into());
    }
    let receipt: CloudBundleReceipt = response
        .json()
        .await
        .map_err(|_| "Cloud returned an invalid sync receipt.".to_owned())?;
    finish_cloud_sync(&state.store, input.source_id, &sync_event_ids, receipt).await
}

fn cloud_requires_sqlite_support(bundle: &CloudSyncBundle) -> bool {
    bundle
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.database.database_type == DatabaseType::Sqlite)
        || bundle.change_set.as_ref().is_some_and(|changes| {
            changes
                .operations
                .iter()
                .any(|operation| operation.operation_type == schema_diff::OperationType::AlterTable)
        })
}

async fn finish_cloud_sync(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    sync_event_ids: &[Uuid],
    receipt: CloudBundleReceipt,
) -> Result<SyncProjectResult, String> {
    let uploaded_events = store
        .complete_cloud_sync(
            source_id,
            sync_event_ids,
            receipt.version,
            &Utc::now().to_rfc3339(),
        )
        .await
        .map_err(safe_store_error)?;
    Ok(SyncProjectResult {
        version: receipt.version,
        fingerprint: receipt.fingerprint,
        deduplicated: receipt.deduplicated,
        uploaded_events,
    })
}

async fn apply_remote_cloud_bundle(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    bundle: &CloudSyncBundle,
) -> Result<(), String> {
    if bundle.source_id != source_id {
        return Err("The remote project belongs to a different data source.".into());
    }
    if let Some(snapshot) = &bundle.snapshot {
        store
            .save_snapshot(snapshot)
            .await
            .map_err(safe_store_error)?;
    }
    if let Some(change_set) = &bundle.change_set {
        store
            .save_change_set(change_set)
            .await
            .map_err(safe_store_error)?;
    }
    for annotation in &bundle.annotations {
        store
            .save_annotation(annotation)
            .await
            .map_err(safe_store_error)?;
    }
    for group in &bundle.domain_groups {
        store
            .save_domain_group(group)
            .await
            .map_err(safe_store_error)?;
    }
    for view in &bundle.saved_views {
        store.save_view(view).await.map_err(safe_store_error)?;
    }
    for relationship in &bundle.logical_relationships {
        store
            .save_logical_relationship(relationship)
            .await
            .map_err(safe_store_error)?;
    }
    if let Some(layout) = &bundle.layout {
        store.save_layout(layout).await.map_err(safe_store_error)?;
    }
    if let Some(project_settings) = &bundle.project_settings {
        store
            .save_project_settings(project_settings)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(())
}

fn cloud_sync_endpoint(input: &SyncProjectInput) -> Result<reqwest::Url, String> {
    let mut api_url = reqwest::Url::parse(input.api_url.trim())
        .map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(api_url.host_str(), Some("localhost" | "127.0.0.1"));
    if api_url.scheme() != "https" && !local_development {
        return Err("Cloud sync requires HTTPS outside local development.".into());
    }
    if !api_url.path().ends_with('/') {
        api_url.set_path(&format!("{}/", api_url.path()));
    }
    api_url
        .join(&format!("v1/projects/{}/bundle", input.project_id))
        .map_err(|_| "Cloud API URL cannot form a sync endpoint.".to_owned())
}

fn cloud_http_client() -> Result<reqwest::Client, String> {
    if purchase::IS_MAS {
        return Err("Cloud collaboration is unavailable in the Mac App Store edition.".into());
    }
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_mins(1))
        .build()
        .map_err(|_| "Unable to initialize the Cloud HTTP client.".to_owned())
}

fn cloud_access_token(input: &SyncProjectInput) -> Result<String, String> {
    let token_entry = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?;
    if input.access_token.trim().is_empty() {
        return token_entry
            .get_password()
            .map_err(|_| "A cloud access token is required.".to_owned());
    }
    token_entry
        .set_password(input.access_token.trim())
        .map_err(|_| "Unable to save the cloud token in the keychain.".to_owned())?;
    Ok(input.access_token.trim().to_owned())
}

async fn build_cloud_bundle(
    store: &LocalSnapshotStore,
    input: &SyncProjectInput,
    settings: &settings_model::CloudSettings,
) -> Result<CloudSyncBundle, String> {
    let profile = store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected data source no longer exists.".to_owned())?;
    let snapshot = store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before syncing.".to_owned())?;
    let change_set = store
        .change_sets_for_snapshot(snapshot.id)
        .await
        .map_err(safe_store_error)?
        .into_iter()
        .next();
    let mut bundle = CloudSyncBundle {
        project_id: input.project_id,
        source_id: input.source_id,
        source_label: profile.display_name,
        fingerprint: String::new(),
        annotations: if settings.sync_semantics {
            store
                .list_annotations(input.source_id)
                .await
                .map_err(safe_store_error)?
        } else {
            Vec::new()
        },
        domain_groups: if settings.sync_domains {
            store
                .list_domain_groups(input.source_id)
                .await
                .map_err(safe_store_error)?
        } else {
            Vec::new()
        },
        saved_views: if settings.sync_saved_views {
            store
                .list_views(input.source_id)
                .await
                .map_err(safe_store_error)?
        } else {
            Vec::new()
        },
        logical_relationships: if settings.sync_semantics {
            store
                .list_logical_relationships(input.source_id)
                .await
                .map_err(safe_store_error)?
        } else {
            Vec::new()
        },
        layout: if settings.sync_shared_layouts || settings.sync_personal_layouts {
            store
                .get_layout(input.source_id, None)
                .await
                .map_err(safe_store_error)?
                .map(|layout| CanvasLayout {
                    viewport: None,
                    ..layout
                })
        } else {
            None
        },
        snapshot: settings.sync_snapshots.then_some(snapshot),
        change_set: settings.sync_change_sets.then_some(change_set).flatten(),
        project_settings: store
            .get_project_settings(&input.project_id.to_string())
            .await
            .map_err(safe_store_error)?,
        base_version: input.base_version,
    };
    bundle.fingerprint = cloud_bundle_fingerprint(&bundle)?;
    Ok(bundle)
}

fn cloud_bundle_fingerprint(bundle: &CloudSyncBundle) -> Result<String, String> {
    let mut canonical = bundle.clone();
    canonical.fingerprint.clear();
    canonical.base_version = 0;
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|_| "Unable to fingerprint the Cloud metadata bundle.".to_owned())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

async fn update_source_sync_events(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    new_state: &str,
) -> Result<usize, String> {
    let queued: Vec<_> = store
        .pending_sync()
        .await
        .map_err(safe_store_error)?
        .into_iter()
        .filter(|event| event.source_id == source_id)
        .collect();
    for event in &queued {
        store
            .update_sync_state(event.id, new_state)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(queued.len())
}

fn validate_connection_input(input: &SaveDataSourceInput) -> Result<(), String> {
    validate_connection_profile_input(input)?;
    if input.database_type != DatabaseType::Sqlite && input.password.is_empty() {
        return Err("A database password is required to verify the connection.".into());
    }
    Ok(())
}

fn validate_connection_profile_input(input: &SaveDataSourceInput) -> Result<(), String> {
    if input.database_type == DatabaseType::Sqlite {
        if input.display_name.trim().is_empty() {
            return Err("A data source name is required.".into());
        }
        let file = input
            .sqlite
            .as_ref()
            .ok_or("Choose a SQLite database file.")?;
        if !std::path::Path::new(&file.path).is_absolute() {
            return Err("Choose a local SQLite database file.".into());
        }
        return Ok(());
    }
    if input.sqlite.is_some() {
        return Err("Network connections cannot contain a SQLite file target.".into());
    }
    if input.display_name.trim().is_empty()
        || input.host.trim().is_empty()
        || input.username.trim().is_empty()
    {
        return Err("Name, host, and username are required.".into());
    }
    if input.port == 0 {
        return Err("Database port must be greater than zero.".into());
    }
    connection_security::validate(&input.security, input.ssl_mode)?;
    Ok(())
}

#[cfg(test)]
fn connection_options_from_input(input: &SaveDataSourceInput) -> PostgresConnectionOptions {
    PostgresConnectionOptions::from_fields(
        input.host.trim(),
        input.port,
        input.database.trim(),
        input.username.trim(),
        &input.password,
        adapter_ssl_mode(input.ssl_mode),
    )
    .with_tls(&input.security.tls)
}

fn connection_options_from_profile(
    profile: &DataSourceProfile,
    password: &str,
) -> PostgresConnectionOptions {
    PostgresConnectionOptions::from_fields(
        &profile.host,
        profile.port,
        &profile.database,
        &profile.username,
        password,
        adapter_ssl_mode(profile.ssl_mode),
    )
    .with_tls(&profile.security.tls)
}

fn mysql_connection_options_from_profile(
    profile: &DataSourceProfile,
    password: &str,
) -> MySqlConnectionOptions {
    MySqlConnectionOptions::from_fields(
        &profile.host,
        profile.port,
        &profile.database,
        &profile.username,
        password,
        mysql_ssl_mode(profile.ssl_mode),
    )
    .with_tls(&profile.security.tls)
}

const fn adapter_ssl_mode(mode: SslMode) -> PostgresSslMode {
    match mode {
        SslMode::Disable => PostgresSslMode::Disable,
        SslMode::Prefer => PostgresSslMode::Prefer,
        SslMode::Require => PostgresSslMode::Require,
        SslMode::VerifyCa => PostgresSslMode::VerifyCa,
        SslMode::VerifyFull => PostgresSslMode::VerifyFull,
    }
}

const fn mysql_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disable => MySqlSslMode::Disabled,
        SslMode::Prefer => MySqlSslMode::Preferred,
        SslMode::Require => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

fn credential_entry(id: Uuid) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())
}

fn safe_connection_error(error: postgres_adapter::PostgresAdapterError) -> String {
    match error {
        postgres_adapter::PostgresAdapterError::Database(sqlx::Error::Tls(_)) => {
            "TLS negotiation or certificate verification failed. Check the CA, database hostname, and client certificate/key. The connection was not downgraded.".into()
        }
        postgres_adapter::PostgresAdapterError::Database(_) => {
            "Unable to connect to PostgreSQL or read its schema metadata.".into()
        }
        other => other.to_string(),
    }
}

fn safe_mysql_error(error: mysql_adapter::MySqlAdapterError) -> String {
    match error {
        mysql_adapter::MySqlAdapterError::Database(sqlx::Error::Tls(_)) => {
            "TLS negotiation or certificate verification failed. Check the CA, database hostname, and client certificate/key. The connection was not downgraded.".into()
        }
        mysql_adapter::MySqlAdapterError::Database(_) => {
            "Unable to connect to MySQL or read its schema metadata.".into()
        }
        mysql_adapter::MySqlAdapterError::Metadata { stage, .. } => {
            format!("Connected to MySQL, but unable to read its {stage} metadata.")
        }
        other => other.to_string(),
    }
}

// Used directly by Result::map_err, which supplies an owned error.
#[allow(clippy::needless_pass_by_value)]
fn safe_store_error(error: snapshot_store::SnapshotStoreError) -> String {
    storage_errors::message(&error).into()
}

fn safe_git_workspace_error(error: &git_workspace::GitWorkspaceError) -> String {
    match error {
        git_workspace::GitWorkspaceError::InvalidRoot => {
            "Choose an existing absolute repository directory.".into()
        }
        git_workspace::GitWorkspaceError::UnsafePath(_) => {
            "The existing Nodal Studio manifest contains an unsafe managed path.".into()
        }
        git_workspace::GitWorkspaceError::InvalidRelationship => {
            "A logical relationship file is unsupported or invalid.".into()
        }
        _ => "Unable to export the Git workspace files.".into(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines)]
/// Starts the native application event loop.
///
/// # Panics
///
/// Panics when Tauri cannot initialize the configured desktop runtime or local store.
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(desktop_menu::menu)
        .on_menu_event(|app, event| desktop_menu::on_menu_event(app, &event));
    #[cfg(not(feature = "mac-app-store"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(purchase::PurchaseState::default())
        .manage(connection_tests::ConnectionTests::default())
        .manage(connection_sync::folder::FolderRuntime::default())
        .manage(updates::UpdateState::default())
        .manage(table_understanding::TableAiState::default())
        .manage(discovery::DiscoveryAiState::default())
        .manage(knowledge::KnowledgeDrafts::default())
        .manage(code_view::review::ReviewState::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("nodalstudio.sqlite3");
            if app.config().identifier == "com.claycosmos.nodalstudio"
                && !database_path.exists()
                && let Some(application_support) = data_dir.parent()
            {
                let legacy_database = application_support
                    .join("com.claycosmos.sqlaieditor")
                    .join("sqlaieditor.sqlite3");
                if legacy_database.is_file() {
                    fs::copy(legacy_database, &database_path)?;
                }
            }
            let cache_dir = app.path().app_cache_dir()?;
            tauri::async_runtime::block_on(cleanup_retired_external_artifacts(
                &database_path,
                &cache_dir,
            ))
            .map_err(std::io::Error::other)?;
            let store =
                tauri::async_runtime::block_on(LocalSnapshotStore::open_path(database_path))?;
            let initial_offline = tauri::async_runtime::block_on(effective_settings(&store, None))
                .is_ok_and(|settings| settings.app.privacy.offline_mode);
            let _ = offline_watch_sender().send(initial_offline);
            let sessions = ConnectionSessions::default();
            sessions.start_reaper();
            app.manage(AppState {
                sessions,
                store,
                ai_limiter: Arc::new(Semaphore::new(840)),
                snapshot_captures: Arc::new(Mutex::new(HashMap::new())),
                cloud_operations: Arc::new(Mutex::new(HashMap::new())),
                active_queries: Arc::new(Mutex::new(HashMap::new())),
            });
            app.manage(database_export::Jobs::default());
            purchase::start(app.handle().clone());
            connection_sync::folder::start(app.handle().clone());
            #[cfg(not(mobile))]
            startup_window::show_main_window(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                purchase::start(window.app_handle().clone());
            }
        })
        .invoke_handler(|invoke| {
            if let Some(reason) = purchase::reject_reason(&invoke) {
                invoke.resolver.reject(reason);
                return true;
            }
            if updates::reject_during_install(&invoke) {
                invoke
                    .resolver
                    .reject("An update is being installed. Please wait for the app to restart.");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                save_diagram_export,
                save_diagram_export_binary,
                save_schema_report,
                query_export::export_query_result,
                database_export::export_database_file,
                database_export::cancel_database_export,
                get_runtime_info,
                #[cfg(target_os = "macos")]
                get_system_accent,
                purchase::get_purchase_status,
                purchase::restore_app_purchase,
                purchase::open_app_store,
                get_diagnostic_info,
                reveal_app_directory,
                list_data_sources,
                save_data_source,
                save_and_map_data_source,
                database_server::list_server_databases,
                database_server::create_server_database,
                database_server::open_server_database,
                test_postgres_connection,
                cancel_connection_test,
                connection_security::pick_connection_file,
                file_access::pick_workspace_path,
                code_view::review::choose_code_review_project,
                code_view::review::get_code_review_project,
                code_view::review::list_code_review_projects,
                code_view::review::edit_code_review_project_groups,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::review::code_review_finder_action,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::review::paste_code_review_projects,
                code_view::review::open_saved_code_review_project,
                code_view::review::pin_code_review_project,
                code_view::review::remove_code_review_project,
                code_view::review::refresh_code_review,
                code_view::review::list_code_review_directory,
                code_view::review::list_code_review_paths,
                code_view::search::search_code_review_content,
                code_view::review::read_code_review_file,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::python_debug::prepare_python_debug,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::python_debug::start_python_debug,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::python_debug::control_python_debug,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::python_debug::stop_python_debug,
                #[cfg(all(
                    target_os = "macos",
                    any(feature = "code-extensions", feature = "mac-app-store")
                ))]
                code_view::extensions::list_code_extensions,
                #[cfg(all(target_os = "macos", feature = "code-extensions"))]
                code_view::extensions::install_code_extension,
                #[cfg(all(target_os = "macos", feature = "mac-app-store"))]
                code_view::extensions::syntax_catalog::list_code_syntax_catalog,
                #[cfg(all(target_os = "macos", feature = "mac-app-store"))]
                code_view::extensions::syntax_catalog::import_code_syntax,
                #[cfg(all(
                    target_os = "macos",
                    any(feature = "code-extensions", feature = "mac-app-store")
                ))]
                code_view::extensions::change_code_extension,
                #[cfg(all(
                    target_os = "macos",
                    any(feature = "code-extensions", feature = "mac-app-store")
                ))]
                code_view::extensions::prepare_code_extension,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::extensions::open_vsx::search_code_open_vsx,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::extensions::open_vsx::detail_code_open_vsx,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::extensions::open_vsx::check_code_open_vsx_updates,
                #[cfg(all(
                    target_os = "macos",
                    feature = "code-extensions",
                    not(feature = "mac-app-store")
                ))]
                code_view::extensions::open_vsx::install_code_open_vsx,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::eslint::inspect_code_eslint,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::eslint::approve_code_eslint,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::eslint::run_code_eslint,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::eslint::cancel_code_eslint,
                #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
                code_view::eslint::revoke_code_eslint,
                code_view::review::find_code_definition,
                code_view::review::find_code_document_highlights,
                code_view::review::get_code_document_outline,
                code_view::review::get_code_language_status,
                code_view::review::enable_code_language_services,
                code_view::review::read_code_definition_source,
                connection_sync::export_connection_sync,
                connection_sync::preview_connection_sync,
                connection_sync::import_connection_sync,
                connection_sync::folder::inspect_connection_folder,
                connection_sync::folder::preview_connection_folder_setup,
                connection_sync::folder::enable_connection_folder,
                connection_sync::folder::get_connection_folder_status,
                connection_sync::folder::check_connection_folder,
                connection_sync::folder::set_connection_folder_paused,
                connection_sync::folder::preview_connection_folder_updates,
                connection_sync::folder::apply_connection_folder_updates,
                verify_and_refresh_data_source,
                capture_postgres_snapshot,
                execute_readonly_query,
                execute_table_preview_query,
                table_ddl::read_table_ddl,
                table_row_counts::read_table_row_counts,
                sqlite_source::load_sqlite_table,
                sqlite_source::count_sqlite_table_rows,
                sqlite_source::save_sqlite_table,
                sqlite_source::execute_sqlite_ddl,
                schema_ddl::execute_network_ddl,
                cancel_query,
                list_query_history,
                delete_query_history,
                clear_query_history,
                list_snapshots,
                list_recent_snapshot_ids,
                get_snapshot,
                compare_snapshots,
                compare_environment_snapshots,
                save_change_provenance,
                save_code_lineage,
                export_git_workspace,
                preview_git_export,
                preview_git_import,
                import_git_workspace,
                get_settings,
                update_app_settings,
                update_data_source_settings,
                reset_app_settings,
                reset_data_source_settings,
                update_organization_policy,
                refresh_organization_policy,
                list_cloud_audit,
                bootstrap_cloud_account,
                refresh_cloud_session,
                create_cloud_project,
                list_cloud_shares,
                create_cloud_share,
                revoke_cloud_share,
                rotate_cloud_share,
                update_project_settings,
                get_storage_usage,
                clear_layouts,
                clear_regenerable_cache,
                rename_data_source,
                duplicate_data_source,
                preview_source_data_deletion,
                generate_event_trigger_script,
                delete_source_data,
                factory_reset,
                save_ai_credential,
                save_cloud_credential,
                clear_credentials,
                get_security_status,
                list_sync_diagnostics,
                list_external_access,
                check_merge_driver,
                read_git_conflict_report,
                delete_git_conflict_report,
                export_settings_file,
                preview_settings_file,
                import_settings_file,
                export_portable_backup,
                preview_portable_backup,
                import_portable_backup,
                updates::check_for_updates,
                updates::get_update_status,
                updates::open_update_releases,
                updates::download_update,
                updates::cancel_update_download,
                updates::install_update,
                get_semantics,
                change_review::get_change_review,
                ontology::list_ontology,
                ontology::confirm_ontology,
                ontology::draft_ontology_last_month,
                ontology::save_ontology_sample,
                ontology::verify_ontology_review,
                change_review::apply_change_review,
                knowledge::prepare_knowledge_draft,
                knowledge::confirm_knowledge_draft,
                knowledge::cancel_knowledge_draft,
                list_logical_relationships,
                validate_logical_relationship,
                create_logical_relationship,
                update_logical_relationship,
                delete_logical_relationship,
                ignore_relationship_inference,
                restore_relationship_inference,
                relationship_batches::preview_relationship_batch,
                relationship_batches::apply_relationship_batch,
                relationship_batches::list_relationship_batches,
                relationship_batches::undo_relationship_batch,
                list_ignored_relationship_inferences,
                save_annotation,
                save_domain_group,
                save_view,
                delete_view,
                save_layout,
                explain_schema,
                table_understanding::prepare_table_explanation,
                table_understanding::run_table_explanation,
                table_understanding::cancel_table_explanation,
                discovery::prepare_discovery,
                discovery::run_discovery,
                discovery::cancel_discovery,
                test_ai_provider,
                sync_project
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("failed to build Nodal Studio desktop application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                code_view::review::close_on_exit(app);
            }
            database_export::handle_app_event(app, event);
        });
}

mod commands;
#[allow(clippy::wildcard_imports)]
use commands::{
    ai::*, backup::*, cloud::*, credentials::*, git_merge::*, git_workspace::*, query::*,
    relationships::*, semantics::*, settings::*, storage::*,
};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_ai_requires_consent_matching_current_settings() {
        let mut ai = settings_model::AiSettings::default();
        assert!(validate_remote_consent(&ai, None).is_ok());
        ai.provider = AiProviderKind::OpenAiCompatible;
        ai.endpoint = "https://provider.example/v1".into();
        ai.model = "model".into();
        let mut consent = RemoteAiConsent {
            endpoint: ai.endpoint.clone(),
            model: ai.model.clone(),
            include_comments: ai.include_comments,
        };
        assert!(validate_remote_consent(&ai, None).is_err());
        assert!(validate_remote_consent(&ai, Some(&consent)).is_ok());
        consent.endpoint = "https://other.example/v1".into();
        assert!(validate_remote_consent(&ai, Some(&consent)).is_err());
        consent.endpoint = ai.endpoint.clone();
        consent.include_comments = !ai.include_comments;
        assert!(validate_remote_consent(&ai, Some(&consent)).is_err());
        consent.include_comments = ai.include_comments;
        consent.model = "different".into();
        assert!(validate_remote_consent(&ai, Some(&consent)).is_err());
    }

    /// Some monotonic clocks cannot represent an instant before their origin.
    /// Keep expiry tests real on those platforms instead of panicking or skipping.
    pub(crate) async fn expired_instant(age: Duration) -> std::time::Instant {
        let now = std::time::Instant::now();
        if let Some(past) = now.checked_sub(age) {
            past
        } else {
            tokio::time::sleep(age).await;
            now
        }
    }

    #[tokio::test]
    async fn layout_snapshot_guard_rejects_history_and_other_sources() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let source = Uuid::new_v4();
        let mut before = DatabaseSnapshot::new(
            source,
            schema_model::DatabaseInfo {
                name: "layout-fixture".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![],
        );
        before.canonicalize().unwrap();
        store.save_captured_snapshot(&before).await.unwrap();
        assert!(
            ensure_current_layout_snapshot(&store, source, Some(before.id))
                .await
                .is_ok()
        );
        let mut after = DatabaseSnapshot::new(
            source,
            before.database.clone(),
            vec![schema_model::SchemaDefinition {
                programs: Vec::new(),
                dependencies: Vec::new(),
                name: "public".into(),
                tables: vec![schema_model::TableDefinition::empty("public", "orders")],
                views: vec![],
                enums: vec![],
            }],
        );
        after.canonicalize().unwrap();
        store.save_captured_snapshot(&after).await.unwrap();
        assert!(
            ensure_current_layout_snapshot(&store, source, Some(before.id))
                .await
                .is_err()
        );
        assert!(
            ensure_current_layout_snapshot(&store, source, Some(after.id))
                .await
                .is_ok()
        );
        assert!(
            ensure_current_layout_snapshot(&store, Uuid::new_v4(), Some(after.id))
                .await
                .is_err()
        );
    }

    #[test]
    fn validates_workspace_geometry() {
        let mut layout = CanvasLayout {
            source_id: Uuid::new_v4(),
            view_id: None,
            positions: std::collections::BTreeMap::new(),
            viewport: Some(semantic_model::CanvasViewport {
                x: 0.0,
                y: 1.0,
                zoom: 0.5,
            }),
            updated_at: Utc::now(),
        };
        assert!(validate_canvas_layout(&layout).is_ok());
        layout.viewport.as_mut().unwrap().zoom = 0.0;
        assert!(validate_canvas_layout(&layout).is_err());
        layout.viewport = None;
        layout.positions.insert(
            "public.orders".into(),
            CanvasPosition {
                x: f64::NAN,
                y: 0.0,
                width: None,
                height: None,
                pinned: false,
            },
        );
        assert!(validate_canvas_layout(&layout).is_err());
    }

    #[test]
    fn rejects_incomplete_connection_input() {
        let input = SaveDataSourceInput {
            sqlite: None,
            id: None,
            display_name: String::new(),
            host: "localhost".into(),
            port: 5432,
            database: "app".into(),
            username: "developer".into(),
            password: "secret".into(),
            ssh_password: None,
            ssh_key_passphrase: None,
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Prefer,
            security: schema_model::ConnectionSecurity::default(),
        };
        assert!(validate_connection_input(&input).is_err());
    }

    #[test]
    fn allows_an_existing_profile_to_keep_its_keychain_password() {
        let input = SaveDataSourceInput {
            sqlite: None,
            id: Some(Uuid::new_v4()),
            display_name: "Local development".into(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            username: "developer".into(),
            password: String::new(),
            ssh_password: None,
            ssh_key_passphrase: None,
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Prefer,
            security: schema_model::ConnectionSecurity::default(),
        };
        assert!(validate_connection_profile_input(&input).is_ok());
        assert!(validate_connection_input(&input).is_err());
    }

    #[tokio::test]
    async fn imported_server_keeps_its_pending_identity_until_credentials_are_verified() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let state = AppState {
            store,
            ai_limiter: Arc::new(Semaphore::new(1)),
            snapshot_captures: Arc::default(),
            cloud_operations: Arc::default(),
            active_queries: Arc::default(),
            sessions: ConnectionSessions::default(),
        };
        let id = Uuid::new_v4();
        let input = SaveDataSourceInput {
            sqlite: None,
            id: Some(id),
            display_name: "Imported server".into(),
            host: "db.example".into(),
            port: 5432,
            database: String::new(),
            username: "reader".into(),
            password: String::new(),
            ssh_password: None,
            ssh_key_passphrase: None,
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Require,
            security: schema_model::ConnectionSecurity::default(),
        };
        let now = Utc::now();
        let mut profile = data_source_profile_from_input(&input, id, now, now);
        profile.connection_sync = Some(schema_model::ConnectionSyncIdentity {
            origin_id: Uuid::new_v4(),
            pending: true,
        });
        state.store.save_data_source(&profile).await.unwrap();

        assert_eq!(
            save_data_source_using(input, &state).await.unwrap_err(),
            connection_credentials::DATABASE_PASSWORD_REQUIRED
        );
        assert_eq!(
            state.store.get_data_source(id).await.unwrap(),
            Some(profile)
        );
    }

    #[tokio::test]
    async fn discovers_retired_model_credentials_before_the_schema_is_removed() {
        let root =
            std::env::temp_dir().join(format!("nodalstudio-retired-models-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("model.sqlite3");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&database)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        let connection_id = Uuid::new_v4();
        sqlx::query("PRAGMA user_version = 2")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE model_connections (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO model_connections (id) VALUES (?)")
            .bind(connection_id.to_string())
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        assert_eq!(
            retired_model_connection_ids(&database).await.unwrap(),
            [connection_id]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn removes_the_retired_managed_project_cache() {
        let root =
            std::env::temp_dir().join(format!("nodalstudio-retired-projects-{}", Uuid::new_v4()));
        let projects = root.join("cache").join("projects");
        fs::create_dir_all(projects.join("repository")).unwrap();
        fs::write(
            projects.join("repository").join("README.md"),
            "private source",
        )
        .unwrap();

        cleanup_retired_external_artifacts(&root.join("missing.sqlite3"), &root.join("cache"))
            .await
            .unwrap();

        assert!(!projects.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalizes_openai_compatible_chat_endpoints() {
        assert_eq!(
            remote_chat_endpoint("https://ai.example/v1")
                .unwrap()
                .as_str(),
            "https://ai.example/v1/chat/completions"
        );
        assert!(remote_chat_endpoint("file:///tmp/model").is_err());
        assert!(remote_chat_endpoint("http://ai.example/v1").is_err());
        assert!(remote_chat_endpoint("http://127.0.0.1:11434/v1").is_ok());
    }

    fn relationship_validation_snapshot(source_id: Uuid) -> DatabaseSnapshot {
        let column = |name: &str| schema_model::ColumnDefinition {
            name: name.into(),
            ordinal_position: 1,
            formatted_type: "uuid".into(),
            type_schema: "pg_catalog".into(),
            type_name: "uuid".into(),
            nullable: false,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        };
        let mut users = schema_model::TableDefinition::empty("public", "users");
        users.columns.push(column("id"));
        users.primary_key = Some(schema_model::PrimaryKeyDefinition {
            name: "users_pkey".into(),
            columns: vec!["id".into()],
        });
        let mut orders = schema_model::TableDefinition::empty("public", "orders");
        orders.columns.push(column("user_id"));
        DatabaseSnapshot::new(
            source_id,
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![schema_model::SchemaDefinition {
                programs: Vec::new(),
                dependencies: Vec::new(),
                name: "public".into(),
                tables: vec![users, orders],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        )
    }

    #[test]
    fn validates_logical_relationship_types_duplicates_and_physical_constraints() {
        let source_id = Uuid::new_v4();
        let snapshot = relationship_validation_snapshot(source_id);
        let mut orders = snapshot.schemas[0].tables[1].clone();
        let source = RelationshipEndpoint::new("public", "orders", vec!["user_id".into()]);
        let target = RelationshipEndpoint::new("public", "users", vec!["id".into()]);
        let validation =
            validate_relationship_against_snapshot(&snapshot, &[], &source, &target, None);
        assert!(validation.valid);
        assert_eq!(
            validation.suggested_cardinality,
            RelationshipCardinality::ManyToOne
        );

        let mut mysql_snapshot = snapshot.clone();
        mysql_snapshot.database.database_type = DatabaseType::MySql;
        for table in &mut mysql_snapshot.schemas[0].tables {
            table.columns[0].type_name = "int".into();
            table.columns[0].type_schema = String::new();
            table.columns[0].formatted_type = "int".into();
        }
        mysql_snapshot.schemas[0].tables[0].columns[0].formatted_type = "int unsigned".into();
        let signedness =
            validate_relationship_against_snapshot(&mysql_snapshot, &[], &source, &target, None);
        assert!(!signedness.valid);
        assert!(!signedness.compatible);
        assert_eq!(signedness.message_codes, ["typeMismatch"]);
        assert_eq!(signedness.message_codes.len(), signedness.messages.len());
        assert_eq!(signedness.status, LogicalRelationshipStatus::Conflicted);
        mysql_snapshot.schemas[0].tables[1].columns[0].formatted_type = "INT UNSIGNED".into();
        assert!(
            validate_relationship_against_snapshot(&mysql_snapshot, &[], &source, &target, None)
                .valid
        );

        let now = Utc::now();
        let existing = LogicalRelationship {
            id: Uuid::new_v4(),
            source_id,
            name: "owner".into(),
            source: source.clone(),
            target: target.clone(),
            cardinality: RelationshipCardinality::ManyToOne,
            status: LogicalRelationshipStatus::Active,
            origin: LogicalRelationshipOrigin::Manual,
            note: None,
            evidence: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        assert!(
            validate_relationship_against_snapshot(&snapshot, &[existing], &source, &target, None)
                .duplicate
        );

        orders
            .foreign_keys
            .push(schema_model::ForeignKeyDefinition {
                name: "orders_user_fk".into(),
                columns: vec!["user_id".into()],
                referenced_schema: "public".into(),
                referenced_table: "users".into(),
                referenced_columns: vec!["id".into()],
                on_update: schema_model::ReferentialAction::NoAction,
                on_delete: schema_model::ReferentialAction::NoAction,
                match_type: schema_model::MatchType::Simple,
                deferrable: false,
                initially_deferred: false,
            });
        let physical_snapshot = DatabaseSnapshot::new(
            source_id,
            snapshot.database.clone(),
            vec![schema_model::SchemaDefinition {
                programs: Vec::new(),
                dependencies: Vec::new(),
                name: "public".into(),
                tables: vec![snapshot.schemas[0].tables[0].clone(), orders],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        );
        let physical =
            validate_relationship_against_snapshot(&physical_snapshot, &[], &source, &target, None);
        assert!(physical.physical_exists);
        assert_eq!(
            physical.status,
            LogicalRelationshipStatus::SupersededByPhysical
        );
    }
}

#[cfg(test)]
mod knowledge_tests;

#[cfg(test)]
mod live_acceptance_tests;

#[cfg(test)]
mod live_model_acceptance;
