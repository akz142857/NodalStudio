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
    domain_context, table_context,
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
    MySqlConnectionOptions, connect as connect_mysql, inspect_schema as inspect_mysql_schema,
    test_connection as test_mysql_connection,
};
use postgres_adapter::{
    PostgresConnectionOptions, PostgresSslMode, connect, inspect_schema, test_connection,
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
    kind: &'static str,
    label: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticInfo {
    app_version: &'static str,
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
    id: Option<Uuid>,
    display_name: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    database_type: DatabaseType,
    ssl_mode: SslMode,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateManifest {
    version: String,
    download_url: String,
    notes: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    current_version: String,
    available_version: Option<String>,
    download_url: Option<String>,
    notes: Option<String>,
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

#[derive(Serialize)]
struct OpenAiChatRequest<'a> {
    model: &'a str,
    messages: Vec<OpenAiMessage<'a>>,
    temperature: f32,
}

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiResponseMessage,
}

#[derive(Deserialize)]
struct OpenAiResponseMessage {
    content: String,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLayoutInput {
    source_id: Uuid,
    view_id: Option<Uuid>,
    positions: std::collections::BTreeMap<String, CanvasPosition>,
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
    object_key: Option<schema_model::ObjectKey>,
    domain_group: Option<DomainGroup>,
    change_set: Option<SchemaChangeSet>,
    question: Option<String>,
    relationship_depth: u8,
    ai_enabled: bool,
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
    annotations: Vec<ObjectAnnotation>,
    orphaned_annotations: Vec<ObjectAnnotation>,
    domain_groups: Vec<DomainGroup>,
    saved_views: Vec<SavedView>,
    layout: Option<CanvasLayout>,
    logical_relationships: Vec<LogicalRelationship>,
    ignored_relationship_inferences: Vec<IgnoredRelationshipInference>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSnapshotResult {
    snapshot: DatabaseSnapshot,
    stored: bool,
    change_set: Option<SchemaChangeSet>,
}

#[tauri::command]
fn get_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        kind: "desktop",
        label: "Tauri desktop runtime",
        version: env!("CARGO_PKG_VERSION"),
    }
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
        app_version: env!("CARGO_PKG_VERSION"),
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
    validate_connection_profile_input(&input)?;
    let now = Utc::now();
    let id = input.id.unwrap_or_else(Uuid::new_v4);
    let existing = state
        .store
        .get_data_source(id)
        .await
        .map_err(safe_store_error)?;
    if existing.is_none() && input.password.is_empty() {
        return Err("A database password is required for a new data source.".into());
    }
    let created_at = match existing {
        Some(existing) => existing.created_at,
        None => now,
    };
    if !input.password.is_empty() {
        credential_entry(id)?
            .set_password(&input.password)
            .map_err(|_| {
                "Unable to save the database password in the operating system keychain.".to_owned()
            })?;
    }

    let profile = data_source_profile_from_input(&input, id, created_at, now);
    state
        .store
        .save_data_source(&profile)
        .await
        .map_err(safe_store_error)?;
    Ok(profile)
}

#[tauri::command]
async fn test_postgres_connection(
    input: SaveDataSourceInput,
) -> Result<ConnectionTestResult, String> {
    let input = connection_input_with_resolved_password(input)?;
    validate_connection_input(&input)?;
    test_database_connection(&input).await
}

async fn test_database_connection(
    input: &SaveDataSourceInput,
) -> Result<ConnectionTestResult, String> {
    match input.database_type {
        DatabaseType::PostgreSql => {
            let options = connection_options_from_input(input);
            let pool = connect(&options).await.map_err(safe_connection_error)?;
            let database = test_connection(&pool)
                .await
                .map_err(safe_connection_error)?;
            let server_read_only = sqlx::query_scalar::<_, String>("SHOW transaction_read_only")
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .map(|value| value == "on");
            let ssl_active = sqlx::query_scalar::<_, bool>(
                "SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)",
            )
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
            Ok(ConnectionTestResult {
                database,
                ssl_active,
                server_read_only,
            })
        }
        DatabaseType::MySql => {
            let options = mysql_connection_options_from_input(input);
            let pool = connect_mysql(&options).await.map_err(safe_mysql_error)?;
            let database = test_mysql_connection(&pool)
                .await
                .map_err(safe_mysql_error)?;
            let server_read_only = sqlx::query_scalar::<_, i64>("SELECT @@global.read_only")
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .map(|value| value != 0);
            let ssl_active = sqlx::query("SHOW STATUS LIKE 'Ssl_cipher'")
                .fetch_optional(&pool)
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
    }
}

fn connection_input_with_resolved_password(
    mut input: SaveDataSourceInput,
) -> Result<SaveDataSourceInput, String> {
    validate_connection_profile_input(&input)?;
    if input.password.is_empty() {
        let source_id = input.id.ok_or_else(|| {
            "A database password is required to verify a new connection.".to_owned()
        })?;
        input.password = credential_entry(source_id)?
            .get_password()
            .map_err(|_| "Unable to read the database password from the keychain.".to_owned())?;
    }
    Ok(input)
}

fn data_source_profile_from_input(
    input: &SaveDataSourceInput,
    id: Uuid,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
) -> DataSourceProfile {
    DataSourceProfile {
        id,
        display_name: input.display_name.trim().to_owned(),
        host: input.host.trim().to_owned(),
        port: input.port,
        database: input.database.trim().to_owned(),
        username: input.username.trim().to_owned(),
        database_type: input.database_type,
        ssl_mode: input.ssl_mode,
        created_at,
        updated_at,
    }
}

#[tauri::command]
async fn verify_and_refresh_data_source(
    input: SaveDataSourceInput,
    state: State<'_, AppState>,
) -> Result<VerifyAndRefreshResult, String> {
    let source_id = input
        .id
        .ok_or_else(|| "Verify and refresh requires an existing data source.".to_owned())?;
    let previous_profile = state
        .store
        .get_data_source(source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected data source no longer exists.".to_owned())?;
    let entry = credential_entry(source_id)?;
    let previous_password = entry.get_password().ok();
    let resolved = connection_input_with_resolved_password(input)?;
    validate_connection_input(&resolved)?;
    let connection = test_database_connection(&resolved).await?;
    let profile = data_source_profile_from_input(
        &resolved,
        source_id,
        previous_profile.created_at,
        Utc::now(),
    );

    entry.set_password(&resolved.password).map_err(|_| {
        "Unable to save the database password in the operating system keychain.".to_owned()
    })?;
    if let Err(error) = state.store.save_data_source(&profile).await {
        restore_database_secret(source_id, previous_password.as_deref())?;
        return Err(safe_store_error(error));
    }

    let capture = match capture_snapshot(
        CaptureSnapshotInput {
            source_id,
            trigger: None,
        },
        &state,
    )
    .await
    {
        Ok(capture) => capture,
        Err(error) => {
            let profile_restored = state
                .store
                .save_data_source(&previous_profile)
                .await
                .is_ok();
            let secret_restored =
                restore_database_secret(source_id, previous_password.as_deref()).is_ok();
            if !profile_restored || !secret_restored {
                return Err(format!(
                    "{error} The previous connection profile could not be fully restored."
                ));
            }
            return Err(error);
        }
    };

    Ok(VerifyAndRefreshResult {
        profile,
        connection,
        capture,
    })
}

fn restore_database_secret(source_id: Uuid, previous_password: Option<&str>) -> Result<(), String> {
    match previous_password {
        Some(password) => credential_entry(source_id)?
            .set_password(password)
            .map_err(|_| "Unable to restore the previous database password.".to_owned()),
        None => delete_secret(KEYRING_SERVICE, source_id),
    }
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
    let capture_gate = {
        let mut captures = state.snapshot_captures.lock().await;
        Arc::clone(
            captures
                .entry(input.source_id)
                .or_insert_with(|| Arc::new(Semaphore::new(1))),
        )
    };
    let _capture_permit = capture_gate
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
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected data source no longer exists.".to_owned())?;
    let password = credential_entry(profile.id)?
        .get_password()
        .map_err(|_| "Unable to read the database password from the keychain.".to_owned())?;
    let snapshot = match profile.database_type {
        DatabaseType::PostgreSql => {
            let options = connection_options_from_profile(&profile, &password)
                .with_connect_timeout(Duration::from_secs(u64::from(
                    source_settings.refresh.connection_timeout_seconds,
                )));
            let pool = connect(&options).await.map_err(safe_connection_error)?;
            tokio::time::timeout(
                Duration::from_secs(u64::from(
                    source_settings.refresh.introspection_timeout_seconds,
                )),
                inspect_schema(&pool, profile.id),
            )
            .await
            .map_err(|_| "PostgreSQL introspection timed out.".to_owned())?
            .map_err(safe_connection_error)?
        }
        DatabaseType::MySql => {
            let options = mysql_connection_options_from_profile(&profile, &password)
                .with_connect_timeout(Duration::from_secs(u64::from(
                    source_settings.refresh.connection_timeout_seconds,
                )));
            let pool = connect_mysql(&options).await.map_err(safe_mysql_error)?;
            tokio::time::timeout(
                Duration::from_secs(u64::from(
                    source_settings.refresh.introspection_timeout_seconds,
                )),
                inspect_mysql_schema(&pool, profile.id),
            )
            .await
            .map_err(|_| "MySQL introspection timed out.".to_owned())?
            .map_err(safe_mysql_error)?
        }
    };
    let previous = state
        .store
        .latest_snapshot(profile.id)
        .await
        .map_err(safe_store_error)?;
    let stored = state
        .store
        .save_snapshot(&snapshot)
        .await
        .map_err(safe_store_error)?;
    let change_set = if stored {
        previous.map(|previous| diff_snapshots(&previous, &snapshot))
    } else {
        None
    };
    if let Some(change_set) = &change_set {
        state
            .store
            .save_change_set(change_set)
            .await
            .map_err(safe_store_error)?;
    }
    if stored {
        enqueue_sync_event(
            &state.store,
            profile.id,
            "snapshot.capture",
            &snapshot.fingerprint,
            serde_json::json!({ "snapshot": snapshot, "changeSet": change_set }),
        )
        .await?;
        apply_snapshot_retention(&state.store, profile.id).await?;
    }

    Ok(CaptureSnapshotResult {
        snapshot,
        stored,
        change_set,
    })
}

#[tauri::command]
async fn execute_readonly_query(
    input: ExecuteReadonlyQueryInput,
    state: State<'_, AppState>,
) -> Result<QueryExecutionResult, QueryCommandError> {
    let query_id = input.query_id;
    let started = std::time::Instant::now();
    let executed_at = Utc::now().to_rfc3339();
    let request = ExecuteQueryRequest {
        query_id,
        sql: input.sql.clone(),
        row_limit: input.row_limit,
        timeout_ms: input.timeout_ms,
        max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
        max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
    };
    request
        .validate()
        .map_err(|error| query_command_error(query_id, error))?;

    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(|_| query_command_error(query_id, QueryError::Connection))?
        .ok_or_else(|| query_command_error(query_id, QueryError::Connection))?;
    if profile.database_type != DatabaseType::PostgreSql {
        return Err(query_command_error(
            query_id,
            QueryError::Validation("Query currently supports PostgreSQL data sources only.".into()),
        ));
    }
    let password = credential_entry(profile.id)
        .map_err(|_| query_command_error(query_id, QueryError::Connection))?
        .get_password()
        .map_err(|_| query_command_error(query_id, QueryError::Connection))?;
    let source_settings = state
        .store
        .get_data_source_settings(profile.id)
        .await
        .map_err(|_| query_command_error(query_id, QueryError::Connection))?;
    let options = connection_options_from_profile(&profile, &password).with_connect_timeout(
        Duration::from_secs(u64::from(
            source_settings.refresh.connection_timeout_seconds,
        )),
    );
    let pool = connect(&options)
        .await
        .map_err(|_| query_command_error(query_id, QueryError::Connection))?;
    let cancellation = CancellationToken::new();
    {
        let mut active = state.active_queries.lock().await;
        if active
            .values()
            .any(|(source_id, _)| *source_id == input.source_id)
        {
            return Err(query_command_error(
                query_id,
                QueryError::Validation("A query is already running for this data source.".into()),
            ));
        }
        active.insert(query_id, (input.source_id, cancellation.clone()));
    }
    let result = execute_postgres_query(&pool, &request, &cancellation).await;
    state.active_queries.lock().await.remove(&query_id);
    pool.close().await;

    let history = match &result {
        Ok(value) => QueryHistoryEntry {
            id: Uuid::new_v4(),
            source_id: input.source_id,
            executed_at,
            sql_text: input.sql,
            duration_ms: value.duration_ms,
            row_count: value.row_count,
            status: "succeeded".into(),
            error_kind: None,
        },
        Err(error) => QueryHistoryEntry {
            id: Uuid::new_v4(),
            source_id: input.source_id,
            executed_at,
            sql_text: input.sql,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            row_count: 0,
            status: if matches!(error, QueryError::Cancelled) {
                "cancelled".into()
            } else {
                "failed".into()
            },
            error_kind: Some(error.kind().into()),
        },
    };
    let _ = state.store.save_query_history(&history).await;
    result.map_err(|error| query_command_error(query_id, error))
}

#[tauri::command]
async fn cancel_query(input: QueryIdInput, state: State<'_, AppState>) -> Result<bool, String> {
    let active = state.active_queries.lock().await;
    let Some((_, cancellation)) = active.get(&input.query_id) else {
        return Ok(false);
    };
    cancellation.cancel();
    Ok(true)
}

#[tauri::command]
async fn list_query_history(
    input: QueryHistoryInput,
    state: State<'_, AppState>,
) -> Result<Vec<QueryHistoryEntry>, String> {
    state
        .store
        .list_query_history(input.source_id, input.limit.unwrap_or(100))
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn delete_query_history(
    input: DeleteQueryHistoryInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .store
        .delete_query_history(input.source_id, input.history_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn clear_query_history(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    state
        .store
        .clear_query_history(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[allow(clippy::needless_pass_by_value)]
fn query_command_error(query_id: Uuid, error: QueryError) -> QueryCommandError {
    QueryCommandError {
        query_id,
        kind: error.kind().into(),
        message: error.public_message(),
    }
}

async fn apply_snapshot_retention(
    store: &LocalSnapshotStore,
    source_id: Uuid,
) -> Result<(), String> {
    let settings = store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    let (retain_count, cutoff) = match settings.storage.retention {
        settings_model::RetentionPolicy::Forever => (None, None),
        settings_model::RetentionPolicy::Count => {
            (Some(usize::from(settings.storage.retention_value)), None)
        }
        settings_model::RetentionPolicy::Days => (
            None,
            Some(
                (Utc::now() - chrono::Duration::days(i64::from(settings.storage.retention_value)))
                    .to_rfc3339(),
            ),
        ),
    };
    if retain_count.is_some() || cutoff.is_some() {
        store
            .prune_snapshots(
                source_id,
                retain_count,
                cutoff.as_deref(),
                settings.storage.preserve_high_risk,
            )
            .await
            .map_err(safe_store_error)?;
    }
    Ok(())
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
async fn export_git_workspace(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<ExportReceipt, String> {
    let (_, workspace) = render_local_workspace(&state.store, input.source_id).await?;
    write_workspace(
        std::path::Path::new(input.repository_path.trim()),
        &workspace,
    )
    .map_err(|error| safe_git_workspace_error(&error))
}

async fn render_local_workspace(
    store: &LocalSnapshotStore,
    source_id: Uuid,
) -> Result<(DatabaseSnapshot, WorkspaceFiles), String> {
    let snapshot = store
        .latest_snapshot(source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before exporting Git workspace files.".to_owned())?;
    let annotations = store
        .list_annotations(source_id)
        .await
        .map_err(safe_store_error)?;
    let domain_groups = store
        .list_domain_groups(source_id)
        .await
        .map_err(safe_store_error)?;
    let saved_views = store
        .list_views(source_id)
        .await
        .map_err(safe_store_error)?;
    let provenance = store
        .list_change_provenance(source_id)
        .await
        .map_err(safe_store_error)?;
    let lineage = store
        .list_lineage(source_id)
        .await
        .map_err(safe_store_error)?;
    let relationships = store
        .list_logical_relationships(source_id)
        .await
        .map_err(safe_store_error)?;
    let workspace = render_workspace(&WorkspaceInput {
        snapshot: &snapshot,
        annotations: &annotations,
        domain_groups: &domain_groups,
        saved_views: &saved_views,
        provenance: &provenance,
        lineage: &lineage,
        relationships: &relationships,
    })
    .map_err(|error| safe_git_workspace_error(&error))?;
    Ok((snapshot, workspace))
}

#[tauri::command]
async fn preview_git_export(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<WorkspacePreview, String> {
    let (_, workspace) = render_local_workspace(&state.store, input.source_id).await?;
    preview_workspace(
        std::path::Path::new(input.repository_path.trim()),
        &workspace,
    )
    .map_err(|error| safe_git_workspace_error(&error))
}

#[tauri::command]
async fn preview_git_import(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<GitImportPreview, String> {
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before importing Git workspace files.".to_owned())?;
    let workspace = read_workspace(std::path::Path::new(input.repository_path.trim()))
        .map_err(|error| safe_git_workspace_error(&error))?;
    let local_relationships = state
        .store
        .list_logical_relationships(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let relationship_conflicts = workspace
        .relationships
        .iter()
        .filter_map(|document| {
            let key = logical_relationship_key(&document.from, &document.to);
            local_relationships
                .iter()
                .find(|relationship| relationship.relationship_key() == key)
                .and_then(|relationship| {
                    (relationship.name != document.name
                        || relationship.cardinality != document.cardinality
                        || relationship.note != document.note)
                        .then_some(key)
                })
        })
        .collect();
    Ok(GitImportPreview {
        annotations: workspace
            .semantics
            .iter()
            .map(|document| {
                usize::from(document.value != SemanticValue::default()) + document.members.len()
            })
            .sum(),
        domain_groups: workspace.domain_groups.len(),
        saved_views: workspace.saved_views.len(),
        provenance: workspace.provenance.len(),
        lineage_links: workspace.lineage.len(),
        logical_relationships: workspace.relationships.len(),
        relationship_conflicts,
        fingerprint_matches: snapshot.fingerprint == workspace.manifest.schema_fingerprint,
        workspace_fingerprint: workspace.manifest.schema_fingerprint,
    })
}

#[tauri::command]
async fn import_git_workspace(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<ImportGitWorkspaceResult, String> {
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before importing Git workspace files.".to_owned())?;
    let workspace = read_workspace(std::path::Path::new(input.repository_path.trim()))
        .map_err(|error| safe_git_workspace_error(&error))?;
    let now = Utc::now();
    let imported_annotations =
        import_git_semantics(&state.store, input.source_id, &workspace.semantics, now).await?;
    import_git_domain_groups(&state.store, input.source_id, &workspace.domain_groups, now).await?;
    import_git_saved_views(&state.store, input.source_id, &workspace.saved_views, now).await?;
    import_git_provenance(&state.store, &workspace.provenance, now).await?;
    if !workspace.lineage.is_empty() {
        state
            .store
            .replace_lineage(input.source_id, &workspace.lineage)
            .await
            .map_err(safe_store_error)?;
    }
    let existing_relationships = state
        .store
        .list_logical_relationships(input.source_id)
        .await
        .map_err(safe_store_error)?;
    let mut imported_logical_relationships = 0;
    for document in &workspace.relationships {
        let key = logical_relationship_key(&document.from, &document.to);
        let existing_id = existing_relationships
            .iter()
            .find(|relationship| relationship.relationship_key() == key)
            .map(|relationship| relationship.id);
        persist_logical_relationship(
            SaveLogicalRelationshipInput {
                id: existing_id,
                source_id: input.source_id,
                name: document.name.clone(),
                source: document.from.clone(),
                target: document.to.clone(),
                cardinality: document.cardinality,
                origin: Some(LogicalRelationshipOrigin::Imported),
                note: document.note.clone(),
                evidence: vec!["Imported from .nodalstudio/relationships".into()],
                disabled: false,
                allow_type_mismatch: true,
            },
            &state,
        )
        .await?;
        imported_logical_relationships += 1;
    }
    Ok(ImportGitWorkspaceResult {
        imported_annotations,
        imported_domain_groups: workspace.domain_groups.len(),
        imported_saved_views: workspace.saved_views.len(),
        imported_provenance: workspace.provenance.len(),
        imported_lineage_links: workspace.lineage.len(),
        imported_logical_relationships,
        fingerprint_matches: snapshot.fingerprint == workspace.manifest.schema_fingerprint,
        workspace_fingerprint: workspace.manifest.schema_fingerprint,
    })
}

async fn import_git_semantics(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    semantics: &[SemanticDocument],
    updated_at: chrono::DateTime<Utc>,
) -> Result<usize, String> {
    let mut imported = 0;
    for document in semantics {
        if document.value != SemanticValue::default() {
            store
                .save_annotation(&git_annotation(
                    source_id,
                    document.object.clone(),
                    &document.value,
                    updated_at,
                ))
                .await
                .map_err(safe_store_error)?;
            imported += 1;
        }
        for (member, value) in &document.members {
            if let Some(column) = member.strip_prefix("column:") {
                store
                    .save_annotation(&git_annotation(
                        source_id,
                        document
                            .object
                            .child(schema_model::ObjectKind::Column, column),
                        value,
                        updated_at,
                    ))
                    .await
                    .map_err(safe_store_error)?;
                imported += 1;
            }
        }
    }
    Ok(imported)
}

async fn import_git_domain_groups(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    documents: &[DomainDocument],
    updated_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    for document in documents {
        let mut group = DomainGroup {
            id: document.id,
            source_id,
            name: document.name.clone(),
            description: document.description.clone(),
            color: document.color.clone(),
            table_keys: document.tables.clone(),
            updated_at,
        };
        group.canonicalize();
        store
            .save_domain_group(&group)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(())
}

async fn import_git_saved_views(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    documents: &[ViewDocument],
    updated_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    for document in documents {
        let mut view = SavedView {
            id: document.id,
            source_id,
            name: document.name.clone(),
            root_table_keys: document.roots.clone(),
            relationship_depth: document.relationship_depth,
            updated_at,
        };
        view.canonicalize();
        store.save_view(&view).await.map_err(safe_store_error)?;
    }
    Ok(())
}

async fn import_git_provenance(
    store: &LocalSnapshotStore,
    documents: &[ProvenanceDocument],
    recorded_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    for document in documents {
        let mut provenance = ChangeProvenance {
            change_set_id: document.change_set_id,
            branch: document.branch.clone(),
            commit_sha: document.commit_sha.clone(),
            pull_request_url: document.pull_request_url.clone(),
            migration_files: document.migration_files.clone(),
            recorded_at,
        };
        provenance.canonicalize();
        store
            .save_change_provenance(&provenance)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(())
}

fn git_annotation(
    source_id: Uuid,
    object_key: schema_model::ObjectKey,
    value: &SemanticValue,
    updated_at: chrono::DateTime<Utc>,
) -> ObjectAnnotation {
    ObjectAnnotation {
        source_id,
        object_key,
        description: value.description.clone(),
        tags: value.tags.iter().cloned().collect(),
        owner: value.owner.clone(),
        is_core: value.is_core,
        updated_at,
    }
}

#[tauri::command]
async fn get_semantics(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<SemanticBundle, String> {
    let annotations = state
        .store
        .list_annotations(input.source_id)
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
    let (annotations, orphaned_annotations, domain_groups) = if let Some(snapshot) = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
    {
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
        annotations,
        orphaned_annotations,
        domain_groups,
        saved_views,
        layout,
        logical_relationships: validated_logical_relationships(&state.store, input.source_id)
            .await?,
        ignored_relationship_inferences: state
            .store
            .list_ignored_relationship_inferences(input.source_id)
            .await
            .map_err(safe_store_error)?,
    })
}

#[tauri::command]
async fn get_settings(
    input: SettingsInput,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    effective_settings(&state.store, input.source_id).await
}

async fn effective_settings(
    store: &LocalSnapshotStore,
    source_id: Option<Uuid>,
) -> Result<EffectiveSettings, String> {
    let app = store.get_app_settings().await.map_err(safe_store_error)?;
    let source = if let Some(source_id) = source_id {
        Some(
            store
                .get_data_source_settings(source_id)
                .await
                .map_err(safe_store_error)?,
        )
    } else {
        None
    };
    let project = if let Some(project_id) = source
        .as_ref()
        .map(|settings| settings.cloud.project_id.trim())
        .filter(|project_id| !project_id.is_empty())
    {
        store
            .get_project_settings(project_id)
            .await
            .map_err(safe_store_error)?
    } else {
        None
    };
    let mut policy = store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    if policy.expires_at.as_deref().is_some_and(|value| {
        chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|expires| expires <= Utc::now())
    }) {
        policy = OrganizationPolicy::default();
    }
    Ok(apply_settings_layers(app, source, project, &policy))
}

#[tauri::command]
async fn update_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    settings
        .validate()
        .map_err(|error| format!("Invalid settings: {error}"))?;
    state
        .store
        .save_app_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    let policy = state
        .store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_policy(settings, None, &policy))
}

#[tauri::command]
async fn update_data_source_settings(
    settings: DataSourceSettings,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    settings
        .validate()
        .map_err(|error| format!("Invalid settings: {error}"))?;
    state
        .store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    let policy = state
        .store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_policy(app, Some(settings), &policy))
}

#[tauri::command]
async fn reset_app_settings(state: State<'_, AppState>) -> Result<EffectiveSettings, String> {
    update_app_settings(AppSettings::default(), state).await
}

#[tauri::command]
async fn reset_data_source_settings(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    update_data_source_settings(DataSourceSettings::defaults_for(input.source_id), state).await
}

#[tauri::command]
async fn update_organization_policy(
    policy: OrganizationPolicy,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    state
        .store
        .save_organization_policy(&policy)
        .await
        .map_err(safe_store_error)?;
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_policy(app, None, &policy))
}

#[tauri::command]
async fn refresh_organization_policy(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Organization policy refresh is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    if cloud.endpoint.trim().is_empty() || cloud.team_id.trim().is_empty() {
        return Err("Configure a Cloud endpoint and Team ID before refreshing policy.".into());
    }
    let mut endpoint = reqwest::Url::parse(cloud.endpoint.trim())
        .map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() != "https" && !local_development {
        return Err("Cloud policy refresh requires HTTPS outside local development.".into());
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    let team_id = Uuid::parse_str(cloud.team_id.trim())
        .map_err(|_| "Team ID must be a valid UUID.".to_owned())?;
    let endpoint = endpoint
        .join(&format!("v1/teams/{team_id}/policy"))
        .map_err(|_| "Cloud API URL cannot form a policy endpoint.".to_owned())?;
    let access_token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure the Cloud token before refreshing policy.".to_owned())?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let policy = cloud_http_client()?
        .get(endpoint)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "Cloud policy endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the organization policy request.".to_owned())?
        .json::<OrganizationPolicy>()
        .await
        .map_err(|_| "Cloud returned an invalid organization policy.".to_owned())?;
    state
        .store
        .save_organization_policy(&policy)
        .await
        .map_err(safe_store_error)?;
    effective_settings(&state.store, Some(input.source_id)).await
}

#[tauri::command]
async fn list_cloud_audit(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<CloudAuditEntry>, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud audit is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let project_id = Uuid::parse_str(cloud.project_id.trim()).map_err(|_| {
        "Configure a valid Cloud Project ID before loading audit events.".to_owned()
    })?;
    let mut endpoint = reqwest::Url::parse(cloud.endpoint.trim())
        .map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() != "https" && !local_development {
        return Err("Cloud audit requires HTTPS outside local development.".into());
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    let endpoint = endpoint
        .join(&format!("v1/projects/{project_id}/audit"))
        .map_err(|_| "Cloud API URL cannot form an audit endpoint.".to_owned())?;
    let token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure the Cloud token before loading audit events.".to_owned())?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    cloud_http_client()?
        .get(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cloud audit endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the audit request.".to_owned())?
        .json::<Vec<CloudAuditEntry>>()
        .await
        .map_err(|_| "Cloud returned invalid audit events.".to_owned())
}

fn cloud_settings_endpoint(base: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut endpoint =
        reqwest::Url::parse(base.trim()).map_err(|_| "Cloud API URL is invalid.".to_owned())?;
    let local_development = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1"));
    if endpoint.scheme() != "https" && !local_development {
        return Err("Cloud account operations require HTTPS outside local development.".into());
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    endpoint
        .join(path)
        .map_err(|_| "Cloud API URL cannot form the requested endpoint.".to_owned())
}

async fn persist_cloud_session(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    account_label: String,
    session: CloudAuthSession,
) -> Result<CloudAccountResult, String> {
    save_secret(CLOUD_KEYRING_SERVICE, source_id, &session.access_token)?;
    save_secret(
        CLOUD_REFRESH_KEYRING_SERVICE,
        source_id,
        &session.refresh_token,
    )?;
    let mut settings = store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    settings.cloud.account_label.clone_from(&account_label);
    settings.cloud.team_id = session.team_id.to_string();
    settings.cloud.credential_configured = true;
    store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    Ok(CloudAccountResult {
        account_label,
        team_id: session.team_id.to_string(),
        access_expires_at: session.access_expires_at,
    })
}

#[tauri::command]
async fn bootstrap_cloud_account(
    input: CloudBootstrapInput,
    state: State<'_, AppState>,
) -> Result<CloudAccountResult, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud account creation is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let endpoint = cloud_settings_endpoint(&cloud.endpoint, "v1/auth/bootstrap")?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let account_label = input.email.trim().to_owned();
    let session = cloud_http_client()?
        .post(endpoint)
        .header("x-bootstrap-secret", input.bootstrap_secret)
        .json(&serde_json::json!({
            "email": input.email,
            "displayName": input.display_name,
            "teamName": input.team_name,
        }))
        .send()
        .await
        .map_err(|_| "Cloud account endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud account creation was rejected.".to_owned())?
        .json::<CloudAuthSession>()
        .await
        .map_err(|_| "Cloud returned an invalid account session.".to_owned())?;
    persist_cloud_session(&state.store, input.source_id, account_label, session).await
}

#[tauri::command]
async fn refresh_cloud_session(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<CloudAccountResult, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud session refresh is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let endpoint = cloud_settings_endpoint(&cloud.endpoint, "v1/auth/refresh")?;
    let refresh_token =
        keyring::Entry::new(CLOUD_REFRESH_KEYRING_SERVICE, &input.source_id.to_string())
            .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
            .get_password()
            .map_err(|_| "No Cloud refresh token is stored in Keychain.".to_owned())?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let session = cloud_http_client()?
        .post(endpoint)
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|_| "Cloud session endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud session refresh was rejected.".to_owned())?
        .json::<CloudAuthSession>()
        .await
        .map_err(|_| "Cloud returned an invalid refreshed session.".to_owned())?;
    persist_cloud_session(
        &state.store,
        input.source_id,
        cloud.account_label.clone(),
        session,
    )
    .await
}

#[tauri::command]
async fn create_cloud_project(
    input: CloudProjectInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud project creation is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let team_id = Uuid::parse_str(cloud.team_id.trim())
        .map_err(|_| "Configure a valid Team ID before creating a project.".to_owned())?;
    let endpoint = cloud_settings_endpoint(&cloud.endpoint, "v1/projects")?;
    let token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &input.source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| {
            "Configure or refresh the Cloud account before creating a project.".to_owned()
        })?;
    state
        .store
        .record_external_access("cloud", "attempted")
        .await
        .map_err(safe_store_error)?;
    let project = cloud_http_client()?
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "teamId": team_id, "name": input.name }))
        .send()
        .await
        .map_err(|_| "Cloud project endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud project creation was rejected.".to_owned())?
        .json::<CloudProjectRecord>()
        .await
        .map_err(|_| "Cloud returned an invalid project record.".to_owned())?;
    let mut settings = state
        .store
        .get_data_source_settings(input.source_id)
        .await
        .map_err(safe_store_error)?;
    settings.cloud.project_id = project.id.to_string();
    settings.cloud.enabled = true;
    settings.cloud.base_version = 0;
    state
        .store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    Ok(format!("{} ({})", project.name, project.id))
}

async fn cloud_project_request(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    suffix: &str,
) -> Result<(reqwest::Url, String), String> {
    let effective = effective_settings(store, Some(source_id)).await?;
    if effective.app.privacy.offline_mode {
        return Err("Cloud sharing is blocked by completely offline mode.".into());
    }
    let cloud = effective
        .source
        .as_ref()
        .map(|source| &source.cloud)
        .ok_or_else(|| "Cloud settings are unavailable for this data source.".to_owned())?;
    let project_id = Uuid::parse_str(cloud.project_id.trim())
        .map_err(|_| "Configure a valid Cloud Project ID first.".to_owned())?;
    let endpoint = cloud_settings_endpoint(
        &cloud.endpoint,
        &format!("v1/projects/{project_id}/shares{suffix}"),
    )?;
    let token = keyring::Entry::new(CLOUD_KEYRING_SERVICE, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure or refresh the Cloud account first.".to_owned())?;
    Ok((endpoint, token))
}

#[tauri::command]
async fn list_cloud_shares(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<CloudShareSummary>, String> {
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, "").await?;
    cloud_http_client()?
        .get(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share list request.".to_owned())?
        .json()
        .await
        .map_err(|_| "Cloud returned invalid share records.".to_owned())
}

#[tauri::command]
async fn create_cloud_share(
    input: CloudShareInput,
    state: State<'_, AppState>,
) -> Result<CloudShareRecord, String> {
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, "").await?;
    cloud_http_client()?
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "expiresAt": input.expires_at }))
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share creation request.".to_owned())?
        .json()
        .await
        .map_err(|_| "Cloud returned an invalid share record.".to_owned())
}

#[tauri::command]
async fn revoke_cloud_share(
    input: CloudShareActionInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let suffix = format!("/{}", input.share_id);
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, &suffix).await?;
    cloud_http_client()?
        .delete(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share revocation request.".to_owned())?;
    Ok(())
}

#[tauri::command]
async fn rotate_cloud_share(
    input: CloudShareActionInput,
    state: State<'_, AppState>,
) -> Result<CloudShareRecord, String> {
    let suffix = format!("/{}/rotate", input.share_id);
    let (endpoint, token) = cloud_project_request(&state.store, input.source_id, &suffix).await?;
    cloud_http_client()?
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "expiresAt": input.expires_at }))
        .send()
        .await
        .map_err(|_| "Cloud share endpoint is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "Cloud rejected the share rotation request.".to_owned())?
        .json()
        .await
        .map_err(|_| "Cloud returned an invalid share record.".to_owned())
}

#[tauri::command]
async fn update_project_settings(
    settings: ProjectSettings,
    state: State<'_, AppState>,
) -> Result<EffectiveSettings, String> {
    settings
        .validate()
        .map_err(|error| format!("Invalid project settings: {error}"))?;
    let mut source_id = None;
    for profile in state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)?
    {
        let source_settings = state
            .store
            .get_data_source_settings(profile.id)
            .await
            .map_err(safe_store_error)?;
        if source_settings.cloud.project_id == settings.project_id {
            source_id = Some(profile.id);
            break;
        }
    }
    let _operation = if let Some(source_id) = source_id {
        Some(acquire_cloud_operation(&state, source_id).await?)
    } else {
        None
    };
    state
        .store
        .save_project_settings(&settings)
        .await
        .map_err(safe_store_error)?;
    if let Some(source_id) = source_id {
        enqueue_sync_event(
            &state.store,
            source_id,
            "project.settings",
            &settings.updated_at,
            serde_json::to_value(&settings)
                .map_err(|_| "Unable to create project settings sync metadata.".to_owned())?,
        )
        .await?;
    }
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    let policy = state
        .store
        .get_organization_policy()
        .await
        .map_err(safe_store_error)?;
    Ok(apply_settings_layers(app, None, Some(settings), &policy))
}

#[tauri::command]
async fn get_storage_usage(state: State<'_, AppState>) -> Result<StorageUsage, String> {
    state.store.storage_usage().await.map_err(safe_store_error)
}

#[tauri::command]
async fn clear_layouts(input: SettingsInput, state: State<'_, AppState>) -> Result<u64, String> {
    state
        .store
        .clear_layouts(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
const fn clear_regenerable_cache() -> u64 {
    // Schema models are persisted as history, not cache. This remains an
    // explicit boundary for future thumbnails or derived search indexes.
    0
}

#[tauri::command]
async fn delete_source_data(
    input: DeleteSourceDataInput,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if !input.selection.connection && !input.selection.history && !input.selection.semantics {
        return Err("Select at least one local data category to delete.".into());
    }
    let affected = state
        .store
        .delete_source_data(
            input.source_id,
            input.selection.connection,
            input.selection.history,
            input.selection.semantics,
        )
        .await
        .map_err(safe_store_error)?;
    if input.remove_database_credential {
        delete_secret(KEYRING_SERVICE, input.source_id)?;
    }
    Ok(affected)
}

#[tauri::command]
async fn preview_source_data_deletion(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<SourceDataImpact, String> {
    state
        .store
        .source_data_impact(input.source_id)
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn generate_event_trigger_script(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The data source no longer exists.".to_owned())?;
    if profile.database_type != DatabaseType::PostgreSql {
        return Err("Event Trigger enhancement is currently available for PostgreSQL only.".into());
    }
    Ok(EventTriggerPlan {
        schema: "public".into(),
        channel: format!("nodalstudio_{}", input.source_id.simple()),
        enabled: true,
    }
    .review_sql())
}

#[tauri::command]
async fn rename_data_source(
    input: RenameSourceInput,
    state: State<'_, AppState>,
) -> Result<DataSourceProfile, String> {
    if input.display_name.trim().is_empty() {
        return Err("A data source name is required.".into());
    }
    let mut profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The data source no longer exists.".to_owned())?;
    profile.display_name = input.display_name.trim().to_owned();
    profile.updated_at = Utc::now();
    state
        .store
        .save_data_source(&profile)
        .await
        .map_err(safe_store_error)?;
    Ok(profile)
}

#[tauri::command]
async fn duplicate_data_source(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<DataSourceProfile, String> {
    let original = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The data source no longer exists.".to_owned())?;
    let now = Utc::now();
    let copy = DataSourceProfile {
        id: Uuid::new_v4(),
        display_name: format!("{} copy", original.display_name),
        host: original.host,
        port: original.port,
        database: original.database,
        username: original.username,
        database_type: original.database_type,
        ssl_mode: original.ssl_mode,
        created_at: now,
        updated_at: now,
    };
    state
        .store
        .save_data_source(&copy)
        .await
        .map_err(safe_store_error)?;
    let mut source_settings = state
        .store
        .get_data_source_settings(input.source_id)
        .await
        .map_err(safe_store_error)?;
    source_settings.source_id = copy.id;
    source_settings.ai.credential_configured = false;
    source_settings.cloud.credential_configured = false;
    source_settings.cloud.enabled = false;
    source_settings.cloud.project_id.clear();
    source_settings.cloud.base_version = 0;
    source_settings.cloud.last_success_at = None;
    state
        .store
        .save_data_source_settings(&source_settings)
        .await
        .map_err(safe_store_error)?;
    Ok(copy)
}

#[tauri::command]
async fn factory_reset(
    input: FactoryResetInput,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    if input.confirmation != "DELETE LOCAL DATA" {
        return Err("Factory reset requires the exact confirmation phrase.".into());
    }
    let profiles = state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)?;
    for profile in &profiles {
        delete_secret(KEYRING_SERVICE, profile.id)?;
        delete_secret(AI_KEYRING_SERVICE, profile.id)?;
        delete_secret(CLOUD_KEYRING_SERVICE, profile.id)?;
        delete_secret(CLOUD_REFRESH_KEYRING_SERVICE, profile.id)?;
    }
    state.store.factory_reset().await.map_err(safe_store_error)
}

#[tauri::command]
async fn save_ai_credential(input: SecretInput, state: State<'_, AppState>) -> Result<(), String> {
    save_secret(AI_KEYRING_SERVICE, input.source_id, &input.secret)?;
    mark_credential_configured(&state.store, input.source_id, "ai", true).await
}

#[tauri::command]
async fn save_cloud_credential(
    input: SecretInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    save_secret(CLOUD_KEYRING_SERVICE, input.source_id, &input.secret)?;
    mark_credential_configured(&state.store, input.source_id, "cloud", true).await
}

#[tauri::command]
async fn clear_credentials(
    input: ClearCredentialsInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if input.database {
        delete_secret(KEYRING_SERVICE, input.source_id)?;
    }
    if input.ai {
        delete_secret(AI_KEYRING_SERVICE, input.source_id)?;
        mark_credential_configured(&state.store, input.source_id, "ai", false).await?;
    }
    if input.cloud {
        delete_secret(CLOUD_KEYRING_SERVICE, input.source_id)?;
        delete_secret(CLOUD_REFRESH_KEYRING_SERVICE, input.source_id)?;
        mark_credential_configured(&state.store, input.source_id, "cloud", false).await?;
    }
    Ok(())
}

#[tauri::command]
async fn get_security_status(
    input: SettingsInput,
    state: State<'_, AppState>,
) -> Result<SecurityStatus, String> {
    let app = state
        .store
        .get_app_settings()
        .await
        .map_err(safe_store_error)?;
    let profiles = state
        .store
        .list_data_sources()
        .await
        .map_err(safe_store_error)?;
    let pending = state.store.pending_sync().await.map_err(safe_store_error)?;
    let source_id = input.source_id;
    let mut stale_model_sources = 0_u64;
    for profile in &profiles {
        let model_is_stale = state
            .store
            .latest_snapshot(profile.id)
            .await
            .map_err(safe_store_error)?
            .is_none_or(|snapshot| Utc::now() - snapshot.captured_at > chrono::Duration::days(30));
        stale_model_sources += u64::from(model_is_stale);
    }
    let mut unresolved_git_conflict_reports = 0_u64;
    for settings in state
        .store
        .list_data_source_settings()
        .await
        .map_err(safe_store_error)?
    {
        let path = std::path::Path::new(settings.git.repository_path.trim()).join(".nodalstudio");
        // A directory that cannot be read must not audit as zero conflicts: this
        // is the security panel, and "could not check" reported as "nothing to
        // see" is the one failure mode it must not have. list_conflict_reports
        // already returns Ok(empty) when there is simply no workspace.
        unresolved_git_conflict_reports +=
            u64::try_from(list_conflict_reports(&path)?.len()).unwrap_or(u64::MAX);
    }
    Ok(SecurityStatus {
        offline_mode: app.privacy.offline_mode,
        database_credential_configured: source_id
            .is_some_and(|id| credential_exists(KEYRING_SERVICE, id)),
        ai_credential_configured: source_id
            .is_some_and(|id| credential_exists(AI_KEYRING_SERVICE, id)),
        cloud_credential_configured: source_id
            .is_some_and(|id| credential_exists(CLOUD_KEYRING_SERVICE, id)),
        weak_ssl_sources: profiles
            .iter()
            .filter(|profile| profile.ssl_mode == SslMode::Disable)
            .count() as u64,
        failed_or_conflicted_sync_items: pending
            .iter()
            .filter(|item| item.state == "conflict" || item.attempts > 0)
            .count() as u64,
        stale_model_sources,
        unresolved_git_conflict_reports,
    })
}

#[tauri::command]
async fn list_sync_diagnostics(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<SyncDiagnostic>, String> {
    Ok(state
        .store
        .pending_sync()
        .await
        .map_err(safe_store_error)?
        .into_iter()
        .filter(|item| item.source_id == input.source_id)
        .map(|item| SyncDiagnostic {
            id: item.id,
            event_kind: item.event_kind,
            attempts: item.attempts,
            state: item.state,
            created_at: item.created_at,
        })
        .collect())
}

#[tauri::command]
async fn list_external_access(
    state: State<'_, AppState>,
) -> Result<Vec<ExternalAccessRecord>, String> {
    state
        .store
        .list_external_access()
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn check_merge_driver(
    input: ExportGitWorkspaceInput,
    state: State<'_, AppState>,
) -> Result<MergeDriverStatus, String> {
    let root = std::path::Path::new(input.repository_path.trim());
    if !root.is_absolute() || !root.is_dir() {
        return Err("Choose an existing absolute repository directory.".into());
    }
    let repository_is_git = Command::new("git")
        .args([
            "-C",
            input.repository_path.trim(),
            "rev-parse",
            "--is-inside-work-tree",
        ])
        .output()
        .is_ok_and(|output| output.status.success());
    let driver_configured = Command::new("git")
        .args([
            "-C",
            input.repository_path.trim(),
            "config",
            "--get",
            "merge.nodalstudio-semantic.driver",
        ])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains("nodalstudio-semantic-merge")
        });
    let workspace_root = root.join(".nodalstudio");
    let attributes_configured = fs::read_to_string(workspace_root.join(".gitattributes"))
        .is_ok_and(|value| value.contains("merge=nodalstudio-semantic"));
    let conflict_reports = list_conflict_reports(&workspace_root)?;
    let expected_version = env!("CARGO_PKG_VERSION").to_owned();
    let driver_version = Command::new("nodalstudio-semantic-merge")
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8(output.stdout)
                .ok()
                .and_then(|value| value.split_whitespace().last().map(str::to_owned))
        });
    let workspace_fingerprint = fs::read_to_string(workspace_root.join("project.json"))
        .ok()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|value| value.get("schemaFingerprint")?.as_str().map(str::to_owned));
    let local_fingerprint = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .map(|snapshot| snapshot.fingerprint);
    Ok(MergeDriverStatus {
        repository_is_git,
        manifest_present: workspace_root.join("project.json").is_file(),
        attributes_configured,
        driver_configured,
        driver_version,
        expected_version,
        install_command: "git config --local merge.nodalstudio-semantic.name 'Nodal Studio semantic merge' && git config --local merge.nodalstudio-semantic.driver 'nodalstudio-semantic-merge %O %A %B'".into(),
        conflict_reports,
        fingerprint_matches: workspace_fingerprint
            .zip(local_fingerprint)
            .map(|(workspace, local)| workspace == local),
    })
}

fn list_conflict_reports(workspace_root: &std::path::Path) -> Result<Vec<String>, String> {
    let semantics = workspace_root.join("semantics");
    if !semantics.is_dir() {
        return Ok(Vec::new());
    }
    let mut directories = vec![semantics];
    let mut reports = Vec::new();
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)
            .map_err(|_| "Unable to inspect Git conflict reports.".to_owned())?
        {
            let entry = entry.map_err(|_| "Unable to inspect Git conflict reports.".to_owned())?;
            let path = entry.path();
            if path.is_dir() {
                directories.push(path);
            } else if path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .is_some_and(|name| name.ends_with(".conflicts.json"))
            {
                let relative = path
                    .strip_prefix(workspace_root)
                    .map_err(|_| "Git conflict report path is invalid.".to_owned())?;
                reports.push(relative.to_string_lossy().into_owned());
            }
        }
    }
    reports.sort();
    Ok(reports)
}

fn conflict_report_path(input: &ConflictReportInput) -> Result<std::path::PathBuf, String> {
    let root = std::path::PathBuf::from(input.repository_path.trim()).join(".nodalstudio");
    let relative = std::path::Path::new(input.report_path.trim());
    if !root.is_dir()
        || relative.is_absolute()
        || !input.report_path.starts_with("semantics/")
        || !input.report_path.ends_with(".conflicts.json")
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Choose a listed semantic conflict report.".into());
    }
    Ok(root.join(relative))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn read_git_conflict_report(input: ConflictReportInput) -> Result<String, String> {
    let path = conflict_report_path(&input)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 1024 * 1024) {
        return Err("The conflict report is missing or exceeds 1 MB.".into());
    }
    fs::read_to_string(path).map_err(|_| "Unable to read the conflict report.".into())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn delete_git_conflict_report(input: ConflictReportInput) -> Result<(), String> {
    let path = conflict_report_path(&input)?;
    fs::remove_file(path).map_err(|_| "Unable to remove the reviewed conflict report.".into())
}

async fn mark_credential_configured(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    kind: &str,
    configured: bool,
) -> Result<(), String> {
    let mut settings = store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    match kind {
        "ai" => settings.ai.credential_configured = configured,
        "cloud" => settings.cloud.credential_configured = configured,
        _ => return Err("Unsupported credential type.".into()),
    }
    store
        .save_data_source_settings(&settings)
        .await
        .map_err(safe_store_error)
}

fn save_secret(service: &str, source_id: Uuid, secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("A non-empty credential is required.".into());
    }
    keyring::Entry::new(service, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .set_password(secret)
        .map_err(|_| "Unable to save the credential in the operating system keychain.".to_owned())
}

fn delete_secret(service: &str, source_id: Uuid) -> Result<(), String> {
    let entry = keyring::Entry::new(service, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Unable to remove the credential from the operating system keychain.".into()),
    }
}

fn credential_exists(service: &str, source_id: Uuid) -> bool {
    keyring::Entry::new(service, &source_id.to_string())
        .and_then(|entry| entry.get_password())
        .is_ok()
}

async fn cleanup_retired_external_artifacts(
    database_path: &Path,
    app_cache_dir: &Path,
) -> Result<(), String> {
    for connection_id in retired_model_connection_ids(database_path).await? {
        delete_secret(RETIRED_MODEL_KEYRING_SERVICE, connection_id)?;
    }
    let managed_projects = app_cache_dir.join("projects");
    if managed_projects.exists() {
        fs::remove_dir_all(&managed_projects)
            .map_err(|_| "Unable to remove the retired managed project cache.".to_owned())?;
    }
    Ok(())
}

async fn retired_model_connection_ids(database_path: &Path) -> Result<Vec<Uuid>, String> {
    if !database_path.is_file() {
        return Ok(Vec::new());
    }
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|_| "Unable to inspect retired local project data.".to_owned())?;
    let version = sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .map_err(|_| "Unable to inspect the local schema version.".to_owned())?;
    if version >= 3 {
        pool.close().await;
        return Ok(Vec::new());
    }
    let table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_connections')",
    )
    .fetch_one(&pool)
    .await
    .map_err(|_| "Unable to inspect retired model credentials.".to_owned())?
        != 0;
    if !table_exists {
        pool.close().await;
        return Ok(Vec::new());
    }
    let accounts = sqlx::query_scalar::<_, String>("SELECT id FROM model_connections")
        .fetch_all(&pool)
        .await
        .map_err(|_| "Unable to inspect retired model credentials.".to_owned())?;
    pool.close().await;
    accounts
        .into_iter()
        .map(|account| {
            Uuid::parse_str(&account)
                .map_err(|_| "Retired model credential identity is invalid.".to_owned())
        })
        .collect()
}

#[tauri::command]
async fn export_settings_file(
    input: SettingsFileInput,
    state: State<'_, AppState>,
) -> Result<SettingsFileReceipt, String> {
    let path = validate_settings_file_path(&input.path)?;
    let mut bundle = SettingsExportBundle {
        format_version: settings_model::SETTINGS_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        app: state
            .store
            .get_app_settings()
            .await
            .map_err(safe_store_error)?,
        sources: state
            .store
            .list_data_source_settings()
            .await
            .map_err(safe_store_error)?,
    };
    bundle.sanitize();
    let payload = serde_json::to_string_pretty(&bundle)
        .map_err(|_| "Unable to serialize the non-sensitive settings bundle.".to_owned())?;
    fs::write(&path, format!("{payload}\n"))
        .map_err(|_| "Unable to write the settings export file.".to_owned())?;
    Ok(SettingsFileReceipt {
        path: path.to_string_lossy().into_owned(),
        source_settings: bundle.sources.len(),
    })
}

#[tauri::command]
async fn import_settings_file(
    input: SettingsFileInput,
    state: State<'_, AppState>,
) -> Result<SettingsFileReceipt, String> {
    let path = validate_settings_file_path(&input.path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 2 * 1024 * 1024) {
        return Err("Choose an existing settings JSON file smaller than 2 MB.".into());
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| "Unable to read the settings import file.".to_owned())?;
    let mut bundle: SettingsExportBundle = serde_json::from_str(&payload)
        .map_err(|_| "The settings import file is invalid.".to_owned())?;
    bundle
        .validate()
        .map_err(|error| format!("Invalid settings import: {error}"))?;
    bundle.sanitize();
    state
        .store
        .save_app_settings(&bundle.app)
        .await
        .map_err(safe_store_error)?;
    for source in &bundle.sources {
        state
            .store
            .save_data_source_settings(source)
            .await
            .map_err(safe_store_error)?;
    }
    Ok(SettingsFileReceipt {
        path: path.to_string_lossy().into_owned(),
        source_settings: bundle.sources.len(),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn preview_settings_file(input: SettingsFileInput) -> Result<SettingsFilePreview, String> {
    let path = validate_settings_file_path(&input.path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 2 * 1024 * 1024) {
        return Err("Choose an existing settings JSON file smaller than 2 MB.".into());
    }
    let payload = fs::read_to_string(path)
        .map_err(|_| "Unable to read the settings import file.".to_owned())?;
    let mut bundle: SettingsExportBundle = serde_json::from_str(&payload)
        .map_err(|_| "The settings import file is invalid.".to_owned())?;
    bundle
        .validate()
        .map_err(|error| format!("Invalid settings import: {error}"))?;
    bundle.sanitize();
    Ok(SettingsFilePreview {
        format_version: bundle.format_version,
        exported_at: bundle.exported_at,
        source_settings: bundle.sources.len(),
        replaces_app_settings: true,
        credentials_included: false,
    })
}

fn validate_settings_file_path(value: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(value.trim());
    if !path.is_absolute()
        || path.extension().and_then(std::ffi::OsStr::to_str) != Some("json")
        || path.parent().is_none_or(|parent| !parent.is_dir())
    {
        return Err("Choose an absolute .json path inside an existing directory.".into());
    }
    Ok(path)
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
async fn export_portable_backup(
    input: BackupFileInput,
    state: State<'_, AppState>,
) -> Result<BackupReceipt, String> {
    let source_id = input
        .source_id
        .ok_or_else(|| "Choose an active data source before exporting a backup.".to_owned())?;
    let path = validate_backup_file_path(&input.path)?;
    let snapshots = state
        .store
        .list_snapshot_models(source_id)
        .await
        .map_err(safe_store_error)?;
    let mut change_sets = std::collections::BTreeMap::new();
    for snapshot in &snapshots {
        for change_set in state
            .store
            .change_sets_for_snapshot(snapshot.id)
            .await
            .map_err(safe_store_error)?
        {
            change_sets.insert(change_set.id, change_set);
        }
    }
    let saved_views = state
        .store
        .list_views(source_id)
        .await
        .map_err(safe_store_error)?;
    let mut layouts = Vec::new();
    if let Some(layout) = state
        .store
        .get_layout(source_id, None)
        .await
        .map_err(safe_store_error)?
    {
        layouts.push(layout);
    }
    for view in &saved_views {
        if let Some(layout) = state
            .store
            .get_layout(source_id, Some(view.id))
            .await
            .map_err(safe_store_error)?
        {
            layouts.push(layout);
        }
    }
    let mut source_settings = state
        .store
        .get_data_source_settings(source_id)
        .await
        .map_err(safe_store_error)?;
    source_settings.ai.credential_configured = false;
    source_settings.cloud.credential_configured = false;
    let bundle = PortableBackup {
        format_version: settings_model::SETTINGS_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        source_id,
        source_profile: state
            .store
            .get_data_source(source_id)
            .await
            .map_err(safe_store_error)?,
        source_settings,
        snapshots,
        change_sets: change_sets.into_values().collect(),
        annotations: state
            .store
            .list_annotations(source_id)
            .await
            .map_err(safe_store_error)?,
        domain_groups: state
            .store
            .list_domain_groups(source_id)
            .await
            .map_err(safe_store_error)?,
        saved_views,
        layouts,
        provenance: state
            .store
            .list_change_provenance(source_id)
            .await
            .map_err(safe_store_error)?,
        lineage: state
            .store
            .list_lineage(source_id)
            .await
            .map_err(safe_store_error)?,
        logical_relationships: state
            .store
            .list_logical_relationships(source_id)
            .await
            .map_err(safe_store_error)?,
        ignored_relationship_inferences: state
            .store
            .list_ignored_relationship_inferences(source_id)
            .await
            .map_err(safe_store_error)?,
    };
    let payload = serde_json::to_string(&bundle)
        .map_err(|_| "Unable to serialize the portable model backup.".to_owned())?;
    fs::write(&path, payload)
        .map_err(|_| "Unable to write the portable backup file.".to_owned())?;
    Ok(BackupReceipt {
        path: path.to_string_lossy().into_owned(),
        snapshots: bundle.snapshots.len(),
        annotations: bundle.annotations.len(),
        saved_views: bundle.saved_views.len(),
    })
}

#[tauri::command]
async fn import_portable_backup(
    input: BackupFileInput,
    state: State<'_, AppState>,
) -> Result<BackupReceipt, String> {
    let path = validate_backup_file_path(&input.path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 100 * 1024 * 1024) {
        return Err("Choose an existing portable backup smaller than 100 MB.".into());
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| "Unable to read the portable backup file.".to_owned())?;
    let mut bundle: PortableBackup =
        serde_json::from_str(&payload).map_err(|_| "The portable backup is invalid.".to_owned())?;
    validate_portable_backup(&bundle)?;
    bundle.source_settings.ai.credential_configured = false;
    bundle.source_settings.cloud.credential_configured = false;
    state
        .store
        .import_portable_model(&bundle)
        .await
        .map_err(safe_store_error)?;
    Ok(BackupReceipt {
        path: path.to_string_lossy().into_owned(),
        snapshots: bundle.snapshots.len(),
        annotations: bundle.annotations.len(),
        saved_views: bundle.saved_views.len(),
    })
}

#[tauri::command]
async fn preview_portable_backup(
    input: BackupFileInput,
    state: State<'_, AppState>,
) -> Result<BackupPreview, String> {
    let path = validate_backup_file_path(&input.path)?;
    if fs::metadata(&path).map_or(true, |metadata| metadata.len() > 100 * 1024 * 1024) {
        return Err("Choose an existing portable backup smaller than 100 MB.".into());
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| "Unable to read the portable backup file.".to_owned())?;
    let bundle: PortableBackup =
        serde_json::from_str(&payload).map_err(|_| "The portable backup is invalid.".to_owned())?;
    validate_portable_backup(&bundle)?;
    let database = bundle.snapshots.first().map(|snapshot| &snapshot.database);
    Ok(BackupPreview {
        format_version: bundle.format_version,
        exported_at: bundle.exported_at,
        source_id: bundle.source_id,
        source_label: bundle
            .source_profile
            .as_ref()
            .map(|profile| profile.display_name.clone()),
        database_name: database.map(|database| database.name.clone()),
        database_type: database.map(|database| database.database_type),
        snapshots: bundle.snapshots.len(),
        annotations: bundle.annotations.len(),
        saved_views: bundle.saved_views.len(),
        will_update_existing_source: state
            .store
            .get_data_source(bundle.source_id)
            .await
            .map_err(safe_store_error)?
            .is_some(),
        conflict_strategy: "Stable IDs are inserted or updated; unrelated local data is preserved.",
    })
}

fn validate_backup_file_path(value: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(value.trim());
    let extension = path.extension().and_then(std::ffi::OsStr::to_str);
    if !path.is_absolute()
        || !matches!(extension, Some("nodalmodel" | "sqlaimodel"))
        || path.parent().is_none_or(|parent| !parent.is_dir())
    {
        return Err("Choose an absolute .nodalmodel path inside an existing directory.".into());
    }
    Ok(path)
}

fn validate_portable_backup(bundle: &PortableBackup) -> Result<(), String> {
    let snapshot_ids = bundle
        .snapshots
        .iter()
        .map(|snapshot| snapshot.id)
        .collect::<BTreeSet<_>>();
    let change_set_ids = bundle
        .change_sets
        .iter()
        .map(|change_set| change_set.id)
        .collect::<BTreeSet<_>>();
    if bundle.format_version != settings_model::SETTINGS_SCHEMA_VERSION
        || bundle.source_settings.source_id != bundle.source_id
        || bundle
            .source_profile
            .as_ref()
            .is_some_and(|profile| profile.id != bundle.source_id)
        || bundle
            .snapshots
            .iter()
            .any(|snapshot| snapshot.source_id != bundle.source_id)
        || bundle
            .annotations
            .iter()
            .any(|annotation| annotation.source_id != bundle.source_id)
        || bundle
            .domain_groups
            .iter()
            .any(|group| group.source_id != bundle.source_id)
        || bundle
            .saved_views
            .iter()
            .any(|view| view.source_id != bundle.source_id)
        || bundle
            .layouts
            .iter()
            .any(|layout| layout.source_id != bundle.source_id)
        || bundle
            .logical_relationships
            .iter()
            .any(|relationship| relationship.source_id != bundle.source_id)
        || bundle
            .ignored_relationship_inferences
            .iter()
            .any(|ignored| ignored.source_id != bundle.source_id)
        || bundle.change_sets.iter().any(|change_set| {
            !snapshot_ids.contains(&change_set.before_snapshot_id)
                || !snapshot_ids.contains(&change_set.after_snapshot_id)
        })
        || bundle
            .provenance
            .iter()
            .any(|provenance| !change_set_ids.contains(&provenance.change_set_id))
    {
        return Err(
            "The portable backup has an unsupported version, mixed source IDs, or broken references."
                .into(),
        );
    }
    bundle
        .source_settings
        .validate()
        .map_err(|error| format!("Invalid source settings in backup: {error}"))
}

#[tauri::command]
async fn check_for_updates(state: State<'_, AppState>) -> Result<UpdateCheckResult, String> {
    let effective = effective_settings(&state.store, None).await?;
    if effective.app.privacy.offline_mode {
        return Err("Update checks are blocked by completely offline mode.".into());
    }
    let feed = effective
        .app
        .updates
        .custom_feed_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Configure an update feed URL before checking for updates.".to_owned())?;
    let url = reqwest::Url::parse(feed)
        .map_err(|_| "The update feed must be a valid HTTPS URL.".to_owned())?;
    if url.scheme() != "https" {
        return Err("The update feed must use HTTPS.".into());
    }
    state
        .store
        .record_external_access("updates", "attempted")
        .await
        .map_err(safe_store_error)?;
    let manifest = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Unable to initialize the update client.".to_owned())?
        .get(url)
        .send()
        .await
        .map_err(|_| "The update feed is unreachable.".to_owned())?
        .error_for_status()
        .map_err(|_| "The update feed rejected the request.".to_owned())?
        .json::<UpdateManifest>()
        .await
        .map_err(|_| "The update feed returned an invalid manifest.".to_owned())?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "The current application version is invalid.".to_owned())?;
    let available = semver::Version::parse(&manifest.version)
        .map_err(|_| "The update manifest version is invalid.".to_owned())?;
    let is_newer = available > current;
    Ok(UpdateCheckResult {
        current_version: current.to_string(),
        available_version: is_newer.then_some(manifest.version),
        download_url: is_newer.then_some(manifest.download_url),
        notes: is_newer.then_some(manifest.notes),
    })
}

#[tauri::command]
async fn save_annotation(
    input: SaveAnnotationInput,
    state: State<'_, AppState>,
) -> Result<ObjectAnnotation, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    let mut annotation = ObjectAnnotation {
        source_id: input.source_id,
        object_key: input.object_key,
        description: input.description,
        tags: input.tags,
        owner: input.owner,
        is_core: input.is_core,
        updated_at: Utc::now(),
    };
    annotation.canonicalize();
    state
        .store
        .save_annotation(&annotation)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        annotation.source_id,
        "annotation.save",
        &format!(
            "{}:{}:{}:{}",
            annotation.object_key.kind as u8,
            annotation.object_key.schema,
            annotation.object_key.name,
            annotation.updated_at.timestamp_millis()
        ),
        serde_json::to_value(&annotation)
            .map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await?;
    Ok(annotation)
}

#[tauri::command]
async fn save_domain_group(
    input: SaveDomainGroupInput,
    state: State<'_, AppState>,
) -> Result<DomainGroup, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    if input.name.trim().is_empty() {
        return Err("A domain group requires a name.".into());
    }
    let mut group = DomainGroup {
        id: input.id.unwrap_or_else(Uuid::new_v4),
        source_id: input.source_id,
        name: input.name.trim().to_owned(),
        description: input.description,
        color: input.color,
        table_keys: input.table_keys,
        updated_at: Utc::now(),
    };
    group.canonicalize();
    state
        .store
        .save_domain_group(&group)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        group.source_id,
        "domain.save",
        &format!("{}:{}", group.id, group.updated_at.timestamp_millis()),
        serde_json::to_value(&group).map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await?;
    Ok(group)
}

#[tauri::command]
async fn save_view(input: SaveViewInput, state: State<'_, AppState>) -> Result<SavedView, String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    if input.name.trim().is_empty() || input.root_table_keys.is_empty() {
        return Err("A saved view requires a name and at least one root table.".into());
    }
    let mut view = SavedView {
        id: input.id.unwrap_or_else(Uuid::new_v4),
        source_id: input.source_id,
        name: input.name.trim().to_owned(),
        root_table_keys: input.root_table_keys,
        relationship_depth: input.relationship_depth,
        updated_at: Utc::now(),
    };
    view.canonicalize();
    state
        .store
        .save_view(&view)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        view.source_id,
        "view.save",
        &format!("{}:{}", view.id, view.updated_at.timestamp_millis()),
        serde_json::to_value(&view).map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await?;
    Ok(view)
}

#[tauri::command]
async fn save_layout(input: SaveLayoutInput, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = acquire_cloud_operation(&state, input.source_id).await?;
    let layout = CanvasLayout {
        source_id: input.source_id,
        view_id: input.view_id,
        positions: input.positions,
        updated_at: Utc::now(),
    };
    state
        .store
        .save_layout(&layout)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        layout.source_id,
        "layout.save",
        &format!(
            "{}:{}",
            layout
                .view_id
                .map_or_else(|| "default".into(), |id| id.to_string()),
            layout.updated_at.timestamp_millis()
        ),
        serde_json::to_value(&layout).map_err(|_| "Unable to create sync metadata.".to_owned())?,
    )
    .await
}

fn relationship_table<'a>(
    snapshot: &'a DatabaseSnapshot,
    endpoint: &RelationshipEndpoint,
) -> Option<&'a schema_model::TableDefinition> {
    snapshot
        .schemas
        .iter()
        .find(|schema| schema.name == endpoint.schema)
        .and_then(|schema| {
            schema
                .tables
                .iter()
                .find(|table| table.key.name == endpoint.table)
        })
}

fn endpoint_is_unique(table: &schema_model::TableDefinition, columns: &[String]) -> bool {
    table
        .primary_key
        .as_ref()
        .is_some_and(|key| key.columns == columns)
        || table
            .indexes
            .iter()
            .any(|index| index.unique && index.columns == columns)
}

fn physical_relationship_exists(
    snapshot: &DatabaseSnapshot,
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
) -> bool {
    relationship_table(snapshot, source).is_some_and(|table| {
        table.foreign_keys.iter().any(|foreign_key| {
            foreign_key.columns == source.columns
                && foreign_key.referenced_schema == target.schema
                && foreign_key.referenced_table == target.table
                && foreign_key.referenced_columns == target.columns
        })
    })
}

fn endpoint_column_types(
    snapshot: &DatabaseSnapshot,
    endpoint: &RelationshipEndpoint,
) -> Option<Vec<(String, String)>> {
    let table = relationship_table(snapshot, endpoint)?;
    endpoint
        .columns
        .iter()
        .map(|name| {
            table
                .columns
                .iter()
                .find(|column| &column.name == name)
                .map(|column| {
                    (
                        column.type_schema.to_ascii_lowercase(),
                        column.type_name.to_ascii_lowercase(),
                    )
                })
        })
        .collect()
}

fn suggested_cardinality(
    snapshot: &DatabaseSnapshot,
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
) -> RelationshipCardinality {
    let source_unique = relationship_table(snapshot, source)
        .is_some_and(|table| endpoint_is_unique(table, &source.columns));
    let target_unique = relationship_table(snapshot, target)
        .is_some_and(|table| endpoint_is_unique(table, &target.columns));
    match (source_unique, target_unique) {
        (true, true) => RelationshipCardinality::OneToOne,
        (true, false) => RelationshipCardinality::OneToMany,
        (false, true) => RelationshipCardinality::ManyToOne,
        (false, false) => RelationshipCardinality::Unspecified,
    }
}

fn logical_relationship_key(
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
) -> String {
    format!("{}->{}", source.display_key(), target.display_key())
}

fn validate_relationship_against_snapshot(
    snapshot: &DatabaseSnapshot,
    existing: &[LogicalRelationship],
    source: &RelationshipEndpoint,
    target: &RelationshipEndpoint,
    relationship_id: Option<Uuid>,
) -> RelationshipValidation {
    let mut messages = Vec::new();
    if source.columns.is_empty()
        || target.columns.is_empty()
        || source.columns.len() != target.columns.len()
    {
        messages.push("Relationship endpoints require the same non-zero number of columns.".into());
        return RelationshipValidation {
            valid: false,
            compatible: false,
            duplicate: false,
            physical_exists: false,
            suggested_cardinality: RelationshipCardinality::Unspecified,
            status: LogicalRelationshipStatus::Orphaned,
            messages,
        };
    }
    if source == target {
        messages.push("A relationship cannot connect a field to itself.".into());
        return RelationshipValidation {
            valid: false,
            compatible: true,
            duplicate: false,
            physical_exists: false,
            suggested_cardinality: RelationshipCardinality::Unspecified,
            status: LogicalRelationshipStatus::Conflicted,
            messages,
        };
    }
    let source_types = endpoint_column_types(snapshot, source);
    let target_types = endpoint_column_types(snapshot, target);
    if source_types.is_none() || target_types.is_none() {
        messages.push("One or more relationship tables or columns no longer exist.".into());
        return RelationshipValidation {
            valid: false,
            compatible: false,
            duplicate: false,
            physical_exists: false,
            suggested_cardinality: RelationshipCardinality::Unspecified,
            status: LogicalRelationshipStatus::Orphaned,
            messages,
        };
    }
    let compatible = source_types == target_types;
    if !compatible {
        messages.push("Source and target column types differ.".into());
    }
    let physical_exists = physical_relationship_exists(snapshot, source, target);
    if physical_exists {
        messages.push("The database already contains this physical foreign key.".into());
    }
    let key = logical_relationship_key(source, target);
    let duplicate = existing.iter().any(|relationship| {
        Some(relationship.id) != relationship_id && relationship.relationship_key() == key
    });
    if duplicate {
        messages.push("This logical relationship already exists.".into());
    }
    let status = if physical_exists {
        LogicalRelationshipStatus::SupersededByPhysical
    } else if compatible {
        LogicalRelationshipStatus::Active
    } else {
        LogicalRelationshipStatus::Conflicted
    };
    RelationshipValidation {
        valid: compatible && !duplicate && !physical_exists,
        compatible,
        duplicate,
        physical_exists,
        suggested_cardinality: suggested_cardinality(snapshot, source, target),
        status,
        messages,
    }
}

async fn current_relationship_validation(
    state: &AppState,
    input: &ValidateLogicalRelationshipInput,
) -> Result<RelationshipValidation, String> {
    let snapshot = state
        .store
        .latest_snapshot(input.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "Capture a snapshot before creating logical relationships.".to_owned())?;
    let existing = state
        .store
        .list_logical_relationships(input.source_id)
        .await
        .map_err(safe_store_error)?;
    Ok(validate_relationship_against_snapshot(
        &snapshot,
        &existing,
        &input.source,
        &input.target,
        input.relationship_id,
    ))
}

#[tauri::command]
async fn validate_logical_relationship(
    input: ValidateLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<RelationshipValidation, String> {
    current_relationship_validation(&state, &input).await
}

#[tauri::command]
async fn list_logical_relationships(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<LogicalRelationship>, String> {
    validated_logical_relationships(&state.store, input.source_id).await
}

async fn validated_logical_relationships(
    store: &LocalSnapshotStore,
    source_id: Uuid,
) -> Result<Vec<LogicalRelationship>, String> {
    let mut relationships = store
        .list_logical_relationships(source_id)
        .await
        .map_err(safe_store_error)?;
    if let Some(snapshot) = store
        .latest_snapshot(source_id)
        .await
        .map_err(safe_store_error)?
    {
        let all = relationships.clone();
        for relationship in &mut relationships {
            if relationship.status == LogicalRelationshipStatus::Disabled {
                continue;
            }
            let previous = relationship.status;
            relationship.status = validate_relationship_against_snapshot(
                &snapshot,
                &all,
                &relationship.source,
                &relationship.target,
                Some(relationship.id),
            )
            .status;
            if relationship.status != previous {
                store
                    .save_logical_relationship(relationship)
                    .await
                    .map_err(safe_store_error)?;
            }
        }
    }
    Ok(relationships)
}

#[allow(clippy::too_many_lines)]
async fn persist_logical_relationship(
    input: SaveLogicalRelationshipInput,
    state: &AppState,
) -> Result<LogicalRelationship, String> {
    let mut source = input.source;
    let mut target = input.target;
    source.canonicalize();
    target.canonicalize();
    let endpoint_too_long = [&source, &target].iter().any(|endpoint| {
        endpoint.schema.len() > 128
            || endpoint.table.len() > 128
            || endpoint.columns.iter().any(|column| column.len() > 128)
    });
    if endpoint_too_long
        || input.name.trim().len() > 160
        || input.note.as_ref().is_some_and(|note| note.len() > 2_000)
        || input.evidence.len() > 20
        || input.evidence.iter().any(|item| item.len() > 500)
    {
        return Err("Logical relationship metadata exceeds the supported size.".into());
    }
    let validation = current_relationship_validation(
        state,
        &ValidateLogicalRelationshipInput {
            source_id: input.source_id,
            source: source.clone(),
            target: target.clone(),
            relationship_id: input.id,
        },
    )
    .await?;
    if validation.duplicate || validation.physical_exists {
        return Err(validation.messages.join(" "));
    }
    if !validation.valid && validation.compatible {
        return Err(validation.messages.join(" "));
    }
    if !validation.compatible && !input.allow_type_mismatch {
        return Err("Source and target types differ. Confirm the mismatch to continue.".into());
    }
    if validation.status == LogicalRelationshipStatus::Orphaned {
        return Err(validation.messages.join(" "));
    }
    let previous = if let Some(id) = input.id {
        state
            .store
            .list_logical_relationships(input.source_id)
            .await
            .map_err(safe_store_error)?
            .into_iter()
            .find(|relationship| relationship.id == id)
    } else {
        None
    };
    if input.id.is_some() && previous.is_none() {
        return Err("The selected logical relationship no longer exists.".into());
    }
    if input.name.trim().is_empty() {
        return Err("A logical relationship requires a name.".into());
    }
    let now = Utc::now();
    let mut relationship = LogicalRelationship {
        id: input.id.unwrap_or_else(Uuid::new_v4),
        source_id: input.source_id,
        name: input.name,
        source,
        target,
        cardinality: input.cardinality,
        status: if input.disabled {
            LogicalRelationshipStatus::Disabled
        } else {
            validation.status
        },
        origin: input.origin.unwrap_or_else(|| {
            previous
                .as_ref()
                .map_or(LogicalRelationshipOrigin::Manual, |value| value.origin)
        }),
        note: input.note,
        evidence: input.evidence,
        created_at: previous.as_ref().map_or(now, |value| value.created_at),
        updated_at: now,
    };
    relationship.canonicalize();
    state
        .store
        .save_logical_relationship(&relationship)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        relationship.source_id,
        "logical_relationship.save",
        &format!(
            "{}:{}",
            relationship.id,
            relationship.updated_at.timestamp_millis()
        ),
        serde_json::to_value(&relationship)
            .map_err(|_| "Unable to record the relationship event.".to_owned())?,
    )
    .await?;
    Ok(relationship)
}

#[tauri::command]
async fn create_logical_relationship(
    input: SaveLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<LogicalRelationship, String> {
    if input.id.is_some() {
        return Err("New logical relationships must not provide an id.".into());
    }
    persist_logical_relationship(input, &state).await
}

#[tauri::command]
async fn update_logical_relationship(
    input: SaveLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<LogicalRelationship, String> {
    if input.id.is_none() {
        return Err("Choose a logical relationship to update.".into());
    }
    persist_logical_relationship(input, &state).await
}

#[tauri::command]
async fn delete_logical_relationship(
    input: DeleteLogicalRelationshipInput,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let deleted = state
        .store
        .delete_logical_relationship(input.source_id, input.relationship_id)
        .await
        .map_err(safe_store_error)?;
    if deleted {
        enqueue_sync_event(
            &state.store,
            input.source_id,
            "logical_relationship.delete",
            &format!(
                "{}:{}",
                input.relationship_id,
                Utc::now().timestamp_millis()
            ),
            serde_json::json!({ "relationshipId": input.relationship_id }),
        )
        .await?;
    }
    Ok(deleted)
}

#[tauri::command]
async fn ignore_relationship_inference(
    input: IgnoreRelationshipInferenceInput,
    state: State<'_, AppState>,
) -> Result<IgnoredRelationshipInference, String> {
    if input.relationship_key.trim().is_empty() {
        return Err("Choose an inferred relationship to ignore.".into());
    }
    if input.relationship_key.len() > 1_000 {
        return Err("The inferred relationship key is too long.".into());
    }
    let ignored = IgnoredRelationshipInference {
        source_id: input.source_id,
        relationship_key: input.relationship_key.trim().to_owned(),
        ignored_at: Utc::now(),
    };
    state
        .store
        .save_ignored_relationship_inference(&ignored)
        .await
        .map_err(safe_store_error)?;
    enqueue_sync_event(
        &state.store,
        ignored.source_id,
        "logical_relationship.ignore_inference",
        &format!(
            "{}:{}",
            ignored.relationship_key,
            ignored.ignored_at.timestamp_millis()
        ),
        serde_json::to_value(&ignored)
            .map_err(|_| "Unable to record the relationship review.".to_owned())?,
    )
    .await?;
    Ok(ignored)
}

#[tauri::command]
async fn list_ignored_relationship_inferences(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<IgnoredRelationshipInference>, String> {
    state
        .store
        .list_ignored_relationship_inferences(input.source_id)
        .await
        .map_err(safe_store_error)
}

async fn enqueue_sync_event(
    store: &LocalSnapshotStore,
    source_id: Uuid,
    event_kind: &str,
    idempotency_suffix: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    store
        .enqueue_sync(&SyncQueueItem {
            id: Uuid::new_v4(),
            source_id,
            event_kind: event_kind.to_owned(),
            idempotency_key: format!("{source_id}:{event_kind}:{idempotency_suffix}"),
            payload,
            base_version: 0,
            attempts: 0,
            state: "pending".into(),
            created_at: Utc::now().to_rfc3339(),
        })
        .await
        .map_err(safe_store_error)
}

#[tauri::command]
async fn explain_schema(
    input: ExplainSchemaInput,
    state: State<'_, AppState>,
) -> Result<Explanation, String> {
    if !input.ai_enabled {
        return Err(
            "AI explanations are disabled. Enable offline AI explicitly to continue.".into(),
        );
    }
    let snapshot = state
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected snapshot no longer exists.".to_owned())?;
    let effective = effective_settings(&state.store, Some(snapshot.source_id)).await?;
    let ai = effective
        .source
        .as_ref()
        .map(|settings| &settings.ai)
        .ok_or_else(|| "AI settings are unavailable for this data source.".to_owned())?;
    if !ai.enabled {
        return Err("AI explanations are disabled in Settings.".into());
    }
    if effective.app.privacy.offline_mode && ai.provider != AiProviderKind::Offline {
        return Err("Remote AI is blocked by completely offline mode.".into());
    }
    let annotations = if ai.include_confirmed_semantics {
        state
            .store
            .list_annotations(snapshot.source_id)
            .await
            .map_err(safe_store_error)?
    } else {
        Vec::new()
    };
    let configured_depth = match ai.context_scope {
        settings_model::AiContextScope::CurrentTable => 0,
        settings_model::AiContextScope::OneHop => 1,
        settings_model::AiContextScope::Domain => input.relationship_depth.min(2),
    };
    let mut context = match input.target_type.as_str() {
        "table" => table_context(
            &snapshot,
            input
                .object_key
                .as_ref()
                .ok_or_else(|| "A table explanation requires an object key.".to_owned())?,
            configured_depth,
            &annotations,
        )
        .ok_or_else(|| "The selected table no longer exists in this snapshot.".to_owned())?,
        "domain" => domain_context(
            &snapshot,
            input
                .domain_group
                .as_ref()
                .ok_or_else(|| "A domain explanation requires a domain group.".to_owned())?,
            &annotations,
        ),
        "changeSet" => change_context(
            &snapshot,
            input
                .change_set
                .as_ref()
                .ok_or_else(|| "A change explanation requires a change set.".to_owned())?,
            &annotations,
        ),
        _ => return Err("Unsupported AI explanation target.".into()),
    };
    if !ai.include_comments {
        for table in &mut context.tables {
            table.comment = None;
        }
    }
    if ai.provider == AiProviderKind::Offline {
        return Ok(OfflineSchemaProvider.explain(&context, input.question.as_deref()));
    }
    state
        .store
        .record_external_access("ai", "attempted")
        .await
        .map_err(safe_store_error)?;
    remote_ai_explanation(
        ai,
        &context,
        input.question.as_deref(),
        snapshot.source_id,
        &state.ai_limiter,
    )
    .await
}

#[tauri::command]
async fn test_ai_provider(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<AiProviderTestResult, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    let ai = effective
        .source
        .as_ref()
        .map(|settings| &settings.ai)
        .ok_or_else(|| "AI settings are unavailable for this data source.".to_owned())?;
    if !ai.enabled {
        return Err("Enable AI explanations before testing the provider.".into());
    }
    if ai.provider == AiProviderKind::Offline {
        return Ok(AiProviderTestResult {
            provider: "offline-schema".into(),
            model: None,
            tested_at: Utc::now().to_rfc3339(),
            network_used: false,
        });
    }
    if effective.app.privacy.offline_mode {
        return Err("Remote AI is blocked by completely offline mode.".into());
    }
    state
        .store
        .record_external_access("ai", "attempted")
        .await
        .map_err(safe_store_error)?;
    let context = SchemaContext {
        target: "provider-connectivity-test".into(),
        tables: Vec::new(),
        recent_change: None,
        policy: ContextPolicy {
            relationship_depth: 0,
            credentials_included: false,
            row_data_included: false,
            complete_schema_included: false,
        },
    };
    remote_ai_explanation(
        ai,
        &context,
        Some("Connectivity test only. Reply briefly."),
        input.source_id,
        &state.ai_limiter,
    )
    .await?;
    Ok(AiProviderTestResult {
        provider: "openai-compatible".into(),
        model: Some(ai.model.clone()),
        tested_at: Utc::now().to_rfc3339(),
        network_used: true,
    })
}

async fn remote_ai_explanation(
    settings: &settings_model::AiSettings,
    context: &ai_context::SchemaContext,
    question: Option<&str>,
    source_id: Uuid,
    limiter: &Arc<Semaphore>,
) -> Result<Explanation, String> {
    const AI_PERMITS: u32 = 840;
    if settings.endpoint.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("Remote AI requires an endpoint and model in Settings.".into());
    }
    let key = keyring::Entry::new(AI_KEYRING_SERVICE, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure the AI API key in Settings before using remote AI.".to_owned())?;
    let endpoint = remote_chat_endpoint(&settings.endpoint)?;
    let context_json = serde_json::to_string(context)
        .map_err(|_| "Unable to prepare the privacy-bounded AI context.".to_owned())?;
    let user_prompt = format!(
        "Explain this database metadata for an engineer. Distinguish facts from inference. Do not invent business meaning. Optional question: {}\n\nSchema context:\n{}",
        question.unwrap_or("None"),
        context_json
    );
    let permits = AI_PERMITS / u32::from(settings.max_concurrency.max(1));
    let _permit = Arc::clone(limiter)
        .acquire_many_owned(permits)
        .await
        .map_err(|_| "The AI request limiter is unavailable.".to_owned())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(u64::from(settings.timeout_seconds)))
        .build()
        .map_err(|_| "Unable to initialize the remote AI client.".to_owned())?;
    let mut response = None;
    for attempt in 0..=settings.max_retries {
        match client
            .post(endpoint.clone())
            .bearer_auth(&key)
            .json(&OpenAiChatRequest {
                model: &settings.model,
                messages: vec![
                    OpenAiMessage {
                        role: "system",
                        content: "You explain database structure using only supplied metadata. Never claim access to credentials or row data.",
                    },
                    OpenAiMessage {
                        role: "user",
                        content: &user_prompt,
                    },
                ],
                temperature: 0.2,
            })
            .send()
            .await
        {
            Ok(value)
                if value.status().is_server_error()
                    && attempt < settings.max_retries =>
            {}
            Ok(value) => {
                response = Some(value);
                break;
            }
            Err(_) if attempt < settings.max_retries => {}
            Err(_) => {
                return Err(
                    "Remote AI is unreachable; no schema context was retained by Nodal Studio."
                        .to_owned(),
                );
            }
        }
    }
    let response = response.ok_or_else(|| "Remote AI did not return a response.".to_owned())?;
    if !response.status().is_success() {
        return Err(
            "Remote AI rejected the request. Check the endpoint, model, and API key.".into(),
        );
    }
    let generated_text = response
        .json::<OpenAiChatResponse>()
        .await
        .map_err(|_| "Remote AI returned an invalid response.".to_owned())?
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Remote AI returned an empty explanation.".to_owned())?;
    let mut explanation = OfflineSchemaProvider.explain(context, question);
    explanation.provider = "openai-compatible".into();
    explanation.model = Some(settings.model.clone());
    explanation.generated_at = Some(Utc::now().to_rfc3339());
    explanation.title = format!("{} · AI explanation", context.target);
    explanation.explanation.clone_from(&generated_text);
    explanation.candidate_annotation = Some(generated_text);
    Ok(explanation)
}

fn remote_chat_endpoint(endpoint: &str) -> Result<reqwest::Url, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let url = if trimmed.ends_with("/chat/completions") {
        trimmed.to_owned()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    };
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "Remote AI endpoint must be a valid HTTP or HTTPS URL.".to_owned())?;
    let local_development = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local_development) {
        return Err("Remote AI endpoint must use HTTPS outside local development.".into());
    }
    Ok(parsed)
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
    if input.password.is_empty() {
        return Err("A database password is required to verify the connection.".into());
    }
    Ok(())
}

fn validate_connection_profile_input(input: &SaveDataSourceInput) -> Result<(), String> {
    if input.display_name.trim().is_empty()
        || input.host.trim().is_empty()
        || input.database.trim().is_empty()
        || input.username.trim().is_empty()
    {
        return Err("Name, host, database, and username are required.".into());
    }
    if input.port == 0 {
        return Err("Database port must be greater than zero.".into());
    }
    Ok(())
}

fn connection_options_from_input(input: &SaveDataSourceInput) -> PostgresConnectionOptions {
    PostgresConnectionOptions::from_fields(
        input.host.trim(),
        input.port,
        input.database.trim(),
        input.username.trim(),
        &input.password,
        adapter_ssl_mode(input.ssl_mode),
    )
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
}

fn mysql_connection_options_from_input(input: &SaveDataSourceInput) -> MySqlConnectionOptions {
    MySqlConnectionOptions::from_fields(
        input.host.trim(),
        input.port,
        input.database.trim(),
        input.username.trim(),
        &input.password,
        mysql_ssl_mode(input.ssl_mode),
    )
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
        postgres_adapter::PostgresAdapterError::Database(_) => {
            "Unable to connect to PostgreSQL or read its schema metadata.".into()
        }
        other => other.to_string(),
    }
}

fn safe_mysql_error(error: mysql_adapter::MySqlAdapterError) -> String {
    match error {
        mysql_adapter::MySqlAdapterError::Database(_) => {
            "Unable to connect to MySQL or read its schema metadata.".into()
        }
        mysql_adapter::MySqlAdapterError::Metadata { stage, .. } => {
            format!("Connected to MySQL, but unable to read its {stage} metadata.")
        }
        other => other.to_string(),
    }
}

fn safe_store_error(_error: snapshot_store::SnapshotStoreError) -> String {
    "Unable to access Nodal Studio local storage.".into()
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
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("nodalstudio.sqlite3");
            if !database_path.exists()
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
            app.manage(AppState {
                store,
                ai_limiter: Arc::new(Semaphore::new(840)),
                snapshot_captures: Arc::new(Mutex::new(HashMap::new())),
                cloud_operations: Arc::new(Mutex::new(HashMap::new())),
                active_queries: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            get_diagnostic_info,
            reveal_app_directory,
            list_data_sources,
            save_data_source,
            test_postgres_connection,
            verify_and_refresh_data_source,
            capture_postgres_snapshot,
            execute_readonly_query,
            cancel_query,
            list_query_history,
            delete_query_history,
            clear_query_history,
            list_snapshots,
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
            check_for_updates,
            get_semantics,
            list_logical_relationships,
            validate_logical_relationship,
            create_logical_relationship,
            update_logical_relationship,
            delete_logical_relationship,
            ignore_relationship_inference,
            list_ignored_relationship_inferences,
            save_annotation,
            save_domain_group,
            save_view,
            save_layout,
            explain_schema,
            test_ai_provider,
            sync_project
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Nodal Studio desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_desktop_runtime() {
        let info = get_runtime_info();
        assert_eq!(info.kind, "desktop");
    }

    #[test]
    fn rejects_incomplete_connection_input() {
        let input = SaveDataSourceInput {
            id: None,
            display_name: String::new(),
            host: "localhost".into(),
            port: 5432,
            database: "app".into(),
            username: "developer".into(),
            password: "secret".into(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Prefer,
        };
        assert!(validate_connection_input(&input).is_err());
    }

    #[test]
    fn allows_an_existing_profile_to_keep_its_keychain_password() {
        let input = SaveDataSourceInput {
            id: Some(Uuid::new_v4()),
            display_name: "Local development".into(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            username: "developer".into(),
            password: String::new(),
            database_type: DatabaseType::PostgreSql,
            ssl_mode: SslMode::Prefer,
        };
        assert!(validate_connection_profile_input(&input).is_ok());
        assert!(validate_connection_input(&input).is_err());
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

    #[test]
    fn validates_logical_relationship_types_duplicates_and_physical_constraints() {
        let source_id = Uuid::new_v4();
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
        let snapshot = DatabaseSnapshot::new(
            source_id,
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![schema_model::SchemaDefinition {
                name: "public".into(),
                tables: vec![users, orders.clone()],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        );
        let source = RelationshipEndpoint::new("public", "orders", vec!["user_id".into()]);
        let target = RelationshipEndpoint::new("public", "users", vec!["id".into()]);
        let validation =
            validate_relationship_against_snapshot(&snapshot, &[], &source, &target, None);
        assert!(validation.valid);
        assert_eq!(
            validation.suggested_cardinality,
            RelationshipCardinality::ManyToOne
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
