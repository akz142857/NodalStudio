import { describe, expect, it } from "vitest";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { diagramColumn, diagramTable } from "../test/diagram-comparison-fixture";
import { assertReportSize, createSchemaReport, schemaReportFileName } from "./schema-report";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("schema report", () => {
  it("exports a complete single snapshot with columns, keys, indexes, constraints, views, enums and saved semantics", () => {
    const inputBefore = JSON.stringify([reportSnapshot, reportSemantics]);
    const { html, tableCount, columnCount } = createSchemaReport(reportSnapshot, reportSemantics);
    const document = parse(html);
    expect(tableCount).toBe(3); expect(columnCount).toBe(6);
    expect(document.title).toBe("Commerce — Schema report");
    expect(document.body.textContent).toContain("Captured 2026-10-13T08:00:00Z");
    expect(document.body.textContent).toContain(reportSnapshot.fingerprint);
    expect(document.querySelector(".summary")?.textContent).toContain("1 view");
    const orders = document.getElementById("table-0-1")!;
    for (const detail of ["gen_random_uuid()", "Identity by default", "Generated", "Customer identifier", "orders_pk", "orders_customer_fk", "cascade", "Deferrable", "Initially deferred", "orders_customer_idx", "total > 0", "CHECK (total >= 0)", "Commerce team", "订单：记录已确认的购买意图", "Amount before shipping"]) {
      expect(orders.textContent).toContain(detail);
    }
    expect(document.getElementById("view-0-0")?.textContent).toContain("Materialized view");
    expect(document.getElementById("view-0-0")?.textContent).toContain("SELECT customer_id");
    expect([...document.querySelectorAll("#enum-0-0 li")].map((item) => item.textContent)).toEqual(["new", "paid", "shipped"]);
    expect(document.getElementById("domains")?.textContent).toContain("Customer orders and ownership");
    expect(document.getElementById("logical-0")?.textContent).toContain("Confirmed inference");
    expect(document.getElementById("logical-0")?.textContent).toContain("Active");
    expect(document.body.textContent).toContain("not historical versions");
    expect(JSON.stringify([reportSnapshot, reportSemantics])).toBe(inputBefore);
    expect(createSchemaReport(reportSnapshot, reportSemantics).html).toBe(html);
  });

  it("escapes every untrusted text surface and emits no scripts, external resources or workspace secrets", () => {
    const snapshot = structuredClone(reportSnapshot);
    const semantics = structuredClone(reportSemantics);
    const payload = '</style><script>alert("x")</script><img src="https://evil.test" onerror="boom">&\'';
    snapshot.database.name = payload;
    snapshot.schemas[0].name = payload;
    const table = snapshot.schemas[0].tables[1];
    table.comment = payload; table.columns[0].defaultValue = payload; table.columns[0].comment = payload;
    table.indexes[0].predicate = payload; table.constraints[0].definition = payload;
    snapshot.schemas[0].views[0].definition = payload; snapshot.schemas[0].enums[0].values = [payload];
    semantics.annotations[0].description = payload; semantics.annotations[0].owner = payload; semantics.annotations[0].tags = [payload];
    semantics.domainGroups[0].name = payload; semantics.domainGroups[0].description = payload; semantics.domainGroups[0].color = payload;
    semantics.logicalRelationships[0].name = payload; semantics.logicalRelationships[0].note = payload; semantics.logicalRelationships[0].evidence = [payload];
    Object.assign(snapshot, { password: "database-secret", host: "private-host", rows: ["query-row-secret"] });
    Object.assign(semantics, { accessToken: "cloud-secret", filePath: "/private/code/path" });
    const { html } = createSchemaReport(snapshot, semantics);
    const document = parse(html);
    expect(document.title).toBe(`${payload} — Schema report`);
    expect(document.querySelectorAll("script,img,iframe,link,base,form")).toHaveLength(0);
    expect(document.querySelectorAll("style")).toHaveLength(1);
    expect(document.querySelectorAll("[onerror],[onclick],[src]")).toHaveLength(0);
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("default-src 'none'");
    expect(document.body.textContent).toContain(payload);
    for (const secret of ["database-secret", "private-host", "query-row-secret", "cloud-secret", "/private/code/path", snapshot.sourceId, snapshot.id, "private-logical-id", "domain-private-id"]) expect(html).not.toContain(secret);
  });

  it("keeps qualified object links distinct, handles missing endpoints and excludes unattached or foreign-source semantics", () => {
    const snapshot = structuredClone(reportSnapshot);
    const semantics = structuredClone(reportSemantics);
    snapshot.schemas[0].tables[1].foreignKeys[0].referencedSchema = "archive";
    snapshot.schemas[0].tables[1].foreignKeys[0].referencedTable = "orders";
    semantics.logicalRelationships.push({ ...semantics.logicalRelationships[0], id: "orphan", name: "Missing relationship", status: "orphaned", target: { schema: "missing", table: "table", columns: ["id"] } });
    semantics.logicalRelationships.push({ ...semantics.logicalRelationships[0], id: "disabled", name: "Disabled link", status: "disabled", target: { schema: "public", table: "orders", columns: ["removed_column"] } });
    semantics.logicalRelationships.push({ ...semantics.logicalRelationships[0], sourceId: "other-source", name: "Unrelated saved relationship" });
    semantics.orphanedAnnotations.push({ ...semantics.annotations[0], description: "Orphaned secret" });
    semantics.annotations.push({ ...semantics.annotations[0], sourceId: "other-source", description: "Other source semantics" });
    semantics.domainGroups[0].tableKeys.push({ kind: "table", schema: "missing", name: "orphaned_table" });
    const document = parse(createSchemaReport(snapshot, semantics).html);
    expect(document.querySelector('#table-0-1 table[aria-label="Physical foreign keys"] a')?.getAttribute("href")).toBe("#table-1-0");
    expect(document.getElementById("logical-1")?.textContent).toContain("Orphaned");
    expect(document.getElementById("logical-1")?.textContent).toContain("not in this snapshot");
    expect(document.getElementById("logical-2")?.textContent).toContain("Disabled");
    expect(document.getElementById("logical-2")?.textContent).toContain("column unavailable");
    for (const value of ["Orphaned secret", "Other source semantics", "Unrelated saved relationship", "orphaned_table"]) expect(document.body.textContent).not.toContain(value);
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const link of document.querySelectorAll("a")) {
      expect(link.getAttribute("href")).toMatch(/^#/);
      expect(document.getElementById(link.getAttribute("href")!.slice(1))).not.toBeNull();
    }
  });

  it("supports MySQL, empty snapshots, and portable filenames", () => {
    const snapshot = { ...reportSnapshot, database: { ...reportSnapshot.database, name: "../../业务 <db>", databaseType: "mySql" as const, version: "8.4" }, schemas: [] };
    const report = createSchemaReport(snapshot, reportSemantics);
    expect(parse(report.html).body.textContent).toContain("MySQL 8.4");
    expect(parse(report.html).body.textContent).toContain("No schemas in this snapshot");
    expect(report.tableCount).toBe(0);
    expect(schemaReportFileName(snapshot)).toMatch(/^[a-zA-Z0-9_-]+\.html$/);
    expect(schemaReportFileName({ ...snapshot, database: { ...snapshot.database, name: "业务" } })).toBe("database-schema-report-schema-repor.html");
  });

  it("exports the 500 table / 5,000 column target without truncating the dictionary", () => {
    const snapshot = { ...reportSnapshot, schemas: [{ name: "public", views: [], enums: [], tables: Array.from({ length: 500 }, (_, index) => diagramTable(`table_${index}`, Array.from({ length: 10 }, (_, column) => diagramColumn(`column_${column}`, column + 1)))) }] };
    const report = createSchemaReport(snapshot, { ...reportSemantics, annotations: [], domainGroups: [], logicalRelationships: [] });
    expect(report.tableCount).toBe(500); expect(report.columnCount).toBe(5000);
    expect(report.html).toContain('id="table-0-499"');
    expect(report.html.match(/<code>column_9<\/code>/g)).toHaveLength(500);
    expect(() => assertReportSize("模型".repeat(6_000_000))).toThrow("smaller than 32 MB");
  });
});
