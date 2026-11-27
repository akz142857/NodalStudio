import type { CodeDefinitionPosition, CodeExtension, CodeExtensionLanguage, PreparedCodeExtension } from "../../platform/code-review";

export type ExtensionDiagnostic = {
  rule: string;
  message: string;
  severity: "error" | "warning";
  start?: CodeDefinitionPosition;
  end?: CodeDefinitionPosition;
};
export type SyntaxToken = { from: number; to: number; style: "keyword" | "string" | "comment" | "number" | "variable" | "type" };
type DiagnosticsResult = { findings: ExtensionDiagnostic[]; total: number };
type SyntaxResult = { tokens: SyntaxToken[] };

type Request = { text: string } & (
  { source: Extract<PreparedCodeExtension, { capability: "syntax" }>; path?: never }
  | { source: Extract<PreparedCodeExtension, { capability: "diagnostics" }>; path: string; config: unknown; limit: number }
);
type Response = DiagnosticsResult | SyntaxResult | { error: string };

export type { Request as ExtensionWorkerRequest, Response as ExtensionWorkerResponse };

type WorkerKind = "syntax" | "diagnostics";

class PooledWorker {
  private worker: Worker | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly create: () => Worker) {}

  run<T>(request: unknown, signal: AbortSignal, timeoutMs: number): Promise<T> {
    const task = this.queue.then(() => this.execute<T>(request, signal, timeoutMs));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private reset() {
    this.worker?.terminate();
    this.worker = null;
  }

  private execute<T>(request: unknown, signal: AbortSignal, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Extension run cancelled.", "AbortError"));
        return;
      }
      const worker = this.worker ?? (this.worker = this.create());
      let settled = false;
      const cleanup = (terminate: boolean) => {
        if (settled) return false;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        if (terminate) this.reset();
        return true;
      };
      const abort = () => {
        if (cleanup(true)) reject(new DOMException("Extension run cancelled.", "AbortError"));
      };
      const deadline = setTimeout(() => {
        if (cleanup(true)) reject(new Error("The extension timed out."));
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (event) => {
        if (cleanup(true)) reject(new Error(event.message || "The extension worker could not start."));
      };
      worker.onmessageerror = () => {
        if (cleanup(true)) reject(new Error("The extension worker returned an unreadable response."));
      };
      worker.onmessage = ({ data }: MessageEvent<Response>) => {
        if (!cleanup(false)) return;
        if (data && typeof data === "object" && "error" in data) reject(new Error(data.error));
        else resolve(data as T);
      };
      try {
        worker.postMessage(request);
      } catch (error) {
        if (cleanup(true)) reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

const pools: Record<WorkerKind, PooledWorker> = {
  syntax: new PooledWorker(() => new Worker(new URL("./code-extension-syntax.worker.ts", import.meta.url), { type: "module" })),
  diagnostics: new PooledWorker(() => new Worker(new URL("./code-extension-diagnostics.worker.ts", import.meta.url), { type: "module" })),
};

export async function runExtension(request: Request, signal: AbortSignal): Promise<DiagnosticsResult | SyntaxResult> {
  signal.throwIfAborted();
  const kind: WorkerKind = request.path === undefined ? "syntax" : "diagnostics";
  return pools[kind].run<DiagnosticsResult | SyntaxResult>(request, signal, 7_000);
}

export type ExtensionSyntax = { extension: CodeExtension; language: CodeExtensionLanguage };

export function findExtensionSyntax(extensions: CodeExtension[], path: string): ExtensionSyntax | undefined {
  const filename = path.split("/").at(-1) ?? path;
  const lower = filename.toLowerCase();
  for (const extension of extensions) {
    if (!extension.enabled || extension.capability !== "syntax") continue;
    const language = extension.languages.find((candidate) => candidate.filenames.includes(filename)
      || candidate.extensions.some((suffix) => lower.endsWith(suffix.toLowerCase()))
      || candidate.filenamePatterns.some((pattern) => pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")
        && filename.startsWith(pattern.slice(0, -1))));
    if (language) return { extension, language };
  }
}
