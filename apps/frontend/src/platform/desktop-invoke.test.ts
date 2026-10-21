import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
import { invoke } from "./desktop-invoke";
describe("update IPC guard", () => {
  it("waits for imports and blocks new writes during installation, then unlocks on failure", async () => {
    let finish!: () => void;
    native.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const importing = invoke("import_portable_backup");
    await expect(invoke("install_update")).rejects.toThrow("running operations");
    finish(); await importing;
    let fail!: (error: Error) => void;
    native.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const installation = invoke("install_update");
    await expect(invoke("save_annotation")).rejects.toThrow("being installed");
    native.mockResolvedValueOnce({ phase: "installing" });
    await expect(invoke("get_update_status")).resolves.toEqual({ phase: "installing" });
    fail(new Error("disk full")); await expect(installation).rejects.toThrow("disk full");
    native.mockResolvedValueOnce(true);
    await expect(invoke("save_annotation")).resolves.toBe(true);
  });
});
