export interface RuntimeInfo {
  kind: "desktop" | "web";
  label: string;
  version: string;
}

export interface DatabaseInfo {
  name: string;
  databaseType: "postgreSql" | "mySql";
  version: string;
}

export interface ConnectionTestResult {
  database: DatabaseInfo;
  sslActive: boolean | null;
  serverReadOnly: boolean | null;
}

export interface ObjectKey {
  kind: string;
  schema: string;
  name: string;
}

export interface ColumnDefinition {
  name: string;
  ordinalPosition: number;
  formattedType: string;
  typeSchema: string;
  typeName: string;
  nullable: boolean;
  defaultValue: string | null;
  identity: "always" | "byDefault" | null;
  generated: boolean;
  comment: string | null;
}

export interface ForeignKeyDefinition {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
  matchType: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface IndexDefinition {
  name: string;
  method: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  predicate: string | null;
}

export interface ConstraintDefinition {
  name: string;
  constraintType: "check" | "unique" | "exclusion";
  definition: string;
}

export interface ViewDefinition {
  key: { kind: "view"; schema: string; name: string };
  definition: string;
  materialized: boolean;
  comment: string | null;
}

export interface EnumDefinition {
  key: { kind: "enum"; schema: string; name: string };
  values: string[];
}

export interface TableDefinition {
  key: {
    kind: "table";
    schema: string;
    name: string;
  };
  tableKind: "ordinary" | "partitioned" | "foreign";
  columns: ColumnDefinition[];
  primaryKey: { name: string; columns: string[] } | null;
  foreignKeys: ForeignKeyDefinition[];
  indexes: IndexDefinition[];
  constraints: ConstraintDefinition[];
  comment: string | null;
}

export interface SchemaDefinition {
  name: string;
  tables: TableDefinition[];
  views: ViewDefinition[];
  enums: EnumDefinition[];
}

export interface DatabaseSnapshot {
  id: string;
  sourceId: string;
  capturedAt: string;
  fingerprint: string;
  database: DatabaseInfo;
  schemas: SchemaDefinition[];
}

export type SslMode = "disable" | "prefer" | "require" | "verifyCa" | "verifyFull";

export interface SaveDataSourceInput {
  id?: string;
  displayName: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  databaseType: "postgreSql" | "mySql";
  sslMode: SslMode;
}

export interface DataSourceProfile {
  id: string;
  displayName: string;
  host: string;
  port: number;
  database: string;
  username: string;
  databaseType: "postgreSql" | "mySql";
  sslMode: SslMode;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureSnapshotResult {
  snapshot: DatabaseSnapshot;
  stored: boolean;
  changeSet: SchemaChangeSet | null;
}

export interface ObjectAnnotation {
  sourceId: string;
  objectKey: ObjectKey;
  description: string | null;
  tags: string[];
  owner: string | null;
  isCore: boolean;
  updatedAt: string;
}

export interface DomainGroup {
  id: string;
  sourceId: string;
  name: string;
  description: string | null;
  color: string;
  tableKeys: ObjectKey[];
  updatedAt: string;
}

export interface SavedView {
  id: string;
  sourceId: string;
  name: string;
  rootTableKeys: ObjectKey[];
  relationshipDepth: number;
  updatedAt: string;
}

export interface CanvasLayout {
  sourceId: string;
  viewId: string | null;
  positions: Record<string, CanvasNodeLayout>;
  updatedAt: string;
}

export interface CanvasNodeLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface RelationshipEndpoint {
  schema: string;
  table: string;
  columns: string[];
}

export type RelationshipCardinality =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany"
  | "unspecified";

export type LogicalRelationshipStatus =
  | "active"
  | "disabled"
  | "orphaned"
  | "conflicted"
  | "supersededByPhysical";

export type LogicalRelationshipOrigin = "manual" | "confirmedInference" | "imported";

export interface LogicalRelationship {
  id: string;
  sourceId: string;
  name: string;
  source: RelationshipEndpoint;
  target: RelationshipEndpoint;
  cardinality: RelationshipCardinality;
  status: LogicalRelationshipStatus;
  origin: LogicalRelationshipOrigin;
  note: string | null;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IgnoredRelationshipInference {
  sourceId: string;
  relationshipKey: string;
  ignoredAt: string;
}

export interface SaveLogicalRelationshipInput {
  id?: string;
  sourceId: string;
  name: string;
  source: RelationshipEndpoint;
  target: RelationshipEndpoint;
  cardinality: RelationshipCardinality;
  origin?: LogicalRelationshipOrigin;
  note?: string | null;
  evidence?: string[];
  disabled?: boolean;
  allowTypeMismatch?: boolean;
}

export interface RelationshipValidation {
  valid: boolean;
  compatible: boolean;
  duplicate: boolean;
  physicalExists: boolean;
  suggestedCardinality: RelationshipCardinality;
  status: LogicalRelationshipStatus;
  messages: string[];
}

export interface SemanticBundle {
  annotations: ObjectAnnotation[];
  orphanedAnnotations: ObjectAnnotation[];
  domainGroups: DomainGroup[];
  savedViews: SavedView[];
  layout: CanvasLayout | null;
  logicalRelationships: LogicalRelationship[];
  ignoredRelationshipInferences: IgnoredRelationshipInference[];
}

export interface AiExplanation {
  provider: string;
  model: string | null;
  generatedAt: string | null;
  title: string;
  explanation: string;
  evidence: string[];
  candidateAnnotation: string | null;
  contextPolicy: {
    relationshipDepth: number;
    credentialsIncluded: boolean;
    rowDataIncluded: boolean;
    completeSchemaIncluded: boolean;
  };
}

export interface ExplainSchemaInput {
  snapshotId: string;
  targetType: "table" | "domain" | "changeSet";
  objectKey?: ObjectKey;
  domainGroup?: DomainGroup;
  changeSet?: SchemaChangeSet;
  question?: string;
  relationshipDepth: number;
  aiEnabled: boolean;
}

export interface CloudViewBundle {
  projectId: string;
  sourceId: string;
  sourceLabel: string;
  fingerprint: string;
  snapshot: DatabaseSnapshot | null;
  changeSet: SchemaChangeSet | null;
  annotations: ObjectAnnotation[];
  domainGroups: DomainGroup[];
  savedViews: SavedView[];
  layout: CanvasLayout | null;
  logicalRelationships?: LogicalRelationship[];
  projectGraphs: SharedProjectGraph[];
  baseVersion: number;
}

export interface SyncProjectInput {
  sourceId: string;
  projectId: string;
  apiUrl: string;
  accessToken: string;
  baseVersion: number;
}

export interface SyncProjectResult {
  version: number;
  fingerprint: string;
  deduplicated: boolean;
  uploadedEvents: number;
}

export interface ExportGitWorkspaceResult {
  workspacePath: string;
  writtenFiles: number;
  removedStaleFiles: number;
  schemaFingerprint: string;
}

export interface ImportGitWorkspaceResult {
  importedAnnotations: number;
  importedDomainGroups: number;
  importedSavedViews: number;
  importedProvenance: number;
  importedLineageLinks: number;
  importedLogicalRelationships: number;
  fingerprintMatches: boolean;
  workspaceFingerprint: string;
}

export interface DriftReport {
  fromEnvironment: string;
  toEnvironment: string;
  inSync: boolean;
  changeSet: SchemaChangeSet;
}

export interface ChangeProvenance {
  changeSetId: string;
  branch: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  migrationFiles: string[];
  recordedAt: string;
}

export interface CodeLineageLink {
  objectKey: ObjectKey;
  language: string;
  framework: string;
  symbol: string;
  filePath: string;
  line: number | null;
  confidence: "declared" | "convention" | "inferred";
}

export interface LocalProject {
  id: string;
  name: string;
  rootPath: string;
  repositoryKind: "directory" | "git";
  remoteUrl: string | null;
  managedCache: boolean;
  databaseSourceIds: string[];
  createdAt: string;
}

export type ProjectScanStatus =
  | "queued"
  | "discovering"
  | "parsing"
  | "matching"
  | "aiAnalysis"
  | "reviewRequired"
  | "ready"
  | "cancelled"
  | "failed";

export interface ProjectScan {
  id: string;
  projectId: string;
  branch: string | null;
  commitSha: string | null;
  dirty: boolean;
  status: ProjectScanStatus;
  analyzerVersions: Record<string, string>;
  startedAt: string;
  completedAt: string | null;
}

export type ProjectNodeKind =
  | "project" | "module" | "file" | "symbol" | "page" | "endpoint"
  | "service" | "repository" | "ormModel" | "query" | "migration" | "table" | "column";

export interface ProjectNode {
  id: string;
  projectId: string;
  kind: ProjectNodeKind;
  name: string;
  qualifiedName: string;
  relativePath: string | null;
  line: number | null;
  databaseObject: ObjectKey | null;
  attributes: Record<string, string>;
}

export interface EdgeEvidence {
  id: string;
  projectId: string;
  relativePath: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
  analyzer: string;
  excerptHash: string | null;
  explanation: string | null;
}

export interface ProjectEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: "contains" | "imports" | "calls" | "handles" | "reads" | "writes" | "joins" | "mapsTo" | "returns" | "changes" | "triggers";
  certainty: "declared" | "static" | "convention" | "aiInferred" | "humanConfirmed";
  reviewStatus: "notRequired" | "pending" | "confirmed" | "rejected" | "stale";
  evidence: EdgeEvidence[];
  scanId: string;
}

export interface ProjectGraphSnapshot {
  scanId: string;
  nodes: ProjectNode[];
  edges: ProjectEdge[];
}

export interface SharedProjectGraph {
  projectId: string;
  projectName: string;
  scan: ProjectScan;
  nodes: ProjectNode[];
  edges: ProjectEdge[];
}

export interface CodeUsageResult {
  nodes: ProjectNode[];
  edges: ProjectEdge[];
}

export type ProviderKind = "offline" | "openAiCompatible";
export type ModelRole = "analysis" | "explanation" | "embedding";
export interface ModelCapabilities { chat: boolean; structuredOutput: boolean; toolCalling: boolean; embeddings: boolean; codeAnalysis: boolean; local: boolean; maxContextTokens: number | null; }
export interface ModelConnection { id: string; name: string; provider: ProviderKind; endpoint: string | null; model: string; credentialRef: string | null; capabilities: ModelCapabilities; privacy: { allowUncommittedCode: boolean; allowSourceExcerpts: boolean; remote: boolean }; enabled: boolean; }
export interface ModelRoute { role: ModelRole; primaryConnectionId: string; fallbackConnectionIds: string[]; }
export type AiCandidateStatus = "pending" | "confirmed" | "rejected" | "stale";
export interface AiRelationCandidate { id: string; scanId: string; connectionId: string; model: string; proposedEdge: ProjectEdge; explanation: string; status: AiCandidateStatus; createdAt: string; reviewedAt: string | null; }
export interface AiProjectContextPreview { scanId: string; connectionId: string | null; provider: ProviderKind | null; model: string | null; networkUsed: boolean; nodeCount: number; edgeCount: number; evidenceCount: number; requestCount: number; maxRequestNodes: number; sourceExcerpts: number; uncommittedCodeIncluded: boolean; }
export interface AiUsageEvent { id: string; role: ModelRole; connectionId: string; provider: ProviderKind; model: string; startedAt: string; completedAt: string; inputTokens: number | null; outputTokens: number | null; fallbackFrom: string | null; status: string; fileCount: number; snippetCount: number; privacyPolicyVersion: number; }
export interface ImpactPath { target: ObjectKey; nodeIds: string[]; edgeIds: string[]; potential: boolean; }
export interface ModelFallbackStep { connectionId: string; name: string; eligible: boolean; local: boolean; }

export interface SaveAnnotationInput {
  sourceId: string;
  objectKey: ObjectKey;
  description: string | null;
  tags: string[];
  owner: string | null;
  isCore: boolean;
}

export interface SaveDomainGroupInput {
  id?: string;
  sourceId: string;
  name: string;
  description: string | null;
  color: string;
  tableKeys: ObjectKey[];
}

export interface SaveViewInput {
  id?: string;
  sourceId: string;
  name: string;
  rootTableKeys: ObjectKey[];
  relationshipDepth: number;
}

export interface SnapshotSummary {
  id: string;
  sourceId: string;
  capturedAt: string;
  fingerprint: string;
  databaseName: string;
  schemaCount: number;
  tableCount: number;
}

export type OperationType =
  | "addTable"
  | "dropTable"
  | "addColumn"
  | "dropColumn"
  | "renameColumn"
  | "alterColumn"
  | "addPrimaryKey"
  | "dropPrimaryKey"
  | "addForeignKey"
  | "dropForeignKey"
  | "addIndex"
  | "dropIndex"
  | "addConstraint"
  | "dropConstraint"
  | "addView"
  | "dropView"
  | "alterView"
  | "addEnum"
  | "dropEnum"
  | "alterEnum";

export type RiskLevel = "informational" | "low" | "medium" | "high";

export interface SchemaOperation {
  operationType: OperationType;
  object: {
    kind: string;
    schema: string;
    name: string;
  };
  risk: RiskLevel;
  before: string | null;
  after: string | null;
}

export interface SchemaChangeSet {
  id: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  createdAt: string;
  operations: SchemaOperation[];
  riskSummary: Record<RiskLevel, number>;
}

export type QueryErrorKind =
  | "validation"
  | "unsupported"
  | "connection"
  | "timeout"
  | "cancelled"
  | "database"
  | "resultLimit"
  | "unsupportedType"
  | "internal";

export interface ExecuteReadonlyQueryInput {
  queryId: string;
  sourceId: string;
  sql: string;
  rowLimit: number;
  timeoutMs: number;
}

export interface QueryColumn {
  name: string;
  databaseType: string;
}

export type QueryCell =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string; truncated: boolean }
  | { kind: "json"; value: unknown; truncated: boolean }
  | { kind: "binary"; byteLength: number };

export interface QueryExecutionResult {
  queryId: string;
  columns: QueryColumn[];
  rows: QueryCell[][];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  notices: string[];
}

export interface QueryHistoryEntry {
  id: string;
  sourceId: string;
  executedAt: string;
  sqlText: string;
  durationMs: number;
  rowCount: number;
  status: "succeeded" | "failed" | "cancelled";
  errorKind: QueryErrorKind | null;
}

export interface NodalStudioPlatform {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  getDiagnosticInfo(): Promise<import("./settings-types").DiagnosticInfo>;
  revealAppDirectory(kind: "data" | "logs"): Promise<void>;
  listDataSources(): Promise<DataSourceProfile[]>;
  renameDataSource(sourceId: string, displayName: string): Promise<DataSourceProfile>;
  duplicateDataSource(sourceId: string): Promise<DataSourceProfile>;
  saveDataSource(input: SaveDataSourceInput): Promise<DataSourceProfile>;
  testPostgresConnection(input: SaveDataSourceInput): Promise<ConnectionTestResult>;
  capturePostgresSnapshot(sourceId: string, trigger?: "manual" | "background"): Promise<CaptureSnapshotResult>;
  listSnapshots(sourceId: string): Promise<SnapshotSummary[]>;
  getSnapshot(snapshotId: string): Promise<DatabaseSnapshot>;
  compareSnapshots(beforeSnapshotId: string, afterSnapshotId: string): Promise<SchemaChangeSet>;
  executeReadonlyQuery(input: ExecuteReadonlyQueryInput): Promise<QueryExecutionResult>;
  cancelQuery(queryId: string): Promise<boolean>;
  listQueryHistory(sourceId: string, limit?: number): Promise<QueryHistoryEntry[]>;
  deleteQueryHistory(sourceId: string, historyId: string): Promise<boolean>;
  clearQueryHistory(sourceId: string): Promise<number>;
  getSemantics(sourceId: string): Promise<SemanticBundle>;
  listLogicalRelationships(sourceId: string): Promise<LogicalRelationship[]>;
  validateLogicalRelationship(input: {
    sourceId: string;
    source: RelationshipEndpoint;
    target: RelationshipEndpoint;
    relationshipId?: string;
  }): Promise<RelationshipValidation>;
  createLogicalRelationship(input: SaveLogicalRelationshipInput): Promise<LogicalRelationship>;
  updateLogicalRelationship(input: SaveLogicalRelationshipInput): Promise<LogicalRelationship>;
  deleteLogicalRelationship(sourceId: string, relationshipId: string): Promise<boolean>;
  ignoreRelationshipInference(sourceId: string, relationshipKey: string): Promise<IgnoredRelationshipInference>;
  listIgnoredRelationshipInferences(sourceId: string): Promise<IgnoredRelationshipInference[]>;
  saveAnnotation(input: SaveAnnotationInput): Promise<ObjectAnnotation>;
  saveDomainGroup(input: SaveDomainGroupInput): Promise<DomainGroup>;
  saveView(input: SaveViewInput): Promise<SavedView>;
  saveLayout(
    sourceId: string,
    viewId: string | null,
    positions: Record<string, CanvasNodeLayout>,
  ): Promise<void>;
  explainSchema(input: ExplainSchemaInput): Promise<AiExplanation>;
  testAiProvider(sourceId: string): Promise<import("./settings-types").AiProviderTestResult>;
  loadSharedBundle(): Promise<CloudViewBundle | null>;
  syncProject(input: SyncProjectInput): Promise<SyncProjectResult>;
  compareEnvironmentSnapshots(
    fromSnapshotId: string,
    fromEnvironment: string,
    toSnapshotId: string,
    toEnvironment: string,
  ): Promise<DriftReport>;
  saveChangeProvenance(
    input: Omit<ChangeProvenance, "recordedAt">,
  ): Promise<ChangeProvenance>;
  saveCodeLineage(sourceId: string, links: CodeLineageLink[]): Promise<void>;
  addLocalProject(input: { rootPath: string; name?: string; databaseSourceIds: string[] }): Promise<LocalProject>;
  cloneRemoteProject(input: { remoteUrl: string; name?: string; databaseSourceIds: string[] }): Promise<LocalProject>;
  selectProjectDirectory(): Promise<string | null>;
  listLocalProjects(): Promise<LocalProject[]>;
  setProjectBindings(projectId: string, databaseSourceIds: string[]): Promise<LocalProject>;
  removeLocalProject(projectId: string, deleteManagedCache?: boolean): Promise<void>;
  startProjectScan(projectId: string): Promise<ProjectScan>;
  cancelProjectScan(scanId: string): Promise<boolean>;
  getProjectScanStatus(scanId: string): Promise<ProjectScan | null>;
  listProjectScans(projectId: string): Promise<ProjectScan[]>;
  getProjectGraph(scanId: string): Promise<ProjectGraphSnapshot>;
  getDatabaseCodeUsage(sourceId: string, objectKey: ObjectKey): Promise<CodeUsageResult>;
  getChangeImpact(sourceId: string, objectKeys: ObjectKey[], maxDepth?: number): Promise<ImpactPath[]>;
  openCodeLocation(projectId: string, relativePath: string, line?: number | null): Promise<void>;
  listModelConnections(): Promise<ModelConnection[]>;
  saveModelConnection(connection: ModelConnection): Promise<ModelConnection>;
  deleteModelConnection(connectionId: string): Promise<void>;
  saveModelCredential(connectionId: string, secret: string): Promise<ModelConnection>;
  getModelRoutes(): Promise<ModelRoute[]>;
  saveModelRoute(route: ModelRoute): Promise<ModelRoute>;
  deleteModelRoute(role: ModelRole): Promise<void>;
  previewModelFallback(role: ModelRole, containsSourceExcerpts: boolean, containsUncommittedCode: boolean): Promise<ModelFallbackStep[]>;
  testModelConnection(connectionId: string): Promise<{ connectionId: string; testedAt: string; networkUsed: boolean }>;
  previewAiProjectContext(scanId: string): Promise<AiProjectContextPreview>;
  runAiProjectAnalysis(scanId: string): Promise<AiRelationCandidate[]>;
  listAiCandidates(scanId: string): Promise<AiRelationCandidate[]>;
  listAiUsageEvents(): Promise<AiUsageEvent[]>;
  reviewAiCandidate(scanId: string, candidateId: string, decision: "confirmed" | "rejected"): Promise<AiRelationCandidate>;
  exportGitWorkspace(
    sourceId: string,
    repositoryPath: string,
  ): Promise<ExportGitWorkspaceResult>;
  previewGitExport(sourceId: string, repositoryPath: string): Promise<import("./settings-types").GitExportPreview>;
  previewGitImport(sourceId: string, repositoryPath: string): Promise<import("./settings-types").GitImportPreview>;
  importGitWorkspace(
    sourceId: string,
    repositoryPath: string,
  ): Promise<ImportGitWorkspaceResult>;
  getSettings(sourceId?: string): Promise<import("./settings-types").EffectiveSettings>;
  updateAppSettings(settings: import("./settings-types").AppSettings): Promise<import("./settings-types").EffectiveSettings>;
  updateDataSourceSettings(settings: import("./settings-types").DataSourceSettings): Promise<import("./settings-types").EffectiveSettings>;
  resetAppSettings(): Promise<import("./settings-types").EffectiveSettings>;
  resetDataSourceSettings(sourceId: string): Promise<import("./settings-types").EffectiveSettings>;
  updateOrganizationPolicy(policy: import("./settings-types").OrganizationPolicy): Promise<import("./settings-types").EffectiveSettings>;
  refreshOrganizationPolicy(sourceId: string): Promise<import("./settings-types").EffectiveSettings>;
  updateProjectSettings(settings: import("./settings-types").ProjectSettings): Promise<import("./settings-types").EffectiveSettings>;
  getStorageUsage(): Promise<import("./settings-types").StorageUsage>;
  clearLayouts(sourceId?: string): Promise<number>;
  clearRegenerableCache(): Promise<number>;
  saveAiCredential(sourceId: string, secret: string): Promise<void>;
  saveCloudCredential(sourceId: string, secret: string): Promise<void>;
  clearCredentials(sourceId: string, kinds: { database: boolean; ai: boolean; cloud: boolean }): Promise<void>;
  getSecurityStatus(sourceId?: string): Promise<import("./settings-types").SecurityStatus>;
  checkMergeDriver(sourceId: string, repositoryPath: string): Promise<import("./settings-types").MergeDriverStatus>;
  readGitConflictReport(repositoryPath: string, reportPath: string): Promise<string>;
  deleteGitConflictReport(repositoryPath: string, reportPath: string): Promise<void>;
  exportSettingsFile(path: string): Promise<import("./settings-types").SettingsFileReceipt>;
  previewSettingsFile(path: string): Promise<import("./settings-types").SettingsFilePreview>;
  importSettingsFile(path: string): Promise<import("./settings-types").SettingsFileReceipt>;
  exportPortableBackup(sourceId: string, path: string): Promise<import("./settings-types").BackupReceipt>;
  previewPortableBackup(path: string): Promise<import("./settings-types").BackupPreview>;
  importPortableBackup(path: string): Promise<import("./settings-types").BackupReceipt>;
  checkForUpdates(): Promise<import("./settings-types").UpdateCheckResult>;
  deleteSourceData(sourceId: string, options: import("./settings-types").DeleteSourceDataOptions): Promise<number>;
  previewSourceDataDeletion(sourceId: string): Promise<import("./settings-types").SourceDataImpact>;
  generateEventTriggerScript(sourceId: string): Promise<string>;
  listSyncDiagnostics(sourceId: string): Promise<import("./settings-types").SyncDiagnostic[]>;
  listCloudAudit(sourceId: string): Promise<import("./settings-types").CloudAuditEntry[]>;
  listExternalAccess(): Promise<import("./settings-types").ExternalAccessRecord[]>;
  bootstrapCloudAccount(sourceId: string, email: string, displayName: string, teamName: string, bootstrapSecret: string): Promise<import("./settings-types").CloudAccountResult>;
  refreshCloudSession(sourceId: string): Promise<import("./settings-types").CloudAccountResult>;
  createCloudProject(sourceId: string, name: string): Promise<string>;
  listCloudShares(sourceId: string): Promise<import("./settings-types").CloudShareSummary[]>;
  createCloudShare(sourceId: string, expiresAt?: string): Promise<import("./settings-types").CloudShareRecord>;
  revokeCloudShare(sourceId: string, shareId: string): Promise<void>;
  rotateCloudShare(sourceId: string, shareId: string, expiresAt?: string): Promise<import("./settings-types").CloudShareRecord>;
  factoryReset(confirmation: string): Promise<number>;
}
