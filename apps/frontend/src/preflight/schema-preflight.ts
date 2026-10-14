import type { ColumnDefinition, DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform/types";

export type PreflightOutcome = "design" | "suspected" | "insufficient" | "style";
export interface PreflightFinding {
  id: string;
  ruleId: string;
  severity: "suggestion" | "warning" | "info";
  outcome: PreflightOutcome;
  objectKey: ObjectKey;
  tableKey: TableDefinition["key"];
  relatedTables: TableDefinition["key"][];
  message: string;
  evidence: string[];
  recommendation: string;
}
export interface PreflightCoverage {
  ruleId: string;
  name: string;
  status: "checked" | "partial" | "skipped";
  checked: number;
  incomplete: number;
  skipped: number;
  explanation: string;
}
export interface PreflightReport {
  dialect: string;
  tableCount: number;
  columnCount: number;
  foreignKeyCount: number;
  excludedViewCount: number;
  findings: PreflightFinding[];
  coverage: PreflightCoverage[];
}
const tableId = (key: { schema: string; name: string }) => JSON.stringify([key.schema, key.name]);
const pgFamilies: Record<string, string> = {
  int2: "numeric", int4: "numeric", int8: "numeric", numeric: "numeric", float4: "numeric", float8: "numeric",
  text: "string", varchar: "string", bpchar: "string", name: "string",
  timestamp: "temporal", timestamptz: "temporal", date: "temporal", time: "temporal", timetz: "temporal",
  uuid: "uuid", bool: "boolean", bytea: "binary",
};
const mysqlIntegers = new Set(["tinyint", "smallint", "mediumint", "int", "bigint"]);
const mysqlStrings = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext"]);
const mysqlName = (name: string) => ({ integer: "int", numeric: "decimal", dec: "decimal" })[name.toLowerCase() as "integer" | "numeric" | "dec"] ?? name.toLowerCase();

/** Metadata observations only. A captured physical FK is never declared invalid by this checker. */
export function runSchemaPreflight(snapshot: DatabaseSnapshot, options: { nameSpaces?: boolean } = {}): PreflightReport {
  const tables = snapshot.schemas.flatMap((schema) => schema.tables);
  const lookup = new Map(tables.map((table) => [tableId(table.key), table]));
  const columns = new Map(tables.map((table) => [tableId(table.key), new Map(table.columns.map((column) => [column.name, column]))]));
  const findings: PreflightFinding[] = [];
  const coverage: PreflightCoverage[] = [];
  const add = (ruleId: string, table: TableDefinition, object: string | undefined, detail: string, outcome: PreflightOutcome, message: string, evidence: string[], recommendation: string, relatedTables: TableDefinition["key"][] = []) => {
    findings.push({ id: JSON.stringify([ruleId, table.key.schema, table.key.name, object ?? null, detail]), ruleId,
      severity: outcome === "suspected" ? "warning" : outcome === "design" ? "suggestion" : "info", outcome,
      objectKey: object === undefined ? table.key : { kind: "constraint", schema: `${table.key.schema}.${table.key.name}`, name: object },
      tableKey: table.key, relatedTables, message, evidence, recommendation });
  };
  const rule = (ruleId: string, name: string, explanation: string, enabled = true): PreflightCoverage => {
    const result: PreflightCoverage = { ruleId, name, status: "skipped", checked: 0, incomplete: 0, skipped: 0, explanation };
    coverage.push(result);
    if (!enabled) result.skipped = tables.reduce((count, table) => count + table.foreignKeys.length, 0);
    return result;
  };
  const pk = rule("table-primary-key", "Primary key presence", "Ordinary and partitioned tables only. A missing primary key is a design suggestion; foreign tables and views are outside this rule.");
  const references = rule("key-references", "Key references", "Checks captured PK/FK column lists and endpoints. A target absent from this snapshot may be outside introspection scope; it is not proof of a dangling database constraint.");
  const pg = rule("postgres-fk-types", "PostgreSQL FK types", snapshot.database.databaseType === "postgreSql"
    ? "Checks captured built-in type identities and flags different known type families for review. Cross-type operators, casts, domains, collation and constraint validation state are not captured."
    : "Not applicable: this is not a PostgreSQL snapshot.", snapshot.database.databaseType === "postgreSql");
  const mysql = rule("mysql-fk-types", "MySQL FK types", snapshot.database.databaseType === "mySql"
    ? "Checks integer size/sign and DECIMAL precision/scale/sign. String length alone is not a mismatch. Character set, collation, storage engine and server-specific restrictions are not captured."
    : "Not applicable: this is not a MySQL snapshot.", snapshot.database.databaseType === "mySql");
  const names = rule("name-spaces", "Names containing whitespace", options.nameSpaces ? "Optional style hint for table and column names. Quoted identifiers containing whitespace are legal; this is not a database error." : "Disabled by default. Enable the optional table/column naming style hint.");

  for (const table of tables) {
    const ownColumns = columns.get(tableId(table.key))!;
    if (table.tableKind === "foreign") pk.skipped++;
    else {
      pk.checked++;
      if (!table.primaryKey) add(pk.ruleId, table, undefined, "missing", "design", "No primary key is captured for this table.", [`Table kind: ${table.tableKind}`, "Snapshot primaryKey: absent"], "Review whether this table needs a stable row identifier. A primary key is optional; views and some analytical tables use other designs.");
    }
    if (table.primaryKey) {
      const key = table.primaryKey;
      references.checked++;
      const missing = key.columns.filter((name) => !ownColumns.has(name));
      if (!key.columns.length || new Set(key.columns).size !== key.columns.length || missing.length) add(references.ruleId, table, key.name, "pk-columns", "suspected", "The captured primary key column list is inconsistent with the table metadata.", [`Primary key columns: ${JSON.stringify(key.columns)}`, `Missing columns: ${JSON.stringify(missing)}`], "Refresh metadata or review capture coverage before drawing conclusions about the live database.");
    }
    if (options.nameSpaces) {
      names.checked += 1 + table.columns.length;
      for (const { name, isTable } of [{ name: table.key.name, isTable: true }, ...table.columns.map((column) => ({ name: column.name, isTable: false }))]) if (/\s/u.test(name)) {
        add(names.ruleId, table, undefined, JSON.stringify([isTable ? "table" : "column", name]), "style", "This name contains whitespace and may require quoting in SQL.", [`${isTable ? "Table" : "Column"} name: ${JSON.stringify(name)}`], "Keep quoted names if intentional, or follow your team's naming convention. No rename is performed.");
        if (!isTable) findings.at(-1)!.objectKey = { kind: "column", schema: `${table.key.schema}.${table.key.name}`, name };
      }
    }
    for (const fk of table.foreignKeys) {
      const target = lookup.get(tableId({ schema: fk.referencedSchema, name: fk.referencedTable }));
      const targetColumns = target ? columns.get(tableId(target.key)) : undefined;
      const absentSource = fk.columns.filter((name) => !ownColumns.has(name));
      const absentTarget = target ? fk.referencedColumns.filter((name) => !targetColumns!.has(name)) : [];
      const validLists = fk.columns.length > 0 && fk.columns.length === fk.referencedColumns.length
        && new Set(fk.columns).size === fk.columns.length && new Set(fk.referencedColumns).size === fk.referencedColumns.length;
      const evidence = [`Foreign key: ${fk.name}`, `Source columns: ${JSON.stringify(fk.columns)}`, `Target: ${JSON.stringify([fk.referencedSchema, fk.referencedTable])}`, `Target columns: ${JSON.stringify(fk.referencedColumns)}`];
      if (target) references.checked++;
      if (!validLists || absentSource.length || absentTarget.length) add(references.ruleId, table, fk.name, "fk-columns", "suspected", "The captured foreign key column lists are inconsistent.", [...evidence, `Missing source columns: ${JSON.stringify(absentSource)}`, `Missing target columns: ${JSON.stringify(absentTarget)}`], "Review the captured column lists and refresh metadata. A snapshot inconsistency does not establish that a physical constraint is invalid.", target ? [target.key] : []);
      if (!target) {
        references.incomplete++;
        add(references.ruleId, table, fk.name, "target-unavailable", "insufficient", "The referenced table is outside the loaded snapshot.", evidence, "Capture the referenced schema/table to inspect it. Cross-schema references can be valid even when their target is not captured.");
      }
      const types = snapshot.database.databaseType === "postgreSql" ? pg : snapshot.database.databaseType === "mySql" ? mysql : undefined;
      if (!types) continue;
      if (!validLists || absentSource.length || absentTarget.length || !target) { types.incomplete++; continue; }
      fk.columns.forEach((name, index) => {
        const source = ownColumns.get(name)!;
        const dest = targetColumns!.get(fk.referencedColumns[index])!;
        const comparison = snapshot.database.databaseType === "postgreSql" ? comparePostgres(source, dest) : compareMysql(source, dest);
        if (comparison.outcome === "insufficient") types.incomplete++; else types.checked++;
        if (comparison.outcome) add(types.ruleId, table, fk.name, `pair-${index}`, comparison.outcome, comparison.message,
          [...evidence, `Pair ${index + 1}: ${JSON.stringify(name)} → ${JSON.stringify(dest.name)}`, `Source type: ${source.typeSchema}.${source.typeName} (${source.formattedType})`, `Target type: ${dest.typeSchema}.${dest.typeName} (${dest.formattedType})`], comparison.recommendation, [target.key]);
      });
    }
  }
  for (const item of coverage) item.status = item.incomplete ? "partial" : item.checked ? "checked" : "skipped";
  const rank = { warning: 0, suggestion: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));
  return { dialect: snapshot.database.databaseType === "postgreSql" ? "PostgreSQL" : snapshot.database.databaseType === "mySql" ? "MySQL" : "Unsupported dialect",
    tableCount: tables.length, columnCount: tables.reduce((count, table) => count + table.columns.length, 0), foreignKeyCount: tables.reduce((count, table) => count + table.foreignKeys.length, 0),
    excludedViewCount: snapshot.schemas.reduce((count, schema) => count + schema.views.length, 0), findings, coverage };
}
interface TypeComparison { outcome?: "suspected" | "insufficient"; message: string; recommendation: string }
const unknown = (message: string): TypeComparison => ({ outcome: "insufficient", message, recommendation: "Review catalog metadata and the existing physical constraint on the database. This snapshot cannot establish complete foreign key compatibility." });
const suspect = (message: string): TypeComparison => ({ outcome: "suspected", message, recommendation: "Review these captured type differences and refresh metadata. Existing physical constraints may rely on details not captured here; no invalidity or repair is inferred." });
const agrees: TypeComparison = { message: "Available type metadata agrees.", recommendation: "" };

function comparePostgres(a: ColumnDefinition, b: ColumnDefinition): TypeComparison {
  if (a.typeSchema !== "pg_catalog" || b.typeSchema !== "pg_catalog") return unknown("PostgreSQL domain or custom-type compatibility needs catalog information absent from this snapshot.");
  const left = pgFamilies[a.typeName]; const right = pgFamilies[b.typeName];
  if (!left || !right) return unknown("These PostgreSQL types need catalog/operator information absent from this snapshot.");
  if (a.typeName === b.typeName) return agrees;
  if (left === right) return unknown("Different PostgreSQL types may support cross-type comparisons; the required operators and casts are not captured.");
  return suspect("The captured PostgreSQL columns belong to different built-in type families.");
}
function compareMysql(a: ColumnDefinition, b: ColumnDefinition): TypeComparison {
  const left = mysqlName(a.typeName); const right = mysqlName(b.typeName);
  if (a.typeSchema !== "mysql" || b.typeSchema !== "mysql") return unknown("MySQL type metadata is not identified as MySQL catalog data.");
  if (mysqlStrings.has(left) && mysqlStrings.has(right)) return unknown("MySQL character foreign keys require matching character set and collation; neither is captured. String length differences alone are not a mismatch.");
  const sign = (column: ColumnDefinition) => /\b(?:unsigned|zerofill)\b/i.test(column.formattedType);
  if (mysqlIntegers.has(left) && mysqlIntegers.has(right)) {
    if ([a, b].some((column) => mysqlName(column.formattedType.trim().match(/^([a-z]+)/i)?.[1] ?? "") !== mysqlName(column.typeName))) return unknown("MySQL integer formatted types are missing or inconsistent; signedness cannot be established.");
    return left === right && sign(a) === sign(b) ? agrees : suspect("MySQL integer foreign key columns differ in storage size or signedness; display width is ignored.");
  }
  if (left === "decimal" && right === "decimal") {
    const precision = (column: ColumnDefinition) => column.formattedType.match(/^(?:decimal|numeric|dec)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/i)?.slice(1).join(",");
    const p = precision(a); const q = precision(b);
    if (!p || !q) return unknown("MySQL DECIMAL precision/scale is not available in the captured formatted types.");
    return p === q && sign(a) === sign(b) ? agrees : suspect("MySQL DECIMAL foreign key columns differ in precision, scale or signedness.");
  }
  return unknown("This MySQL type pair is outside the first version's integer/DECIMAL checks; compatibility cannot be determined from this snapshot.");
}
