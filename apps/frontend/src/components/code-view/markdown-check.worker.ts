import { getVersion } from "markdownlint";
import { lint } from "markdownlint/sync";
import type { MarkdownRequest, MarkdownResponse } from "./code-review-checks";

self.addEventListener("message", ({ data }: MessageEvent<MarkdownRequest>) => {
  let result: MarkdownResponse;
  try {
    const findings = lint({ strings: { markdown: data.text }, config: data.config }).markdown;
    result = { version: getVersion(), findings: findings.slice(0, data.limit), total: findings.length };
  } catch {
    result = { failed: true };
  }
  self.postMessage(result);
});
