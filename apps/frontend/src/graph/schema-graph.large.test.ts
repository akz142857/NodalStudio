import { describe, expect, it } from "vitest";
import type { DatabaseSnapshot, TableDefinition } from "../platform";
import { diagramColumn, diagramForeignKey, diagramTable } from "../test/diagram-comparison-fixture";
import { buildSchemaGraph, inferRelationships, orientFieldEdges } from "./schema-graph";

function largeSchema(count: number): DatabaseSnapshot {
  const tables = Array.from({ length: count }, (_, i) => {
    const table = diagramTable(`entity_${i}s`, [diagramColumn("id"), diagramColumn(`entity_${(i + 1) % count}_id`, 2), ...Array.from({ length: 18 }, (_, c) => diagramColumn(`value_${c}`, c + 3))]);
    table.primaryKey = { name: `${table.key.name}_pkey`, columns: ["id"] };
    return table;
  });
  return { id: "large", sourceId: "large", capturedAt: "2026-10-15T00:00:00Z", fingerprint: "large", database: { name: "Large", databaseType: "postgreSql", version: "17" }, schemas: [{ name: "public", tables, views: [], enums: [] }] };
}

// Independent exhaustive matcher preserves the previous ambiguity and scoring
// rules while the production path uses indexed lookup instead of all-pairs scans.
function exhaustiveTargets(tables: Array<{ schema: string; table: TableDefinition }>) {
  const candidates = tables.filter(({ table }) => table.primaryKey?.columns.includes("id"));
  return tables.flatMap(({ schema, table }) => table.columns.flatMap((column) => {
    if (!column.name.endsWith("_id") || table.foreignKeys.some((fk) => fk.columns.includes(column.name))) return [];
    const stem = column.name.slice(0, -3);
    const plural = stem.endsWith("y") ? `${stem.slice(0, -1)}ies` : `${stem}s`;
    const matches = candidates.filter(({ table: target }) => target.key.name === stem || target.key.name === plural || target.key.name.endsWith(`_${plural}`)).map((target) => {
      const left = table.key.name.split("_"); const right = target.table.key.name.split("_");
      let prefix = 0; while (left[prefix] && left[prefix] === right[prefix]) prefix += 1;
      return { target, score: prefix * 10 + (target.schema === schema ? 2 : 0) + ([stem, `${stem}s`].includes(target.table.key.name) ? 1 : 0) };
    }).sort((a, b) => b.score - a.score);
    if (!matches[0] || matches[0].score === matches[1]?.score) return [];
    return [`${schema}.${table.key.name}:${column.name}->${matches[0].target.schema}.${matches[0].target.table.key.name}`];
  }));
}

describe("large schema graph", () => {
  it.each([125, 1000])("builds every table, field and relationship for %i tables with the same inference results", (count) => {
    const snapshot = largeSchema(count);
    const tables = snapshot.schemas.flatMap((schema) => schema.tables.map((table) => ({ schema: schema.name, table })));
    const start = performance.now();
    const graph = buildSchemaGraph(snapshot, { includeInferredRelationships: true });
    const elapsed = performance.now() - start;
    expect(graph.nodes).toHaveLength(count);
    expect(graph.nodes.reduce((sum, node) => sum + node.data.table.columns.length, 0)).toBe(count * 20);
    expect(graph.edges).toHaveLength(count);
    expect(inferRelationships(tables).map((rel) => `${rel.sourceId}:${rel.column}->${rel.targetId}`)).toEqual(exhaustiveTargets(tables));
    console.info(`Graph benchmark: ${count} tables / ${count * 20} columns / ${graph.edges.length} relationships: ${elapsed.toFixed(1)} ms (graph construction, not frame rate)`);
  });

  it("preserves suffix, irregular plural, schema preference and ambiguity rules without treating declared keys as inferred", () => {
    const make = (schema: string, name: string) => {
      const table = diagramTable(name, [diagramColumn("id")]);
      table.key.schema = schema; table.primaryKey = { name: "pk", columns: ["id"] };
      return { schema, table };
    };
    const source = make("public", "tenant_orders");
    source.table.columns.push(...["user_id", "category_id", "order_id", "team_id", "owner_id"].map((name, index) => diagramColumn(name, index + 2)));
    source.table.foreignKeys.push(diagramForeignKey("owner_fk", "owner_id", "owners"));
    const tables = [source, make("public", "users"), make("archive", "users"), make("public", "tenant_users"), make("public", "categories"), make("public", "owners"), make("public", "sales_teams"), make("public", "billing_teams")];
    const inferred = inferRelationships(tables);
    expect(inferred.map((rel) => `${rel.sourceId}:${rel.column}->${rel.targetId}`)).toEqual(exhaustiveTargets(tables));
    expect(inferred.find((rel) => rel.column === "user_id")?.targetId).toBe("public.tenant_users");
    expect(inferred.find((rel) => rel.column === "category_id")?.targetId).toBe("public.categories");
    expect(inferred.some((rel) => rel.column === "team_id" || rel.column === "owner_id")).toBe(false);
  });

  it("retains edge identity when moving a table does not change its attachment sides", () => {
    const graph = buildSchemaGraph(largeSchema(125), { includeInferredRelationships: true });
    const first = orientFieldEdges(graph.edges, graph.nodes);
    const moved = graph.nodes.map((node, i) => i === 0 ? { ...node, position: { x: node.position.x + 1, y: node.position.y + 1 } } : node);
    const second = orientFieldEdges(first, moved);
    expect(second).toHaveLength(first.length);
    expect(second.every((edge, i) => edge === first[i])).toBe(true);
  });
});
