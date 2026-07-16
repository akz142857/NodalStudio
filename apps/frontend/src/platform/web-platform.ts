import type {
  CloudViewBundle,
  CaptureSnapshotResult,
  DataSourceProfile,
  ConnectionTestResult,
  DatabaseSnapshot,
  DomainGroup,
  ObjectAnnotation,
  RuntimeInfo,
  SchemaChangeSet,
  SemanticBundle,
  SavedView,
  SnapshotSummary,
  NodalStudioPlatform,
  LocalProject,
  ProjectScan,
  ProjectGraphSnapshot,
  ObjectKey,
  LogicalRelationship,
  IgnoredRelationshipInference,
  RelationshipValidation,
} from "./types";
import { defaultAppSettings, defaultDataSourceSettings } from "./settings-defaults";
import type {
  AppSettings,
  DataSourceSettings,
  EffectiveSettings,
  OrganizationPolicy,
  ProjectSettings,
  MergeDriverStatus,
  SecurityStatus,
  StorageUsage,
  SettingsFileReceipt,
  BackupReceipt,
  UpdateCheckResult,
  DeleteSourceDataOptions,
  SyncDiagnostic,
} from "./settings-types";

const APP_SETTINGS_KEY = "nodalstudio.settings.app.v1";
const sourceSettingsKey = (sourceId: string) => `nodalstudio.settings.source.${sourceId}.v1`;
const LEGACY_APP_SETTINGS_KEY = "sqlaieditor.settings.app.v1";
const legacySourceSettingsKey = (sourceId: string) => `sqlaieditor.settings.source.${sourceId}.v1`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function readAppSettings(): AppSettings {
  const defaults = defaultAppSettings();
  const stored = readJson<Partial<AppSettings>>(
    APP_SETTINGS_KEY,
    readJson<Partial<AppSettings>>(LEGACY_APP_SETTINGS_KEY, {}),
  );
  return {
    ...defaults,
    ...stored,
    general: { ...defaults.general, ...stored.general },
    appearance: { ...defaults.appearance, ...stored.appearance },
    canvas: { ...defaults.canvas, ...stored.canvas },
    codeAnalysis: { ...defaults.codeAnalysis, ...stored.codeAnalysis },
    connectionDefaults: { ...defaults.connectionDefaults, ...stored.connectionDefaults },
    history: { ...defaults.history, ...stored.history },
    privacy: { ...defaults.privacy, ...stored.privacy },
    notifications: { ...defaults.notifications, ...stored.notifications },
    shortcuts: { bindings: { ...defaults.shortcuts.bindings, ...stored.shortcuts?.bindings } },
    updates: { ...defaults.updates, ...stored.updates },
    advanced: {
      ...defaults.advanced,
      ...stored.advanced,
      experimentalFeatures: { ...defaults.advanced.experimentalFeatures, ...stored.advanced?.experimentalFeatures },
      extensions: { ...defaults.advanced.extensions, ...stored.advanced?.extensions },
    },
  };
}

function readSourceSettings(sourceId: string): DataSourceSettings {
  const defaults = defaultDataSourceSettings(sourceId);
  const stored = readJson<Partial<DataSourceSettings>>(
    sourceSettingsKey(sourceId),
    readJson<Partial<DataSourceSettings>>(legacySourceSettingsKey(sourceId), {}),
  );
  return {
    ...defaults,
    ...stored,
    sourceId,
    refresh: { ...defaults.refresh, ...stored.refresh },
    storage: { ...defaults.storage, ...stored.storage },
    git: { ...defaults.git, ...stored.git },
    ai: { ...defaults.ai, ...stored.ai },
    cloud: { ...defaults.cloud, ...stored.cloud },
  };
}

export class WebPlatform implements NodalStudioPlatform {
  private bundle: CloudViewBundle | null = null;

  getRuntimeInfo(): Promise<RuntimeInfo> {
    return Promise.resolve({
      kind: "web",
      label: "Web runtime",
      version: "0.1.0",
    });
  }

  getDiagnosticInfo(): Promise<import("./settings-types").DiagnosticInfo> {
    return Promise.resolve({ appVersion: "0.1.0", rustVersion: "Unavailable in Web Viewer", target: "web", dataDirectory: "Browser storage", logDirectory: "Browser developer console" });
  }

  revealAppDirectory(): Promise<never> {
    return Promise.reject(new Error("Application directories require the desktop app."));
  }

  listDataSources(): Promise<DataSourceProfile[]> {
    return Promise.resolve([]);
  }

  renameDataSource(): Promise<never> {
    return Promise.reject(new Error("Data source management requires the desktop app."));
  }

  duplicateDataSource(): Promise<never> {
    return Promise.reject(new Error("Data source management requires the desktop app."));
  }

  saveDataSource(): Promise<DataSourceProfile> {
    return Promise.reject(new Error("Saving data sources requires the desktop app."));
  }

  testPostgresConnection(): Promise<ConnectionTestResult> {
    return Promise.reject(new Error("Database connections require the desktop app."));
  }

  capturePostgresSnapshot(): Promise<CaptureSnapshotResult> {
    return Promise.reject(new Error("Database capture requires the desktop app."));
  }

  listSnapshots(): Promise<SnapshotSummary[]> {
    return Promise.resolve([]);
  }

  getSnapshot(snapshotId: string): Promise<DatabaseSnapshot> {
    if (this.bundle?.snapshot?.id === snapshotId) return Promise.resolve(this.bundle.snapshot);
    return Promise.reject(new Error("Snapshot is not available in this shared view."));
  }

  compareSnapshots(): Promise<SchemaChangeSet> {
    return Promise.reject(new Error("Snapshot comparison requires the desktop app."));
  }

  executeReadonlyQuery(): Promise<never> {
    return Promise.reject(new Error("Query execution requires the desktop app."));
  }

  cancelQuery(): Promise<boolean> { return Promise.resolve(false); }
  listQueryHistory(): Promise<[]> { return Promise.resolve([]); }
  deleteQueryHistory(): Promise<boolean> { return Promise.resolve(false); }
  clearQueryHistory(): Promise<number> { return Promise.resolve(0); }

  getSemantics(): Promise<SemanticBundle> {
    if (this.bundle) {
      return Promise.resolve({
        annotations: this.bundle.annotations,
        orphanedAnnotations: [],
        domainGroups: this.bundle.domainGroups,
        savedViews: this.bundle.savedViews,
        layout: this.bundle.layout,
        logicalRelationships: this.bundle.logicalRelationships ?? [],
        ignoredRelationshipInferences: [],
      });
    }
    return Promise.resolve({
      annotations: [],
      orphanedAnnotations: [],
      domainGroups: [],
      savedViews: [],
      layout: null,
      logicalRelationships: [],
      ignoredRelationshipInferences: [],
    });
  }

  listLogicalRelationships(): Promise<LogicalRelationship[]> {
    return Promise.resolve(this.bundle?.logicalRelationships ?? []);
  }

  validateLogicalRelationship(): Promise<RelationshipValidation> {
    return Promise.reject(new Error("Logical relationship validation requires the desktop app."));
  }

  createLogicalRelationship(): Promise<LogicalRelationship> {
    return Promise.reject(new Error("Logical relationship editing requires the desktop app."));
  }

  updateLogicalRelationship(): Promise<LogicalRelationship> {
    return Promise.reject(new Error("Logical relationship editing requires the desktop app."));
  }

  deleteLogicalRelationship(): Promise<boolean> {
    return Promise.reject(new Error("Logical relationship editing requires the desktop app."));
  }

  ignoreRelationshipInference(): Promise<IgnoredRelationshipInference> {
    return Promise.reject(new Error("Relationship review requires the desktop app."));
  }

  listIgnoredRelationshipInferences(): Promise<IgnoredRelationshipInference[]> {
    return Promise.resolve([]);
  }

  saveAnnotation(): Promise<ObjectAnnotation> {
    return Promise.reject(new Error("Annotations require the desktop app."));
  }

  saveDomainGroup(): Promise<DomainGroup> {
    return Promise.reject(new Error("Domain groups require the desktop app."));
  }

  saveView(): Promise<SavedView> {
    return Promise.reject(new Error("Saved views require the desktop app."));
  }

  saveLayout(): Promise<void> {
    return Promise.reject(new Error("Layout persistence requires the desktop app."));
  }

  explainSchema(): Promise<never> {
    return Promise.reject(new Error("AI explanations require the desktop app or cloud API."));
  }

  testAiProvider(): Promise<never> {
    return Promise.reject(new Error("AI provider testing requires the desktop app."));
  }

  async loadSharedBundle(): Promise<CloudViewBundle | null> {
    const shareToken = new URLSearchParams(window.location.search).get("share");
    const apiBase = import.meta.env.VITE_CLOUD_API_URL as string | undefined;
    if (!shareToken || !apiBase) return null;
    const response = await fetch(
      `${apiBase.replace(/\/$/, "")}/v1/view/${encodeURIComponent(shareToken)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error("Shared project could not be loaded.");
    this.bundle = (await response.json()) as CloudViewBundle;
    return this.bundle;
  }

  syncProject(): Promise<never> {
    return Promise.reject(new Error("Cloud publishing requires the desktop app."));
  }

  compareEnvironmentSnapshots(): Promise<never> {
    return Promise.reject(new Error("Environment drift comparison requires the desktop app."));
  }

  saveChangeProvenance(): Promise<never> {
    return Promise.reject(new Error("Change provenance editing requires the desktop app."));
  }

  saveCodeLineage(): Promise<never> {
    return Promise.reject(new Error("Code lineage import requires the desktop app."));
  }

  addLocalProject(): Promise<never> {
    return Promise.reject(new Error("Local project scanning requires the desktop app."));
  }
  cloneRemoteProject(): Promise<never> { return Promise.reject(new Error("Remote project cloning requires the desktop app.")); }
  selectProjectDirectory(): Promise<null> { return Promise.resolve(null); }

  listLocalProjects(): Promise<LocalProject[]> {
    return Promise.resolve((this.bundle?.projectGraphs ?? []).map((project) => ({
      id: project.projectId,
      name: project.projectName,
      rootPath: "",
      repositoryKind: "directory",
      remoteUrl: null,
      managedCache: false,
      databaseSourceIds: this.bundle ? [this.bundle.sourceId] : [],
      createdAt: project.scan.startedAt,
    })));
  }
  setProjectBindings(): Promise<never> { return Promise.reject(new Error("Project bindings require the desktop app.")); }

  removeLocalProject(): Promise<never> {
    return Promise.reject(new Error("Local project scanning requires the desktop app."));
  }

  startProjectScan(): Promise<never> {
    return Promise.reject(new Error("Local project scanning requires the desktop app."));
  }

  cancelProjectScan(): Promise<false> {
    return Promise.resolve(false);
  }

  getProjectScanStatus(scanId: string): Promise<ProjectScan | null> {
    return Promise.resolve(this.bundle?.projectGraphs.find((project) => project.scan.id === scanId)?.scan ?? null);
  }

  listProjectScans(projectId: string): Promise<ProjectScan[]> {
    const shared = this.bundle?.projectGraphs.find((project) => project.projectId === projectId);
    return Promise.resolve(shared ? [shared.scan] : []);
  }

  getProjectGraph(scanId: string): Promise<ProjectGraphSnapshot> {
    const shared = this.bundle?.projectGraphs.find((project) => project.scan.id === scanId);
    return shared
      ? Promise.resolve({ scanId, nodes: shared.nodes, edges: shared.edges })
      : Promise.reject(new Error("Shared project graph is not available."));
  }

  getDatabaseCodeUsage(_sourceId: string, objectKey: ObjectKey): Promise<{ nodes: import("./types").ProjectNode[]; edges: import("./types").ProjectEdge[] }> {
    const nodes = (this.bundle?.projectGraphs ?? []).flatMap((project) => project.nodes);
    const edges = (this.bundle?.projectGraphs ?? []).flatMap((project) => project.edges);
    const roots = new Set(nodes.filter((node) => node.databaseObject?.kind === objectKey.kind && node.databaseObject.schema === objectKey.schema && node.databaseObject.name === objectKey.name).map((node) => node.id));
    const selectedEdges = edges.filter((edge) => roots.has(edge.sourceId) || roots.has(edge.targetId));
    const ids = new Set([...roots, ...selectedEdges.flatMap((edge) => [edge.sourceId, edge.targetId])]);
    return Promise.resolve({ nodes: nodes.filter((node) => ids.has(node.id)), edges: selectedEdges });
  }
  getChangeImpact(_sourceId: string, objectKeys: ObjectKey[], maxDepth = 4): Promise<import("./types").ImpactPath[]> {
    void _sourceId;
    const nodes = (this.bundle?.projectGraphs ?? []).flatMap((project) => project.nodes);
    const edges = (this.bundle?.projectGraphs ?? []).flatMap((project) => project.edges);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, typeof edges>();
    for (const edge of edges) {
      const values = incoming.get(edge.targetId) ?? [];
      values.push(edge);
      incoming.set(edge.targetId, values);
    }
    const paths: import("./types").ImpactPath[] = [];
    for (const target of objectKeys) {
      const roots = nodes.filter((node) =>
        node.databaseObject?.kind === target.kind &&
        node.databaseObject.schema === target.schema &&
        node.databaseObject.name === target.name,
      );
      for (const root of roots) {
        const queue = [{ id: root.id, nodeIds: [root.id], edgeIds: [] as string[], potential: false, depth: 0 }];
        const visited = new Set<string>();
        while (queue.length) {
          const current = queue.shift();
          if (!current || current.depth >= Math.min(maxDepth, 8) || visited.has(`${current.id}:${current.depth}`)) continue;
          visited.add(`${current.id}:${current.depth}`);
          for (const edge of incoming.get(current.id) ?? []) {
            const source = nodeMap.get(edge.sourceId);
            if (!source) continue;
            const nodeIds = [...current.nodeIds, source.id];
            const edgeIds = [...current.edgeIds, edge.id];
            const potential = current.potential || edge.certainty === "convention" || edge.certainty === "aiInferred";
            if (source.kind !== "table" && source.kind !== "column") {
              paths.push({ target, nodeIds, edgeIds, potential });
            }
            queue.push({ id: source.id, nodeIds, edgeIds, potential, depth: current.depth + 1 });
          }
        }
      }
    }
    return Promise.resolve(paths);
  }
  openCodeLocation(): Promise<never> { return Promise.reject(new Error("Opening local code requires the desktop app.")); }

  listModelConnections(): Promise<[]> { return Promise.resolve([]); }
  saveModelConnection(): Promise<never> { return Promise.reject(new Error("Model connections require the desktop app.")); }
  deleteModelConnection(): Promise<never> { return Promise.reject(new Error("Model connections require the desktop app.")); }
  saveModelCredential(): Promise<never> { return Promise.reject(new Error("Model credentials require the desktop app.")); }
  getModelRoutes(): Promise<[]> { return Promise.resolve([]); }
  saveModelRoute(): Promise<never> { return Promise.reject(new Error("Model routes require the desktop app.")); }
  deleteModelRoute(): Promise<never> { return Promise.reject(new Error("Model routes require the desktop app.")); }
  previewModelFallback(): Promise<[]> { return Promise.resolve([]); }
  testModelConnection(): Promise<never> { return Promise.reject(new Error("Model connections require the desktop app.")); }
  previewAiProjectContext(): Promise<never> { return Promise.reject(new Error("AI project analysis requires the desktop app.")); }
  runAiProjectAnalysis(): Promise<never> { return Promise.reject(new Error("AI project analysis requires the desktop app.")); }
  listAiCandidates(): Promise<[]> { return Promise.resolve([]); }
  listAiUsageEvents(): Promise<[]> { return Promise.resolve([]); }
  reviewAiCandidate(): Promise<never> { return Promise.reject(new Error("AI candidate review requires the desktop app.")); }

  exportGitWorkspace(): Promise<never> {
    return Promise.reject(new Error("Git workspace export requires the desktop app."));
  }

  previewGitExport(): Promise<never> {
    return Promise.reject(new Error("Git workspace preview requires the desktop app."));
  }

  previewGitImport(): Promise<never> {
    return Promise.reject(new Error("Git workspace preview requires the desktop app."));
  }

  importGitWorkspace(): Promise<never> {
    return Promise.reject(new Error("Git workspace import requires the desktop app."));
  }

  getSettings(sourceId?: string): Promise<EffectiveSettings> {
    return Promise.resolve({
      app: readAppSettings(),
      source: sourceId
        ? readSourceSettings(sourceId)
        : null,
      project: null,
      managed: [],
    });
  }

  updateAppSettings(settings: AppSettings): Promise<EffectiveSettings> {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
    window.localStorage.removeItem(LEGACY_APP_SETTINGS_KEY);
    return this.getSettings();
  }

  updateDataSourceSettings(settings: DataSourceSettings): Promise<EffectiveSettings> {
    window.localStorage.setItem(sourceSettingsKey(settings.sourceId), JSON.stringify(settings));
    window.localStorage.removeItem(legacySourceSettingsKey(settings.sourceId));
    return this.getSettings(settings.sourceId);
  }

  resetAppSettings(): Promise<EffectiveSettings> {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(defaultAppSettings()));
    return this.getSettings();
  }

  resetDataSourceSettings(sourceId: string): Promise<EffectiveSettings> {
    window.localStorage.setItem(
      sourceSettingsKey(sourceId),
      JSON.stringify(defaultDataSourceSettings(sourceId)),
    );
    return this.getSettings(sourceId);
  }

  updateOrganizationPolicy(_policy: OrganizationPolicy): Promise<EffectiveSettings> {
    void _policy;
    return Promise.reject(new Error("Organization policies are read-only in Web Viewer."));
  }

  refreshOrganizationPolicy(): Promise<never> {
    return Promise.reject(new Error("Organization policy refresh requires the desktop app."));
  }

  updateProjectSettings(_settings: ProjectSettings): Promise<EffectiveSettings> {
    void _settings;
    return Promise.reject(new Error("Project policies are read-only in Web Viewer."));
  }

  getStorageUsage(): Promise<StorageUsage> {
    return Promise.resolve({ snapshotBytes: 0, semanticBytes: 0, layoutBytes: 0, syncQueueBytes: 0, settingsBytes: 0, snapshotCount: 0, pendingSyncCount: 0 });
  }

  clearLayouts(): Promise<number> {
    const keys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter(
      (key): key is string =>
        Boolean(key?.startsWith("nodalstudio:layout:") || key?.startsWith("sqlaieditor:layout:")),
    );
    keys.forEach((key) => window.localStorage.removeItem(key));
    return Promise.resolve(keys.length);
  }

  clearRegenerableCache(): Promise<number> {
    return Promise.resolve(0);
  }

  saveAiCredential(): Promise<never> {
    return Promise.reject(new Error("Credential storage requires the desktop app."));
  }

  saveCloudCredential(): Promise<never> {
    return Promise.reject(new Error("Credential storage requires the desktop app."));
  }

  clearCredentials(): Promise<never> {
    return Promise.reject(new Error("Credential storage requires the desktop app."));
  }

  getSecurityStatus(): Promise<SecurityStatus> {
    const app = readAppSettings();
    return Promise.resolve({ offlineMode: app.privacy.offlineMode, databaseCredentialConfigured: false, aiCredentialConfigured: false, cloudCredentialConfigured: false, weakSslSources: 0, failedOrConflictedSyncItems: 0, staleModelSources: 0, unresolvedGitConflictReports: 0 });
  }

  checkMergeDriver(): Promise<MergeDriverStatus> {
    return Promise.reject(new Error("Git repository inspection requires the desktop app."));
  }

  readGitConflictReport(): Promise<never> {
    return Promise.reject(new Error("Git conflict reports require the desktop app."));
  }

  deleteGitConflictReport(): Promise<never> {
    return Promise.reject(new Error("Git conflict reports require the desktop app."));
  }

  exportSettingsFile(): Promise<SettingsFileReceipt> {
    return Promise.reject(new Error("Settings file export requires the desktop app."));
  }

  previewSettingsFile(): Promise<never> {
    return Promise.reject(new Error("Settings file preview requires the desktop app."));
  }

  importSettingsFile(): Promise<SettingsFileReceipt> {
    return Promise.reject(new Error("Settings file import requires the desktop app."));
  }

  exportPortableBackup(): Promise<BackupReceipt> {
    return Promise.reject(new Error("Portable backup export requires the desktop app."));
  }

  previewPortableBackup(): Promise<never> {
    return Promise.reject(new Error("Portable backup preview requires the desktop app."));
  }

  importPortableBackup(): Promise<BackupReceipt> {
    return Promise.reject(new Error("Portable backup import requires the desktop app."));
  }

  checkForUpdates(): Promise<UpdateCheckResult> {
    return Promise.reject(new Error("Desktop application updates are unavailable in Web Viewer."));
  }

  deleteSourceData(_sourceId: string, _options: DeleteSourceDataOptions): Promise<number> {
    void _sourceId;
    void _options;
    return Promise.reject(new Error("Data source deletion requires the desktop app."));
  }

  previewSourceDataDeletion(): Promise<never> {
    return Promise.reject(new Error("Data source deletion preview requires the desktop app."));
  }

  generateEventTriggerScript(): Promise<never> {
    return Promise.reject(new Error("Event Trigger scripts require the desktop app."));
  }

  listSyncDiagnostics(): Promise<SyncDiagnostic[]> {
    return Promise.resolve([]);
  }

  listCloudAudit(): Promise<never> {
    return Promise.reject(new Error("Cloud audit requires the desktop app."));
  }

  listExternalAccess(): Promise<import("./settings-types").ExternalAccessRecord[]> {
    return Promise.resolve([]);
  }

  bootstrapCloudAccount(): Promise<never> {
    return Promise.reject(new Error("Cloud account management requires the desktop app."));
  }

  refreshCloudSession(): Promise<never> {
    return Promise.reject(new Error("Cloud account management requires the desktop app."));
  }

  createCloudProject(): Promise<never> {
    return Promise.reject(new Error("Cloud project management requires the desktop app."));
  }

  listCloudShares(): Promise<[]> { return Promise.resolve([]); }
  createCloudShare(): Promise<never> { return Promise.reject(new Error("Cloud sharing requires the desktop app.")); }
  revokeCloudShare(): Promise<never> { return Promise.reject(new Error("Cloud sharing requires the desktop app.")); }
  rotateCloudShare(): Promise<never> { return Promise.reject(new Error("Cloud sharing requires the desktop app.")); }

  factoryReset(): Promise<number> {
    return Promise.reject(new Error("Factory reset requires the desktop app."));
  }
}
