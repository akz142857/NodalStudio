export interface CodeReviewProject {
  id: string;
  savedProjectId?: string | null;
  key: string;
  name: string;
  baseline: string | null;
  git: "folder" | "ready" | "noBaseline" | "unavailable";
}

export interface CodeSavedProject {
  id: string;
  name: string;
  path: string;
  pinned: boolean;
  groupId?: string | null;
}

export interface CodeSavedProjectGroup {
  id: string;
  name: string;
  collapsed: boolean;
  color?: CodeProjectGroupColor | null;
}

export type CodeProjectGroupColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface CodeProjectCatalog {
  projects: CodeSavedProject[];
  groups: CodeSavedProjectGroup[];
}

export type CodeProjectGroupAction =
  | { kind: "create"; name: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "remove"; id: string }
  | { kind: "collapse"; id: string; collapsed: boolean }
  | { kind: "color"; id: string; color: CodeProjectGroupColor | null }
  | { kind: "move"; projectId: string; groupId: string | null };

export interface CodeProjectLibrary {
  list(): Promise<CodeProjectCatalog>;
  editGroups(input: CodeProjectGroupAction): Promise<void>;
  open(id: string): Promise<CodeReviewProject>;
  pin(id: string, pinned: boolean): Promise<void>;
  relocate(id: string): Promise<CodeReviewProject | null>;
  remove(id: string): Promise<CodeReviewProject | null>;
}

export type CodeFinderTarget =
  | { kind: "project"; id: string }
  | { kind: "entry" | "worktree"; projectId: string; path: string }
  | { kind: "dependency"; projectId: string; sourceId: string };
export type CodeFinderAction = "reveal" | "copy" | "paste";
export interface CodePasteResult {
  added: number;
  skipped: number;
}

export type CodeChangeComparison = "staged" | "unstaged";

export interface CodeReviewChange {
  path: string;
  previousPath: string | null;
  kind: "added" | "modified" | "deleted" | "renamed" | "conflict";
  staged: boolean;
  indexOnly: boolean;
  evidence: string | null;
  comparison?: CodeChangeComparison;
}

export interface CodeReviewGit {
  branch: string | null;
  head?: string | null;
  baseline: string | null;
  baselineChanged: boolean;
  indexRevision: string;
  worktrees?: CodeReviewWorktree[];
}

export interface CodeReviewWorktree {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  primary: boolean;
  current: boolean;
}

export interface CodeBranchChanges {
  target: string;
  base: string;
  head: string;
  files: CodeReviewChange[];
  limited: boolean;
}

export interface CodeIndexChange {
  path: string;
  comparison: CodeChangeComparison;
  evidence: string;
  indexRevision: string;
}

export interface CodeReviewChanges {
  files: CodeReviewChange[];
  limited: boolean;
  localLimited?: boolean;
  git?: CodeReviewGit | null;
  staged?: CodeReviewChange[];
  unstaged?: CodeReviewChange[];
  previousFiles?: CodeReviewChange[] | null;
  previousStaged?: CodeReviewChange[] | null;
  previousLimited?: boolean;
  branchChanges?: CodeBranchChanges | null;
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
  executableChangedTo?: boolean;
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
  | { state: "offline" | "disabled" | "unavailable" | "stale" }
  | { state: "missingServer" | "serverFailed"; command: string }
  | { state: "ready"; symbols: CodeOutlineSymbol[] };

export interface CodeDefinitionTarget {
  path: string;
  sourceId?: string;
  position: CodeDefinitionPosition;
}

export type CodeDefinitionResult =
  | { state: "offline" | "disabled" | "unsupported" | "stale" | "unavailable" | "notFound" }
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
  extension?: { entry: string; version: string };
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
  inspect(projectId: string, path: string, extensionSha256?: string): Promise<CodeEslintTool>;
  approve(projectId: string, path: string, toolId: string, extensionSha256?: string): Promise<void>;
  lint(projectId: string, input: {
    requestId: string;
    path: string;
    compare: boolean;
    comparison?: CodeChangeComparison;
    evidence: string | null;
    digest: string;
    context: string;
    limit: number;
    extensionSha256?: string;
  }): Promise<{ ignored: boolean; findings: CodeEslintFinding[]; total: number }>;
  cancel(projectId: string, requestId: string): Promise<void>;
  revoke(projectId: string): Promise<void>;
}

export type CodeNewEntryKind = "file" | "folder";

export interface CodeReviewPlatform {
  current(): Promise<CodeReviewProject | null>;
  choose(): Promise<CodeReviewProject | null>;
  projects?: CodeProjectLibrary;
  finder?: {
    act(target: CodeFinderTarget, action: CodeFinderAction): Promise<CodePasteResult>;
    addProjects(): Promise<CodePasteResult>;
  };
  changes(projectId: string): Promise<CodeReviewChanges>;
  switchWorktree?(projectId: string, path: string): Promise<CodeReviewProject>;
  branchFile?(projectId: string, path: string): Promise<CodeReviewDocument>;
  updateBaseline?(this: void, projectId: string): Promise<CodeReviewChanges>;
  changeIndex?(projectId: string, input: CodeIndexChange): Promise<void>;
  directory(projectId: string, path: string, compact?: CodeReviewCompactFolders): Promise<CodeReviewDirectory>;
  createEntry?(projectId: string, directory: string, name: string, kind: CodeNewEntryKind): Promise<string>;
  paths?(this: void, projectId: string): Promise<{ paths: string[]; limited: boolean }>;
  searchContent?(projectId: string, query: string): Promise<CodeContentSearchResult>;
  file(projectId: string, path: string, compareFile: boolean, comparison?: CodeChangeComparison, previous?: boolean): Promise<CodeReviewDocument>;
  eslint?: CodeEslintPlatform;
  extensions?: CodeExtensionPlatform;
  pythonDebug?: PythonDebugPlatform;
  definition?(projectId: string, input: CodeDefinitionRequest): Promise<CodeDefinitionResult>;
  documentHighlights?(projectId: string, input: CodeSourcePosition): Promise<CodeDocumentHighlightRange[]>;
  documentOutline?(projectId: string, input: CodeDocumentOutlineRequest): Promise<CodeDocumentOutlineResult>;
  languageServices?: {
    status(projectId: string): Promise<CodeLanguageStatus>;
    enable(projectId: string): Promise<void>;
  };
  definitionSource?(projectId: string, sourceId: string): Promise<string>;
}

export type CodeLanguageStatus =
  | { state: "offline" | "disabled" | "discovering" | "failed" }
  | { state: "workspaces"; workspaces: CodeLanguageWorkspace[] };

export interface CodeLanguageWorkspace {
  language: "Java" | "TypeScript" | "Go" | "Php" | "Python" | "Rust" | "Clang" | "CSharp" | "Swift";
  root: string;
  command: string;
  state: "queued" | "starting" | "connected" | "missing" | "failed";
  progress: { title: string; message: string | null; percentage: number | null } | null;
  lastTask: string | null;
}

export interface CodeExtensionLanguage {
  id: string;
  aliases: string[];
  filenames: string[];
  filenamePatterns: string[];
  extensions: string[];
}

export type CodeExtensionCapability = "diagnostics" | "eslint" | "pythonDebugger" | "syntax" | "unsupported";

export interface PythonDebugFrame {
  id: number;
  name: string;
  path: string | null;
  source: string;
  line: number;
}

export type PythonDebugEvent =
  | { state: "running" }
  | { state: "paused"; frames: PythonDebugFrame[]; selected: number | null; scopes: { name: string; variables: { name: string; value: string; type?: string }[] }[] }
  | { state: "breakpoints"; path: string; lines: number[] }
  | { state: "output"; text: string }
  | { state: "finished"; error: string | null };

export type PythonDebugAction = { kind: "continue" | "stepOver" | "stepIn" | "stepOut" }
  | { kind: "frame"; id: number }
  | { kind: "breakpoints"; path: string; lines: number[] };

export interface PythonDebugPlatform {
  prepare(projectId: string, path: string): Promise<{ root: string; program: string; interpreters: string[] }>;
  start(projectId: string, id: string, input: { path: string; interpreter: string; cwd: string; args: string[]; breakpoints: Record<string, number[]> }, receive: (event: PythonDebugEvent) => void): Promise<void>;
  control(projectId: string, id: string, action: PythonDebugAction): Promise<void>;
  stop(projectId: string, id: string): Promise<void>;
}

export interface CodeExtension {
  id: string;
  name: string;
  publisher: string;
  version: string;
  description: string;
  fileName: string;
  sha256: string;
  source: "local" | "openVsx" | "openVsxSyntax" | "bundledSyntax";
  engine: string;
  capability: CodeExtensionCapability;
  enabled: boolean;
  languages: CodeExtensionLanguage[];
}

export type CodeExtensionAction = "enable" | "disable" | "uninstall";

export type PreparedCodeExtension =
  | { capability: "diagnostics"; script: string }
  | { capability: "syntax"; grammar: string; scopeName: string; dependencies?: { grammar: string; scopeName: string }[] };

export interface CodeExtensionPlatform {
  list(projectId: string): Promise<CodeExtension[]>;
  install(projectId: string): Promise<CodeExtension | null>;
  change(projectId: string, id: string, action: CodeExtensionAction): Promise<CodeExtension | null>;
  prepare(projectId: string, id: string, sha256: string, language: string): Promise<PreparedCodeExtension>;
  openVsx?: CodeOpenVsxPlatform;
  syntaxCatalog?: {
    list(): Promise<CodeSyntaxSource[]>;
    enable(projectId: string, id: string): Promise<CodeExtension>;
  };
}

export interface CodeSyntaxSource {
  id: string;
  name: string;
  version: string;
  extensions: readonly string[];
  filenames?: readonly string[];
  filenamePatterns?: readonly string[];
}

export interface CodeOpenVsxItem {
  id: string;
  publisher: string;
  name: string;
  description: string;
  version: string;
  verified: boolean;
  deprecated: boolean;
}

export interface CodeOpenVsxDetail extends CodeOpenVsxItem {
  versions: string[];
  license: string | null;
  engine: string | null;
  capability: CodeExtensionCapability | null;
  incompatibility: "debugger" | "extensionDependencies" | null;
  downloadable: boolean;
  canUpdate: boolean;
}

export interface CodeOpenVsxUpdate {
  id: string;
  version: string;
  installedSha256: string;
}

export interface CodeOpenVsxPlatform {
  /** An empty query loads the registry's featured extensions. */
  search(projectId: string, query: string, offset: number): Promise<{ items: CodeOpenVsxItem[]; nextOffset: number | null }>;
  detail(projectId: string, id: string, version?: string): Promise<CodeOpenVsxDetail>;
  updates(projectId: string): Promise<{ updates: CodeOpenVsxUpdate[]; failed: number }>;
  install(projectId: string, input: { id: string; version: string; installedSha256?: string }): Promise<CodeExtension>;
}
