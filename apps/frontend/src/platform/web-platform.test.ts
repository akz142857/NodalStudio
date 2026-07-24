import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudViewBundle } from "./types";
import { WebPlatform } from "./web-platform";

const bundle: CloudViewBundle = {
  projectId: "project",
  sourceId: "source",
  sourceLabel: "Shared model",
  fingerprint: "abc",
  snapshot: {
    id: "snapshot",
    sourceId: "source",
    capturedAt: "2026-07-11T00:00:00Z",
    fingerprint: "abc",
    database: { name: "app", databaseType: "postgreSql", version: "17" },
    schemas: [],
  },
  changeSet: null,
  annotations: [],
  domainGroups: [],
  savedViews: [],
  layout: null,
  baseVersion: 1,
};

describe("WebPlatform", () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("loads a metadata-only shared bundle without database credentials", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://cloud.example");
    window.history.replaceState({}, "", "/?share=viewer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(bundle), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const platform = new WebPlatform();
    await expect(platform.loadSharedBundle()).resolves.toEqual(bundle);
    await expect(platform.getSnapshot("snapshot")).resolves.toEqual(bundle.snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example/v1/view/viewer-token",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("reads legacy settings and moves them to the Nodal Studio storage key on update", async () => {
    localStorage.setItem(
      "sqlaieditor.settings.app.v1",
      JSON.stringify({ appearance: { density: "compact" } }),
    );
    const platform = new WebPlatform();
    const settings = await platform.getSettings();

    expect(settings.app.appearance.density).toBe("compact");
    await platform.updateAppSettings(settings.app);

    expect(localStorage.getItem("nodalstudio.settings.app.v1")).not.toBeNull();
    expect(localStorage.getItem("sqlaieditor.settings.app.v1")).toBeNull();
  });
});
