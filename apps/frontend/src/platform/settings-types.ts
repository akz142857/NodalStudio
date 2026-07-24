export type Language = "system" | "zhCn" | "en";
export type Theme = "system" | "dark" | "light";
export type StartPage = "lastDataSource" | "connection" | "blank";
export type DateTimeFormat = "local" | "iso8601";
export type Density = "comfortable" | "compact";
export type IndexDisplay = "expanded" | "collapsed" | "hidden";
export type EdgeStyle = "orthogonal" | "curved";
export type LayoutDirection = "leftToRight" | "topToBottom";
export type CapturePolicy = "onChange" | "interval" | "manual";
export type RetentionPolicy = "forever" | "count" | "days";
export type LogLevel = "error" | "warn" | "info" | "debug";
export type ChangeNotificationLevel = "all" | "highRisk" | "off";
export type UpdateChannel = "stable" | "beta";
export type AiProviderKind = "offline" | "openAiCompatible";
export type AiContextScope = "currentTable" | "oneHop" | "domain";
export type ConflictStrategy = "ask" | "keepLocal" | "keepRemote";

export interface AppSettings {
  schemaVersion: number;
  legacyStorageMigrationVersion: number;
  general: {
    language: Language;
    theme: Theme;
    uiScalePercent: number;
    startPage: StartPage;
    reopenLastWorkspace: boolean;
    confirmBeforeQuit: boolean;
    dateTimeFormat: DateTimeFormat;
    lastSourceId: string | null;
    lastViewMode: "explore" | "query" | "changes" | "history";
  };
  appearance: {
    density: Density;
    uiFontSize: number;
    nodeFontSize: number;
    monospaceFontSize: number;
    reduceMotion: boolean;
    highContrastRelations: boolean;
    colorBlindPalette: boolean;
    leftSidebarExpanded: boolean;
    leftSidebarWidth: number;
    rightSidebarExpanded: boolean;
    rightSidebarWidth: number;
    restoreSidebarState: boolean;
  };
  canvas: {
    showSchema: boolean;
    showTableComments: boolean;
    showColumnTypes: boolean;
    showColumnNullable: boolean;
    showColumnDefaults: boolean;
    showColumnComments: boolean;
    showKeyBadges: boolean;
    indexes: IndexDisplay;
    maxInitialColumns: number;
    showDeclaredRelationships: boolean;
    showInferredRelationships: boolean;
    fieldLevelEdges: boolean;
    showRelationNames: boolean;
    showCardinality: boolean;
    showReferentialActions: boolean;
    relationshipHighlightDepth: number;
    edgeStyle: EdgeStyle;
    layoutDirection: LayoutDirection;
    nodeSpacing: number;
    layerSpacing: number;
    edgeSpacing: number;
    restorePersonalLayout: boolean;
    largeModelThreshold: number;
  };
  connectionDefaults: {
    databaseEngine: "postgreSql" | "mySql";
    sslMode: "disable" | "prefer" | "require" | "verifyCa" | "verifyFull";
  };
  history: {
    capturePolicy: CapturePolicy;
    retention: RetentionPolicy;
    retentionValue: number;
    preserveHighRisk: boolean;
    storageWarningMegabytes: number;
  };
  privacy: {
    offlineMode: boolean;
    diagnosticsEnabled: boolean;
    crashReportsEnabled: boolean;
    logLevel: LogLevel;
    logRetentionDays: number;
  };
  notifications: {
    schemaChanges: ChangeNotificationLevel;
    gitConflicts: boolean;
    cloudFailures: boolean;
    storageWarnings: boolean;
    updateAvailable: boolean;
    systemNotifications: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
  };
  shortcuts: { bindings: Record<string, string> };
  updates: {
    automaticChecks: boolean;
    channel: UpdateChannel;
    customFeedUrl: string | null;
  };
  advanced: {
    performanceMetrics: boolean;
    layoutWorkerTimeoutMs: number;
    renderDegradeThreshold: number;
    betaFeatures: boolean;
    experimentalFeatures: Record<string, boolean>;
    extensions: Record<string, boolean>;
  };
}

export interface DataSourceSettings {
  schemaVersion: number;
  legacyStorageMigrationVersion: number;
  sourceId: string;
  refresh: {
    intervalSeconds: number;
    pauseInBackground: boolean;
    changeNotifications: ChangeNotificationLevel;
    connectionTimeoutSeconds: number;
    introspectionTimeoutSeconds: number;
    autoConnect: boolean;
  };
  storage: {
    capturePolicy: CapturePolicy;
    retention: RetentionPolicy;
    retentionValue: number;
    preserveHighRisk: boolean;
  };
  git: { repositoryPath: string; commitReminders: boolean };
  ai: {
    enabled: boolean;
    provider: AiProviderKind;
    endpoint: string;
    model: string;
    timeoutSeconds: number;
    maxRetries: number;
    maxConcurrency: number;
    contextScope: AiContextScope;
    includeComments: boolean;
    includeConfirmedSemantics: boolean;
    credentialConfigured: boolean;
  };
  cloud: {
    enabled: boolean;
    endpoint: string;
    viewerUrl: string;
    accountLabel: string;
    teamId: string;
    projectId: string;
    syncSemantics: boolean;
    syncDomains: boolean;
    syncSavedViews: boolean;
    syncChangeSets: boolean;
    syncSnapshots: boolean;
    syncSharedLayouts: boolean;
    syncPersonalLayouts: boolean;
    conflictStrategy: ConflictStrategy;
    credentialConfigured: boolean;
    baseVersion: number;
    lastSuccessAt: string | null;
  };
}

export interface ManagedSetting {
  path: string;
  source: string;
  reason: string;
}

export interface EffectiveSettings {
  app: AppSettings;
  source: DataSourceSettings | null;
  project: ProjectSettings | null;
  managed: ManagedSetting[];
}

export interface ProjectSettings {
  schemaVersion: number;
  projectId: string;
  sharedCanvas: AppSettings["canvas"] | null;
  allowSnapshotSync: boolean;
  allowSharedLayouts: boolean;
  allowRemoteAi: boolean;
  updatedAt: string;
}

export interface OrganizationPolicy {
  version: number;
  source: string;
  expiresAt: string | null;
  forceOffline: boolean;
  allowRemoteAi: boolean;
  allowCloudSync: boolean;
  allowDiagnostics: boolean;
  allowUpdateChecks: boolean;
  maxRetentionDays: number | null;
}

export interface StorageUsage {
  snapshotBytes: number;
  semanticBytes: number;
  layoutBytes: number;
  syncQueueBytes: number;
  settingsBytes: number;
  snapshotCount: number;
  pendingSyncCount: number;
}

export interface SecurityStatus {
  offlineMode: boolean;
  databaseCredentialConfigured: boolean;
  aiCredentialConfigured: boolean;
  cloudCredentialConfigured: boolean;
  weakSslSources: number;
  failedOrConflictedSyncItems: number;
  staleModelSources: number;
  unresolvedGitConflictReports: number;
}

export interface MergeDriverStatus {
  repositoryIsGit: boolean;
  manifestPresent: boolean;
  attributesConfigured: boolean;
  driverConfigured: boolean;
  driverVersion: string | null;
  expectedVersion: string;
  installCommand: string;
  conflictReports: string[];
  fingerprintMatches: boolean | null;
}

export interface GitExportPreview {
  addedFiles: number;
  modifiedFiles: number;
  unchangedFiles: number;
  removedFiles: number;
  schemaFingerprint: string;
}

export interface GitImportPreview {
  annotations: number;
  domainGroups: number;
  savedViews: number;
  provenance: number;
  lineageLinks: number;
  logicalRelationships: number;
  relationshipConflicts: string[];
  fingerprintMatches: boolean;
  workspaceFingerprint: string;
}

export interface SettingsFileReceipt {
  path: string;
  sourceSettings: number;
}

export interface SettingsFilePreview {
  formatVersion: number;
  exportedAt: string;
  sourceSettings: number;
  replacesAppSettings: boolean;
  credentialsIncluded: boolean;
}

export interface BackupReceipt {
  path: string;
  snapshots: number;
  annotations: number;
  savedViews: number;
}

export interface BackupPreview {
  formatVersion: number;
  exportedAt: string;
  sourceId: string;
  sourceLabel: string | null;
  databaseName: string | null;
  databaseType: "postgreSql" | "mySql" | null;
  snapshots: number;
  annotations: number;
  savedViews: number;
  willUpdateExistingSource: boolean;
  conflictStrategy: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  availableVersion: string | null;
  downloadUrl: string | null;
  notes: string | null;
}

export interface DiagnosticInfo {
  appVersion: string;
  rustVersion: string;
  target: string;
  dataDirectory: string;
  logDirectory: string;
}

export interface DeleteSourceDataOptions {
  deleteConnection: boolean;
  deleteHistory: boolean;
  deleteSemantics: boolean;
  removeDatabaseCredential: boolean;
}

export interface SourceDataImpact {
  connectionRecords: number;
  snapshotRecords: number;
  semanticRecords: number;
  pendingSyncRecords: number;
  snapshotBytes: number;
  semanticBytes: number;
  syncQueueBytes: number;
  estimatedBytes: number;
}

export interface SyncDiagnostic {
  id: string;
  eventKind: string;
  attempts: number;
  state: string;
  createdAt: string;
}

export interface CloudAuditEntry {
  action: string;
  createdAt: string;
}

export interface CloudAccountResult {
  accountLabel: string;
  teamId: string;
  accessExpiresAt: string;
}

export interface CloudShareRecord {
  id: string;
  token: string;
  permission: string;
  expiresAt: string;
  createdAt: string;
}

export interface CloudShareSummary {
  id: string;
  permission: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastAccessAt: string | null;
}

export interface ExternalAccessRecord {
  capability: string;
  lastAccessAt: string;
  outcome: string;
}

export interface AiProviderTestResult {
  provider: string;
  model: string | null;
  testedAt: string;
  networkUsed: boolean;
}
