import { afterEach, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { prepareSvgBytes } from "./svg-bytes";

afterEach(() => vi.restoreAllMocks());

it("encodes escaped Unicode exactly into the pre-sized IPC buffer without a Blob or whole-string encode", async () => {
  const svg = "a".repeat(128 * 1024 - 1) + "🐱中文&<\"" + "b".repeat(200000) + "\ud800x\udc00";
  const expected = new TextEncoder().encode(svg);
  const blob = vi.spyOn(globalThis, "Blob");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  const data = await prepareSvgBytes({ svg, byteLength: expected.length });
  expect(Buffer.compare(Buffer.from(data!), Buffer.from(expected))).toBe(0); expect(data!.buffer.byteLength).toBe(expected.length);
  expect(blob).not.toHaveBeenCalled(); expect(encode).not.toHaveBeenCalled();
});

it("yields within a time budget and cancels between chunks", async () => {
  let clock = 0, current = true;
  vi.spyOn(performance, "now").mockImplementation(() => ++clock);
  const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { current = false; callback(0); return 1; });
  const encodeInto = vi.spyOn(TextEncoder.prototype, "encodeInto");
  const svg = "a".repeat(1024 * 1024);
  expect(await prepareSvgBytes({ svg, byteLength: svg.length }, () => current)).toBeUndefined();
  expect(frames).toHaveBeenCalledOnce(); expect(encodeInto.mock.calls.length).toBeLessThan(8);
  expect(Math.max(...encodeInto.mock.calls.map(([value]) => value.length))).toBeLessThanOrEqual(128 * 1024);
});

it("retains exact legacy bytes without size metadata and rejects invalid or overflowing budgets", async () => {
  const svg = "<svg>中文🐱</svg>";
  expect(Buffer.compare(Buffer.from((await prepareSvgBytes({ svg }))!), Buffer.from(new TextEncoder().encode(svg)))).toBe(0);
  expect(await prepareSvgBytes({ svg: "", byteLength: 0 })).toHaveLength(0);
  expect(await prepareSvgBytes({ svg }, () => false)).toBeUndefined();
  for (const byteLength of [-1, NaN, 1.5, 32 * 1024 * 1024 + 1]) await expect(prepareSvgBytes({ svg, byteLength })).rejects.toThrow("exceeds 32 MB");
  await expect(prepareSvgBytes({ svg, byteLength: 1 })).rejects.toThrow("byte budget");
  await expect(prepareSvgBytes({ svg, byteLength: 100 })).rejects.toThrow("inconsistent");
});
