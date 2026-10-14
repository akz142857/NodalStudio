import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOperation } from "./use-operation";
const messages = { running: "Saving…", success: (value: string) => `Saved ${value}`, failure: "Save failed." };
function deferred() { let resolve!: (value: string) => void; let reject!: (reason: unknown) => void; const promise = new Promise<string>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

describe("scoped operations", () => {
  it("blocks duplicate submissions, preserves running state when dismissed and reports the actual result", async () => {
    const job = deferred(); const save = vi.fn(() => job.promise);
    const { result } = renderHook(() => useOperation("source-a"));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(save, messages); void result.current.run(save, messages); });
    expect(save).toHaveBeenCalledOnce(); expect(result.current.busy).toBe(true);
    act(() => result.current.dismiss()); expect(result.current.state?.phase).toBe("running");
    await act(async () => { job.resolve("3 tables"); await pending; });
    expect(result.current.state).toEqual({ phase: "success", summary: "Saved 3 tables" });
    act(() => result.current.dismiss()); expect(result.current.state).toBeUndefined();
  });
  it("retains errors as details, clears them on retry and allows non-Error rejection values", async () => {
    const { result } = renderHook(() => useOperation("source-a"));
    // IPC failures can be strings; exercise that boundary deliberately.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await act(() => result.current.run(() => Promise.reject<string>("storage unavailable"), messages));
    expect(result.current.state).toEqual({ phase: "error", summary: "Save failed.", details: "storage unavailable" });
    const job = deferred(); let pending!: Promise<void>;
    act(() => { pending = result.current.run(() => job.promise, messages); });
    expect(result.current.state).toEqual({ phase: "running", summary: "Saving…" });
    await act(async () => { job.resolve("current layout"); await pending; });
    expect(result.current.state?.summary).toBe("Saved current layout");
  });
  it("hides previous scope results, ignores late failures and can start work in the new scope", async () => {
    const old = deferred(); const current = deferred();
    const { result, rerender } = renderHook(({ scope }) => useOperation(scope), { initialProps: { scope: "a" } });
    let previous!: Promise<void>; let next!: Promise<void>; let oldIsCurrent!: () => boolean;
    act(() => { previous = result.current.run((isCurrent) => { oldIsCurrent = isCurrent; return old.promise; }, messages); });
    rerender({ scope: "b" }); expect(result.current.state).toBeUndefined(); expect(oldIsCurrent()).toBe(false);
    act(() => { next = result.current.run(() => current.promise, messages); });
    await act(async () => { old.reject(new Error("old failure")); await previous; });
    expect(result.current.state?.phase).toBe("running");
    await act(async () => { current.resolve("b"); await next; });
    expect(result.current.state?.summary).toBe("Saved b");
    rerender({ scope: "a" }); expect(result.current.state).toBeUndefined();
  });
  it("never resurrects a completed result when returning to a previous scope", async () => {
    const { result, rerender } = renderHook(({ scope }) => useOperation(scope), { initialProps: { scope: "a" } });
    await act(() => result.current.run(() => Promise.resolve("a"), messages));
    rerender({ scope: "b" }); rerender({ scope: "a" }); expect(result.current.state).toBeUndefined();
  });
  it("invalidates completion callbacks on unmount and supports React StrictMode", async () => {
    const job = deferred(); let isCurrent!: () => boolean; let pending!: Promise<void>;
    const { result, unmount } = renderHook(() => useOperation("a"), { wrapper: StrictMode });
    act(() => { pending = result.current.run((check) => { isCurrent = check; return job.promise; }, messages); });
    expect(isCurrent()).toBe(true); unmount(); expect(isCurrent()).toBe(false);
    job.resolve("a"); await pending;
  });
});
