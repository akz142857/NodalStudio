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
  CloudViewBundle,
  ChangeProvenance,
  CodeLineageLink,
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
  LogicalRelationship,
  LogicalRelationshipOrigin,
  LogicalRelationshipStatus,
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
  VerifyAndRefreshDataSourceResult,
} from "./types";
export type * from "./settings-types";
export { defaultAppSettings, defaultDataSourceSettings, defaultEffectiveSettings, defaultProjectSettings } from "./settings-defaults";
