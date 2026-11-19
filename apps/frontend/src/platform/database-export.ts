import type { ObjectKey } from "./types";

export type DumpMode = "structureOnly" | "structureAndData";
export type TableExportFormat = "csv" | "json";
export type DatabaseExport =
  | { kind: "tableData"; table: ObjectKey; columns: string[]; format: TableExportFormat; protectFormulas: boolean }
  | { kind: "sqlDump"; schema: string; mode: DumpMode };
export interface DatabaseExportRequest { sourceId: string; jobId: string; export: DatabaseExport; locale: string }
export type DatabaseExportProgress = { stage: "exporting"; bytes: number } | { stage: "finalizing" };
export interface DatabaseExportReceipt { path: string; bytes: number }
