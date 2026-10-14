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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it.each(["svg", "html"] as const)("downloads generated %s locally and cleans up the temporary link and URL", async (format) => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue("blob:diagram-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    let filename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
      expect(this.isConnected).toBe(true);
      expect(this.href).toBe("blob:diagram-export");
    });
    const html = '<!doctype html><html lang="en"><body>模型 &amp; report</body></html>';
    const bytes = new TextEncoder().encode(format === "html" ? html : '<svg xmlns="http://www.w3.org/2000/svg"><text>模型</text></svg>');
    const platform = new WebPlatform();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(format === "html" ? platform.saveSchemaReport({ fileName: "model.html", html }) : platform.saveDiagramExport({ fileName: "model.svg", format: "svg", data: Array.from(bytes) })).resolves.toEqual({ path: null });
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe(format === "html" ? "text/html;charset=utf-8" : "image/svg+xml");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(bytes));
    expect(filename).toBe(`model.${format}`);
    expect(document.querySelector(`a[download="model.${format}"]`)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagram-export");
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
