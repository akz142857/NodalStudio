import type { ObjectKey } from "./types";

export interface TableAiInput {
  snapshotId: string;
  target: ObjectKey;
  focusColumn: string | null;
  domainId: string | null;
  question: string;
  uiLocale?: "en" | "zh-CN";
}

export interface TableAiEvidence {
  id: string;
  tableKey: ObjectKey;
  objectKey: ObjectKey;
  kind: string;
  label: string;
  detail: string;
  columns: string[];
}

export interface TableAiContext {
  version: number;
  target: ObjectKey;
  focusColumn: string | null;
  scope: "currentTable" | "oneHop" | "domain";
  dialect: "postgreSql" | "mySql";
  tables: ObjectKey[];
  evidence: TableAiEvidence[];
  coverage: string[];
}

export interface TableAiPreview {
  requestId: string;
  sourceId: string;
  snapshotId: string;
  fingerprint: string;
  provider: string;
  model: string | null;
  endpoint: string | null;
  context: TableAiContext;
  requestBody: unknown;
  expiresAt: string;
}

export interface TableAiResult {
  requestId: string;
  sourceId: string;
  snapshotId: string;
  target: ObjectKey;
  provider: string;
  model: string | null;
  generatedAt: string;
  answer: {
    schemaVersion: 2;
    summary: { text: string; evidenceIds: string[] } | null;
    interpretations: { text: string; evidenceIds: string[] }[];
    unknowns: string[];
  };
}
