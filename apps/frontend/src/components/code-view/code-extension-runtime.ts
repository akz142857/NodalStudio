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

export async function runExtension(request: Request, signal: AbortSignal) {
  return new Promise<DiagnosticsResult | SyntaxResult>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./code-extension.worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      clearTimeout(deadline);
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { finish(); reject(new DOMException("Extension run cancelled.", "AbortError")); };
    const deadline = setTimeout(() => { finish(); reject(new Error("The extension timed out.")); }, 7_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The extension worker could not start."));
    };
    worker.onmessage = ({ data }: MessageEvent<Response>) => {
      finish();
      if ("error" in data) reject(new Error(data.error));
      else resolve(data);
    };
    try { worker.postMessage(request); }
    catch (error) { finish(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
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
