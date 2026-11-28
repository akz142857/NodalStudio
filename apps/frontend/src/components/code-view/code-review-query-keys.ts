import type { CodeChangeComparison, CodeReviewCompactFolders } from "../../platform/code-review";

export const codeReviewKeys = {
  all: ["code-review"] as const,
  current: ["code-review", "current"] as const,
  projects: ["code-review", "projects"] as const,
  project: (projectId: string) => ["code-review", projectId] as const,
  changes: (projectId: string) => ["code-review", projectId, "changes"] as const,
  directory: (projectId: string, path: string, compact?: CodeReviewCompactFolders) =>
    ["code-review", projectId, "directory", path, compact ?? null] as const,
  directories: (projectId: string) => ["code-review", projectId, "directory"] as const,
  paths: (projectId: string) => ["code-review", projectId, "paths"] as const,
  contentRoot: (projectId: string) => ["code-review", projectId, "content"] as const,
  content: (projectId: string, query: string) => ["code-review", projectId, "content", query] as const,
  files: (projectId: string) => ["code-review", projectId, "file"] as const,
  file: (projectId: string, path: string, compare: boolean, evidence?: string | null, comparison?: CodeChangeComparison) =>
    ["code-review", projectId, "file", path, compare, compare ? (evidence ?? null) : null, comparison ?? null] as const,
  extensions: (projectId: string) => ["code-review", projectId, "extensions"] as const,
  syntaxCatalog: ["code-review", "syntax-catalog"] as const,
  openVsx: (projectId: string) => ["code-review", projectId, "open-vsx"] as const,
  openVsxSearch: (projectId: string, query: string) => ["code-review", projectId, "open-vsx", "search", query] as const,
  languages: (projectId: string) => ["code-review", projectId, "languages"] as const,
  outlines: (projectId: string) => ["code-review", projectId, "outline"] as const,
  outline: (projectId: string, path: string, updatedAt: number, mode: string) =>
    ["code-review", projectId, "outline", path, updatedAt, mode] as const,
  pythonDebugLaunch: (projectId: string, path?: string) =>
    ["code-review", projectId, "python-debug-launch", path ?? null] as const,
};
