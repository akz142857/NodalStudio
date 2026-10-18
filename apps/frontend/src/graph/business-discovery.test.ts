import { describe, expect, it } from "vitest";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { diagramColumn, diagramForeignKey, diagramTable } from "../test/diagram-comparison-fixture";
import { discoverTables, findKnownPath, knownRelationships, neighborhood, objectId } from "./business-discovery";

const tables = reportSnapshot.schemas.flatMap((s) => s.tables);
const [customers, orders, archive] = tables;
describe("business search and local paths", () => {
  it("ranks an exact table name before many partial field matches", () => {
    const snapshot = structuredClone(reportSnapshot);
    snapshot.schemas[0].tables[0].columns = Array.from({ length: 30 }, (_, i) => ({ ...customers.columns[0], name: `orders_detail_${i}` }));
    for (const query of ["orders", " Public.Orders "]) {
      const result = discoverTables(snapshot, query, [], false);
      expect(result[0].table.key.name).toBe("orders");
      if (query.includes(".")) expect(result[0].table.key.schema).toBe("public");
      expect(result.find((c) => c.table.key.name === customers.key.name)?.score).toBeGreaterThan(result[0].score);
    }
  });
  it("does not promote a model-expanded identifier above an explicit table name", () => {
    const result = discoverTables(reportSnapshot, "public.orders", [], false, "", ["customers"]);
    expect(result[0].table.key).toEqual(orders.key);
    expect(result.some((c) => objectId(c.table.key) === objectId(customers.key))).toBe(true);
  });
  it("searches all schemas with qualified identities and explains direct versus translated matches", () => {
    const direct = discoverTables(reportSnapshot, "orders", [], false);
    expect(direct.map((c) => objectId(c.table.key))).toEqual([objectId(archive.key), objectId(orders.key)]);
    expect(direct.every((c) => c.direct)).toBe(true);
    const translated = discoverTables(reportSnapshot, "查询订单", [], false);
    expect(translated).toHaveLength(2); expect(translated.every((c) => !c.direct)).toBe(true);
    expect(translated[0].reasons[0]).toContain("Term hypothesis");
  });
  it("respects comments and explicit local domains without indexing saved notes", () => {
    expect(discoverTables(reportSnapshot, "Calculated", reportSemantics.domainGroups, false)).toHaveLength(0);
    const result = discoverTables(reportSnapshot, "Calculated", reportSemantics.domainGroups, true);
    expect(result[0].matchingColumns).toEqual(["total"]); expect(result[0].reasons[0]).toContain("Database field comment");
    expect(discoverTables(reportSnapshot, "购买意图", reportSemantics.domainGroups, true)).toHaveLength(0);
    expect(discoverTables(reportSnapshot, "orders", reportSemantics.domainGroups, false, "domain-private-id").map((c) => c.table.key)).toEqual([orders.key]);
    expect(discoverTables(reportSnapshot, "orders", reportSemantics.domainGroups, false, "unknown-domain")).toHaveLength(0);
  });
  it("model terms run locally and cannot create tables or erase genuine no-result states", () => {
    expect(discoverTables(reportSnapshot, "unknown_business", [], false, "", ["invented_payments"])).toHaveLength(0);
    const candidates = discoverTables(reportSnapshot, "购买", [], false, "", ["orders"]);
    expect(candidates).toHaveLength(2); expect(candidates.every((c) => tables.includes(c.table))).toBe(true);
  });
  it("finds Chinese comments inside a business sentence even with opaque table names", () => {
    const snapshot = structuredClone(reportSnapshot);
    snapshot.schemas[0].tables[1].key.name = "t_100";
    snapshot.schemas[0].tables[1].comment = "订单与支付记录";
    const candidates = discoverTables(snapshot, "在哪里查询订单的支付记录？", [], true);
    const opaque = candidates.find((candidate) => candidate.table.key.name === "t_100");
    expect(opaque?.direct).toBe(true);
    expect(opaque?.reasons).toContain("Direct match · Database comment: 订单, 支付");
    expect(discoverTables(snapshot, "在哪里查询订单的支付记录？", [], false).some((c) => c.table.key.name === "t_100")).toBe(false);
  });
  it("supports inbound one hop and explicit two hops including valid logical edges", () => {
    const { relationships } = knownRelationships(reportSnapshot, reportSemantics.logicalRelationships);
    expect(relationships.map((r) => r.kind).sort()).toEqual(["logical", "physical"]);
    expect(findKnownPath(customers.key, archive.key, relationships, 1)).toBeUndefined();
    const path = findKnownPath(customers.key, archive.key, relationships, 2)!;
    expect(path.tables).toEqual([customers.key, orders.key, archive.key]);
    expect(path.relationships.map((r) => r.kind)).toEqual(["physical", "logical"]);
    const local = neighborhood(reportSnapshot, customers.key, relationships, 1);
    expect(local.snapshot.schemas.flatMap((s) => s.tables).map((t) => t.key)).toEqual([customers.key, orders.key]);
    expect(reportSnapshot.schemas[1].tables).toEqual([archive]);
  });
  it("preserves composite mapping order and reports missing endpoints without inventing paths", () => {
    const snapshot = structuredClone(reportSnapshot); const relation = snapshot.schemas[0].tables[1].foreignKeys[0];
    relation.columns = ["customer_id", "id"]; relation.referencedColumns = ["id", "name"];
    snapshot.schemas[0].tables[0].foreignKeys.push(diagramForeignKey("missing_fk", "id", "uncollected"));
    const { relationships, gaps } = knownRelationships(snapshot, []);
    expect(relationships).toHaveLength(1); expect(relationships[0].sourceColumns).toEqual(["customer_id", "id"]); expect(relationships[0].targetColumns).toEqual(["id", "name"]);
    expect(gaps[0]).toContain("missing_fk"); expect(findKnownPath(customers.key, archive.key, relationships)).toBeUndefined();
  });
  it.each(["disabled", "foreignSource", "missingColumn", "typeChanged", "duplicate"])("excludes %s logical relationships even if a previous snapshot marked them active", (kind) => {
    const snapshot = structuredClone(reportSnapshot); const logical = structuredClone(reportSemantics.logicalRelationships);
    if (kind === "disabled") logical[0].status = "disabled";
    if (kind === "foreignSource") logical[0].sourceId = "other-source";
    if (kind === "missingColumn") logical[0].source.columns = ["missing"];
    if (kind === "typeChanged") snapshot.schemas[1].tables[0].columns[0].typeName = "text";
    if (kind === "duplicate") logical.push({ ...logical[0], id: "duplicate" });
    expect(knownRelationships(snapshot, logical).relationships.every((r) => r.kind === "physical")).toBe(true);
  });
  it("bounds a dense local graph to 100 tables while keeping the chosen path complete", () => {
    const snapshot = structuredClone(reportSnapshot);
    for (let i = 0; i < 150; i++) { const t = diagramTable(`child_${i}`, [diagramColumn("id")]); t.foreignKeys = [diagramForeignKey(`child_${i}_fk`, "id", "customers")]; snapshot.schemas[0].tables.push(t); }
    const { relationships } = knownRelationships(snapshot, []);
    const last = snapshot.schemas[0].tables.at(-1)!; const path = findKnownPath(customers.key, last.key, relationships)!;
    const local = neighborhood(snapshot, customers.key, relationships, 1, path);
    expect(local.snapshot.schemas.flatMap((s) => s.tables)).toHaveLength(100);
    expect(local.snapshot.schemas.flatMap((s) => s.tables)).toContain(last); expect(local.omitted).toBe(52);
  });
});

it("reuses only current locally confirmed team statements and drops pending descriptions immediately", () => {
  const state: import("../platform").KnowledgeState = { sourceId: reportSnapshot.sourceId, objectKey: orders.key, status: "confirmed", reason: "Local", confirmation: { id: "confirmation", sourceId: reportSnapshot.sourceId, objectKey: orders.key, finalText: "采购意图", descriptionDigest: "digest", snapshotId: reportSnapshot.id, fingerprint: reportSnapshot.fingerprint, confirmedAt: reportSnapshot.capturedAt, basis: { tables: [], relationships: [], notes: [] }, origin: { kind: "manualReview", requestId: null, provider: null, model: null, generatedAt: null, evidence: null } } };
  expect(discoverTables(reportSnapshot, "采购意图", [], false, "", [], [state]).map((c) => c.table.key)).toEqual([orders.key]);
  expect(discoverTables(reportSnapshot, "采购意图", [], false, "", [], [{ ...state, status: "pendingReview" }])).toHaveLength(0);
  expect(discoverTables(reportSnapshot, "采购意图", [], false, "", [], [{ ...state, sourceId: "different-source" }])).toHaveLength(0);
});

it.each(["unique", "ambiguous", "missing", "independent"] as const)("resolves %s knowledge ownership before applying domain filters", (kind) => {
  const snapshot = structuredClone(reportSnapshot);
  const other = diagramTable("orders.v2", [diagramColumn("id")]);
  const owner = diagramTable("v2", [diagramColumn("id"), diagramColumn("business_code")]);
  owner.key.schema = "public.orders";
  if (kind === "ambiguous") other.columns.push(diagramColumn("business_code"));
  snapshot.schemas = [{ name: "public", tables: [other], views: [], enums: [] }, { name: "public.orders", tables: [owner], views: [], enums: [] }];
  const key: import("../platform").ObjectKey = { kind: kind === "independent" ? "view" : "column", schema: "public.orders.v2", name: kind === "missing" ? "absent" : "business_code" };
  const state: import("../platform").KnowledgeState = { sourceId: snapshot.sourceId, objectKey: key, status: "confirmed", reason: "Local", confirmation: { id: "proof", sourceId: snapshot.sourceId, objectKey: key, finalText: "quasarzephyr", descriptionDigest: "digest", snapshotId: snapshot.id, fingerprint: snapshot.fingerprint, confirmedAt: snapshot.capturedAt, basis: { tables: [[owner.key, "hash"]], relationships: [], notes: [] }, origin: { kind: "manualReview", requestId: null, provider: null, model: null, generatedAt: null, evidence: null } } };
  const candidates = discoverTables(snapshot, "quasarzephyr", [], false, "", [], [state]);
  expect(candidates.map((candidate) => candidate.table.key)).toEqual(kind === "unique" ? [owner.key] : []);
  if (kind === "unique") {
    expect(candidates[0].matchingColumns).toEqual(["business_code"]);
    expect(candidates[0].reasons).toContain("Direct match · Confirmed team statement business_code: quasarzephyr");
  }
  const domain = { ...reportSemantics.domainGroups[0], id: "only-owner", sourceId: snapshot.sourceId, tableKeys: [owner.key] };
  expect(discoverTables(snapshot, "quasarzephyr", [domain], false, domain.id, [], [state]).map((candidate) => candidate.table.key)).toEqual(kind === "unique" ? [owner.key] : []);
});
