import type { DatabaseInfo, SchemaDefinition } from "../platform/types";
export type DdlDialect = DatabaseInfo["databaseType"];
export const ddlLimits = { bytes: 1_048_576, tokens: 100_000, statements: 5_000, depth: 64, tables: 500, columns: 5_000 } as const;
export interface SourceRange { start: number; end: number; line: number; column: number }
export interface DdlDiagnostic extends SourceRange { level: "error" | "warning" | "info"; code: string; message: string; statement: number }
export interface DdlLocation extends SourceRange { schema: string; table: string; columnName?: string }
export interface DdlPreview {
  source: { kind: "ddl-file" | "ddl-clipboard"; name: string; id: string; contentHash: string };
  dialect: DdlDialect;
  defaultSchema: string;
  fingerprint: string;
  schemas: SchemaDefinition[];
  diagnostics: DdlDiagnostic[];
  locations: DdlLocation[];
  coverage: { accepted: number; skipped: number; errors: number; warnings: number };
}
export interface DdlRequest { text: string; dialect: DdlDialect; defaultSchema: string; source: Pick<DdlPreview["source"], "kind" | "name" | "id"> }
