import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewDdlInWorker } from "./ddl-worker-client";
import type { DdlRequest } from "./ddl-types";
const request: DdlRequest = { text: "CREATE TABLE t(id int);", dialect: "postgreSql", defaultSchema: "public", source: { kind: "ddl-clipboard", name: "Clipboard", id: "session" } };
class PreviewWorker {
  static last: PreviewWorker;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { PreviewWorker.last = this; }
}
describe("DDL worker lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("Worker", PreviewWorker); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("returns a preview and releases the worker/timer", async () => {
    const signal = new AbortController(); const promise = previewDdlInWorker(request, signal.signal); const worker = PreviewWorker.last;
    expect(worker.postMessage).toHaveBeenCalledWith(request);
    const preview = { source: { id: "ddl-preview:session" } }; worker.onmessage?.({ data: { preview } } as MessageEvent);
    await expect(promise).resolves.toEqual(preview); expect(worker.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    signal.abort(); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("cancels and terminates pending work without returning an old preview", async () => {
    const signal = new AbortController(); const promise = previewDdlInWorker(request, signal.signal); const worker = PreviewWorker.last;
    signal.abort(); await expect(promise).rejects.toThrow("cancelled"); expect(worker.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("times out and releases resources", async () => {
    const promise = previewDdlInWorker(request, new AbortController().signal); const rejected = expect(promise).rejects.toThrow("10 seconds");
    vi.advanceTimersByTime(10_000); await rejected; expect(PreviewWorker.last.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("reports worker errors and skips construction for a previously aborted signal", async () => {
    const promise = previewDdlInWorker(request, new AbortController().signal); PreviewWorker.last.onerror?.(); await expect(promise).rejects.toThrow("worker failed");
    const signal = new AbortController(); signal.abort(); await expect(previewDdlInWorker(request, signal.signal)).rejects.toThrow("cancelled");
  });
});
