import { describe, expect, it } from "vitest";
import { reportSnapshot, reportSemantics } from "../../test/schema-report-fixture";
import { discoverySettings } from "../../test/discovery-fixture";
import { resolveDraftContext } from "./query-context";
const unique = { ...reportSnapshot, schemas: [reportSnapshot.schemas[0]] };
const semantics = { ...reportSemantics, logicalRelationships: [] };
describe("question-first query context", () => {
  it("finds relevant data without a manually selected root and uses only confirmed paths", () => {
    const settings = discoverySettings();
    const result = resolveDraftContext(unique, semantics, settings, "按客户统计订单数量");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.context.tables.map((t) => t.name).sort()).toEqual(["customers", "orders"]);
  });
  it("asks for clarification for same-name schemas and never silently selects one", () => {
    const result = resolveDraftContext(reportSnapshot, reportSemantics, discoverySettings(), "orders");
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.choices.map((c) => c.key.schema)).toContain("archive");
    const qualified = resolveDraftContext(reportSnapshot, reportSemantics, discoverySettings(), "List public.orders IDs");
    expect(qualified.kind).toBe("ready");
    if (qualified.kind === "ready") expect(qualified.context.tables).toEqual([reportSnapshot.schemas[0].tables[1].key]);
  });
  it("does not expand current-table scope or guess a domain", () => {
    const settings = discoverySettings(); settings.source!.ai.contextScope = "currentTable";
    expect(resolveDraftContext(unique, semantics, settings, "customers orders").kind).toBe("blocked");
    settings.source!.ai.contextScope = "domain";
    expect(resolveDraftContext(unique, semantics, settings, "orders").kind).toBe("blocked");
    expect(resolveDraftContext(unique, semantics, settings, "orders", reportSemantics.domainGroups[0].id).kind).toBe("ready");
  });
  it("asks a focused question for no match and ignores an unrelated inspected table", () => {
    expect(resolveDraftContext(unique, semantics, discoverySettings(), "天气", "", unique.schemas[0].tables[0].key).kind).toBe("clarify");
    const result = resolveDraftContext(unique, semantics, discoverySettings(), "当前表数量", "", unique.schemas[0].tables[0].key);
    expect(result.kind).toBe("ready");
  });
  it("does not invent a relationship between matched subjects", () => {
    const snapshot = { ...unique, schemas: unique.schemas.map((s) => ({ ...s, tables: s.tables.map((t) => ({ ...t, foreignKeys: [] })) })) };
    expect(resolveDraftContext(snapshot, semantics, discoverySettings(), "customers orders").kind).toBe("clarify");
  });
});
