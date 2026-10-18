// Offline acceptance against a locally captured metadata snapshot; no network or writes to DBs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { discoverTables, knownRelationships, findKnownPath, neighborhood, objectId } from "../apps/frontend/src/graph/business-discovery.ts";

const [snapshotPath, reportPath, casesPath] = process.argv.slice(2);
if (!snapshotPath || !reportPath) throw new Error("Usage: node Scripts/evaluate_ai_catalog.mjs snapshot.json report.json [questions.json]");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const tables = snapshot.schemas.flatMap((s) => s.tables);
const start = performance.now();
let exactTopFive = 0;
for (const table of tables) {
  const candidates = discoverTables(snapshot, `${table.key.schema}.${table.key.name}`, [], true);
  assert(candidates.some((c) => objectId(c.table.key) === objectId(table.key)), "every actual table is discoverable");
  if (candidates.slice(0, 5).some((c) => objectId(c.table.key) === objectId(table.key))) exactTopFive++;
  assert(candidates.every((c) => tables.includes(c.table)), "no fabricated objects");
}
assert.equal(discoverTables(snapshot, "qzxv_nonexistent_acceptance_9f481", [], true).length, 0);
const { relationships, gaps } = knownRelationships(snapshot, []);
assert.equal(gaps.length, 0, "all real FK endpoints should resolve");
assert.equal(relationships.length, tables.reduce((n, t) => n + t.foreignKeys.length, 0));
let paths = 0;
for (const relation of relationships) {
  if (objectId(relation.source) === objectId(relation.target)) continue;
  const path = findKnownPath(relation.source, relation.target, relationships);
  assert(path && path.relationships.length === 1);
  const local = neighborhood(snapshot, relation.source, relationships, 2, path);
  const localTables = local.snapshot.schemas.flatMap((s) => s.tables);
  assert(localTables.some((t) => objectId(t.key) === objectId(relation.source)));
  assert(localTables.some((t) => objectId(t.key) === objectId(relation.target)));
  paths++;
}
const questions = casesPath ? JSON.parse(await readFile(casesPath, "utf8")) : [];
const questionResults = questions.map((item) => {
  const started = performance.now();
  const candidates = discoverTables(snapshot, item.question, [], true);
  const names = candidates.slice(0, 5).map((c) => `${c.table.key.schema}.${c.table.key.name}`);
  return { ...item, topFive: names, expectedInTopFive: (item.expectedTables ?? []).some((n) => names.includes(n)),
    milliseconds: performance.now() - started, resultCount: candidates.length };
});
const report = { tables: tables.length, exactNameTopFive: exactTopFive, physicalRelationships: relationships.length,
  distinctTablePathsChecked: paths, milliseconds: performance.now() - start,
  businessLabels: "provisional structure-based candidates, awaiting project-owner review", questions: questionResults };
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ...report, questions: questionResults.map(({ id, expectedInTopFive, resultCount }) => ({ id, expectedInTopFive, resultCount })) }));
