import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    deleteView: vi.fn(),
    pickWorkspacePath: vi.fn(),
    pickConnectionFile: vi.fn(),
    exportQueryResult: vi.fn(),
    getChangeReview: vi.fn(),
    applyChangeReview: vi.fn(),
    prepareKnowledgeDraft: vi.fn(),
    confirmKnowledgeDraft: vi.fn(),
    cancelKnowledgeDraft: vi.fn(),
    prepareDiscovery: vi.fn(),
    runDiscovery: vi.fn(),
    cancelDiscovery: vi.fn(),
    prepareTableExplanation: vi.fn(),
    runTableExplanation: vi.fn(),
    cancelTableExplanation: vi.fn(),
    saveDiagramExport: vi.fn().mockResolvedValue({ path: null }),
    saveSchemaReport: vi.fn().mockResolvedValue({ path: null }),
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
    previewRelationshipBatch: vi.fn(), applyRelationshipBatch: vi.fn(), listRelationshipBatches: vi.fn(), undoRelationshipBatch: vi.fn(),
    restoreRelationshipInference: vi.fn(),
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
    openAppStore: vi.fn(),
    getPurchaseStatus: vi.fn(),
    restoreAppPurchase: vi.fn(),
    getUpdateStatus: vi.fn(), openUpdateReleases: vi.fn(), downloadUpdate: vi.fn(), cancelUpdateDownload: vi.fn(), installUpdate: vi.fn(),
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

    expect(await screen.findByText("Latest captured")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));

    await waitFor(() => expect(onCompare).toHaveBeenCalledWith(snapshot, changeSet));
    expect(compareSnapshots).toHaveBeenCalledWith("before", "after");
  });

  it("distinguishes the viewed historical version from the newest captured version", async () => {
    const onSelect = vi.fn();
    const old = { ...snapshot, id: "before", capturedAt: summaries[1].capturedAt, fingerprint: summaries[1].fingerprint };
    render(<HistoryPanel sourceId="source" revision="before" activeSnapshot={old} platform={platformMock(vi.fn())} onSelect={onSelect} onCompare={vi.fn()}/>);
    expect(await screen.findByText("Historical")).toBeVisible();
    expect(screen.getByRole("region",{name:"Viewing snapshot details"})).toHaveTextContent(old.fingerprint);
    const current = screen.getByRole("button",{name:/Viewing/});
    expect(current).toHaveAttribute("aria-current","true");
    const latest = screen.getByRole("button",{name:/Latest captured/});
    expect(latest).not.toHaveAttribute("aria-current");
    fireEvent.click(latest);
    await waitFor(()=>expect(onSelect).toHaveBeenCalledWith(snapshot));
  });
  it("compares in the chosen direction even when the target is older", async () => {
    const compareSnapshots = vi.fn().mockResolvedValue(changeSet);
    const platform = platformMock(compareSnapshots);
    const getSnapshot = vi.fn().mockResolvedValue(snapshot);
    platform.getSnapshot = getSnapshot;
    render(<HistoryPanel sourceId="source" revision="after" platform={platform} onSelect={vi.fn()} onCompare={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Swap direction" }));
    expect(screen.getByLabelText("Before (baseline)")).toHaveValue("after");
    expect(screen.getByLabelText("After (target)")).toHaveValue("before");
    fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
    await waitFor(() => expect(compareSnapshots).toHaveBeenCalledWith("after", "before"));
    expect(getSnapshot).toHaveBeenCalledWith("before");
  });

  it("prevents comparison of a snapshot with itself", async () => {
    const compareSnapshots = vi.fn().mockResolvedValue(changeSet);
    render(<HistoryPanel sourceId="source" revision="after" platform={platformMock(compareSnapshots)} onSelect={vi.fn()} onCompare={vi.fn()} />);
    await screen.findByRole("button", { name: "Swap direction" });
    fireEvent.change(screen.getByLabelText("Before (baseline)"), { target: { value: "after" } });
    expect(screen.getByRole("button", { name: "Compare versions" })).toBeDisabled();
    expect(compareSnapshots).not.toHaveBeenCalled();
  });

  it("ignores a comparison that finishes after the history has changed", async () => {
    let complete!: (changeSet: SchemaChangeSet) => void;
    const compareSnapshots = vi.fn<NodalStudioPlatform["compareSnapshots"]>().mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const platform = platformMock(compareSnapshots);
    const onCompare = vi.fn();
    const { rerender } = render(<HistoryPanel sourceId="source" revision="after" platform={platform} onSelect={vi.fn()} onCompare={onCompare} />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare versions" }));
    rerender(<HistoryPanel sourceId="source" revision="new-capture" platform={platform} onSelect={vi.fn()} onCompare={onCompare} />);
    await act(async () => { complete(changeSet); await Promise.resolve(); });
    expect(onCompare).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Compare versions" })).toBeEnabled();
  });
});
