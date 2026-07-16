//! Versioned, non-sensitive settings shared by desktop persistence and policy evaluation.
#![allow(clippy::struct_excessive_bools)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const SETTINGS_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u16,
    pub legacy_storage_migration_version: u16,
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub canvas: CanvasSettings,
    #[serde(default)]
    pub code_analysis: CodeAnalysisSettings,
    #[serde(default)]
    pub connection_defaults: ConnectionDefaults,
    pub history: HistorySettings,
    pub privacy: PrivacySettings,
    pub notifications: NotificationSettings,
    pub shortcuts: ShortcutSettings,
    pub updates: UpdateSettings,
    pub advanced: AdvancedSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            legacy_storage_migration_version: 0,
            general: GeneralSettings::default(),
            appearance: AppearanceSettings::default(),
            canvas: CanvasSettings::default(),
            code_analysis: CodeAnalysisSettings::default(),
            connection_defaults: ConnectionDefaults::default(),
            history: HistorySettings::default(),
            privacy: PrivacySettings::default(),
            notifications: NotificationSettings::default(),
            shortcuts: ShortcutSettings::default(),
            updates: UpdateSettings::default(),
            advanced: AdvancedSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAnalysisSettings {
    pub enabled: bool,
    pub auto_scan: bool,
    pub include_gitignore: bool,
    pub include_nodal_studio_ignore: bool,
    pub max_file_bytes: u64,
    #[serde(default)]
    pub editor: EditorIntegration,
    pub allow_uncommitted_code_for_remote_ai: bool,
    pub allow_source_excerpts_for_remote_ai: bool,
}

impl Default for CodeAnalysisSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_scan: false,
            include_gitignore: true,
            include_nodal_studio_ignore: true,
            max_file_bytes: 2 * 1024 * 1024,
            editor: EditorIntegration::SystemDefault,
            allow_uncommitted_code_for_remote_ai: false,
            allow_source_excerpts_for_remote_ai: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EditorIntegration {
    #[default]
    SystemDefault,
    VisualStudioCode,
    Cursor,
    Zed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDefaults {
    pub database_engine: DatabaseEngine,
    pub ssl_mode: DefaultSslMode,
}

impl Default for ConnectionDefaults {
    fn default() -> Self {
        Self {
            database_engine: DatabaseEngine::PostgreSql,
            ssl_mode: DefaultSslMode::Prefer,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub language: Language,
    pub theme: Theme,
    pub ui_scale_percent: u16,
    pub start_page: StartPage,
    pub reopen_last_workspace: bool,
    pub confirm_before_quit: bool,
    pub date_time_format: DateTimeFormat,
    #[serde(default)]
    pub last_source_id: Option<Uuid>,
    #[serde(default = "default_last_view_mode")]
    pub last_view_mode: String,
}

fn default_last_view_mode() -> String {
    "explore".into()
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            language: Language::System,
            theme: Theme::System,
            ui_scale_percent: 100,
            start_page: StartPage::LastDataSource,
            reopen_last_workspace: true,
            confirm_before_quit: true,
            date_time_format: DateTimeFormat::Local,
            last_source_id: None,
            last_view_mode: default_last_view_mode(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub density: Density,
    pub ui_font_size: u16,
    pub node_font_size: u16,
    pub monospace_font_size: u16,
    pub reduce_motion: bool,
    pub high_contrast_relations: bool,
    pub color_blind_palette: bool,
    pub left_sidebar_expanded: bool,
    pub left_sidebar_width: u16,
    pub right_sidebar_expanded: bool,
    pub right_sidebar_width: u16,
    pub restore_sidebar_state: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            density: Density::Comfortable,
            ui_font_size: 13,
            node_font_size: 12,
            monospace_font_size: 11,
            reduce_motion: false,
            high_contrast_relations: false,
            color_blind_palette: false,
            left_sidebar_expanded: true,
            left_sidebar_width: 272,
            right_sidebar_expanded: true,
            right_sidebar_width: 300,
            restore_sidebar_state: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSettings {
    pub show_schema: bool,
    pub show_table_comments: bool,
    pub show_column_types: bool,
    pub show_column_nullable: bool,
    pub show_column_defaults: bool,
    pub show_column_comments: bool,
    pub show_key_badges: bool,
    pub indexes: IndexDisplay,
    pub max_initial_columns: u16,
    pub show_declared_relationships: bool,
    pub show_inferred_relationships: bool,
    pub field_level_edges: bool,
    pub show_relation_names: bool,
    pub show_cardinality: bool,
    pub show_referential_actions: bool,
    pub relationship_highlight_depth: u8,
    pub edge_style: EdgeStyle,
    pub layout_direction: LayoutDirection,
    pub node_spacing: u16,
    pub layer_spacing: u16,
    pub edge_spacing: u16,
    pub restore_personal_layout: bool,
    pub large_model_threshold: u16,
}

impl Default for CanvasSettings {
    fn default() -> Self {
        Self {
            show_schema: true,
            show_table_comments: true,
            show_column_types: true,
            show_column_nullable: true,
            show_column_defaults: false,
            show_column_comments: true,
            show_key_badges: true,
            indexes: IndexDisplay::Expanded,
            max_initial_columns: 60,
            show_declared_relationships: true,
            show_inferred_relationships: false,
            field_level_edges: true,
            show_relation_names: false,
            show_cardinality: false,
            show_referential_actions: false,
            relationship_highlight_depth: 1,
            edge_style: EdgeStyle::Orthogonal,
            layout_direction: LayoutDirection::LeftToRight,
            node_spacing: 70,
            layer_spacing: 110,
            edge_spacing: 24,
            restore_personal_layout: true,
            large_model_threshold: 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySettings {
    pub capture_policy: CapturePolicy,
    pub retention: RetentionPolicy,
    pub retention_value: u16,
    pub preserve_high_risk: bool,
    pub storage_warning_megabytes: u32,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            capture_policy: CapturePolicy::OnChange,
            retention: RetentionPolicy::Forever,
            retention_value: 100,
            preserve_high_risk: true,
            storage_warning_megabytes: 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacySettings {
    pub offline_mode: bool,
    pub diagnostics_enabled: bool,
    pub crash_reports_enabled: bool,
    pub log_level: LogLevel,
    pub log_retention_days: u16,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            offline_mode: false,
            diagnostics_enabled: false,
            crash_reports_enabled: false,
            log_level: LogLevel::Warn,
            log_retention_days: 14,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub schema_changes: ChangeNotificationLevel,
    pub git_conflicts: bool,
    pub cloud_failures: bool,
    pub storage_warnings: bool,
    pub update_available: bool,
    pub system_notifications: bool,
    pub quiet_hours_enabled: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            schema_changes: ChangeNotificationLevel::HighRisk,
            git_conflicts: true,
            cloud_failures: true,
            storage_warnings: true,
            update_available: true,
            system_notifications: false,
            quiet_hours_enabled: false,
            quiet_hours_start: "22:00".into(),
            quiet_hours_end: "08:00".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub bindings: BTreeMap<String, String>,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            bindings: BTreeMap::from([
                ("openSettings".into(), "Mod+,".into()),
                ("focusSearch".into(), "Mod+F".into()),
                ("refreshSchema".into(), "Mod+R".into()),
                ("toggleLeftSidebar".into(), "Mod+Shift+L".into()),
                ("toggleRightInspector".into(), "Mod+Shift+I".into()),
                ("fitCanvas".into(), "F".into()),
                ("focusSelectedTable".into(), "Enter".into()),
                ("relayoutCanvas".into(), "Mod+Shift+R".into()),
            ]),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub automatic_checks: bool,
    pub channel: UpdateChannel,
    pub custom_feed_url: Option<String>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            automatic_checks: false,
            channel: UpdateChannel::Stable,
            custom_feed_url: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedSettings {
    pub performance_metrics: bool,
    pub layout_worker_timeout_ms: u32,
    pub render_degrade_threshold: u16,
    pub beta_features: bool,
    #[serde(default = "default_experimental_features")]
    pub experimental_features: BTreeMap<String, bool>,
    #[serde(default = "default_extensions")]
    pub extensions: BTreeMap<String, bool>,
}

fn default_experimental_features() -> BTreeMap<String, bool> {
    BTreeMap::from([
        ("largeModelVirtualization".into(), false),
        ("relationshipInferenceV2".into(), false),
    ])
}

fn default_extensions() -> BTreeMap<String, bool> {
    BTreeMap::from([
        ("environmentDrift".into(), true),
        ("migrationProvenance".into(), true),
        ("codeLineage".into(), true),
    ])
}

impl Default for AdvancedSettings {
    fn default() -> Self {
        Self {
            performance_metrics: false,
            layout_worker_timeout_ms: 15_000,
            render_degrade_threshold: 500,
            beta_features: false,
            experimental_features: default_experimental_features(),
            extensions: default_extensions(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceSettings {
    pub schema_version: u16,
    pub legacy_storage_migration_version: u16,
    pub source_id: Uuid,
    pub refresh: RefreshSettings,
    pub storage: SourceStorageSettings,
    pub git: GitSettings,
    pub ai: AiSettings,
    pub cloud: CloudSettings,
}

impl DataSourceSettings {
    pub fn defaults_for(source_id: Uuid) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            legacy_storage_migration_version: 0,
            source_id,
            refresh: RefreshSettings::default(),
            storage: SourceStorageSettings::default(),
            git: GitSettings::default(),
            ai: AiSettings::default(),
            cloud: CloudSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSettings {
    pub interval_seconds: u32,
    pub pause_in_background: bool,
    pub change_notifications: ChangeNotificationLevel,
    pub connection_timeout_seconds: u16,
    pub introspection_timeout_seconds: u16,
    pub auto_connect: bool,
}

impl Default for RefreshSettings {
    fn default() -> Self {
        Self {
            interval_seconds: 30,
            pause_in_background: true,
            change_notifications: ChangeNotificationLevel::HighRisk,
            connection_timeout_seconds: 15,
            introspection_timeout_seconds: 60,
            auto_connect: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStorageSettings {
    pub capture_policy: CapturePolicy,
    pub retention: RetentionPolicy,
    pub retention_value: u16,
    pub preserve_high_risk: bool,
}

impl Default for SourceStorageSettings {
    fn default() -> Self {
        Self {
            capture_policy: CapturePolicy::OnChange,
            retention: RetentionPolicy::Forever,
            retention_value: 100,
            preserve_high_risk: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    pub repository_path: String,
    pub commit_reminders: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub enabled: bool,
    pub provider: AiProviderKind,
    pub endpoint: String,
    pub model: String,
    pub timeout_seconds: u16,
    pub max_retries: u8,
    pub max_concurrency: u8,
    pub context_scope: AiContextScope,
    pub include_comments: bool,
    pub include_confirmed_semantics: bool,
    pub credential_configured: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: AiProviderKind::Offline,
            endpoint: String::new(),
            model: String::new(),
            timeout_seconds: 30,
            max_retries: 1,
            max_concurrency: 2,
            context_scope: AiContextScope::CurrentTable,
            include_comments: true,
            include_confirmed_semantics: true,
            credential_configured: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettings {
    pub enabled: bool,
    pub endpoint: String,
    #[serde(default)]
    pub viewer_url: String,
    pub account_label: String,
    pub team_id: String,
    pub project_id: String,
    pub sync_semantics: bool,
    pub sync_domains: bool,
    pub sync_saved_views: bool,
    pub sync_change_sets: bool,
    pub sync_snapshots: bool,
    pub sync_shared_layouts: bool,
    pub sync_personal_layouts: bool,
    pub conflict_strategy: ConflictStrategy,
    pub credential_configured: bool,
    #[serde(default)]
    pub base_version: i64,
    #[serde(default)]
    pub last_success_at: Option<String>,
}

impl Default for CloudSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: String::new(),
            viewer_url: String::new(),
            account_label: String::new(),
            team_id: String::new(),
            project_id: String::new(),
            sync_semantics: true,
            sync_domains: true,
            sync_saved_views: true,
            sync_change_sets: true,
            sync_snapshots: false,
            sync_shared_layouts: true,
            sync_personal_layouts: false,
            conflict_strategy: ConflictStrategy::Ask,
            credential_configured: false,
            base_version: 0,
            last_success_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationPolicy {
    pub version: u64,
    pub source: String,
    pub expires_at: Option<String>,
    pub force_offline: bool,
    pub allow_remote_ai: bool,
    pub allow_cloud_sync: bool,
    pub allow_diagnostics: bool,
    pub allow_update_checks: bool,
    pub max_retention_days: Option<u16>,
}

impl Default for OrganizationPolicy {
    fn default() -> Self {
        Self {
            version: 0,
            source: "Local defaults".into(),
            expires_at: None,
            force_offline: false,
            allow_remote_ai: true,
            allow_cloud_sync: true,
            allow_diagnostics: true,
            allow_update_checks: true,
            max_retention_days: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSetting {
    pub path: String,
    pub source: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSettings {
    pub app: AppSettings,
    pub source: Option<DataSourceSettings>,
    pub project: Option<ProjectSettings>,
    pub managed: Vec<ManagedSetting>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub schema_version: u16,
    pub project_id: String,
    pub shared_canvas: Option<CanvasSettings>,
    pub allow_snapshot_sync: bool,
    pub allow_shared_layouts: bool,
    pub allow_remote_ai: bool,
    pub updated_at: String,
}

impl ProjectSettings {
    pub fn defaults_for(project_id: impl Into<String>) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            project_id: project_id.into(),
            shared_canvas: None,
            allow_snapshot_sync: false,
            allow_shared_layouts: true,
            allow_remote_ai: true,
            updated_at: String::new(),
        }
    }

    /// Verifies the project identity and shared Settings schema.
    ///
    /// # Errors
    ///
    /// Returns an error when the document cannot be safely applied.
    pub fn validate(&self) -> Result<(), SettingsValidationError> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsValidationError::UnsupportedVersion);
        }
        if self.project_id.trim().is_empty() {
            return Err(SettingsValidationError::InvalidProjectId);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub snapshot_bytes: u64,
    pub semantic_bytes: u64,
    pub layout_bytes: u64,
    pub sync_queue_bytes: u64,
    pub settings_bytes: u64,
    pub snapshot_count: u64,
    pub pending_sync_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub offline_mode: bool,
    pub database_credential_configured: bool,
    pub ai_credential_configured: bool,
    pub cloud_credential_configured: bool,
    pub weak_ssl_sources: u64,
    pub failed_or_conflicted_sync_items: u64,
    pub stale_model_sources: u64,
    pub unresolved_git_conflict_reports: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDriverStatus {
    pub repository_is_git: bool,
    pub manifest_present: bool,
    pub attributes_configured: bool,
    pub driver_configured: bool,
    #[serde(default)]
    pub driver_version: Option<String>,
    #[serde(default)]
    pub expected_version: String,
    #[serde(default)]
    pub install_command: String,
    pub conflict_reports: Vec<String>,
    pub fingerprint_matches: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsExportBundle {
    pub format_version: u16,
    pub exported_at: String,
    pub app: AppSettings,
    pub sources: Vec<DataSourceSettings>,
}

impl SettingsExportBundle {
    pub fn sanitize(&mut self) {
        for source in &mut self.sources {
            source.ai.credential_configured = false;
            source.cloud.credential_configured = false;
        }
    }

    /// Validates every document before it is imported into local persistence.
    ///
    /// # Errors
    ///
    /// Returns an error when the format or any nested settings document is invalid.
    pub fn validate(&self) -> Result<(), SettingsValidationError> {
        if self.format_version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsValidationError::UnsupportedVersion);
        }
        self.app.validate()?;
        for source in &self.sources {
            source.validate()?;
        }
        Ok(())
    }
}

pub fn apply_policy(
    app: AppSettings,
    source: Option<DataSourceSettings>,
    policy: &OrganizationPolicy,
) -> EffectiveSettings {
    apply_settings_layers(app, source, None, policy)
}

pub fn apply_settings_layers(
    mut app: AppSettings,
    mut source: Option<DataSourceSettings>,
    project: Option<ProjectSettings>,
    policy: &OrganizationPolicy,
) -> EffectiveSettings {
    let mut managed = Vec::new();
    if let (Some(source_settings), Some(project_settings)) = (&mut source, &project) {
        if let Some(shared_canvas) = &project_settings.shared_canvas {
            app.canvas.clone_from(shared_canvas);
            managed.push(ManagedSetting {
                path: "canvas".into(),
                source: format!("Project {}", project_settings.project_id),
                reason: "This project shares a common ER presentation policy.".into(),
            });
        }
        if !project_settings.allow_snapshot_sync {
            source_settings.cloud.sync_snapshots = false;
            managed.push(ManagedSetting {
                path: "cloud.syncSnapshots".into(),
                source: format!("Project {}", project_settings.project_id),
                reason: "Snapshot sync is disabled for this project.".into(),
            });
        }
        if !project_settings.allow_shared_layouts {
            source_settings.cloud.sync_shared_layouts = false;
        }
        if !project_settings.allow_remote_ai
            && source_settings.ai.provider != AiProviderKind::Offline
        {
            source_settings.ai.enabled = false;
            managed.push(ManagedSetting {
                path: "ai.enabled".into(),
                source: format!("Project {}", project_settings.project_id),
                reason: "Remote AI is disabled for this project.".into(),
            });
        }
    }
    let mut lock = |path: &str, reason: &str| {
        managed.push(ManagedSetting {
            path: path.into(),
            source: policy.source.clone(),
            reason: reason.into(),
        });
    };
    if policy.force_offline {
        app.privacy.offline_mode = true;
        lock(
            "privacy.offlineMode",
            "The organization requires offline operation.",
        );
    }
    if !policy.allow_diagnostics || app.privacy.offline_mode {
        app.privacy.diagnostics_enabled = false;
        app.privacy.crash_reports_enabled = false;
        lock(
            "privacy.diagnosticsEnabled",
            "External diagnostics are not allowed.",
        );
    }
    if !policy.allow_update_checks || app.privacy.offline_mode {
        app.updates.automatic_checks = false;
        lock(
            "updates.automaticChecks",
            "External update checks are not allowed.",
        );
    }
    if let Some(settings) = &mut source {
        if !policy.allow_remote_ai || app.privacy.offline_mode {
            if settings.ai.provider != AiProviderKind::Offline {
                settings.ai.enabled = false;
            }
            lock("ai.enabled", "Remote AI is disabled by privacy policy.");
        }
        if !policy.allow_cloud_sync || app.privacy.offline_mode {
            settings.cloud.enabled = false;
            lock("cloud.enabled", "Cloud sync is disabled by privacy policy.");
        }
        if let Some(days) = policy.max_retention_days
            && settings.storage.retention == RetentionPolicy::Days
            && settings.storage.retention_value > days
        {
            settings.storage.retention_value = days;
            lock(
                "storage.retentionValue",
                "Retention is limited by organization policy.",
            );
        }
    }
    EffectiveSettings {
        app,
        source,
        project,
        managed,
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SettingsValidationError {
    #[error("settings schema version is not supported")]
    UnsupportedVersion,
    #[error("UI scale must be between 90 and 125 percent")]
    InvalidUiScale,
    #[error("sidebar width is outside the supported range")]
    InvalidSidebarWidth,
    #[error("refresh interval must be off or at least 30 seconds")]
    InvalidRefreshInterval,
    #[error("timeout values must be greater than zero")]
    InvalidTimeout,
    #[error("remote endpoints must use HTTP or HTTPS")]
    InvalidEndpoint,
    #[error("retention value must be greater than zero")]
    InvalidRetention,
    #[error("project settings require a project identifier")]
    InvalidProjectId,
    #[error("code analysis file limit must be between 64 KiB and 10 MiB")]
    InvalidCodeAnalysisFileLimit,
}

impl AppSettings {
    /// Verifies schema compatibility and bounded UI/storage values.
    ///
    /// # Errors
    ///
    /// Returns the first invalid or unsupported setting.
    pub fn validate(&self) -> Result<(), SettingsValidationError> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsValidationError::UnsupportedVersion);
        }
        if !(90..=125).contains(&self.general.ui_scale_percent) {
            return Err(SettingsValidationError::InvalidUiScale);
        }
        if !(220..=480).contains(&self.appearance.left_sidebar_width)
            || !(240..=520).contains(&self.appearance.right_sidebar_width)
        {
            return Err(SettingsValidationError::InvalidSidebarWidth);
        }
        if self.history.retention != RetentionPolicy::Forever && self.history.retention_value == 0 {
            return Err(SettingsValidationError::InvalidRetention);
        }
        if !(64 * 1024..=10 * 1024 * 1024).contains(&self.code_analysis.max_file_bytes) {
            return Err(SettingsValidationError::InvalidCodeAnalysisFileLimit);
        }
        Ok(())
    }
}

impl DataSourceSettings {
    /// Verifies source-scoped intervals, endpoints, timeouts, and retention values.
    ///
    /// # Errors
    ///
    /// Returns the first invalid or unsupported setting.
    pub fn validate(&self) -> Result<(), SettingsValidationError> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsValidationError::UnsupportedVersion);
        }
        if self.refresh.interval_seconds != 0 && self.refresh.interval_seconds < 30 {
            return Err(SettingsValidationError::InvalidRefreshInterval);
        }
        if self.refresh.connection_timeout_seconds == 0
            || self.refresh.introspection_timeout_seconds == 0
            || self.ai.timeout_seconds == 0
        {
            return Err(SettingsValidationError::InvalidTimeout);
        }
        if self.storage.retention != RetentionPolicy::Forever && self.storage.retention_value == 0 {
            return Err(SettingsValidationError::InvalidRetention);
        }
        for endpoint in [
            &self.ai.endpoint,
            &self.cloud.endpoint,
            &self.cloud.viewer_url,
        ] {
            if !endpoint.is_empty()
                && !endpoint.starts_with("https://")
                && !endpoint.starts_with("http://")
            {
                return Err(SettingsValidationError::InvalidEndpoint);
            }
        }
        Ok(())
    }
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum $name { $($variant),+ }
    };
}

string_enum!(Language { System, ZhCn, En });
string_enum!(Theme {
    System,
    Dark,
    Light
});
string_enum!(StartPage {
    LastDataSource,
    Connection,
    Blank
});
string_enum!(DateTimeFormat { Local, Iso8601 });
string_enum!(Density {
    Comfortable,
    Compact
});
string_enum!(IndexDisplay {
    Expanded,
    Collapsed,
    Hidden
});
string_enum!(EdgeStyle { Orthogonal, Curved });
string_enum!(LayoutDirection {
    LeftToRight,
    TopToBottom
});
string_enum!(CapturePolicy {
    OnChange,
    Interval,
    Manual
});
string_enum!(RetentionPolicy {
    Forever,
    Count,
    Days
});
string_enum!(LogLevel {
    Error,
    Warn,
    Info,
    Debug
});
string_enum!(ChangeNotificationLevel { All, HighRisk, Off });
string_enum!(UpdateChannel { Stable, Beta });
string_enum!(AiProviderKind {
    Offline,
    OpenAiCompatible
});
string_enum!(AiContextScope {
    CurrentTable,
    OneHop,
    Domain
});
string_enum!(ConflictStrategy {
    Ask,
    KeepLocal,
    KeepRemote
});
string_enum!(DatabaseEngine { PostgreSql, MySql });
string_enum!(DefaultSslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_do_not_serialize_secrets() {
        let app = AppSettings::default();
        let source = DataSourceSettings::defaults_for(Uuid::new_v4());
        app.validate().unwrap();
        source.validate().unwrap();
        let serialized = serde_json::to_string(&(app, source)).unwrap();
        for forbidden in ["password", "apiKey", "accessToken", "connectionString"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn offline_policy_disables_every_external_capability() {
        let mut app = AppSettings::default();
        app.privacy.diagnostics_enabled = true;
        app.updates.automatic_checks = true;
        let mut source = DataSourceSettings::defaults_for(Uuid::new_v4());
        source.ai.enabled = true;
        source.ai.provider = AiProviderKind::OpenAiCompatible;
        source.cloud.enabled = true;
        let effective = apply_policy(
            app,
            Some(source),
            &OrganizationPolicy {
                force_offline: true,
                ..OrganizationPolicy::default()
            },
        );
        assert!(effective.app.privacy.offline_mode);
        assert!(!effective.app.privacy.diagnostics_enabled);
        assert!(!effective.app.updates.automatic_checks);
        assert!(!effective.source.unwrap().cloud.enabled);
    }

    #[test]
    fn rejects_unsafe_refresh_and_endpoint_values() {
        let mut source = DataSourceSettings::defaults_for(Uuid::new_v4());
        source.refresh.interval_seconds = 5;
        assert_eq!(
            source.validate(),
            Err(SettingsValidationError::InvalidRefreshInterval)
        );
        source.refresh.interval_seconds = 30;
        source.cloud.endpoint = "file:///tmp/token".into();
        assert_eq!(
            source.validate(),
            Err(SettingsValidationError::InvalidEndpoint)
        );
    }

    #[test]
    fn settings_export_removes_credential_presence_metadata() {
        let mut source = DataSourceSettings::defaults_for(Uuid::new_v4());
        source.ai.credential_configured = true;
        source.cloud.credential_configured = true;
        let mut bundle = SettingsExportBundle {
            format_version: SETTINGS_SCHEMA_VERSION,
            exported_at: "2026-07-11T00:00:00Z".into(),
            app: AppSettings::default(),
            sources: vec![source],
        };
        bundle.sanitize();
        bundle.validate().unwrap();
        assert!(!bundle.sources[0].ai.credential_configured);
        assert!(!bundle.sources[0].cloud.credential_configured);
    }

    #[test]
    fn project_rules_override_source_and_canvas_before_organization_policy() {
        let app = AppSettings::default();
        let mut source = DataSourceSettings::defaults_for(Uuid::new_v4());
        source.cloud.sync_snapshots = true;
        source.ai.enabled = true;
        source.ai.provider = AiProviderKind::OpenAiCompatible;
        let mut project = ProjectSettings::defaults_for("project-1");
        project.allow_snapshot_sync = false;
        project.allow_remote_ai = false;
        let shared_canvas = CanvasSettings {
            indexes: IndexDisplay::Hidden,
            ..CanvasSettings::default()
        };
        project.shared_canvas = Some(shared_canvas);

        let effective = apply_settings_layers(
            app,
            Some(source),
            Some(project),
            &OrganizationPolicy::default(),
        );

        assert_eq!(effective.app.canvas.indexes, IndexDisplay::Hidden);
        assert!(!effective.source.as_ref().unwrap().cloud.sync_snapshots);
        assert!(!effective.source.unwrap().ai.enabled);
        assert!(effective.managed.iter().any(|item| item.path == "canvas"));
    }
}
