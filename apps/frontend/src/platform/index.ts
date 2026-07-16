import { isTauri } from "@tauri-apps/api/core";
import { TauriPlatform } from "./tauri-platform";
import type { NodalStudioPlatform } from "./types";
import { WebPlatform } from "./web-platform";

let platform: NodalStudioPlatform | undefined;

export function getPlatform(): NodalStudioPlatform {
  platform ??= isTauri() ? new TauriPlatform() : new WebPlatform();
  return platform;
}

export type {
  AiExplanation,
  AiProjectContextPreview,
  AiRelationCandidate,
  AiUsageEvent,
  CloudViewBundle,
  ChangeProvenance,
  CodeLineageLink,
  CodeUsageResult,
  CaptureSnapshotResult,
  DataSourceProfile,
  DatabaseInfo,
  ConnectionTestResult,
  DatabaseSnapshot,
  DomainGroup,
  DriftReport,
  ExplainSchemaInput,
  ExecuteReadonlyQueryInput,
  ExportGitWorkspaceResult,
  ImportGitWorkspaceResult,
  IgnoredRelationshipInference,
  LocalProject,
  LogicalRelationship,
  LogicalRelationshipOrigin,
  LogicalRelationshipStatus,
  ModelConnection,
  ModelRole,
  ModelRoute,
  ObjectAnnotation,
  ObjectKey,
  QueryCell,
  QueryColumn,
  QueryErrorKind,
  QueryExecutionResult,
  QueryHistoryEntry,
  RuntimeInfo,
  RelationshipCardinality,
  RelationshipEndpoint,
  RelationshipValidation,
  ProjectScan,
  ProjectScanStatus,
  ProjectNode,
  ProjectNodeKind,
  ProjectEdge,
  ProjectGraphSnapshot,
  SchemaChangeSet,
  SchemaOperation,
  SemanticBundle,
  SavedView,
  SaveAnnotationInput,
  SaveLogicalRelationshipInput,
  SaveDataSourceInput,
  SaveDomainGroupInput,
  SaveViewInput,
  NodalStudioPlatform,
  SslMode,
  SnapshotSummary,
  SyncProjectInput,
  SyncProjectResult,
  TableDefinition,
} from "./types";
export type * from "./settings-types";
export { defaultAppSettings, defaultDataSourceSettings, defaultEffectiveSettings, defaultProjectSettings } from "./settings-defaults";
