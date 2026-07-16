import { invoke } from "@tauri-apps/api/core";
import type {
  AiExplanation,
  CloudViewBundle,
  ChangeProvenance,
  CodeLineageLink,
  CaptureSnapshotResult,
  DataSourceProfile,
  ConnectionTestResult,
  CodeUsageResult,
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
  ObjectAnnotation,
  RuntimeInfo,
  QueryExecutionResult,
  QueryHistoryEntry,
  ProjectScan,
  ProjectGraphSnapshot,
  SchemaChangeSet,
  SemanticBundle,
  SavedView,
  SaveAnnotationInput,
  SaveLogicalRelationshipInput,
  SaveDataSourceInput,
  SaveDomainGroupInput,
  SaveViewInput,
  SnapshotSummary,
  RelationshipEndpoint,
  RelationshipValidation,
  SyncProjectInput,
  SyncProjectResult,
  NodalStudioPlatform,
} from "./types";
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

export class TauriPlatform implements NodalStudioPlatform {
  getRuntimeInfo(): Promise<RuntimeInfo> {
    return invoke<RuntimeInfo>("get_runtime_info");
  }

  getDiagnosticInfo(): Promise<import("./settings-types").DiagnosticInfo> {
    return invoke<import("./settings-types").DiagnosticInfo>("get_diagnostic_info");
  }

  revealAppDirectory(kind: "data" | "logs"): Promise<void> {
    return invoke<void>("reveal_app_directory", { input: { kind } });
  }

  listDataSources(): Promise<DataSourceProfile[]> {
    return invoke<DataSourceProfile[]>("list_data_sources");
  }

  renameDataSource(sourceId: string, displayName: string): Promise<DataSourceProfile> {
    return invoke<DataSourceProfile>("rename_data_source", { input: { sourceId, displayName } });
  }

  duplicateDataSource(sourceId: string): Promise<DataSourceProfile> {
    return invoke<DataSourceProfile>("duplicate_data_source", { input: { sourceId } });
  }

  saveDataSource(input: SaveDataSourceInput): Promise<DataSourceProfile> {
    return invoke<DataSourceProfile>("save_data_source", { input });
  }

  testPostgresConnection(input: SaveDataSourceInput): Promise<ConnectionTestResult> {
    return invoke<ConnectionTestResult>("test_postgres_connection", { input });
  }

  capturePostgresSnapshot(sourceId: string, trigger: "manual" | "background" = "manual"): Promise<CaptureSnapshotResult> {
    return invoke<CaptureSnapshotResult>("capture_postgres_snapshot", {
      input: { sourceId, trigger },
    });
  }

  listSnapshots(sourceId: string): Promise<SnapshotSummary[]> {
    return invoke<SnapshotSummary[]>("list_snapshots", { input: { sourceId } });
  }

  getSnapshot(snapshotId: string): Promise<DatabaseSnapshot> {
    return invoke<DatabaseSnapshot>("get_snapshot", { input: { snapshotId } });
  }

  compareSnapshots(beforeSnapshotId: string, afterSnapshotId: string): Promise<SchemaChangeSet> {
    return invoke<SchemaChangeSet>("compare_snapshots", {
      input: { beforeSnapshotId, afterSnapshotId },
    });
  }

  executeReadonlyQuery(input: ExecuteReadonlyQueryInput): Promise<QueryExecutionResult> {
    return invoke<QueryExecutionResult>("execute_readonly_query", { input });
  }

  cancelQuery(queryId: string): Promise<boolean> {
    return invoke<boolean>("cancel_query", { input: { queryId } });
  }

  listQueryHistory(sourceId: string, limit = 100): Promise<QueryHistoryEntry[]> {
    return invoke<QueryHistoryEntry[]>("list_query_history", { input: { sourceId, limit } });
  }

  deleteQueryHistory(sourceId: string, historyId: string): Promise<boolean> {
    return invoke<boolean>("delete_query_history", { input: { sourceId, historyId } });
  }

  clearQueryHistory(sourceId: string): Promise<number> {
    return invoke<number>("clear_query_history", { input: { sourceId } });
  }

  getSemantics(sourceId: string): Promise<SemanticBundle> {
    return invoke<SemanticBundle>("get_semantics", { input: { sourceId } });
  }

  listLogicalRelationships(sourceId: string): Promise<LogicalRelationship[]> {
    return invoke<LogicalRelationship[]>("list_logical_relationships", { input: { sourceId } });
  }

  validateLogicalRelationship(input: {
    sourceId: string;
    source: RelationshipEndpoint;
    target: RelationshipEndpoint;
    relationshipId?: string;
  }): Promise<RelationshipValidation> {
    return invoke<RelationshipValidation>("validate_logical_relationship", { input });
  }

  createLogicalRelationship(input: SaveLogicalRelationshipInput): Promise<LogicalRelationship> {
    return invoke<LogicalRelationship>("create_logical_relationship", { input });
  }

  updateLogicalRelationship(input: SaveLogicalRelationshipInput): Promise<LogicalRelationship> {
    return invoke<LogicalRelationship>("update_logical_relationship", { input });
  }

  deleteLogicalRelationship(sourceId: string, relationshipId: string): Promise<boolean> {
    return invoke<boolean>("delete_logical_relationship", { input: { sourceId, relationshipId } });
  }

  ignoreRelationshipInference(sourceId: string, relationshipKey: string): Promise<IgnoredRelationshipInference> {
    return invoke<IgnoredRelationshipInference>("ignore_relationship_inference", { input: { sourceId, relationshipKey } });
  }

  listIgnoredRelationshipInferences(sourceId: string): Promise<IgnoredRelationshipInference[]> {
    return invoke<IgnoredRelationshipInference[]>("list_ignored_relationship_inferences", { input: { sourceId } });
  }

  saveAnnotation(input: SaveAnnotationInput): Promise<ObjectAnnotation> {
    return invoke<ObjectAnnotation>("save_annotation", { input });
  }

  saveDomainGroup(input: SaveDomainGroupInput): Promise<DomainGroup> {
    return invoke<DomainGroup>("save_domain_group", { input });
  }

  saveView(input: SaveViewInput): Promise<SavedView> {
    return invoke<SavedView>("save_view", { input });
  }

  saveLayout(
    sourceId: string,
    viewId: string | null,
    positions: Record<string, import("./types").CanvasNodeLayout>,
  ): Promise<void> {
    return invoke<void>("save_layout", { input: { sourceId, viewId, positions } });
  }

  explainSchema(input: ExplainSchemaInput): Promise<AiExplanation> {
    return invoke<AiExplanation>("explain_schema", { input });
  }

  testAiProvider(sourceId: string): Promise<import("./settings-types").AiProviderTestResult> {
    return invoke<import("./settings-types").AiProviderTestResult>("test_ai_provider", { input: { sourceId } });
  }

  loadSharedBundle(): Promise<CloudViewBundle | null> {
    return Promise.resolve(null);
  }

  syncProject(input: SyncProjectInput): Promise<SyncProjectResult> {
    return invoke<SyncProjectResult>("sync_project", { input });
  }

  compareEnvironmentSnapshots(
    fromSnapshotId: string,
    fromEnvironment: string,
    toSnapshotId: string,
    toEnvironment: string,
  ): Promise<DriftReport> {
    return invoke<DriftReport>("compare_environment_snapshots", {
      input: { fromSnapshotId, fromEnvironment, toSnapshotId, toEnvironment },
    });
  }

  saveChangeProvenance(
    input: Omit<ChangeProvenance, "recordedAt">,
  ): Promise<ChangeProvenance> {
    return invoke<ChangeProvenance>("save_change_provenance", { input });
  }

  saveCodeLineage(sourceId: string, links: CodeLineageLink[]): Promise<void> {
    return invoke<void>("save_code_lineage", { input: { sourceId, links } });
  }

  addLocalProject(input: { rootPath: string; name?: string; databaseSourceIds: string[] }): Promise<LocalProject> {
    return invoke<LocalProject>("add_local_project", { input });
  }
  cloneRemoteProject(input: { remoteUrl: string; name?: string; databaseSourceIds: string[] }): Promise<LocalProject> { return invoke("clone_remote_project", { input }); }
  selectProjectDirectory(): Promise<string | null> { return invoke("select_project_directory"); }

  listLocalProjects(): Promise<LocalProject[]> {
    return invoke<LocalProject[]>("list_local_projects");
  }
  setProjectBindings(projectId: string, databaseSourceIds: string[]): Promise<LocalProject> { return invoke("set_project_bindings", { input: { projectId, databaseSourceIds } }); }

  removeLocalProject(projectId: string, deleteManagedCache = false): Promise<void> {
    return invoke<void>("remove_local_project", { input: { projectId, deleteManagedCache } });
  }

  startProjectScan(projectId: string): Promise<ProjectScan> {
    return invoke<ProjectScan>("start_project_scan", { input: { projectId } });
  }

  cancelProjectScan(scanId: string): Promise<boolean> {
    return invoke<boolean>("cancel_project_scan", { input: { scanId } });
  }

  getProjectScanStatus(scanId: string): Promise<ProjectScan | null> {
    return invoke<ProjectScan | null>("get_project_scan_status", { input: { scanId } });
  }

  listProjectScans(projectId: string): Promise<ProjectScan[]> {
    return invoke<ProjectScan[]>("list_project_scans", { input: { projectId } });
  }

  getProjectGraph(scanId: string): Promise<ProjectGraphSnapshot> {
    return invoke<ProjectGraphSnapshot>("get_project_graph", { input: { scanId } });
  }

  getDatabaseCodeUsage(sourceId: string, objectKey: import("./types").ObjectKey): Promise<CodeUsageResult> {
    return invoke<CodeUsageResult>("get_database_code_usage", { input: { sourceId, objectKey } });
  }
  getChangeImpact(sourceId: string, objectKeys: import("./types").ObjectKey[], maxDepth = 4): Promise<import("./types").ImpactPath[]> { return invoke("get_change_impact", { input: { sourceId, objectKeys, maxDepth } }); }
  openCodeLocation(projectId: string, relativePath: string, line?: number | null): Promise<void> { return invoke("open_code_location", { input: { projectId, relativePath, line: line ?? null } }); }

  listModelConnections(): Promise<import("./types").ModelConnection[]> { return invoke("list_model_connections"); }
  saveModelConnection(connection: import("./types").ModelConnection): Promise<import("./types").ModelConnection> { return invoke("save_model_connection", { input: { connection } }); }
  deleteModelConnection(connectionId: string): Promise<void> { return invoke("delete_model_connection", { input: { connectionId } }); }
  saveModelCredential(connectionId: string, secret: string): Promise<import("./types").ModelConnection> { return invoke("save_model_credential", { input: { connectionId, secret } }); }
  getModelRoutes(): Promise<import("./types").ModelRoute[]> { return invoke("get_model_routes"); }
  saveModelRoute(route: import("./types").ModelRoute): Promise<import("./types").ModelRoute> { return invoke("save_model_route", { input: { route } }); }
  deleteModelRoute(role: import("./types").ModelRole): Promise<void> { return invoke("delete_model_route", { input: { role } }); }
  previewModelFallback(role: import("./types").ModelRole, containsSourceExcerpts: boolean, containsUncommittedCode: boolean): Promise<import("./types").ModelFallbackStep[]> { return invoke("preview_model_fallback", { input: { role, containsSourceExcerpts, containsUncommittedCode } }); }
  testModelConnection(connectionId: string): Promise<{ connectionId: string; testedAt: string; networkUsed: boolean }> { return invoke("test_model_connection", { input: { connectionId } }); }
  previewAiProjectContext(scanId: string): Promise<import("./types").AiProjectContextPreview> { return invoke("preview_ai_project_context", { input: { scanId } }); }
  runAiProjectAnalysis(scanId: string): Promise<import("./types").AiRelationCandidate[]> { return invoke("run_ai_project_analysis", { input: { scanId } }); }
  listAiCandidates(scanId: string): Promise<import("./types").AiRelationCandidate[]> { return invoke("list_ai_candidates", { input: { scanId } }); }
  listAiUsageEvents(): Promise<import("./types").AiUsageEvent[]> { return invoke("list_ai_usage_events"); }
  reviewAiCandidate(scanId: string, candidateId: string, decision: "confirmed" | "rejected"): Promise<import("./types").AiRelationCandidate> { return invoke("review_ai_candidate", { input: { scanId, candidateId, decision } }); }

  exportGitWorkspace(
    sourceId: string,
    repositoryPath: string,
  ): Promise<ExportGitWorkspaceResult> {
    return invoke<ExportGitWorkspaceResult>("export_git_workspace", {
      input: { sourceId, repositoryPath },
    });
  }

  previewGitExport(sourceId: string, repositoryPath: string): Promise<import("./settings-types").GitExportPreview> {
    return invoke<import("./settings-types").GitExportPreview>("preview_git_export", {
      input: { sourceId, repositoryPath },
    });
  }

  previewGitImport(sourceId: string, repositoryPath: string): Promise<import("./settings-types").GitImportPreview> {
    return invoke<import("./settings-types").GitImportPreview>("preview_git_import", {
      input: { sourceId, repositoryPath },
    });
  }

  importGitWorkspace(
    sourceId: string,
    repositoryPath: string,
  ): Promise<ImportGitWorkspaceResult> {
    return invoke<ImportGitWorkspaceResult>("import_git_workspace", {
      input: { sourceId, repositoryPath },
    });
  }

  getSettings(sourceId?: string): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("get_settings", { input: { sourceId: sourceId ?? null } });
  }

  updateAppSettings(settings: AppSettings): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("update_app_settings", { settings });
  }

  updateDataSourceSettings(settings: DataSourceSettings): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("update_data_source_settings", { settings });
  }

  resetAppSettings(): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("reset_app_settings");
  }

  resetDataSourceSettings(sourceId: string): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("reset_data_source_settings", { input: { sourceId } });
  }

  updateOrganizationPolicy(policy: OrganizationPolicy): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("update_organization_policy", { policy });
  }

  refreshOrganizationPolicy(sourceId: string): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("refresh_organization_policy", { input: { sourceId } });
  }

  updateProjectSettings(settings: ProjectSettings): Promise<EffectiveSettings> {
    return invoke<EffectiveSettings>("update_project_settings", { settings });
  }

  getStorageUsage(): Promise<StorageUsage> {
    return invoke<StorageUsage>("get_storage_usage");
  }

  clearLayouts(sourceId?: string): Promise<number> {
    return invoke<number>("clear_layouts", { input: { sourceId: sourceId ?? null } });
  }

  clearRegenerableCache(): Promise<number> {
    return invoke<number>("clear_regenerable_cache");
  }

  saveAiCredential(sourceId: string, secret: string): Promise<void> {
    return invoke<void>("save_ai_credential", { input: { sourceId, secret } });
  }

  saveCloudCredential(sourceId: string, secret: string): Promise<void> {
    return invoke<void>("save_cloud_credential", { input: { sourceId, secret } });
  }

  clearCredentials(sourceId: string, kinds: { database: boolean; ai: boolean; cloud: boolean }): Promise<void> {
    return invoke<void>("clear_credentials", { input: { sourceId, ...kinds } });
  }

  getSecurityStatus(sourceId?: string): Promise<SecurityStatus> {
    return invoke<SecurityStatus>("get_security_status", { input: { sourceId: sourceId ?? null } });
  }

  checkMergeDriver(sourceId: string, repositoryPath: string): Promise<MergeDriverStatus> {
    return invoke<MergeDriverStatus>("check_merge_driver", { input: { sourceId, repositoryPath } });
  }

  readGitConflictReport(repositoryPath: string, reportPath: string): Promise<string> {
    return invoke<string>("read_git_conflict_report", { input: { repositoryPath, reportPath } });
  }

  deleteGitConflictReport(repositoryPath: string, reportPath: string): Promise<void> {
    return invoke<void>("delete_git_conflict_report", { input: { repositoryPath, reportPath } });
  }

  exportSettingsFile(path: string): Promise<SettingsFileReceipt> {
    return invoke<SettingsFileReceipt>("export_settings_file", { input: { path } });
  }

  previewSettingsFile(path: string): Promise<import("./settings-types").SettingsFilePreview> {
    return invoke<import("./settings-types").SettingsFilePreview>("preview_settings_file", { input: { path } });
  }

  importSettingsFile(path: string): Promise<SettingsFileReceipt> {
    return invoke<SettingsFileReceipt>("import_settings_file", { input: { path } });
  }

  exportPortableBackup(sourceId: string, path: string): Promise<BackupReceipt> {
    return invoke<BackupReceipt>("export_portable_backup", { input: { sourceId, path } });
  }

  previewPortableBackup(path: string): Promise<import("./settings-types").BackupPreview> {
    return invoke<import("./settings-types").BackupPreview>("preview_portable_backup", { input: { sourceId: null, path } });
  }

  importPortableBackup(path: string): Promise<BackupReceipt> {
    return invoke<BackupReceipt>("import_portable_backup", { input: { sourceId: null, path } });
  }

  checkForUpdates(): Promise<UpdateCheckResult> {
    return invoke<UpdateCheckResult>("check_for_updates");
  }

  deleteSourceData(sourceId: string, options: DeleteSourceDataOptions): Promise<number> {
    return invoke<number>("delete_source_data", {
      input: {
        sourceId,
        selection: {
          connection: options.deleteConnection,
          history: options.deleteHistory,
          semantics: options.deleteSemantics,
        },
        removeDatabaseCredential: options.removeDatabaseCredential,
      },
    });
  }

  previewSourceDataDeletion(sourceId: string): Promise<import("./settings-types").SourceDataImpact> {
    return invoke<import("./settings-types").SourceDataImpact>("preview_source_data_deletion", { input: { sourceId } });
  }

  generateEventTriggerScript(sourceId: string): Promise<string> {
    return invoke<string>("generate_event_trigger_script", { input: { sourceId } });
  }

  listSyncDiagnostics(sourceId: string): Promise<SyncDiagnostic[]> {
    return invoke<SyncDiagnostic[]>("list_sync_diagnostics", { input: { sourceId } });
  }

  listCloudAudit(sourceId: string): Promise<import("./settings-types").CloudAuditEntry[]> {
    return invoke<import("./settings-types").CloudAuditEntry[]>("list_cloud_audit", { input: { sourceId } });
  }

  listExternalAccess(): Promise<import("./settings-types").ExternalAccessRecord[]> {
    return invoke<import("./settings-types").ExternalAccessRecord[]>("list_external_access");
  }

  bootstrapCloudAccount(sourceId: string, email: string, displayName: string, teamName: string, bootstrapSecret: string): Promise<import("./settings-types").CloudAccountResult> {
    return invoke<import("./settings-types").CloudAccountResult>("bootstrap_cloud_account", { input: { sourceId, email, displayName, teamName, bootstrapSecret } });
  }

  refreshCloudSession(sourceId: string): Promise<import("./settings-types").CloudAccountResult> {
    return invoke<import("./settings-types").CloudAccountResult>("refresh_cloud_session", { input: { sourceId } });
  }

  createCloudProject(sourceId: string, name: string): Promise<string> {
    return invoke<string>("create_cloud_project", { input: { sourceId, name } });
  }

  listCloudShares(sourceId: string): Promise<import("./settings-types").CloudShareSummary[]> {
    return invoke("list_cloud_shares", { input: { sourceId } });
  }

  createCloudShare(sourceId: string, expiresAt?: string): Promise<import("./settings-types").CloudShareRecord> {
    return invoke("create_cloud_share", { input: { sourceId, expiresAt: expiresAt ?? null } });
  }

  revokeCloudShare(sourceId: string, shareId: string): Promise<void> {
    return invoke("revoke_cloud_share", { input: { sourceId, shareId, expiresAt: null } });
  }

  rotateCloudShare(sourceId: string, shareId: string, expiresAt?: string): Promise<import("./settings-types").CloudShareRecord> {
    return invoke("rotate_cloud_share", { input: { sourceId, shareId, expiresAt: expiresAt ?? null } });
  }

  factoryReset(confirmation: string): Promise<number> {
    return invoke<number>("factory_reset", { input: { confirmation } });
  }
}
