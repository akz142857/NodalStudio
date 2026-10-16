import { expect, it, vi } from "vitest";
import { createExportDetailStore } from "./export-detail-store";

it("only notifies nodes entering or leaving each bounded batch, including unmounted nodes", () => {
  const store = createExportDetailStore(); const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
  const stopA = store.subscribe("a", a); store.subscribe("b", b); store.subscribe("c", c);
  expect(store.includes("offscreen")).toBe(true);
  store.set(new Set()); expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([1, 1, 1]);
  store.set(new Set(["a"])); expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([2, 1, 1]);
  store.set(new Set(["b", "offscreen"])); expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([3, 2, 1]);
  expect(store.includes("a")).toBe(false); expect(store.includes("offscreen")).toBe(true);
  stopA(); store.set(new Set()); expect(a).toHaveBeenCalledTimes(3); expect(b).toHaveBeenCalledTimes(3);
  store.set(undefined); expect(b).toHaveBeenCalledTimes(4); expect(c).toHaveBeenCalledTimes(2);
  expect(store.includes("any")).toBe(true);
});
