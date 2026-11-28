import { Chunk, type DiffConfig } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import type { Configuration, LintError } from "markdownlint";
import type { CodeChangeComparison, CodeEslintFinding, CodeExtension, CodeReviewDocument, CodeReviewPlatform, CodeReviewVersion } from "../../platform/code-review";
import type { ExtensionDiagnostic } from "./code-extension-runtime";

export const reviewDiffConfig: DiffConfig = { scanLimit: 500 };
export const reviewDiffCollapse = { margin: 4, minSize: 10 };
export const markdownConfigPath = ".markdownlint.json";
export const normalizeReviewText = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
export const isEslintSource = (path: string) => /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(path);
export function canCheckWithExtension(extension: CodeExtension, path: string) {
  return extension.enabled && ((extension.capability === "diagnostics" && isMarkdown(path))
    || (extension.capability === "eslint" && isEslintSource(path)));
}
export const eslintExtensionSha = (extension?: CodeExtension) => extension?.capability === "eslint" ? extension.sha256 : undefined;
export type EslintAvailability = "enabled" | "eslintOffline" | "eslintUnavailable";

export type ReadingMode = "diff" | "source";
export type CheckTarget = { path: string; mode: ReadingMode; evidence: string | null; indexOnly: boolean; comparison?: CodeChangeComparison };
export type CheckRange = { line: number; column?: number; length?: number; endLine?: number; endColumn?: number };
export type CheckFinding = {
  rule: string;
  message: string;
  severity: "error" | "warning";
  range?: CheckRange;
  location: "changed" | "other" | "unknown" | "file";
};
export type CheckProblem = "deleted" | "dependency" | "unsupported" | "unreadable" | "binary" | "encoding" | "tooLarge"
  | "noEvidence" | "stale" | "config" | "configUnsupported" | "engine" | "timeout" | "extensionEngine"
  | "eslintOffline" | "eslintUnavailable" | "eslintConfig" | "eslintMissing" | "eslintUnsupported" | "eslintNode"
  | "eslintApproval" | "eslintOutput" | "eslintEngine" | "eslintIgnored" | "eslintIndex" | "eslintCancelled";
export class CheckError extends Error {
  constructor(readonly reason: CheckProblem) { super(reason); }
}
export type MarkdownRequest = { text: string; config?: Configuration; limit: number };
export type MarkdownResponse = { version: string; findings: LintError[]; total: number } | { failed: true };

export function checkTargetProblem(target: CheckTarget, version: CodeReviewVersion, dependency: boolean): CheckProblem | undefined {
  if (dependency) return "dependency";
  if (!isMarkdown(target.path) && !isEslintSource(target.path)) return "unsupported";
  if (version.state === "missing") return "deleted";
  if (version.state !== "text") return version.state;
  if (target.mode === "diff" && !target.evidence) return "noEvidence";
  if (target.indexOnly && isEslintSource(target.path)) return "eslintIndex";
}

export async function contentDigest(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readMarkdownConfig(api: CodeReviewPlatform, projectId: string) {
  const { after } = await api.file(projectId, markdownConfigPath, false).catch(() => { throw new CheckError("config"); });
  if (after.state === "missing") return { digest: null };
  if (after.state !== "text") throw new CheckError("config");
  const text = normalizeReviewText(after.text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new CheckError("config"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CheckError("config");
  for (const [key, value] of Object.entries(parsed)) {
    const name = key.toLowerCase();
    if (["extends", "customrules", "plugins", "__proto__", "constructor", "prototype"].includes(name)) {
      throw new CheckError("configUnsupported");
    }
    if (name === "$schema" || name === "comment") {
      if (typeof value !== "string") throw new CheckError("config");
    } else if (typeof value !== "boolean" && value !== "error" && value !== "warning"
      && (!value || typeof value !== "object" || Array.isArray(value) || name === "default")) {
      throw new CheckError("config");
    }
  }
  return { value: parsed as Configuration, digest: await contentDigest(text) };
}

export function targetMatchesDocument(target: CheckTarget, document: CodeReviewDocument) {
  return target.mode === "source" ? !document.indexOnly
    : Boolean(target.evidence && target.evidence === document.evidence && target.indexOnly === document.indexOnly);
}

function classifyFindings(text: string, before: CodeReviewVersion | null, findings: Omit<CheckFinding, "location">[]): CheckFinding[] {
  const doc = Text.of(text.split("\n"));
  const chunks = before?.state === "text"
    ? Chunk.build(Text.of(normalizeReviewText(before.text).split("\n")), doc, reviewDiffConfig) : [];
  const intervals = chunks.flatMap((chunk) => chunk.fromB === chunk.toB ? [] : [{
    from: doc.lineAt(Math.min(doc.length, chunk.fromB)).number,
    to: chunk.toB > doc.length ? doc.lines : doc.lineAt(chunk.toB - 1).number,
    precise: chunk.precise,
  }]);
  return findings.map((finding) => {
    if (!finding.range) return { ...finding, location: "file" };
    const from = finding.range.line + 1;
    const to = finding.range.endLine === undefined ? from
      : Math.max(from, finding.range.endLine + (finding.range.endColumn === 0 ? 0 : 1));
    const overlaps = intervals.filter((interval) => interval.from <= to && from <= interval.to);
    const location = before?.state === "missing" || overlaps.some((interval) => interval.precise) ? "changed"
      : overlaps.length || before?.state !== "text" ? "unknown" : "other";
    return { ...finding, location };
  });
}

export function markdownFindings(text: string, before: CodeReviewVersion | null, errors: LintError[]): CheckFinding[] {
  const doc = Text.of(text.split("\n"));
  return classifyFindings(text, before, errors.map((error) => {
    const { lineNumber, errorRange } = error;
    let range: CheckRange | undefined;
    if (Number.isInteger(lineNumber) && lineNumber > 0 && lineNumber <= doc.lines) {
      range = { line: lineNumber - 1 };
      if (errorRange) {
        const [column, length] = errorRange;
        const line = doc.line(lineNumber);
        if (Number.isInteger(column) && Number.isInteger(length) && column > 0 && length >= 0
          && column - 1 + length <= line.length) {
          range.column = column - 1;
          range.length = length;
        }
      }
    }
    return {
      rule: error.ruleNames[0],
      message: error.errorDetail ? `${error.ruleDescription} · ${error.errorDetail}` : error.ruleDescription,
      severity: error.severity === "warning" ? "warning" : "error",
      range,
    };
  }));
}

export function eslintFindings(text: string, before: CodeReviewVersion | null, findings: CodeEslintFinding[]): CheckFinding[] {
  const doc = Text.of(text.split("\n"));
  return classifyFindings(text, before, findings.map((finding) => {
    const { line, column, endLine, endColumn } = finding;
    let range: CheckRange | undefined;
    if (line !== null && Number.isInteger(line) && line > 0 && line <= doc.lines) {
      range = { line: line - 1 };
      if (column !== null && Number.isInteger(column) && column > 0 && column <= doc.line(line).length + 1) {
        range.column = column - 1;
        if (endLine !== null && endColumn !== null && Number.isInteger(endLine) && Number.isInteger(endColumn)
          && endLine >= line && endLine <= doc.lines && endColumn <= doc.line(endLine).length + 1
          && endColumn >= (endLine === line ? column : 1)) {
          range.endLine = endLine - 1;
          range.endColumn = endColumn - 1;
        }
      }
    }
    return { rule: finding.ruleId ?? (finding.fatal ? "Parse" : "ESLint"),
      severity: finding.severity === 1 ? "warning" : "error", message: finding.message, range };
  }));
}

export function extensionFindings(text: string, before: CodeReviewVersion | null, findings: ExtensionDiagnostic[]) {
  return eslintFindings(text, before, findings.map((finding) => ({
    ruleId: finding.rule, message: finding.message, severity: finding.severity === "error" ? 2 : 1, fatal: null,
    line: finding.start ? finding.start.line + 1 : null, column: finding.start ? finding.start.character + 1 : null,
    endLine: finding.end ? finding.end.line + 1 : null, endColumn: finding.end ? finding.end.character + 1 : null,
  })));
}

let markdownWorker: Worker | null = null;
let markdownQueue: Promise<void> = Promise.resolve();

export function checkMarkdown(request: MarkdownRequest, signal: AbortSignal): Promise<MarkdownResponse> {
  const task = markdownQueue.then(() => new Promise<MarkdownResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Check cancelled", "AbortError"));
      return;
    }
    const worker = markdownWorker ?? (markdownWorker = new Worker(new URL("./markdown-check.worker.ts", import.meta.url), { type: "module" }));
    let settled = false;
    function finish(terminate: boolean, complete: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      if (terminate) {
        worker.terminate();
        if (markdownWorker === worker) markdownWorker = null;
      }
      complete();
    }
    const timeout = setTimeout(() => finish(true, () => reject(new CheckError("timeout"))), 5_000);
    function abort() { finish(true, () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("Check cancelled", "AbortError"))); }
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<MarkdownResponse>) => finish(false, () => resolve(event.data));
    const workerFailed = () => finish(true, () => reject(new CheckError("engine")));
    worker.onerror = workerFailed;
    worker.onmessageerror = workerFailed;
    try { worker.postMessage(request); }
    catch { finish(true, () => reject(new CheckError("engine"))); }
  }));
  markdownQueue = task.then(() => undefined, () => undefined);
  return task;
}
