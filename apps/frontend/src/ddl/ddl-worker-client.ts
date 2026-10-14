import type { DdlPreview, DdlRequest } from "./ddl-types";
export function previewDdlInWorker(request: DdlRequest, signal: AbortSignal): Promise<DdlPreview> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Preview cancelled.")); return; }
    const worker = new Worker(new URL("./ddl.worker.ts", import.meta.url), { type: "module" });
    const finish = (error?: string, preview?: DdlPreview) => { window.clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate(); if (error) reject(new Error(error)); else if (preview) resolve(preview); else reject(new Error("Worker returned no preview.")); };
    const abort = () => finish("Preview cancelled.");
    const timer = window.setTimeout(() => finish("DDL preview timed out after 10 seconds. Reduce the input and retry."), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ error?: string; preview?: DdlPreview }>) => finish(event.data.error, event.data.preview);
    worker.onerror = () => finish("DDL worker failed. Retry or reduce the input.");
    try { worker.postMessage(request); } catch { finish("Unable to send input to the DDL worker."); }
  });
}
