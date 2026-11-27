import { useCallback, useEffect, useRef, useState } from "react";
import type { CodeEslintTool, CodeExtension, CodeReviewChanges, CodeReviewPlatform, CodeReviewProject } from "../../platform/code-review";
import {
  canCheckWithExtension, checkMarkdown, CheckError, checkTargetProblem, contentDigest, eslintExtensionSha, eslintFindings,
  extensionFindings, isEslintSource, isMarkdown, markdownFindings,
  normalizeReviewText, readMarkdownConfig, targetMatchesDocument, type CheckFinding, type CheckProblem,
  type CheckTarget, type EslintAvailability,
} from "./code-review-checks";
import { runExtension } from "./code-extension-runtime";

export type DisplayedCheckTarget = {
  target: CheckTarget;
  text: string;
  problem?: CheckProblem;
};

export type CheckedFile = {
  target: CheckTarget;
  status: "pending" | "checked" | "skipped" | "failed" | "stale";
  reason?: CheckProblem;
  digest?: string;
  provider?: string;
  version?: string;
  tool?: CodeEslintTool;
  findings: CheckFinding[];
  total: number;
};
export type CheckRun = {
  id: number;
  projectId: string;
  baseline: string | null;
  scope: "file" | "changes";
  startedAt: number;
  status: "running" | "finished" | "cancelled";
  incompleteChanges: boolean;
  limited: boolean;
  reason?: CheckProblem;
  configDigest?: string | null;
  version?: string;
  extension?: CodeExtension;
  extensionError?: string;
  files: CheckedFile[];
};

const maxCheckFileBytes = 512 * 1024;
const maxCheckFindings = 2_000;
const maxBatchFiles = 200;
const maxBatchBytes = 16 * 1024 * 1024;
const problem = (error: unknown): CheckProblem => error instanceof CheckError ? error.reason : "engine";
const eslintReasons: CheckProblem[] = ["eslintOffline", "eslintConfig", "eslintMissing", "eslintUnsupported", "eslintNode",
  "eslintApproval", "eslintOutput", "eslintEngine", "eslintIndex", "eslintCancelled", "timeout"];
function eslintError(error: unknown): CheckError {
  const reason = String(error);
  return new CheckError(reason === "codeReviewStale" ? "stale"
    : eslintReasons.find((code) => code === reason) ?? "eslintEngine");
}

async function readTarget(api: CodeReviewPlatform, projectId: string, target: CheckTarget, resolveIndex = false) {
  const document = await api.file(projectId, target.path, target.mode === "diff").catch((error: unknown) => {
    throw new CheckError(String(error).includes("codeReviewStale") ? "stale" : "unreadable");
  });
  const resolved = resolveIndex ? { ...target, indexOnly: document.indexOnly } : target;
  const reason = checkTargetProblem(target, document.after, false);
  if (reason) throw new CheckError(reason);
  if (!targetMatchesDocument(resolved, document)) throw new CheckError("stale");
  const text = document.after.state === "text" ? normalizeReviewText(document.after.text) : "";
  return { document, text, target: resolved, size: new TextEncoder().encode(text).byteLength };
}

function pending(target: CheckTarget): CheckedFile {
  return { target, status: "pending", findings: [], total: 0 };
}

export function useCodeReviewChecks(api: CodeReviewPlatform, { id: projectId, baseline }: CodeReviewProject, availability: EslintAvailability) {
  const [run, setRun] = useState<CheckRun>();
  const [filter, setFilter] = useState<{ id: number; value: "changed" | "all" }>();
  const [consent, setConsent] = useState<{ tool: CodeEslintTool; decide: (approved: boolean) => void }>();
  const [eslintApproval, setEslintApproval] = useState<{ builtin: boolean; extensionId?: string }>({ builtin: false });
  const eslint = availability === "enabled" ? api.eslint : undefined;
  const active = useRef<AbortController | null>(null);
  const activeExtension = useRef<string | undefined>(undefined);
  const epoch = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      active.current?.abort();
    };
  }, []);

  function requestConsent(tool: CodeEslintTool, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      signal.throwIfAborted();
      function abort() { decide(false); }
      function decide(approved: boolean) {
        signal.removeEventListener("abort", abort);
        if (mounted.current) setConsent((current) => current?.decide === decide ? undefined : current);
        resolve(approved);
      }
      signal.addEventListener("abort", abort, { once: true });
      setConsent({ tool, decide });
    });
  }

  const runChecks = async (initial: CheckedFile[], displayed?: string, incompleteChanges = false, extension?: CodeExtension) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    activeExtension.current = extension?.id;
    const batch = displayed === undefined;
    const extensionSha256 = eslintExtensionSha(extension);
    const snapshot: CheckRun = {
      id: ++epoch.current, projectId, baseline, scope: batch ? "changes" : "file", startedAt: Date.now(),
      status: "running", incompleteChanges, limited: false, files: initial, extension,
    };
    const files = [...initial];
    const publish = (status = snapshot.status) => {
      if (active.current === controller && mounted.current) setRun({ ...snapshot, status, files: [...files] });
    };
    let candidates = 0;
    let bytes = 0;
    let retained = 0;
    let timeBudget = 60_000;
    let timerStarted = performance.now();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const resumeDeadline = () => {
      if (!batch) return;
      timerStarted = performance.now();
      deadline = setTimeout(() => controller.abort(new CheckError("timeout")), timeBudget);
    };
    resumeDeadline();
    const declined = new Set<string>();
    publish();
    try {
      if (files.every((file) => file.status !== "pending")) return;
      let markdownConfig: Awaited<ReturnType<typeof readMarkdownConfig>> | CheckError | undefined;
      for (const [index, file] of files.entries()) {
        if (file.status !== "pending") continue;
        if (++candidates > maxBatchFiles) {
          snapshot.limited = true;
          break;
        }
        try {
          const input = await readTarget(api, projectId, file.target, batch);
          controller.signal.throwIfAborted();
          if (!batch && input.text !== normalizeReviewText(displayed)) throw new CheckError("stale");
          if (input.size > maxCheckFileBytes) throw new CheckError("tooLarge");
          if (bytes + input.size > maxBatchBytes) {
            snapshot.limited = true;
            break;
          }
          bytes += input.size;
          const digest = await contentDigest(input.text);
          const before = input.target.mode === "diff" ? input.document.before : null;
          const limit = maxCheckFindings - retained;
          let checked: Pick<CheckedFile, "provider" | "version" | "findings" | "total" | "tool">;
          if (isMarkdown(file.target.path)) {
            markdownConfig ??= await readMarkdownConfig(api, projectId).catch((error: unknown) => new CheckError(problem(error)));
            if (markdownConfig instanceof CheckError) throw markdownConfig;
            snapshot.configDigest = markdownConfig.digest;
            if (extension) {
              try {
                const source = await api.extensions?.prepare(projectId, extension.id, extension.sha256, "markdown");
                if (source?.capability !== "diagnostics") throw new Error("Diagnostic entry unavailable.");
                const result = await runExtension({
                  source, path: input.target.path, text: input.text, config: markdownConfig.value, limit,
                }, controller.signal);
                if (!("findings" in result)) throw new Error("Missing diagnostic result.");
                checked = { provider: extension.name + " (VSIX)", version: extension.version,
                  findings: extensionFindings(input.text, before, result.findings), total: result.total };
              } catch (error) {
                snapshot.extensionError = String(error);
                throw new CheckError("extensionEngine");
              }
            } else {
              const result = await checkMarkdown({ text: input.text, config: markdownConfig.value, limit }, controller.signal);
              if ("failed" in result) throw new CheckError("engine");
              checked = { provider: "markdownlint", version: result.version, findings: markdownFindings(input.text, before, result.findings), total: result.total };
              snapshot.version = result.version;
            }
          } else {
            if (!eslint) throw new CheckError(availability === "enabled" ? "eslintUnavailable" : availability);
            const path = input.target.path;
            const tool = await eslint.inspect(projectId, path, extensionSha256).catch((error: unknown) => { throw eslintError(error); });
            controller.signal.throwIfAborted();
            if (!tool.approved) {
              if (declined.has(tool.toolId)) throw new CheckError("eslintApproval");
              clearTimeout(deadline);
              timeBudget = Math.max(0, timeBudget - (performance.now() - timerStarted));
              const approved = await requestConsent(tool, controller.signal);
              controller.signal.throwIfAborted();
              resumeDeadline();
              if (!approved) {
                declined.add(tool.toolId);
                throw new CheckError("eslintApproval");
              }
              await eslint.approve(projectId, path, tool.toolId, extensionSha256).catch((error: unknown) => { throw eslintError(error); });
            }
            controller.signal.throwIfAborted();
            setEslintApproval((current) => extensionSha256
              ? { ...current, extensionId: extension?.id }
              : { ...current, builtin: true });
            const requestId = crypto.randomUUID();
            const cancelRequest = () => { void eslint.cancel(projectId, requestId).catch(() => {}); };
            controller.signal.addEventListener("abort", cancelRequest, { once: true });
            try {
              const result = await eslint.lint(projectId, {
                requestId, path, compare: input.target.mode === "diff", evidence: input.target.evidence,
                digest, context: tool.context, limit, extensionSha256,
              }).catch((error: unknown) => { throw eslintError(error); });
              if (result.ignored) throw new CheckError("eslintIgnored");
              checked = { provider: extensionSha256 ? (extension?.name ?? "ESLint") + " (VSIX)" : "ESLint",
                version: extensionSha256 ? extension?.version : tool.version, tool,
                findings: eslintFindings(input.text, before, result.findings), total: result.total };
            } finally {
              controller.signal.removeEventListener("abort", cancelRequest);
            }
          }
          const latest = await readTarget(api, projectId, input.target);
          if (latest.text !== input.text) throw new CheckError("stale");
          if (checked.tool && eslint
            && (await eslint.inspect(projectId, input.target.path, extensionSha256).catch(() => undefined))?.context !== checked.tool.context) {
            throw new CheckError("stale");
          }
          controller.signal.throwIfAborted();
          retained += checked.findings.length;
          files[index] = { target: input.target, status: "checked", digest, ...checked };
        } catch (error) {
          controller.signal.throwIfAborted();
          const reason = problem(error);
          const skipped = ["binary", "encoding", "tooLarge", "noEvidence", "deleted", "eslintIgnored", "eslintIndex",
            "eslintApproval", "eslintOffline", "eslintUnavailable"].includes(reason);
          files[index] = { ...file, status: skipped ? "skipped" : reason === "stale" ? "stale" : "failed", reason };
        }
        publish();
      }
      if (markdownConfig && !(markdownConfig instanceof CheckError)) {
        const latestConfig = await readMarkdownConfig(api, projectId).catch(() => null);
        controller.signal.throwIfAborted();
        if (latestConfig?.digest === markdownConfig.digest) return;
        for (const [index, file] of files.entries()) {
          if (file.status === "checked" && (extension || file.provider === "markdownlint")) {
            files[index] = { ...file, status: "stale", reason: "stale" };
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted || controller.signal.reason instanceof CheckError) snapshot.reason = problem(error);
    } finally {
      clearTimeout(deadline);
      if (!controller.signal.aborted || controller.signal.reason instanceof CheckError) publish("finished");
      if (active.current === controller) {
        active.current = null;
        activeExtension.current = undefined;
      }
    }
  };

  const currentFile = ({ target, text, problem: unavailable }: DisplayedCheckTarget, extension?: CodeExtension) => {
    if (!unavailable && (!extension || canCheckWithExtension(extension, target.path))) {
      void runChecks([pending(target)], text, false, extension);
    }
  };

  const clearExtension = (id: string) => {
    if (activeExtension.current === id) active.current?.abort();
    if (run?.extension?.id === id && run.id === epoch.current) epoch.current += 1;
    setRun((current) => current?.extension?.id === id ? undefined : current);
    setEslintApproval((current) => current.extensionId === id ? { builtin: current.builtin } : current);
  };

  const changedFiles = (changes: CodeReviewChanges) => {
    const files = changes.files.map((change): CheckedFile => {
      const file = pending({ path: change.path, mode: "diff", evidence: change.evidence, indexOnly: change.indexOnly });
      const reason = change.kind === "deleted" ? "deleted" : !isMarkdown(change.path)
        ? !isEslintSource(change.path) || !api.eslint ? "unsupported" : !eslint && availability !== "enabled" ? availability : undefined
        : undefined;
      return reason ? { ...file, status: "skipped", reason } : file;
    });
    void runChecks(files, undefined, changes.limited);
  };

  const cancel = () => {
    active.current?.abort();
    setRun((current) => current?.status === "running" ? { ...current, status: "cancelled" } : current);
  };

  const revoke = async () => {
    if (!api.eslint) return;
    cancel();
    await api.eslint.revoke(projectId);
    setEslintApproval({ builtin: false });
    setRun((current) => current && {
      ...current,
      files: current.files.map((file) => file.tool && file.status === "checked"
        ? { ...file, status: "stale", reason: "eslintApproval" } : file),
    });
  };

  const verify = useCallback(async (file: CheckedFile, snapshot: CheckRun, cachedMarkdownConfig?: Promise<string | null | undefined>) => {
    if (file.status !== "checked" || snapshot.id !== epoch.current || snapshot.projectId !== projectId
      || snapshot.baseline !== baseline || !mounted.current) return;
    try {
      const latest = await readTarget(api, projectId, file.target);
      if (await contentDigest(latest.text) !== file.digest) throw new CheckError("stale");
      if (file.tool) {
        const tool = await eslint?.inspect(projectId, file.target.path, eslintExtensionSha(snapshot.extension));
        if (!tool?.approved || tool.context !== file.tool.context) throw new CheckError("stale");
      } else {
        const digest = cachedMarkdownConfig ? await cachedMarkdownConfig : (await readMarkdownConfig(api, projectId)).digest;
        if (digest !== snapshot.configDigest) throw new CheckError("stale");
      }
      if (mounted.current && epoch.current === snapshot.id) return latest;
    } catch {
      if (mounted.current) setRun((current) => current?.id === snapshot.id ? {
        ...current, files: current.files.map((item) => item === file ? { ...item, status: "stale", reason: "stale" } : item),
      } : current);
    }
  }, [api, baseline, eslint, projectId]);

  const verifyAll = useCallback(async (snapshot: CheckRun, signal?: AbortSignal) => {
    if (snapshot.status === "running" || snapshot.id !== epoch.current) return;
    const hasMarkdown = snapshot.files.some((file) => file.status === "checked" && !file.tool);
    const cachedConfig = hasMarkdown
      ? readMarkdownConfig(api, projectId).then((config) => config.digest, () => undefined)
      : undefined;
    for (const file of snapshot.files) {
      if (signal?.aborted || snapshot.id !== epoch.current) return;
      if (file.status === "checked") await verify(file, snapshot, cachedConfig);
    }
  }, [api, projectId, verify]);

  return { run, currentFile, changedFiles, cancel, clearExtension, verify, verifyAll, filter, setFilter, consent, revoke,
    eslintApproved: eslintApproval.builtin || Boolean(eslintApproval.extensionId),
    eslintAvailable: Boolean(eslint) };
}

export type CodeChecks = ReturnType<typeof useCodeReviewChecks>;
