import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseSnapshot,
  SchemaChangeSet,
  SnapshotSummary,
  NodalStudioPlatform,
} from "../platform";
import { HistoryPanel } from "./HistoryPanel";

const snapshot: DatabaseSnapshot = {
  id: "after",
  sourceId: "source",
  capturedAt: "2026-07-11T10:00:00Z",
  fingerprint: "after-fingerprint",
  database: { name: "app", databaseType: "postgreSql", version: "17" },
  schemas: [],
};

const summaries: SnapshotSummary[] = [
  {
    id: "after",
    sourceId: "source",
    capturedAt: "2026-07-11T10:00:00Z",
    fingerprint: "after-fingerprint",
    databaseName: "app",
    schemaCount: 1,
    tableCount: 3,
  },
  {
    id: "before",
    sourceId: "source",
    capturedAt: "2026-07-11T09:00:00Z",
    fingerprint: "before-fingerprint",
    databaseName: "app",
    schemaCount: 1,
    tableCount: 2,
  },
];

const changeSet: SchemaChangeSet = {
  id: "change",
  beforeSnapshotId: "before",
  afterSnapshotId: "after",
  createdAt: "2026-07-11T10:00:00Z",
  operations: [],
  riskSummary: { informational: 0, low: 0, medium: 0, high: 0 },
};

function platformMock(compareSnapshots: NodalStudioPlatform["compareSnapshots"]): NodalStudioPlatform {
  return {
    getRuntimeInfo: vi.fn(),
    getDiagnosticInfo: vi.fn(),
    revealAppDirectory: vi.fn(),
    listDataSources: vi.fn(),
    renameDataSource: vi.fn(),
    duplicateDataSource: vi.fn(),
    saveDataSource: vi.fn(),
    testPostgresConnection: vi.fn(),
    verifyAndRefreshDataSource: vi.fn(),
    capturePostgresSnapshot: vi.fn(),
    listSnapshots: vi.fn().mockResolvedValue(summaries),
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    compareSnapshots,
    executeReadonlyQuery: vi.fn(),
    cancelQuery: vi.fn(),
    listQueryHistory: vi.fn(),
    deleteQueryHistory: vi.fn(),
    clearQueryHistory: vi.fn(),
    getSemantics: vi.fn(),
    listLogicalRelationships: vi.fn(),
    validateLogicalRelationship: vi.fn(),
    createLogicalRelationship: vi.fn(),
    updateLogicalRelationship: vi.fn(),
    deleteLogicalRelationship: vi.fn(),
    ignoreRelationshipInference: vi.fn(),
    listIgnoredRelationshipInferences: vi.fn(),
    saveAnnotation: vi.fn(),
    saveDomainGroup: vi.fn(),
    saveView: vi.fn(),
    saveLayout: vi.fn(),
    explainSchema: vi.fn(),
    testAiProvider: vi.fn(),
    loadSharedBundle: vi.fn(),
    syncProject: vi.fn(),
    compareEnvironmentSnapshots: vi.fn(),
    saveChangeProvenance: vi.fn(),
    saveCodeLineage: vi.fn(),
    exportGitWorkspace: vi.fn(),
    previewGitExport: vi.fn(),
    previewGitImport: vi.fn(),
    importGitWorkspace: vi.fn(),
    getSettings: vi.fn(),
    updateAppSettings: vi.fn(),
    updateDataSourceSettings: vi.fn(),
    resetAppSettings: vi.fn(),
    resetDataSourceSettings: vi.fn(),
    updateOrganizationPolicy: vi.fn(),
    refreshOrganizationPolicy: vi.fn(),
    updateProjectSettings: vi.fn(),
    getStorageUsage: vi.fn(),
    clearLayouts: vi.fn(),
    clearRegenerableCache: vi.fn(),
    saveAiCredential: vi.fn(),
    saveCloudCredential: vi.fn(),
    clearCredentials: vi.fn(),
    getSecurityStatus: vi.fn(),
    checkMergeDriver: vi.fn(),
    readGitConflictReport: vi.fn(),
    deleteGitConflictReport: vi.fn(),
    exportSettingsFile: vi.fn(),
    previewSettingsFile: vi.fn(),
    importSettingsFile: vi.fn(),
    exportPortableBackup: vi.fn(),
    previewPortableBackup: vi.fn(),
    importPortableBackup: vi.fn(),
    checkForUpdates: vi.fn(),
    deleteSourceData: vi.fn(),
    previewSourceDataDeletion: vi.fn(),
    generateEventTriggerScript: vi.fn(),
    listSyncDiagnostics: vi.fn(),
    listCloudAudit: vi.fn(),
    listExternalAccess: vi.fn(),
    bootstrapCloudAccount: vi.fn(),
    refreshCloudSession: vi.fn(),
    createCloudProject: vi.fn(),
    listCloudShares: vi.fn(),
    createCloudShare: vi.fn(),
    revokeCloudShare: vi.fn(),
    rotateCloudShare: vi.fn(),
    factoryReset: vi.fn(),
  };
}

describe("HistoryPanel", () => {
  it("loads a timeline and compares the newest two snapshots", async () => {
    const compareSnapshots = vi
      .fn<(beforeSnapshotId: string, afterSnapshotId: string) => Promise<SchemaChangeSet>>()
      .mockResolvedValue(changeSet);
    const platform = platformMock(compareSnapshots);
    const onCompare = vi.fn();
    render(
      <HistoryPanel
        sourceId="source"
        revision="after"
        platform={platform}
        onSelect={vi.fn()}
        onCompare={onCompare}
      />,
    );

    expect(await screen.findByText("Current")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));

    await waitFor(() => expect(onCompare).toHaveBeenCalledWith(snapshot, changeSet));
    expect(compareSnapshots).toHaveBeenCalledWith("before", "after");
  });
});
