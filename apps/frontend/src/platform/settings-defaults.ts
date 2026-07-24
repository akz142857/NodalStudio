import type { AppSettings, DataSourceSettings, EffectiveSettings, ProjectSettings } from "./settings-types";

export function defaultAppSettings(): AppSettings {
  return {
    schemaVersion: 1,
    legacyStorageMigrationVersion: 0,
    general: { language: "system", theme: "system", uiScalePercent: 100, startPage: "lastDataSource", reopenLastWorkspace: true, confirmBeforeQuit: true, dateTimeFormat: "local", lastSourceId: null, lastViewMode: "explore" },
    appearance: { density: "comfortable", uiFontSize: 13, nodeFontSize: 12, monospaceFontSize: 11, reduceMotion: false, highContrastRelations: false, colorBlindPalette: false, leftSidebarExpanded: true, leftSidebarWidth: 272, rightSidebarExpanded: true, rightSidebarWidth: 300, restoreSidebarState: true },
    canvas: { showSchema: true, showTableComments: true, showColumnTypes: true, showColumnNullable: true, showColumnDefaults: false, showColumnComments: true, showKeyBadges: true, indexes: "expanded", maxInitialColumns: 60, showDeclaredRelationships: true, showInferredRelationships: false, fieldLevelEdges: true, showRelationNames: false, showCardinality: false, showReferentialActions: false, relationshipHighlightDepth: 1, edgeStyle: "orthogonal", layoutDirection: "leftToRight", nodeSpacing: 70, layerSpacing: 110, edgeSpacing: 24, restorePersonalLayout: true, largeModelThreshold: 500 },
    connectionDefaults: { databaseEngine: "postgreSql", sslMode: "prefer" },
    history: { capturePolicy: "onChange", retention: "forever", retentionValue: 100, preserveHighRisk: true, storageWarningMegabytes: 1024 },
    privacy: { offlineMode: false, diagnosticsEnabled: false, crashReportsEnabled: false, logLevel: "warn", logRetentionDays: 14 },
    notifications: { schemaChanges: "highRisk", gitConflicts: true, cloudFailures: true, storageWarnings: true, updateAvailable: true, systemNotifications: false, quietHoursEnabled: false, quietHoursStart: "22:00", quietHoursEnd: "08:00" },
    shortcuts: { bindings: { openSettings: "Mod+,", focusSearch: "Mod+F", refreshSchema: "Mod+R", toggleLeftSidebar: "Mod+Shift+L", toggleRightInspector: "Mod+Shift+I", fitCanvas: "F", focusSelectedTable: "Enter", relayoutCanvas: "Mod+Shift+R" } },
    updates: { automaticChecks: false, channel: "stable", customFeedUrl: null },
    advanced: { performanceMetrics: false, layoutWorkerTimeoutMs: 15_000, renderDegradeThreshold: 500, betaFeatures: false, experimentalFeatures: { largeModelVirtualization: false, relationshipInferenceV2: false }, extensions: { environmentDrift: true, migrationProvenance: true, codeLineage: true } },
  };
}

export function defaultDataSourceSettings(sourceId: string): DataSourceSettings {
  return {
    schemaVersion: 1,
    legacyStorageMigrationVersion: 0,
    sourceId,
    refresh: { intervalSeconds: 30, pauseInBackground: true, changeNotifications: "highRisk", connectionTimeoutSeconds: 15, introspectionTimeoutSeconds: 60, autoConnect: false },
    storage: { capturePolicy: "onChange", retention: "forever", retentionValue: 100, preserveHighRisk: true },
    git: { repositoryPath: "", commitReminders: false },
    ai: { enabled: false, provider: "offline", endpoint: "", model: "", timeoutSeconds: 30, maxRetries: 1, maxConcurrency: 2, contextScope: "currentTable", includeComments: true, includeConfirmedSemantics: true, credentialConfigured: false },
    cloud: { enabled: false, endpoint: "", viewerUrl: "", accountLabel: "", teamId: "", projectId: "", syncSemantics: true, syncDomains: true, syncSavedViews: true, syncChangeSets: true, syncSnapshots: false, syncSharedLayouts: true, syncPersonalLayouts: false, conflictStrategy: "ask", credentialConfigured: false, baseVersion: 0, lastSuccessAt: null },
  };
}

export function defaultEffectiveSettings(sourceId?: string): EffectiveSettings {
  return { app: defaultAppSettings(), source: sourceId ? defaultDataSourceSettings(sourceId) : null, project: null, managed: [] };
}

export function defaultProjectSettings(projectId: string): ProjectSettings {
  return { schemaVersion: 1, projectId, sharedCanvas: null, allowSnapshotSync: false, allowSharedLayouts: true, allowRemoteAi: true, updatedAt: new Date().toISOString() };
}
