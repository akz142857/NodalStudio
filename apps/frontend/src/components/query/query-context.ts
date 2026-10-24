import type { DatabaseSnapshot, EffectiveSettings, ObjectKey, SemanticBundle } from "../../platform";
import { discoverTables, findKnownPath, knownRelationships, objectId, objectLabel } from "../../graph/business-discovery";

export interface DraftContext { root: ObjectKey; tables: ObjectKey[] }
export interface ContextMatch { key: ObjectKey; reason: string; score: number }
export type ContextResolution = { kind: "ready"; context: DraftContext; reason: string } | { kind: "clarify"; message: string; choices: ContextMatch[] } | { kind: "blocked"; message: string };

export function validateDraftContext(snapshot: DatabaseSnapshot, semantics: SemanticBundle, settings: EffectiveSettings, context: DraftContext, domainId: string): string | undefined {
  const tables = snapshot.schemas.flatMap((s) => s.tables);
  const ids = context.tables.map(objectId);
  if (!ids.length || ids.length > 3 || new Set(ids).size !== ids.length || !ids.includes(objectId(context.root)) || context.tables.some((k) => !tables.some((t) => objectId(t.key) === objectId(k)))) return "This context needs one to three tables from the current database. Adjust the context or narrow your question.";
  const scope = settings.source?.ai.contextScope ?? "currentTable";
  const domain = semantics.domainGroups.find((d) => d.sourceId === snapshot.sourceId && d.id === domainId);
  const relations = knownRelationships(snapshot, semantics.logicalRelationships).relationships;
  const allowed = new Set(scope === "domain" ? domain?.tableKeys.map(objectId) ?? [] : [objectId(context.root), ...(scope === "oneHop" ? relations.flatMap((r) => objectId(r.source) === objectId(context.root) ? [objectId(r.target)] : objectId(r.target) === objectId(context.root) ? [objectId(r.source)] : []) : [])]);
  if (ids.some((id) => !allowed.has(id))) return "The relevant data is outside the configured AI scope. Narrow your question, adjust the context, or change AI settings explicitly.";
  if (context.tables.some((key) => objectId(key) !== objectId(context.root) && !findKnownPath(context.root, key, relations.filter((r) => ids.includes(objectId(r.source)) && ids.includes(objectId(r.target))), 2))) return "These tables have no confirmed relationship path. Clarify which data you need, or confirm their relationship in the model first.";
}

/** Local retrieval only: no model call or policy expansion. The exact send context is reviewed separately. */
export function resolveDraftContext(snapshot: DatabaseSnapshot, semantics: SemanticBundle, settings: EffectiveSettings, question: string, domainId = "", hint?: ObjectKey): ContextResolution {
  if (settings.source?.ai.contextScope === "domain" && !semantics.domainGroups.some((d) => d.id === domainId && d.sourceId === snapshot.sourceId)) return { kind: "blocked", message: "Your AI settings require a business domain. Choose one below to keep this request within its allowed scope." };
  const query = question.trim().toLocaleLowerCase();
  const domainFilter = settings.source?.ai.contextScope === "domain" ? domainId : "";
  const candidates = discoverTables(snapshot, question, semantics.domainGroups, !!settings.source?.ai.includeComments, domainFilter, [], settings.source?.ai.includeConfirmedSemantics ? semantics.knowledge : []);
  const namesOnly = { ...snapshot, schemas: snapshot.schemas.map((s) => ({ ...s, tables: s.tables.map((t) => ({ ...t, columns: [], comment: null })) })) };
  const nameScores = new Map(discoverTables(namesOnly, question, [], false).map((c) => [objectId(c.table.key), c.score / c.table.key.name.split(/[_\s]+/).length]));
  const mentions = (text: string) => new RegExp(`(^|[^a-z0-9_])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`, "i").test(query);
  const ranked = candidates.map((c) => ({ key: c.table.key, explicit: mentions(objectLabel(c.table.key)) || mentions(c.table.key.name), score: mentions(objectLabel(c.table.key)) ? 10000 : mentions(c.table.key.name) ? 1000 : (nameScores.get(objectId(c.table.key)) ?? 0) * 20 + c.score, reason: c.reasons[0] ?? "Matched schema context", nameScore: nameScores.get(objectId(c.table.key)) ?? 0 })).sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score);
  let first = ranked[0];
  if (hint && /this table|current table|当前表|这个表/.test(query)) {
    const table = snapshot.schemas.flatMap((s) => s.tables).find((t) => objectId(t.key) === objectId(hint));
    if (table) first = { key: table.key, explicit: true, score: 10000, reason: "Uses the table you are inspecting", nameScore: 0 };
  }
  if (!first) return { kind: "clarify", message: "I couldn’t find a clear match in this database. Describe the business subject or a field you need, or add context below.", choices: [] };
  const runner = ranked.find((c) => objectId(c.key) !== objectId(first.key));
  if (runner && first.score < 10000 && ((runner.key.name === first.key.name && runner.score >= first.score * .75) || (!first.nameScore && first.score < 1000 && runner.score >= first.score * .8))) return { kind: "clarify", message: "More than one dataset could answer this. Which one did you mean?", choices: ranked.slice(0, 4) };
  // A fuzzy score can exceed 1000 in a long question; it does not prove the
  // table was named (for example, a `state` filter can match `states`).
  const relevant = ranked.filter((c) => objectId(c.key) !== objectId(first.key) && c.key.name !== first.key.name && (c.explicit || (c.nameScore > 0 && c.score >= first.score * .75)));
  const relations = knownRelationships(snapshot, semantics.logicalRelationships).relationships;
  const context: DraftContext = { root: first.key, tables: [first.key] };
  for (const candidate of relevant) {
    const path = findKnownPath(first.key, candidate.key, relations, 2);
    if (!path) return { kind: "clarify", message: "The question matches separate datasets without a confirmed relationship. Which subject should this query focus on?", choices: [first, ...relevant].slice(0, 4) };
    for (const key of path.tables) if (!context.tables.some((k) => objectId(k) === objectId(key))) context.tables.push(key);
  }
  // Automatic retrieval has no user-pinned root. Use the center of the same
  // reviewed table set when it fits OneHop; never widen the configured scope.
  if (settings.source?.ai.contextScope === "oneHop" && validateDraftContext(snapshot, semantics, settings, context, domainId)) {
    const root = context.tables.find((key) => !validateDraftContext(snapshot, semantics, settings, { ...context, root: key }, domainId));
    if (root) context.root = root;
  }
  const problem = validateDraftContext(snapshot, semantics, settings, context, domainId);
  return problem ? { kind: "blocked", message: problem } : { kind: "ready", context, reason: "Found from your question and local schema. Check this context before generating." };
}
