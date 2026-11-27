import { useEffect, useMemo, useState } from "react";
import type { CodeExtension, CodeExtensionPlatform, PreparedCodeExtension } from "../../platform/code-review";
import { findExtensionSyntax, runExtension, type SyntaxToken } from "./code-extension-runtime";
import type { ExtensionActivity } from "./CodeReviewExtensions";

const preparedSyntaxCache = new Map<string, Promise<Extract<PreparedCodeExtension, { capability: "syntax" }>>>();

function prepareSyntax(api: CodeExtensionPlatform, projectId: string, extension: CodeExtension, languageId: string) {
  const key = `${projectId}:${extension.id}:${extension.sha256}:${languageId}`;
  let pending = preparedSyntaxCache.get(key);
  if (!pending) {
    pending = api.prepare(projectId, extension.id, extension.sha256, languageId).then((source) => {
      if (source.capability !== "syntax") throw new Error("TextMate grammar unavailable.");
      return source;
    }).catch((error: unknown) => {
      preparedSyntaxCache.delete(key);
      throw error;
    });
    if (preparedSyntaxCache.size >= 32) preparedSyntaxCache.clear();
    preparedSyntaxCache.set(key, pending);
  }
  return pending;
}

export function useExtensionSyntax(api: CodeExtensionPlatform | undefined, items: CodeExtension[], projectId: string,
  path: string, text: string, onActivity?: (path: string, activity: ExtensionActivity) => void) {
  const syntax = useMemo(() => findExtensionSyntax(items, path), [items, path]);
  const extension = syntax?.extension;
  const language = syntax?.language;
  const [applied, setApplied] = useState<{ source: CodeExtension; path: string; text: string; tokens: SyntaxToken[] }>();
  useEffect(() => {
    if (!api || !extension || !language || !text || text.length > 512 * 1024) return;
    const controller = new AbortController();
    onActivity?.(path, { id: extension.id, state: "running" });
    void prepareSyntax(api, projectId, extension, language.id).then(async (source) => {
      const result = await runExtension({ source, text }, controller.signal);
      if (!("tokens" in result)) throw new Error("Missing tokenization result.");
      if (controller.signal.aborted) return;
      setApplied({ source: extension, text, path, tokens: result.tokens });
      onActivity?.(path, { id: extension.id, state: "ran" });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) onActivity?.(path, { id: extension.id, state: "failed", detail: String(error) });
    });
    return () => controller.abort();
  }, [api, extension, language, onActivity, path, projectId, text]);

  if (extension && language && applied?.source === extension && applied.path === path && applied.text === text) {
    return { name: language.aliases[0] ?? language.id, tokens: applied.tokens, extension: extension.id };
  }
}
