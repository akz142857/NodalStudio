import { describe, expect, it } from "vitest";
import type { ColumnDefinition, DatabaseSnapshot } from "../platform/types";
import { reportSnapshot } from "../test/schema-report-fixture";
import { diagramColumn, diagramForeignKey, diagramTable } from "../test/diagram-comparison-fixture";
import { runSchemaPreflight } from "./schema-preflight";

function pair(dialect: "postgreSql" | "mySql", a: string, b: string, formattedA = a, formattedB = b): DatabaseSnapshot {
  const column = (typeName: string, formattedType: string): ColumnDefinition => ({ ...diagramColumn("id"), typeSchema: dialect === "mySql" ? "mysql" : "pg_catalog", typeName, formattedType });
  const source = diagramTable("source", [column(a, formattedA)]);
  source.foreignKeys = [diagramForeignKey("source_target_fk", "id", "target")];
  return { ...reportSnapshot, database: { ...reportSnapshot.database, databaseType: dialect }, schemas: [{ name: "public", tables: [source, diagramTable("target", [column(b, formattedB)])], views: [], enums: [] }] };
}
const types = (snapshot: DatabaseSnapshot) => runSchemaPreflight(snapshot).findings.filter((finding) => finding.ruleId.endsWith("fk-types"));

describe("snapshot structure preflight", () => {
  it("checks only captured metadata without mutating it or depending on semantics, filters or credentials", () => {
    const original = structuredClone(reportSnapshot);
    const result = runSchemaPreflight(reportSnapshot);
    expect(result.findings).toEqual([]);
    expect(result).toMatchObject({ dialect: "PostgreSQL", tableCount: 3, columnCount: 6, foreignKeyCount: 1, excludedViewCount: 1 });
    expect(result.coverage.find((rule) => rule.ruleId === "mysql-fk-types")).toMatchObject({ status: "skipped", checked: 0 });
    expect(result.coverage.find((rule) => rule.ruleId === "postgres-fk-types")).toMatchObject({ status: "checked", checked: 1 });
    expect(reportSnapshot).toEqual(original);
    const withSecrets = { ...reportSnapshot, password: "do-not-include", rows: [{ secret: "application-data" }] };
    expect(JSON.stringify(runSchemaPreflight(withSecrets))).not.toMatch(/do-not-include|application-data/);
  });

  it("treats missing PKs as design suggestions for ordinary/partitioned tables, excluding foreign tables and views", () => {
    const snapshot = structuredClone(reportSnapshot);
    for (const table of snapshot.schemas.flatMap((schema) => schema.tables)) table.primaryKey = null;
    snapshot.schemas[0].tables[0].tableKind = "foreign";
    snapshot.schemas[0].tables[1].tableKind = "partitioned";
    const result = runSchemaPreflight(snapshot);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.outcome === "design" && finding.severity === "suggestion")).toBe(true);
    expect(result.coverage[0]).toMatchObject({ checked: 2, skipped: 1 });
  });

  it.each<[string[]]>([[[]], [["absent"]], [["id", "id"]]])("explains inconsistent captured primary-key column lists %j", (keyColumns) => {
    const snapshot = pair("postgreSql", "uuid", "uuid");
    snapshot.schemas[0].tables[0].primaryKey!.columns = keyColumns;
    const result = runSchemaPreflight(snapshot).findings;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ruleId: "key-references", outcome: "suspected", objectKey: { kind: "constraint", name: "source_pk" } });
    expect(result[0].evidence.join(" ")).toContain(JSON.stringify(keyColumns));
  });

  it.each(["arity", "source column", "target column", "duplicate"])("reports FK %s inconsistencies and marks type checks incomplete", (kind) => {
    const snapshot = pair("postgreSql", "uuid", "uuid");
    const fk = snapshot.schemas[0].tables[0].foreignKeys[0];
    if (kind === "arity") fk.columns = [];
    if (kind === "source column") fk.columns = ["absent"];
    if (kind === "target column") fk.referencedColumns = ["absent"];
    if (kind === "duplicate") { fk.columns = ["id", "id"]; fk.referencedColumns = ["id", "id"]; }
    const result = runSchemaPreflight(snapshot);
    expect(result.findings[0]).toMatchObject({ ruleId: "key-references", outcome: "suspected" });
    expect(result.coverage.find((rule) => rule.ruleId === "postgres-fk-types")).toMatchObject({ status: "partial", incomplete: 1, checked: 0 });
  });

  it("treats out-of-scope referenced tables as information gaps, never as proven broken constraints", () => {
    const snapshot = pair("postgreSql", "uuid", "uuid");
    snapshot.schemas[0].tables[0].foreignKeys[0].referencedSchema = "outside";
    const result = runSchemaPreflight(snapshot);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ outcome: "insufficient", severity: "info", relatedTables: [] });
    expect(result.findings[0].recommendation).toContain("Cross-schema references can be valid");
    expect(result.coverage[1].status).toBe("partial");
  });

  it("uses qualified tuple identities for quoted names containing dots and checks every composite FK pair", () => {
    const snapshot = pair("postgreSql", "uuid", "uuid");
    const [source, target] = snapshot.schemas[0].tables;
    source.key.schema = "a.b"; source.key.name = "c";
    target.key.schema = "a"; target.key.name = "b.c";
    source.columns.push({ ...diagramColumn("second"), typeName: "text", formattedType: "text" });
    target.columns.push(diagramColumn("second"));
    Object.assign(source.foreignKeys[0], { referencedSchema: "a", referencedTable: "b.c", columns: ["id", "second"], referencedColumns: ["id", "second"] });
    const result = runSchemaPreflight(snapshot);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ tableKey: source.key, relatedTables: [target.key], outcome: "suspected" });
    expect(result.findings[0].evidence.join(" ")).toContain("Pair 2");
    expect(result.coverage.find((rule) => rule.ruleId === "postgres-fk-types")?.checked).toBe(2);
  });

  it.each([
    ["int4", "int4", undefined], ["int2", "int8", "insufficient"], ["numeric", "int4", "insufficient"], ["text", "varchar", "insufficient"],
    ["date", "timestamp", "insufficient"], ["uuid", "text", "suspected"], ["bool", "uuid", "suspected"], ["jsonb", "uuid", "insufficient"],
  ] as const)("PostgreSQL %s → %s produces %s without declaring database invalidity", (a, b, outcome) => {
    const snapshot = pair("postgreSql", a, b);
    const result = types(snapshot);
    if (!outcome) expect(result).toEqual([]);
    else expect(result[0]).toMatchObject({ ruleId: "postgres-fk-types", outcome });
    expect(runSchemaPreflight(snapshot).coverage.find((rule) => rule.ruleId === "mysql-fk-types")?.status).toBe("skipped");
  });

  it("keeps custom/domain types uncertain even when their textual names match", () => {
    const snapshot = pair("postgreSql", "account_id", "account_id");
    snapshot.schemas[0].tables.forEach((table) => { table.columns[0].typeSchema = "domain_schema"; });
    expect(types(snapshot)[0]).toMatchObject({ outcome: "insufficient" });
  });

  it.each([
    ["int", "int", "int(11)", "int(20)", undefined],
    ["integer", "int", "integer unsigned", "int(11) unsigned", undefined],
    ["int", "int", "int unsigned", "int", "suspected"],
    ["int", "bigint", "int", "bigint", "suspected"],
    ["decimal", "numeric", "decimal(12,2)", "numeric(12,2)", undefined],
    ["decimal", "decimal", "decimal(12,2)", "decimal(12,3)", "suspected"],
    ["decimal", "decimal", "decimal(12,2) unsigned", "decimal(12,2)", "suspected"],
    ["decimal", "decimal", "decimal", "decimal(12,2)", "insufficient"],
    ["varchar", "varchar", "varchar(20)", "varchar(100)", "insufficient"],
    ["binary", "varbinary", "binary(16)", "varbinary(16)", "insufficient"],
    ["int", "int", "", "int unsigned", "insufficient"],
  ] as const)("MySQL %s → %s (%s/%s) produces %s", (a, b, fa, fb, outcome) => {
    const snapshot = pair("mySql", a, b, fa, fb);
    const result = types(snapshot);
    if (!outcome) expect(result).toEqual([]);
    else expect(result[0]).toMatchObject({ ruleId: "mysql-fk-types", outcome });
    expect(runSchemaPreflight(snapshot).coverage.find((rule) => rule.ruleId === "postgres-fk-types")?.status).toBe("skipped");
  });

  it("keeps naming hints opt-in, handles table/column names equal to one another and never treats legal quoted names as errors", () => {
    const snapshot = pair("postgreSql", "uuid", "uuid");
    snapshot.schemas[0].tables[0].key.name = "has space";
    snapshot.schemas[0].tables[0].columns.push(diagramColumn("has space"));
    expect(runSchemaPreflight(snapshot).findings).toEqual([]);
    const findings = runSchemaPreflight(snapshot, { nameSpaces: true }).findings;
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.outcome === "style" && finding.severity === "info")).toBe(true);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
    expect(findings.map((finding) => finding.objectKey.kind).sort()).toEqual(["column", "table"]);
  });

  it("emits deterministic identities/order independent of table and column order", () => {
    const snapshot = pair("postgreSql", "uuid", "text");
    snapshot.schemas[0].tables.forEach((table) => { table.primaryKey = null; });
    const shuffled = structuredClone(snapshot);
    shuffled.schemas[0].tables.reverse().forEach((table) => table.columns.reverse());
    expect(runSchemaPreflight(shuffled)).toEqual(runSchemaPreflight(snapshot));
  });

  it("describes empty and unsupported snapshots with skipped checks rather than a validity guarantee", () => {
    const snapshot = { ...reportSnapshot, schemas: [], database: { ...reportSnapshot.database, databaseType: "unknown" } } as unknown as DatabaseSnapshot;
    const result = runSchemaPreflight(snapshot);
    expect(result.dialect).toBe("Unsupported dialect");
    expect(result.findings).toEqual([]);
    expect(result.coverage.every((rule) => rule.status === "skipped")).toBe(true);
  });

  it("handles the planned 500-table/5000-column model with one finding per missing PK", () => {
    const snapshot = { ...reportSnapshot, schemas: [{ name: "public", views: [], enums: [], tables: Array.from({ length: 500 }, (_, index) => ({ ...diagramTable(`table_${index}`, Array.from({ length: 10 }, (_, col) => diagramColumn(`col_${col}`))), primaryKey: null })) }] };
    const result = runSchemaPreflight(snapshot);
    expect(result).toMatchObject({ tableCount: 500, columnCount: 5000 });
    expect(result.findings).toHaveLength(500);
  });
});
