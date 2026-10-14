import type { DatabaseSnapshot, ObjectAnnotation, ObjectKey, SemanticBundle, TableDefinition } from "../platform";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);
const text = (value: string | null) => value === null ? '<span class="muted">Not specified</span>' : escapeHtml(value);
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
const keyOf = (schema: string, name: string) => JSON.stringify([schema, name]);
const quantity = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const annotationKey = (key: ObjectKey) => JSON.stringify([key.kind, key.schema, key.name]);
const cells = (values: string[]) => `<tr>${values.map((value) => `<td>${value}</td>`).join("")}</tr>`;
const grid = (label: string, headings: string[], rows: string[]) => rows.length
  ? `<div class="table-scroll"><table aria-label="${escapeHtml(label)}"><thead><tr>${headings.map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  : '<p class="muted">None in this snapshot.</p>';

const STYLE = `
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d2939; background: #f5f7fa; line-height: 1.5; }
* { box-sizing: border-box; } body { margin: 0; } main { max-width: 1240px; padding: 40px 32px 64px; margin: auto; }
h1 { font-size: 32px; margin: 4px 0 12px; } h2 { font-size: 24px; } h3 { font-size: 20px; margin-top: 0; } h4 { margin: 24px 0 8px; }
a { color: #175cd3; overflow-wrap: anywhere; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; overflow-wrap: anywhere; white-space: pre-wrap; }
p { white-space: pre-wrap; overflow-wrap: anywhere; } .eyebrow { color: #475467; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
.muted, .meta { color: #667085; } .scope { border-left: 3px solid #175cd3; padding-left: 16px; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0; } .badge { display: inline-block; background: #eef4ff; color: #1849a9; border: 1px solid #b2ccff; padding: 3px 9px; border-radius: 6px; font-size: 13px; }
.logical { color: #6941c6; background: #f4f3ff; border-color: #d9d6fe; } .inactive { color: #475467; background: #f2f4f7; border-color: #d0d5dd; }
nav, article, .domain { background: white; border: 1px solid #d0d5dd; border-radius: 10px; padding: 24px; margin: 20px 0; } nav ul { columns: 3 240px; padding-left: 20px; } nav li { break-inside: avoid; margin-bottom: 6px; }
article { scroll-margin-top: 20px; } .table-scroll { overflow-x: auto; } table { width: 100%; border-collapse: collapse; font-size: 14px; } th { text-align: left; background: #f2f4f7; } th, td { padding: 10px 12px; border: 1px solid #e4e7ec; vertical-align: top; overflow-wrap: anywhere; min-width: 90px; } td { white-space: pre-wrap; }
dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 6px 16px; } dt { color: #667085; } dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; } .semantic { border-left: 3px solid #6941c6; padding-left: 16px; margin: 16px 0; }
@media (max-width: 600px) { main { padding: 24px 12px; } article, nav, .domain { padding: 16px; } h1 { font-size: 26px; } dl { grid-template-columns: 1fr; } }
@media print { :root { background: white; } main { max-width: none; padding: 0; } nav { break-after: page; } article { border-radius: 0; } h2, h3, h4 { break-after: avoid; } tr { break-inside: avoid; } .table-scroll { overflow: visible; } table { font-size: 10px; } th, td { padding: 5px; min-width: 0; } }
`;

function semanticDetails(annotation?: ObjectAnnotation): string {
  if (!annotation) return "";
  return `<div class="semantic"><h4>Saved business semantics</h4><dl>
    <dt>Description</dt><dd>${text(annotation.description)}</dd>
    <dt>Owner</dt><dd>${text(annotation.owner)}</dd>
    <dt>Tags</dt><dd>${annotation.tags.map(escapeHtml).join(", ") || "None"}</dd>
    <dt>Core object</dt><dd>${annotation.isCore ? "Yes" : "No"}</dd>
    <dt>Updated</dt><dd>${escapeHtml(annotation.updatedAt)}</dd></dl></div>`;
}

/** One loaded snapshot, with an explicit metadata allowlist. Never serialize the workspace bundle. */
export function createSchemaReport(snapshot: DatabaseSnapshot, semantics: SemanticBundle): { html: string; tableCount: number; columnCount: number } {
  const tables = new Map<string, { table: TableDefinition; anchor: string }>();
  const annotations = new Map(semantics.annotations.filter((item) => item.sourceId === snapshot.sourceId)
    .map((item) => [annotationKey(item.objectKey), item]));
  const tableGroups = new Map<string, string[]>();
  let columnCount = 0;
  snapshot.schemas.forEach((schema, schemaIndex) => schema.tables.forEach((table, tableIndex) => {
    tables.set(keyOf(table.key.schema, table.key.name), { table, anchor: `table-${schemaIndex}-${tableIndex}` });
    columnCount += table.columns.length;
  }));
  const tableLink = (schema: string, name: string) => {
    const item = tables.get(keyOf(schema, name));
    return item ? `<a href="#${item.anchor}">${code(`${schema}.${name}`)}</a>`
      : `${code(`${schema}.${name}`)} <span class="muted">(not in this snapshot)</span>`;
  };
  const endpoint = (schema: string, name: string, columns: string[]) => {
    const item = tables.get(keyOf(schema, name));
    const missing = item && columns.some((column) => !item.table.columns.some((field) => field.name === column));
    return `${tableLink(schema, name)} (${columns.map(code).join(", ")})${missing ? ' <span class="muted">(column unavailable)</span>' : ""}`;
  };
  const groups = semantics.domainGroups.filter((group) => group.sourceId === snapshot.sourceId).flatMap((group) => {
    const members = group.tableKeys.filter((key) => key.kind === "table" && tables.has(keyOf(key.schema, key.name)));
    if (!members.length) return [];
    members.forEach((key) => {
      const id = keyOf(key.schema, key.name);
      tableGroups.set(id, [...(tableGroups.get(id) ?? []), group.name]);
    });
    return [`<div class="domain"><h3>${escapeHtml(group.name)}</h3><p>${text(group.description)}</p><p>${members.map((key) => tableLink(key.schema, key.name)).join(" · ")}</p><small class="muted">Updated ${escapeHtml(group.updatedAt)}</small></div>`];
  });
  const relationships = semantics.logicalRelationships.filter((relationship) => relationship.sourceId === snapshot.sourceId);
  const cardinalities = { oneToOne: "One to one", oneToMany: "One to many", manyToOne: "Many to one", manyToMany: "Many to many", unspecified: "Unspecified" };
  const statuses = { active: "Active", disabled: "Disabled", orphaned: "Orphaned", conflicted: "Conflicted", supersededByPhysical: "Superseded by physical FK" };
  const origins = { manual: "Manual", confirmedInference: "Confirmed inference", imported: "Imported" };
  const logicalReport = relationships.map((relationship, index) => `<article id="logical-${index}">
    <h3>${escapeHtml(relationship.name)}</h3><span class="badge logical">Saved logical relationship</span> <span class="badge${relationship.status === "active" ? " logical" : " inactive"}">${escapeHtml(statuses[relationship.status])}</span>
    <p>${endpoint(relationship.source.schema, relationship.source.table, relationship.source.columns)} → ${endpoint(relationship.target.schema, relationship.target.table, relationship.target.columns)}</p>
    <dl><dt>Cardinality</dt><dd>${escapeHtml(cardinalities[relationship.cardinality])}</dd><dt>Origin</dt><dd>${escapeHtml(origins[relationship.origin])}</dd>
    <dt>Note</dt><dd>${text(relationship.note)}</dd><dt>Evidence</dt><dd>${relationship.evidence.map(escapeHtml).join("\n") || "None"}</dd><dt>Updated</dt><dd>${escapeHtml(relationship.updatedAt)}</dd></dl></article>`).join("");

  const contents = snapshot.schemas.map((schema, schemaIndex) => `<li><a href="#schema-${schemaIndex}">${escapeHtml(schema.name)}</a>
    <ul>${schema.tables.map((table, index) => `<li><a href="#table-${schemaIndex}-${index}">${escapeHtml(table.key.name)}</a> · table</li>`).join("")}
    ${schema.views.map((view, index) => `<li><a href="#view-${schemaIndex}-${index}">${escapeHtml(view.key.name)}</a> · ${view.materialized ? "materialized view" : "view"}</li>`).join("")}
    ${schema.enums.map((item, index) => `<li><a href="#enum-${schemaIndex}-${index}">${escapeHtml(item.key.name)}</a> · enum</li>`).join("")}</ul></li>`).join("");
  const schemaReport = snapshot.schemas.map((schema, schemaIndex) => {
    const tableReport = schema.tables.map((table, tableIndex) => {
      const businessGroups = tableGroups.get(keyOf(table.key.schema, table.key.name)) ?? [];
      const related = relationships.flatMap((relationship, index) =>
        (relationship.source.schema === table.key.schema && relationship.source.table === table.key.name)
        || (relationship.target.schema === table.key.schema && relationship.target.table === table.key.name)
          ? [`<a href="#logical-${index}">${escapeHtml(relationship.name)}</a> (${escapeHtml(statuses[relationship.status])})`] : []);
      return `<article id="table-${schemaIndex}-${tableIndex}"><h3>${escapeHtml(`${table.key.schema}.${table.key.name}`)}</h3>
      <span class="badge">${escapeHtml(table.tableKind)} table</span><p>${text(table.comment)}</p>
      ${businessGroups.length ? `<p>Business domains: ${businessGroups.map(escapeHtml).join(", ")}</p>` : ""}
      ${semanticDetails(annotations.get(annotationKey(table.key)))}
      <h4>Columns (${table.columns.length})</h4>${grid("Columns", ["#", "Name", "Type", "Nullable", "Default", "Identity / generated", "Comment / semantics"], table.columns.map((column) => cells([
        escapeHtml(column.ordinalPosition), code(column.name), `${code(column.formattedType)}<br><small class="muted">${escapeHtml(`${column.typeSchema}.${column.typeName}`)}</small>`, column.nullable ? "Yes" : "No",
        column.defaultValue === null ? '<span class="muted">Not specified</span>' : code(column.defaultValue),
        [column.identity === "always" ? "Identity always" : column.identity === "byDefault" ? "Identity by default" : "", column.generated ? "Generated" : ""].filter(Boolean).join(" · ") || "None",
        `${text(column.comment)}${semanticDetails(annotations.get(annotationKey({ kind: "column", schema: `${table.key.schema}.${table.key.name}`, name: column.name })))}`,
      ])))}
      <h4>Primary key</h4>${table.primaryKey ? `<p>${code(table.primaryKey.name)} (${table.primaryKey.columns.map(code).join(", ")})</p>` : '<p class="muted">None in this snapshot.</p>'}
      <h4>Physical foreign keys (${table.foreignKeys.length})</h4>${grid("Physical foreign keys", ["Name", "Columns", "References", "On update / delete", "Match / deferral"], table.foreignKeys.map((foreignKey) => cells([
        code(foreignKey.name), foreignKey.columns.map(code).join(", "), endpoint(foreignKey.referencedSchema, foreignKey.referencedTable, foreignKey.referencedColumns),
        `${escapeHtml(foreignKey.onUpdate)} / ${escapeHtml(foreignKey.onDelete)}`, `${escapeHtml(foreignKey.matchType)} · ${foreignKey.deferrable ? "Deferrable" : "Not deferrable"} · ${foreignKey.initiallyDeferred ? "Initially deferred" : "Initially immediate"}`,
      ])))}
      <h4>Indexes (${table.indexes.length})</h4>${grid("Indexes", ["Name", "Method", "Columns / expressions", "Unique", "Primary", "Predicate"], table.indexes.map((index) => cells([
        code(index.name), escapeHtml(index.method), index.columns.map(code).join(", "), index.unique ? "Yes" : "No", index.primary ? "Yes" : "No", text(index.predicate),
      ])))}
      <h4>Other constraints (${table.constraints.length})</h4>${grid("Other constraints", ["Name", "Kind", "Definition"], table.constraints.map((constraint) => cells([code(constraint.name), escapeHtml(constraint.constraintType), code(constraint.definition)])))}
      ${related.length ? `<h4>Saved logical relationships</h4><p>${related.join("<br>")}</p>` : ""}<p><a href="#contents">Back to contents</a></p></article>`;
    }).join("");
    return `<section aria-labelledby="schema-${schemaIndex}"><h2 id="schema-${schemaIndex}">Schema ${escapeHtml(schema.name)}</h2>${!schema.tables.length && !schema.views.length && !schema.enums.length ? '<p class="muted">No objects in this schema.</p>' : ""}${tableReport}
      ${schema.views.map((view, index) => `<article id="view-${schemaIndex}-${index}"><h3>${escapeHtml(`${view.key.schema}.${view.key.name}`)}</h3><span class="badge">${view.materialized ? "Materialized view" : "View"}</span><p>${text(view.comment)}</p>${semanticDetails(annotations.get(annotationKey(view.key)))}<h4>Definition</h4><pre>${escapeHtml(view.definition)}</pre><p><a href="#contents">Back to contents</a></p></article>`).join("")}
      ${schema.enums.map((item, index) => `<article id="enum-${schemaIndex}-${index}"><h3>${escapeHtml(`${item.key.schema}.${item.key.name}`)}</h3><span class="badge">Enum</span>${semanticDetails(annotations.get(annotationKey(item.key)))}<h4>Values (declared order)</h4><ol>${item.values.map((value) => `<li>${code(value)}</li>`).join("")}</ol><p><a href="#contents">Back to contents</a></p></article>`).join("")}</section>`;
  }).join("");
  const count = (kind: "views" | "enums") => snapshot.schemas.reduce((total, schema) => total + schema[kind].length, 0);
  const foreignKeyCount = [...tables.values()].reduce((total, { table }) => total + table.foreignKeys.length, 0);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(snapshot.database.name)} — Schema report</title><style>${STYLE}</style></head><body><main>
    <header><p class="eyebrow">Nodal Studio · Data dictionary</p><h1>${escapeHtml(snapshot.database.name)}</h1>
    <p class="meta">${snapshot.database.databaseType === "postgreSql" ? "PostgreSQL" : "MySQL"} ${escapeHtml(snapshot.database.version)} · Captured ${escapeHtml(snapshot.capturedAt)}</p>
    <p>Snapshot fingerprint: ${code(snapshot.fingerprint)}</p>
    <div class="summary">${[quantity(snapshot.schemas.length, "schema"), quantity(tables.size, "table"), quantity(columnCount, "column"), quantity(count("views"), "view"), quantity(count("enums"), "enum")].map((label) => `<span class="badge">${label}</span>`).join("")}</div>
    <div class="scope"><p>Single snapshot: all objects available in the loaded snapshot, independent of Diagram filters. Shared reports contain only metadata available to the viewer.</p><p>Business semantics are the current saved annotations and domains, not historical versions at the snapshot capture time. No orphaned annotations or unconfirmed relationship candidates are included.</p></div>
    <p><span class="badge">Physical FK · ${foreignKeyCount}</span> Database constraints from the snapshot. <span class="badge logical">Saved logical · ${relationships.length}</span> User-confirmed semantic links; do not create database constraints. Inactive statuses are listed explicitly.</p></header>
    <nav id="contents" aria-label="Report contents"><h2>Contents</h2><p class="muted">Use your browser’s Find command to search this offline report.</p><ul>${contents}<li><a href="#domains">Business domains</a></li><li><a href="#logical-relationships">Saved logical relationships</a></li></ul></nav>
    ${schemaReport || '<p class="muted">No schemas in this snapshot.</p>'}
    <section id="domains"><h2>Business domains</h2><p class="muted">Only members present in this snapshot are listed.</p>${groups.join("") || '<p class="muted">None attached to this snapshot.</p>'}</section>
    <section id="logical-relationships"><h2>Saved logical relationships</h2><p>These are saved semantic relationships, not physical constraints. Unconfirmed inference candidates are excluded.</p>${logicalReport || '<p class="muted">None saved.</p>'}</section>
    <footer><p class="muted">Generated by Nodal Studio. This self-contained report includes schema metadata and saved semantics only.</p></footer></main></body></html>`;
  assertReportSize(html);
  return { html, tableCount: tables.size, columnCount };
}

export function assertReportSize(html: string): void {
  if (new TextEncoder().encode(html).byteLength > MAX_REPORT_BYTES) throw new Error("The schema report must be smaller than 32 MB. Reduce the snapshot scope and try again.");
}

export function schemaReportFileName(snapshot: DatabaseSnapshot): string {
  const name = snapshot.database.name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "database";
  const fingerprint = snapshot.fingerprint.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "snapshot";
  return `${name}-schema-report-${fingerprint}.html`;
}
