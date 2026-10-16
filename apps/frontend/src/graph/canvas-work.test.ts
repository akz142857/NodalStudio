import { afterEach, expect, it, vi } from "vitest";
import { observeCanvasWork, startCanvasWork, withCanvasWork, type CanvasWork } from "./canvas-work";
afterEach(() => { observeCanvasWork(() => {})(); vi.restoreAllMocks(); });
it("does not read the clock without a diagnostic observer", () => {
  const now = vi.spyOn(performance, "now");
  startCanvasWork("disabled")();
  expect(now).not.toHaveBeenCalled();
});
it("reports synchronous work once, including cleanup after a failed operation", () => {
  vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(27);
  const observer = vi.fn(), stop = observeCanvasWork(observer);
  const end = startCanvasWork("measure", 264);
  expect(() => { try { throw new Error("failed"); } finally { end(); } }).toThrow("failed");
  end(); stop();
  expect(observer).toHaveBeenCalledExactlyOnceWith({ kind: "measure", start: 10, end: 27, count: 264 });
});
it("does not deliver retired spans to a replacement recorder or let stale cleanup disable it", () => {
  const old = vi.fn<(work: CanvasWork) => void>(), current = vi.fn<(work: CanvasWork) => void>();
  const releaseOld = observeCanvasWork(old), end = startCanvasWork("old");
  const releaseCurrent = observeCanvasWork(current);
  releaseOld(); end(); startCanvasWork("new")(); releaseCurrent();
  expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledOnce();
  expect(current.mock.calls[0][0].kind).toBe("new");
});
it("keeps a throwing diagnostic observer from changing canvas execution", () => {
  const stop = observeCanvasWork(() => { throw new Error("observer"); });
  expect(() => startCanvasWork("safe")()).not.toThrow(); stop();
});

it("preserves a wrapped operation's return identity and original error", () => {
  const observer = vi.fn(), stop = observeCanvasWork(observer);
  const value = { ready: true }, error = new Error("original");
  expect(withCanvasWork("return", () => value)).toBe(value);
  expect(() => withCanvasWork("throw", () => { throw error; })).toThrow(error);
  expect(observer).toHaveBeenCalledTimes(2); stop();
});
