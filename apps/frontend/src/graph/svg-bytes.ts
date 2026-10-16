import type { DiagramSvg } from "./diagram-export";

const MAX_BYTES = 32 * 1024 * 1024;
const CHUNK_CHARS = 128 * 1024;
const FRAME_BUDGET_MS = 8;

/** Encode straight into the IPC buffer, without a giant intermediate Blob or
 * byte array copy. Yield between bounded chunks; never split a surrogate pair. */
export async function prepareSvgBytes(diagram: Pick<DiagramSvg, "svg" | "byteLength">, isCurrent = () => true): Promise<Uint8Array | undefined> {
  const { svg, byteLength } = diagram;
  if (!isCurrent()) return;
  if (svg.length > MAX_BYTES || (byteLength !== undefined && (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > MAX_BYTES))) {
    throw new Error("The SVG exceeds 32 MB. Export a smaller filtered view.");
  }
  const allocationStarted = performance.now();
  // Legacy/custom capture callers may not provide size. UTF-8 is bounded by
  // three bytes per UTF-16 code unit; enforce the same limit while writing.
  const data = new Uint8Array(byteLength ?? Math.min(MAX_BYTES, svg.length * 3));
  performance.measure("diagram-export:byte-allocation", { start: allocationStarted, end: performance.now() });
  const encoder = new TextEncoder();
  let offset = 0, written = 0, budgetStarted = performance.now();
  while (offset < svg.length) {
    if (!isCurrent()) return;
    let end = Math.min(svg.length, offset + CHUNK_CHARS);
    const last = svg.charCodeAt(end - 1), next = svg.charCodeAt(end);
    if (end < svg.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    const started = performance.now();
    const encoded = encoder.encodeInto(svg.slice(offset, end), data.subarray(written));
    if (encoded.read !== end - offset) throw new Error("The SVG exceeds its byte budget. Export a smaller filtered view.");
    written += encoded.written; offset = end;
    performance.measure("diagram-export:utf8-chunk", { start: started, end: performance.now() });
    if (offset < svg.length && performance.now() - budgetStarted >= FRAME_BUDGET_MS) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      budgetStarted = performance.now();
    }
  }
  if (!isCurrent()) return;
  if (byteLength !== undefined && written !== byteLength) throw new Error("The SVG byte length is inconsistent. Try exporting again.");
  return written === data.length ? data : data.subarray(0, written);
}
