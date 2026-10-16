import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { TauriPlatform } from "./tauri-platform";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({ path: "/Downloads/model.svg" }) }));
afterEach(() => vi.clearAllMocks());

it("sends the original typed byte view as raw IPC with bounded filename metadata", async () => {
  const buffer = new Uint8Array([0, 60, 115, 118, 103, 62, 255]);
  const bytes = buffer.subarray(1, 6);
  await expect(new TauriPlatform().saveDiagramExport({ fileName: "model.svg", format: "svg", data: bytes })).resolves.toEqual({ path: "/Downloads/model.svg" });
  expect(invoke).toHaveBeenCalledWith("save_diagram_export_binary", bytes, { headers: { "x-nodal-file-name": "model.svg", "x-nodal-format": "svg" } });
  expect(vi.mocked(invoke).mock.calls[0][1]).toBe(bytes);
  expect([...bytes]).toEqual([60, 115, 118, 103, 62]);
});

it("retains compatibility with legacy number-array callers", async () => {
  const input = { fileName: "model.png", format: "png" as const, data: [137, 80, 78, 71] };
  await new TauriPlatform().saveDiagramExport(input);
  expect(invoke).toHaveBeenCalledWith("save_diagram_export", { input });
});
