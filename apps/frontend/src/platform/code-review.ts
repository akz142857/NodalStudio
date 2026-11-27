export interface CodeReviewProject {
  id: string;
  key: string;
  name: string;
  baseline: string | null;
  git: "folder" | "ready" | "noBaseline" | "unavailable";
}

export interface CodeReviewChange {
  path: string;
  previousPath: string | null;
  kind: "added" | "modified" | "deleted" | "renamed" | "conflict";
  staged: boolean;
  indexOnly: boolean;
  evidence: string | null;
}

export interface CodeReviewChanges {
  files: CodeReviewChange[];
  limited: boolean;
}

export type CodeReviewCompactFolders = "visible" | "all";

export interface CodeReviewDirectory {
  entries: { name: string; path: string; directory: boolean; compactSegments?: string[] }[];
  limited: boolean;
}

export type CodeReviewVersion = { state: "text"; text: string }
  | { state: "missing" | "binary" | "encoding" | "tooLarge" | "unreadable" };

export interface CodeReviewDocument {
  before: CodeReviewVersion | null;
  after: CodeReviewVersion;
  evidence: string | null;
  indexOnly: boolean;
}

export interface CodeDefinitionPosition {
  line: number;
  character: number;
}

export interface CodeSearchMatch extends CodeDefinitionPosition {
  before: string;
  matched: string;
  after: string;
}

export interface CodeContentSearchResult {
  files: { path: string; matches: CodeSearchMatch[] }[];
  limited: boolean;
}

export interface CodeSourcePosition {
  origin: { kind: "workspace"; path: string } | { kind: "dependency"; id: string };
  position: CodeDefinitionPosition;
  text: string;
}

export interface CodeDefinitionRequest extends CodeSourcePosition {
  enable: boolean;
}

export interface CodeDocumentHighlightRange {
  start: CodeDefinitionPosition;
  end: CodeDefinitionPosition;
}

export interface CodeDocumentOutlineRequest extends Omit<CodeSourcePosition, "position"> {
  enable: boolean;
}

export interface CodeOutlineSymbol {
  name: string;
  kind: number;
  position: CodeDefinitionPosition;
  children: CodeOutlineSymbol[];
}

export type CodeDocumentOutlineResult =
  | { state: "disabled" | "unavailable" | "stale" }
  | { state: "missingServer" | "serverFailed"; command: string }
  | { state: "ready"; symbols: CodeOutlineSymbol[] };

export interface CodeDefinitionTarget {
  path: string;
  sourceId?: string;
  position: CodeDefinitionPosition;
}

export type CodeDefinitionResult =
  | { state: "disabled" | "unsupported" | "stale" | "unavailable" | "notFound" }
  | { state: "missingServer"; command: string }
  | { state: "resolved"; targets: CodeDefinitionTarget[] };

export interface CodeEslintTool {
  toolId: string;
  context: string;
  node: string;
  entry: string;
  config: string;
  cwd: string;
  version: string;
  approved: boolean;
}

export interface CodeEslintFinding {
  ruleId: string | null;
  severity: number;
  fatal: boolean | null;
  message: string;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
}

export interface CodeEslintPlatform {
  inspect(projectId: string, path: string): Promise<CodeEslintTool>;
  approve(projectId: string, path: string, toolId: string): Promise<void>;
  lint(projectId: string, input: {
    requestId: string;
    path: string;
    compare: boolean;
    evidence: string | null;
    digest: string;
    context: string;
    limit: number;
  }): Promise<{ ignored: boolean; findings: CodeEslintFinding[]; total: number }>;
  cancel(projectId: string, requestId: string): Promise<void>;
  revoke(projectId: string): Promise<void>;
}

export interface CodeReviewPlatform {
  current(): Promise<CodeReviewProject | null>;
  choose(): Promise<CodeReviewProject | null>;
  changes(projectId: string): Promise<CodeReviewChanges>;
  directory(projectId: string, path: string, compact?: CodeReviewCompactFolders): Promise<CodeReviewDirectory>;
  paths?(projectId: string): Promise<{ paths: string[]; limited: boolean }>;
  searchContent?(projectId: string, query: string): Promise<CodeContentSearchResult>;
  file(projectId: string, path: string, compareFile: boolean): Promise<CodeReviewDocument>;
  eslint?: CodeEslintPlatform;
  extensions?: CodeExtensionPlatform;
  definition?(projectId: string, input: CodeDefinitionRequest): Promise<CodeDefinitionResult>;
  documentHighlights?(projectId: string, input: CodeSourcePosition): Promise<CodeDocumentHighlightRange[]>;
  documentOutline?(projectId: string, input: CodeDocumentOutlineRequest): Promise<CodeDocumentOutlineResult>;
  definitionSource?(projectId: string, sourceId: string): Promise<string>;
}

export interface CodeExtensionLanguage {
  id: string;
  aliases: string[];
  filenames: string[];
  filenamePatterns: string[];
  extensions: string[];
}

export interface CodeExtension {
  id: string;
  name: string;
  publisher: string;
  version: string;
  description: string;
  fileName: string;
  sha256: string;
  engine: string;
  capability: "diagnostics" | "syntax" | "unsupported";
  enabled: boolean;
  languages: CodeExtensionLanguage[];
}

export type CodeExtensionAction = "enable" | "disable" | "uninstall";

export type PreparedCodeExtension =
  | { capability: "diagnostics"; script: string }
  | { capability: "syntax"; grammar: string; scopeName: string };

export interface CodeExtensionPlatform {
  list(projectId: string): Promise<CodeExtension[]>;
  install(projectId: string): Promise<CodeExtension | null>;
  change(projectId: string, id: string, action: CodeExtensionAction): Promise<CodeExtension | null>;
  prepare(projectId: string, id: string, language: string): Promise<PreparedCodeExtension>;
}
