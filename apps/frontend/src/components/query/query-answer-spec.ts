import { createTranslator, type Translate } from "../../i18n";
import { translateUiLabel } from "../../i18n/business-labels";
import { defineCatalog, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import type { QueryExecutionResult, SqlDraft } from "../../platform";
import { resultCellText } from "./result-profile";
import { presentResult } from "./result-presentation";

const presentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("table"), reason: z.string() }),
  z.object({ kind: z.literal("metric"), title: z.string(), value: z.string() }),
  z.object({ kind: z.literal("chart"), title: z.string(), dimension: z.string(), temporal: z.boolean(), period: z.enum(["month", "day", "category"]), points: z.array(z.object({ label: z.string(), value: z.number(), exact: z.string(), order: z.number() })).min(2).max(60) }),
]);

export const queryAnswerCatalog = defineCatalog(schema, {
  components: {
    Answer: { props: z.object({}), slots: ["default"], description: "A reviewed query answer" },
    Summary: { props: z.object({ text: z.string() }), description: "Explanation of the query" },
    Notes: { props: z.object({ title: z.string(), items: z.array(z.string()), clarification: z.boolean() }), description: "Assumptions or clarification questions" },
    Sql: { props: z.object({ sql: z.string() }), description: "Read-only SQL draft, displayed as text" },
    Result: { props: z.object({ queryId: z.string(), columns: z.array(z.string()).max(8), rows: z.array(z.array(z.string()).max(8)).max(12), total: z.number(), columnCount: z.number(), duration: z.number(), truncated: z.boolean(), presentation: presentationSchema }), description: "Local result artifact: a verified chart, single metric or original table. Never populated by model-generated values." },
  },
  // Execution is owned by the app's editor. No model-defined actions or handlers.
  actions: {},
});

/** Map validated domain output to our own catalog; never execute a model UI spec. */
export function queryAnswerSpec(draft: SqlDraft, result?: QueryExecutionResult, t: Translate = createTranslator("en")): Spec {
  const spec: Spec = { root: "answer", elements: { answer: { type: "Answer", props: {}, children: [] } } };
  const add = (id: string, type: string, props: Record<string, unknown>) => {
    spec.elements[id] = { type, props, children: [] };
    spec.elements.answer.children!.push(id);
  };
  add("summary", "Summary", { text: draft.explanation });
  if (draft.clarification.length) add("clarification", "Notes", { title: translateUiLabel("A little more detail is needed", t), items: draft.clarification, clarification: true });
  if (draft.sql && result) add("result", "Result", { queryId: result.queryId, columns: result.columns.slice(0, 8).map((c) => c.name), rows: result.rows.slice(0, 12).map((row) => row.slice(0, 8).map(resultCellText)), total: result.rowCount, columnCount: result.columns.length, duration: result.durationMs, truncated: result.truncated, presentation: presentResult(result) });
  if (draft.sql) add("sql", "Sql", { sql: draft.sql });
  if (draft.assumptions.length) add("assumptions", "Notes", { title: translateUiLabel("Assumptions to check", t), items: draft.assumptions, clarification: false });
  return spec;
}
