import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform } from "../platform";
import { GitWorkspacePanel } from "./GitWorkspacePanel";

describe("GitWorkspacePanel", () => {
  beforeEach(() => { window.localStorage.clear(); vi.spyOn(window, "confirm").mockReturnValue(true); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("exports split metadata to an explicitly selected repository", async () => {
    const exportGitWorkspace = vi.fn().mockResolvedValue({
      workspacePath: "/repo/.nodalstudio",
      writtenFiles: 7,
      removedStaleFiles: 0,
      schemaFingerprint: "abcdef123456",
    });
    const platform = { exportGitWorkspace } as unknown as NodalStudioPlatform;
    render(
      <GitWorkspacePanel
        sourceId="source"
        platform={platform}
        onImported={vi.fn().mockResolvedValue(undefined)}
        defaultRepositoryPath=""
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText(/Snapshots, layouts, credentials, and row data/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Repository directory"), {
      target: { value: "/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export .nodalstudio" }));

    await waitFor(() => expect(exportGitWorkspace).toHaveBeenCalledWith("source", "/repo"));
    expect(await screen.findByText("Exported · 7 files · abcdef12")).toBeVisible();
  });

  it("imports merged semantics and warns when the schema fingerprint differs", async () => {
    const importGitWorkspace = vi.fn().mockResolvedValue({
      importedAnnotations: 4,
      importedDomainGroups: 1,
      importedSavedViews: 1,
      importedProvenance: 0,
      importedLineageLinks: 0,
      importedLogicalRelationships: 2,
      fingerprintMatches: false,
      workspaceFingerprint: "older",
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    const previewGitImport = vi.fn().mockResolvedValue({ annotations: 4, domainGroups: 1, savedViews: 1, provenance: 0, lineageLinks: 0, logicalRelationships: 2, relationshipConflicts: ["public.orders[user_id]->public.users[id]"], fingerprintMatches: false, workspaceFingerprint: "older" });
    const platform = { importGitWorkspace, previewGitImport } as unknown as NodalStudioPlatform;
    render(
      <GitWorkspacePanel
        sourceId="source"
        platform={platform}
        onImported={onImported}
        defaultRepositoryPath=""
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Repository directory"), {
      target: { value: "/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import semantics" }));

    await waitFor(() => expect(importGitWorkspace).toHaveBeenCalledWith("source", "/repo"));
    expect(previewGitImport).toHaveBeenCalledWith("source", "/repo");
    expect(onImported).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Imported · 4 annotations · 2 relationships · schema fingerprint differs"),
    ).toBeVisible();
  });
});
