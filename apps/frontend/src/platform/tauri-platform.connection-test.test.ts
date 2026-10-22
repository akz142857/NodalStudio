import { Channel, invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { TauriPlatform } from "./tauri-platform";
import type { ConnectionTestProgress, ConnectionTestResult, SaveDataSourceInput } from "./types";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage: (message: unknown) => void = () => {}; },
}));
afterEach(() => vi.clearAllMocks());
it("defers early cancellation until registration and targets only that test", async () => {
  let channel!: Channel<ConnectionTestProgress>;
  let testId = "";
  let finish!: (value: ConnectionTestResult) => void;
  vi.mocked(invoke).mockImplementation((command, args) => {
    const input = args as { testId: string; onProgress: Channel<ConnectionTestProgress> };
    if (command === "test_postgres_connection") {
      channel = input.onProgress; testId = input.testId;
      return new Promise((resolve) => { finish = resolve; });
    }
    return Promise.resolve(true);
  });
  const controller = new AbortController(), onProgress = vi.fn();
  const running = new TauriPlatform().testPostgresConnection({} as SaveDataSourceInput, { signal: controller.signal, onProgress });
  controller.abort();
  expect(invoke).toHaveBeenCalledTimes(1);
  channel.onmessage({ phase: "configuration", sshConnected: false });
  expect(invoke).toHaveBeenLastCalledWith("cancel_connection_test", { testId });
  expect(onProgress).not.toHaveBeenCalled();
  finish({} as ConnectionTestResult);
  await running;
  channel.onmessage({ phase: "tls", sshConnected: true });
  expect(onProgress).not.toHaveBeenCalled();
});
