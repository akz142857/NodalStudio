import type { DatabaseInfo, ObjectKey } from "./types";
import type { TableAiEvidence } from "./table-ai-types";

export type DiscoveryOperation = "expand" | "rank" | "path" | "draftSql";
export interface DiscoveryTask {
  operation: DiscoveryOperation;
  question: string;
  root: ObjectKey | null;
  candidates: ObjectKey[];
  pathTables: ObjectKey[];
  pathRelationships: string[];
}
export interface DiscoveryInput { snapshotId: string; domainId: string | null; task: DiscoveryTask; replyLanguage?: { currentQuestion: string; uiLocale: "en" | "zh-CN" } }
export interface KnownRelationship {
  id: string;
  kind: "physical" | "logical";
  source: ObjectKey;
  target: ObjectKey;
  sourceColumns: string[];
  targetColumns: string[];
}
export interface DiscoveryContext {
  operation: DiscoveryOperation;
  scope: "currentTable" | "oneHop" | "domain";
  dialect?: DatabaseInfo["databaseType"];
  tables: ObjectKey[];
  candidates: { id: string; tableKey: ObjectKey }[];
  evidence: TableAiEvidence[];
  path: KnownRelationship[];
  coverage: string[];
}
export interface DiscoveryPreview {
  requestId: string;
  sourceId: string;
  snapshotId: string;
  fingerprint: string;
  provider: string;
  model: string | null;
  endpoint: string | null;
  context: DiscoveryContext;
  requestBody: unknown;
  expiresAt: string;
}
export interface SqlDraft { sql: string | null; explanation: string; assumptions: string[]; clarification: string[] }
export interface DiscoveryAnswer {
  sqlDraft?: SqlDraft;
  terms: string[];
  meanings: { label: string; terms: string[] }[];
  rankings: { candidateId: string; reason: string; evidenceIds: string[] }[];
  interpretations: { text: string; evidenceIds: string[] }[];
  readingOrder: string[];
  unknowns: string[];
}
export interface DiscoveryResult {
  requestId: string;
  sourceId: string;
  snapshotId: string;
  operation: DiscoveryOperation;
  provider: string;
  model: string | null;
  generatedAt: string;
  answer: DiscoveryAnswer;
}
