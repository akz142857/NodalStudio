import { defaultEffectiveSettings, type TableAiPreview, type TableAiResult } from "../platform";
import { reportSnapshot } from "./schema-report-fixture";

export const aiTable = reportSnapshot.schemas[0].tables[1];
export function tableAiSettings() {
  const settings = defaultEffectiveSettings(reportSnapshot.sourceId);
  settings.source!.ai.enabled = true;
  settings.source!.ai.provider = "openAiCompatible";
  settings.source!.ai.model = "fixture-model";
  return settings;
}
export const tableAiPreview: TableAiPreview = {
  requestId: "fixture-request", sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id,
  fingerprint: reportSnapshot.fingerprint, provider: "openai-compatible", model: "fixture-model",
  endpoint: "http://localhost:9999/v1/chat/completions", expiresAt: new Date(Date.now() + 300_000).toISOString(),
  context: { version: 1, target: aiTable.key, focusColumn: null, scope: "currentTable", dialect: "postgreSql", tables: [aiTable.key],
    evidence: [{ id: "e1", tableKey: aiTable.key, objectKey: { kind: "column", schema: "public.orders", name: "customer_id" }, kind: "column", label: "public.orders · customer_id", detail: JSON.stringify(aiTable.columns[1]), columns: ["customer_id"] },
      { id: "e2", tableKey: aiTable.key, objectKey: { kind: "index", schema: "public.orders", name: "orders_customer_idx" }, kind: "index", label: "public.orders · orders_customer_idx", detail: JSON.stringify(aiTable.indexes[0]), columns: [...aiTable.indexes[0].columns] }],
    coverage: ["Snapshot metadata only; no application rows were inspected.", "Relationships outside the permitted scope are omitted.", "Existing notes are excluded."] },
  requestBody: { model: "fixture-model", messages: [{ role: "user", content: "Synthetic metadata fixture for UI verification only" }] },
};
export const tableAiResult: TableAiResult = {
  requestId: tableAiPreview.requestId, sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id,
  target: aiTable.key, provider: tableAiPreview.provider, model: tableAiPreview.model, generatedAt: "2026-10-18T01:00:00Z",
  answer: { interpretations: [{ text: "customer_id may identify the customer associated with this record. The business grain still needs confirmation.", evidenceIds: ["e1", "e2"] }], unknowns: ["Does one row represent an entire order or an order version?", "What currency is used for total?"] },
};
