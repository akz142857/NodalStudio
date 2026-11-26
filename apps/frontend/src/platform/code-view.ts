import type { ObjectKey } from "./types";
import type { DefinitionRevision } from "./ontology-types";
import { z } from "zod";

export const codeQueryHandoffSchema = z.object({
  sourceId: z.string(),
  bindingId: z.string(),
  database: z.string(),
  connection: z.string(),
  profileRevision: z.string(),
  snapshotId: z.string(),
  path: z.string(),
  statementDigest: z.string(),
});
export type CodeQueryHandoff = z.infer<typeof codeQueryHandoffSchema>;
export interface ProjectScope { sourceId: string; bindingId: string }
export interface ProjectFileSelection extends ProjectScope { path: string; indexVersion: string }
export interface ProjectStatementSelection extends ProjectFileSelection { start: number; digest: string }
export interface ProjectSummary {
  id: string;
  name: string;
  directories: string[];
  database: string;
  connectionName: string;
  canOpenExternalEditor?: boolean;
  snapshotId: string;
  snapshotAt: string;
}
export interface ProjectPageRequest {
  sourceId: string;
  offset?: number;
  search?: string;
  object?: ObjectKey;
  checkFiles?: boolean;
}
export type CodeDiagnostic = "syntax" | "sessionContext" | "template" | "notObserved" | "unsupported"
  | "outsideDatabase" | "partialColumns" | "ambiguousColumn";
export interface IndexedProjectFile {
  path: string;
  diagnostic: CodeDiagnostic | null;
  matches: { line: number; start: number; evidence?: "static" | "manual" | "legacy"; stale?: boolean }[];
}
export interface ProjectScan {
  version: string;
  generation: string;
  at: string;
  git: { branch: string | null; commit: string | null };
  skipped: number;
  diagnosticCount: number;
  partialUpdate?: boolean;
  fileCount: number;
  totalMatching: number;
  files: IndexedProjectFile[];
}
export interface ProjectPage {
  project: ProjectSummary | null;
  scan: ProjectScan | null;
  scanning: boolean;
  stale: boolean;
}
export interface CodeChange {
  table: ObjectKey;
  action: "add" | "drop" | "rename" | "modify" | "createTable";
  before: string | null;
  after: string | null;
  beforeObserved?: boolean | null;
  afterObserved?: boolean | null;
}
export interface ProjectStatement {
  start: number;
  end: number;
  line: number;
  digest: string;
  kind: "query" | "migration" | "unsupported";
  references: ObjectKey[];
  diagnostics: CodeDiagnostic[];
  outsideDatabases?: string[];
  changes: CodeChange[];
  openQuery: boolean;
}
export interface CodeOntologyReference {
  id: string;
  name: string;
  revision: number;
  evidence: "field" | "generated" | "confirmed";
  stale: boolean;
}
export interface ProjectFile {
  path: string;
  contents: string;
  statements: ProjectStatement[];
  diagnostic: CodeDiagnostic | null;
  ontology: Record<string, CodeOntologyReference[]>;
  associations?: Record<string, { object: ObjectKey; evidence: "manual" | "legacy"; stale: boolean }[]>;
}
export interface MigrationImpact {
  baselineId: string | null;
  baselineAt: string | null;
  linkedBaselineId?: string | null;
  linkedBaselineAt?: string | null;
  currentAt: string;
  scanAt: string;
  missingBaseline: boolean;
  partial: boolean;
  changes: CodeChange[];
  files: IndexedProjectFile[];
  ontology: CodeOntologyReference[];
}
export interface CodeViewPlatform {
  get(input: ProjectPageRequest): Promise<ProjectPage>;
  choose(sourceId: string, directories: string[]): Promise<ProjectSummary | null>;
  remove(input: ProjectScope): Promise<void>;
  scan(input: ProjectScope): Promise<void>;
  cancel(input: ProjectScope): Promise<void>;
  file(input: ProjectFileSelection): Promise<ProjectFile>;
  openInEditor?(input: ProjectFileSelection): Promise<void>;
  query(input: ProjectStatementSelection): Promise<[string, CodeQueryHandoff]>;
  impact(input: ProjectStatementSelection, baselineId?: string): Promise<MigrationImpact>;
  confirm(input: { selection: ProjectStatementSelection; object?: ObjectKey; definition?: DefinitionRevision }): Promise<void>;
  retryAssociation?(input: ProjectScope & { path: string; generatedFrom: DefinitionRevision }): Promise<void>;
  save(input: ProjectScope & { path: string; sql: string; generatedFrom?: DefinitionRevision }): Promise<{ associationSaved: boolean | null }>;
}
export const codeViewQueryKey = (sourceId: string) => ["code-view", sourceId] as const;
export const codeColumnKey = (table: ObjectKey, name: string): ObjectKey => ({
  kind: "column", schema: `${table.schema}.${table.name}`, name,
});
