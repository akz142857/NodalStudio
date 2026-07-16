import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalProject, ProjectScan, NodalStudioPlatform } from "../platform";
import { ProjectPanel } from "./ProjectPanel";

afterEach(cleanup);

const project: LocalProject = {
  id: "project-1",
  name: "Shop API",
  rootPath: "/workspace/shop-api",
  repositoryKind: "git",
  remoteUrl: null,
  managedCache: false,
  databaseSourceIds: ["source-1"],
  createdAt: "2026-07-11T10:00:00Z",
};

const scan: ProjectScan = {
  id: "scan-1",
  projectId: project.id,
  branch: "main",
  commitSha: "abc123",
  dirty: true,
  status: "discovering",
  analyzerVersions: { "project-scanner": "0.1.0" },
  startedAt: "2026-07-11T10:00:00Z",
  completedAt: null,
};

function platformMock(overrides: Partial<NodalStudioPlatform> = {}): NodalStudioPlatform {
  return {
    listLocalProjects: vi.fn().mockResolvedValue([]),
    listProjectScans: vi.fn().mockResolvedValue([]),
    addLocalProject: vi.fn().mockResolvedValue(project),
    cloneRemoteProject: vi.fn().mockResolvedValue({ ...project, managedCache: true, remoteUrl: "https://example.com/shop-api.git" }),
    setProjectBindings: vi.fn().mockResolvedValue(project),
    startProjectScan: vi.fn().mockResolvedValue(scan),
    cancelProjectScan: vi.fn().mockResolvedValue(true),
    removeLocalProject: vi.fn().mockResolvedValue(undefined),
    getProjectScanStatus: vi.fn().mockResolvedValue(scan),
    ...overrides,
  } as unknown as NodalStudioPlatform;
}

describe("ProjectPanel", () => {
  it("adds a local project without sending source contents", async () => {
    const listLocalProjects = vi.fn().mockResolvedValue([]);
    const addLocalProject = vi.fn().mockResolvedValue(project);
    const platform = platformMock({ listLocalProjects, addLocalProject });
    render(<ProjectPanel platform={platform} sourceId="source-1" />);

    await waitFor(() => expect(listLocalProjects).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Local project directory"), {
      target: { value: "/workspace/shop-api" },
    });
    expect(screen.getByRole("button", { name: "Add local project" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add local project" }));

    await waitFor(() =>
      expect(addLocalProject).toHaveBeenCalledWith({
        rootPath: "/workspace/shop-api",
        databaseSourceIds: ["source-1"],
      }),
    );
  });

  it("starts and cancels a background project scan", async () => {
    const startProjectScan = vi.fn().mockResolvedValue(scan);
    const cancelProjectScan = vi.fn().mockResolvedValue(true);
    const platform = platformMock({
      listLocalProjects: vi.fn().mockResolvedValue([project]),
      listProjectScans: vi.fn().mockResolvedValue([]),
      startProjectScan,
      cancelProjectScan,
    });
    render(<ProjectPanel platform={platform} sourceId="source-1" />);

    const scanButton = await screen.findByRole("button", { name: "Scan" });
    fireEvent.click(scanButton);
    await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(startProjectScan).toHaveBeenCalledWith(project.id);
    expect(cancelProjectScan).toHaveBeenCalledWith(scan.id);
  });

  it("clones an explicit HTTPS remote into the managed project flow", async () => {
    const cloneRemoteProject = vi.fn().mockResolvedValue({ ...project, managedCache: true });
    const platform = platformMock({ cloneRemoteProject });
    render(<ProjectPanel platform={platform} sourceId="source-1" />);
    await screen.findByLabelText("Remote Git URL");
    fireEvent.change(screen.getByLabelText("Remote Git URL"), { target: { value: "https://example.com/team/shop-api.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone remote…" }));
    await waitFor(() => expect(cloneRemoteProject).toHaveBeenCalledWith({ remoteUrl: "https://example.com/team/shop-api.git", databaseSourceIds: ["source-1"] }));
  });

  it("runs one automatic incremental scan for a bound project when enabled", async () => {
    const startProjectScan = vi.fn().mockResolvedValue(scan);
    const platform = platformMock({ listLocalProjects: vi.fn().mockResolvedValue([project]), listProjectScans: vi.fn().mockResolvedValue([]), startProjectScan });
    render(<ProjectPanel platform={platform} sourceId="source-1" autoScan />);
    await waitFor(() => expect(startProjectScan).toHaveBeenCalledTimes(1));
    expect(startProjectScan).toHaveBeenCalledWith(project.id);
  });

  it("can bind and unbind an existing project from the active database", async () => {
    const setProjectBindings = vi.fn().mockResolvedValue({ ...project, databaseSourceIds: [] });
    const platform = platformMock({ listLocalProjects: vi.fn().mockResolvedValue([project]), listProjectScans: vi.fn().mockResolvedValue([]), setProjectBindings });
    render(<ProjectPanel platform={platform} sourceId="source-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Unbind database" }));
    await waitFor(() => expect(setProjectBindings).toHaveBeenCalledWith(project.id, []));
  });
});
