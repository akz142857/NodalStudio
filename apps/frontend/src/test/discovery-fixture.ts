import type { DiscoveryAnswer, DiscoveryInput, DiscoveryPreview, DiscoveryResult, EffectiveSettings } from "../platform";
import { knownRelationships, objectId } from "../graph/business-discovery";
import { reportSemantics, reportSnapshot } from "./schema-report-fixture";
import { tableAiPreview, tableAiSettings } from "./table-ai-fixture";

export function discoverySettings() { const settings = tableAiSettings(); settings.source!.ai.contextScope = "oneHop"; return settings; }
let sequence = 0;
/** Synthetic UI fixture only. Production scope enforcement lives in Rust. */
export function discoveryPreview(input: DiscoveryInput, settings: EffectiveSettings = discoverySettings()): DiscoveryPreview {
  const graph = knownRelationships(reportSnapshot, reportSemantics.logicalRelationships);
  const rootId = input.task.root && objectId(input.task.root);
  let permitted = new Set(rootId ? [rootId, ...graph.relationships.flatMap((r) => objectId(r.source) === rootId ? [objectId(r.target)] : objectId(r.target) === rootId ? [objectId(r.source)] : [])] : []);
  if (input.task.operation !== "expand") {
    if (settings.source!.ai.contextScope === "currentTable") throw new Error("CurrentTable supports single-table explanations; ranking and paths stay local.");
    if (settings.source!.ai.contextScope === "domain") {
      const domain = reportSemantics.domainGroups.find((d) => d.id === input.domainId);
      if (!domain || (rootId && !domain.tableKeys.some((key) => objectId(key) === rootId))) throw new Error("Select one domain containing the root, or clear the root for domain ranking.");
      permitted = new Set(domain.tableKeys.map(objectId));
    } else if (!rootId) throw new Error("Select a root table for OneHop.");
  }
  const tables = input.task.operation === "expand" ? [] : (input.task.operation === "path" ? input.task.pathTables : input.task.candidates).filter((key) => permitted.has(objectId(key)));
  if (input.task.operation === "path" && tables.length !== input.task.pathTables.length) throw new Error("The complete path is outside the AI scope. Keep browsing it locally or change Settings explicitly.");
  const evidence = tables.flatMap((key) => tableAiPreview.context.evidence.filter((e) => objectId(e.tableKey) === objectId(key)));
  const context = { operation: input.task.operation, scope: settings.source!.ai.contextScope, tables, candidates: tables.map((tableKey, i) => ({ id: `c${i + 1}`, tableKey })), evidence, path: graph.relationships.filter((r) => input.task.pathRelationships.includes(r.id)), coverage: ["Synthetic fixture · no real database or model is accessed.", "Only permitted candidates are ranked; all other matches remain local."] };
  return { ...tableAiPreview, requestId: `discovery-fixture-${++sequence}`, context, requestBody: { model: "fixture-model", messages: [{ role: "system", content: "Synthetic discovery fixture for UI verification only" }, { role: "user", content: input.task.operation === "expand" ? input.task.question : JSON.stringify({ question: input.task.question, context }) }] }, expiresAt: new Date(Date.now() + 300_000).toISOString() };
}
export function discoveryResult(preview: DiscoveryPreview): DiscoveryResult {
  const answer: DiscoveryAnswer = { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: ["Confirm table grain and business rules with the team."] };
  if (preview.context.operation === "expand") answer.terms = ["order", "customer", "payment"];
  if (preview.context.operation === "rank") answer.rankings = preview.context.candidates.filter((c) => preview.context.evidence.some((e) => objectId(e.tableKey) === objectId(c.tableKey))).map((c) => ({ candidateId: c.id, reason: "The name and customer_id field suggest an order record. This is a hypothesis.", evidenceIds: preview.context.evidence.filter((e) => objectId(e.tableKey) === objectId(c.tableKey)).map((e) => e.id) }));
  if (preview.context.operation === "path") { answer.interpretations = [{ text: "The recorded relationship connects these tables structurally. It does not establish application execution order.", evidenceIds: preview.context.evidence.map((e) => e.id) }]; answer.readingOrder = preview.context.candidates.map((c) => c.id); }
  return { requestId: preview.requestId, sourceId: preview.sourceId, snapshotId: preview.snapshotId, operation: preview.context.operation, provider: preview.provider, model: preview.model, generatedAt: new Date().toISOString(), answer };
}
