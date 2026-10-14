import type { ColumnDefinition, ForeignKeyDefinition, IndexDefinition, SchemaDefinition, TableDefinition } from "../platform/types";
import { scanDdl, type Token, type Unit } from "./ddl-lexer";
import { ddlLimits, type DdlDiagnostic, type DdlLocation, type DdlRequest, type SourceRange } from "./ddl-types";
const range = (value: SourceRange): SourceRange => ({ start: value.start, end: value.end, line: value.line, column: value.column });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const key = (schema: string, name: string) => JSON.stringify([schema, name]);
const keyword = (token: Token | undefined, word: string) => token?.kind === "word" && token.value.toUpperCase() === word;
const columnMatch = (a: string, b: string, request: DdlRequest) => request.dialect === "mySql" ? a.toLowerCase() === b.toLowerCase() : a === b;
const columnName = (table: TableDefinition, name: string, request: DdlRequest) => table.columns.find((column) => columnMatch(column.name, name, request))?.name ?? name;
class Cursor {
  at = 0;
  constructor(readonly tokens: Token[], readonly request: DdlRequest) {}
  peek() { return this.tokens[this.at]; }
  take(word: string) { if (keyword(this.peek(), word) || this.peek()?.kind === "symbol" && this.peek().value === word) { this.at++; return true; } return false; }
  need(word: string) { if (!this.take(word)) throw new Error(`Expected ${word}; this statement was omitted.`); }
  identifier() { const token = this.tokens[this.at++]; if (!token || !["word", "identifier"].includes(token.kind) || !token.value || token.kind === "word" && /^\d/u.test(token.value)) throw new Error("Expected an identifier; statement omitted."); if (token.kind === "identifier" && this.request.dialect === "postgreSql" && this.request.text[token.start] === "`") throw new Error("Backtick identifiers require the MySQL dialect."); if (token.kind === "identifier" && this.request.dialect === "mySql" && this.request.text[token.start] === '"') throw new Error("Double-quoted MySQL identifiers need ANSI_QUOTES, which this preview does not assume. Use backticks."); return this.request.dialect === "postgreSql" && token.kind === "word" ? token.value.toLowerCase() : token.value; }
  name(namespace = this.request.defaultSchema) { const first = this.identifier(); return this.take(".") ? { schema: first, name: this.identifier() } : { schema: namespace, name: first }; }
  group(): Token[] { this.need("("); const start = this.at; let depth = 1; while (this.at < this.tokens.length) { const token = this.tokens[this.at++]; if (token.kind === "symbol") { if (token.value === "(") depth++; if (token.value === ")" && --depth === 0) return this.tokens.slice(start, this.at - 1); } } throw new Error("Unterminated parenthesized list; statement omitted."); }
  columns() { const parts = split(this.group()); return parts.map((part) => { const cursor = new Cursor(part, this.request); const name = cursor.identifier(); cursor.end(); return name; }); }
  end() { if (this.peek()) throw new Error("Unsupported trailing syntax; statement omitted."); }
}
function split(tokens: Token[]): Token[][] {
  const parts: Token[][] = []; let start = 0; let depth = 0;
  tokens.forEach((token, index) => { if (token.kind !== "symbol") return; if (token.value === "(") depth++; else if (token.value === ")") depth--; else if (token.value === "," && !depth) { parts.push(tokens.slice(start, index)); start = index + 1; } });
  parts.push(tokens.slice(start)); if (parts.some((part) => !part.length)) throw new Error("Empty definition/list entry; statement omitted."); return parts;
}
function textOf(tokens: Token[]) { return tokens.map((token) => token.kind === "string" ? `'${token.value.replaceAll("'", "''")}'` : token.kind === "identifier" ? `"${token.value.replaceAll('"', '""')}"` : token.kind === "word" ? token.value.toLowerCase() : token.value).join(" "); }
const attrs = new Set(["NOT", "NULL", "PRIMARY", "UNIQUE", "REFERENCES", "DEFAULT", "CHECK", "CONSTRAINT", "COMMENT", "AUTO_INCREMENT", "GENERATED", "COLLATE", "AS", "ON"]);
function column(cursor: Cursor, position: number): ColumnDefinition {
  const name = cursor.identifier(); const start = cursor.at; cursor.identifier();
  if (cursor.take(".")) cursor.identifier();
  // Multiword built-in spellings are consumed only after a recognized leading type.
  const leading = cursor.tokens[start].value.toUpperCase();
  if (["CHARACTER", "CHAR", "BIT"].includes(leading)) cursor.take("VARYING");
  if (leading === "DOUBLE") { if (cursor.request.dialect === "postgreSql") cursor.need("PRECISION"); else cursor.take("PRECISION"); }
  if (cursor.peek()?.value === "(") cursor.group();
  if (["TIME", "TIMESTAMP"].includes(leading) && (cursor.take("WITH") || cursor.take("WITHOUT"))) { cursor.need("TIME"); cursor.need("ZONE"); }
  while (cursor.take("[")) cursor.need("]");
  if (cursor.request.dialect === "mySql") { cursor.take("UNSIGNED"); cursor.take("ZEROFILL"); }
  const type = cursor.tokens.slice(start, cursor.at);
  return { name, ordinalPosition: position, formattedType: textOf(type), typeSchema: "ddl", typeName: leading.toLowerCase(), nullable: true, defaultValue: null, identity: null, generated: false, comment: null };
}
function fk(cursor: Cursor, name: string, columns: string[], tableSchema: string): ForeignKeyDefinition {
  cursor.need("REFERENCES"); const target = cursor.name(cursor.request.dialect === "mySql" ? tableSchema : cursor.request.defaultSchema); const referencedColumns = cursor.columns();
  const result: ForeignKeyDefinition = { name, columns, referencedSchema: target.schema, referencedTable: target.name, referencedColumns, onUpdate: "noAction", onDelete: "noAction", matchType: "simple", deferrable: false, initiallyDeferred: false };
  while (cursor.peek()) {
    if (cursor.take("ON")) {
      const update = cursor.take("UPDATE"); if (!update) cursor.need("DELETE"); let action: string;
      if (cursor.take("NO")) { cursor.need("ACTION"); action = "noAction"; } else if (cursor.take("SET")) { if (cursor.take("NULL")) action = "setNull"; else { cursor.need("DEFAULT"); action = "setDefault"; } }
      else if (cursor.take("CASCADE")) action = "cascade"; else { cursor.need("RESTRICT"); action = "restrict"; }
      result[update ? "onUpdate" : "onDelete"] = action;
    } else if (cursor.request.dialect === "postgreSql" && cursor.take("MATCH")) { if (cursor.take("FULL")) result.matchType = "full"; else { cursor.need("SIMPLE"); result.matchType = "simple"; } }
    else if (cursor.request.dialect === "postgreSql" && cursor.take("DEFERRABLE")) result.deferrable = true;
    else if (cursor.request.dialect === "postgreSql" && keyword(cursor.peek(), "NOT") && keyword(cursor.tokens[cursor.at + 1], "DEFERRABLE")) { cursor.at += 2; }
    else if (cursor.request.dialect === "postgreSql" && cursor.take("INITIALLY")) { if (cursor.take("DEFERRED")) result.initiallyDeferred = true; else cursor.need("IMMEDIATE"); }
    else break;
  }
  if (columns.length !== referencedColumns.length) throw new Error("Foreign key column counts differ; statement omitted."); return result;
}
function index(name: string, columns: string[], unique: boolean, primary = false, method = "btree"): IndexDefinition { return { name, columns, unique, primary, method, predicate: null }; }
export interface ParsedDdl { schemas: SchemaDefinition[]; diagnostics: DdlDiagnostic[]; locations: DdlLocation[]; coverage: { accepted: number; skipped: number; errors: number; warnings: number } }
export function parseDdl(request: DdlRequest): ParsedDdl {
  if (!["postgreSql", "mySql"].includes(request.dialect)) throw new Error("Choose PostgreSQL or MySQL explicitly.");
  if (!request.defaultSchema.trim() || request.defaultSchema.length > 128) throw new Error("Default namespace must contain 1–128 characters.");
  if (new TextEncoder().encode(request.text).length > ddlLimits.bytes) throw new Error("Input exceeds the 1 MiB preview limit.");
  const scanned = scanDdl(request.text, request.dialect); const diagnostics = [...scanned.diagnostics]; const locations: DdlLocation[] = [];
  const tables = new Map<string, TableDefinition>(); const pendingIndexes: { table: { schema: string; name: string }; index: IndexDefinition; unit: Unit }[] = [];
  let accepted = 0; let skipped = 0; let columnCount = 0;
  const diagnostic = (unit: Unit, level: DdlDiagnostic["level"], code: string, message: string) => diagnostics.push({ ...range(unit), statement: unit.number, level, code, message });
  for (const unit of scanned.units) {
    const cursor = new Cursor(unit.tokens, request);
    try {
      if (unit.blocked) { if (unit.blocked.startsWith("Unbalanced")) throw new Error(unit.blocked); skipped++; diagnostic(unit, "warning", "unsupported-region", unit.blocked); continue; }
      if (!cursor.take("CREATE")) { skipped++; diagnostic(unit, "warning", "unsupported-statement", "Non-CREATE statement omitted. DML, COPY data, ALTER, SET and namespace directives are not executed or added to the model."); continue; }
      if (cursor.take("TABLE")) {
        if (cursor.take("IF")) { cursor.need("NOT"); cursor.need("EXISTS"); }
        const object = cursor.name(); const id = key(object.schema, object.name);
        if (tables.has(id)) throw new Error("Duplicate CREATE TABLE omitted; this preview does not replay existing-object conditions.");
        if (tables.size >= ddlLimits.tables) throw new Error("Table limit exceeded (500); statement omitted.");
        const entries = split(cursor.group()); const table: TableDefinition = { key: { kind: "table", ...object }, tableKind: "ordinary", columns: [], primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: null };
        const localLocations: DdlLocation[] = [{ ...range(unit), ...object, table: object.name }];
        const notes: string[] = []; let sequence = 0;
        const synthetic = (label: string) => { notes.push("Unnamed keys use generated preview-only names; server-assigned names are unknown."); return `ddl_${label}_${++sequence}`; };
        const primary = (name: string, columns: string[]) => { if (table.primaryKey) throw new Error("Multiple primary keys; statement omitted."); table.primaryKey = { name, columns }; };
        for (const entry of entries) {
          const part = new Cursor(entry, request); let constraintName: string | undefined;
          if (part.take("CONSTRAINT")) constraintName = part.identifier();
          if (part.take("PRIMARY")) { part.need("KEY"); primary(constraintName ?? synthetic("pk"), part.columns()); }
          else if (part.take("FOREIGN")) { part.need("KEY"); if (request.dialect === "mySql" && part.peek()?.value !== "(") part.identifier(); const columns = part.columns(); table.foreignKeys.push(fk(part, constraintName ?? synthetic("fk"), columns, object.schema)); }
          else if (part.take("UNIQUE")) { if (request.dialect === "mySql") { part.take("KEY"); part.take("INDEX"); } const name = constraintName ?? (part.peek()?.value === "(" ? synthetic("unique") : request.dialect === "mySql" ? part.identifier() : ""); if (!name) throw new Error("Use CONSTRAINT for a named PostgreSQL UNIQUE key."); table.indexes.push(index(name, part.columns(), true)); }
          else if (request.dialect === "mySql" && (part.take("KEY") || part.take("INDEX"))) { const name = part.peek()?.value === "(" ? synthetic("index") : part.identifier(); table.indexes.push(index(name, part.columns(), false)); }
          else {
            if (constraintName) throw new Error("This named constraint kind is outside the supported PK/FK/UNIQUE subset.");
            const value = column(part, table.columns.length + 1); table.columns.push(value); localLocations.push({ ...range(entry[0]), end: entry.at(-1)!.end, schema: object.schema, table: object.name, columnName: value.name });
            while (part.peek()) {
              if (part.take("NOT")) { part.need("NULL"); value.nullable = false; }
              else if (part.take("NULL")) value.nullable = true;
              else if (part.take("PRIMARY")) { part.need("KEY"); primary(synthetic("pk"), [value.name]); }
              else if (part.take("UNIQUE")) { part.take("KEY"); table.indexes.push(index(synthetic("unique"), [value.name], true)); }
              else if (keyword(part.peek(), "REFERENCES")) { if (request.dialect === "mySql") throw new Error("MySQL inline REFERENCES is not treated as an enforced foreign key; use table-level FOREIGN KEY."); table.foreignKeys.push(fk(part, synthetic("fk"), [value.name], object.schema)); }
              else if (part.take("DEFAULT")) {
                const start = part.at; let nesting = 0;
                while (part.peek()) { const token = part.peek(); if (!nesting && token.kind === "word" && attrs.has(token.value.toUpperCase())) break; if (token.value === "(" && token.kind === "symbol") nesting++; if (token.value === ")" && token.kind === "symbol") nesting--; part.at++; }
                if (part.at === start) { if (part.take("NULL")) value.defaultValue = "null"; else throw new Error("DEFAULT expression missing; statement omitted."); } else value.defaultValue = textOf(part.tokens.slice(start, part.at));
              } else if (request.dialect === "mySql" && part.take("AUTO_INCREMENT")) value.identity = "byDefault";
              else if (request.dialect === "mySql" && part.take("COMMENT")) { if (part.peek()?.kind !== "string") throw new Error("COMMENT requires a literal."); value.comment = part.tokens[part.at++].value; }
              else if (request.dialect === "postgreSql" && part.take("GENERATED")) { if (part.take("ALWAYS")) value.identity = "always"; else { part.need("BY"); part.need("DEFAULT"); value.identity = "byDefault"; } part.need("AS"); part.need("IDENTITY"); if (part.peek()?.value === "(") { part.group(); notes.push("Identity sequence options are not represented."); } }
              else throw new Error("Unsupported column attribute (including CHECK, generated expressions or collation); the table statement was omitted.");
            }
          }
          part.end();
        }
        if (request.dialect === "mySql") while (cursor.peek()) {
          if (cursor.take("COMMENT")) { cursor.take("="); if (cursor.peek()?.kind !== "string") throw new Error("Table COMMENT requires a literal."); table.comment = cursor.tokens[cursor.at++].value; }
          else { cursor.take("DEFAULT"); if (cursor.take("CHARACTER")) cursor.need("SET"); else if (!(cursor.take("ENGINE") || cursor.take("CHARSET") || cursor.take("COLLATE") || cursor.take("AUTO_INCREMENT") || cursor.take("ROW_FORMAT"))) throw new Error("Unsupported table suffix; statement omitted."); cursor.take("="); if (!["word", "identifier"].includes(cursor.peek()?.kind ?? "")) throw new Error("Missing table option value."); cursor.at++; notes.push("MySQL engine/charset/collation/storage options are omitted; foreign key enforcement and string compatibility are not established."); }
        }
        cursor.end();
        const names = table.columns.map((value) => request.dialect === "mySql" ? value.name.toLowerCase() : value.name);
        if (new Set(names).size !== names.length) throw new Error("Duplicate column names; statement omitted.");
        if (columnCount + table.columns.length > ddlLimits.columns) throw new Error("Column limit exceeded (5,000); statement omitted.");
        const own = (name: string) => names.includes(request.dialect === "mySql" ? name.toLowerCase() : name);
        for (const columns of [table.primaryKey?.columns ?? [], ...table.foreignKeys.map((value) => value.columns), ...table.indexes.map((value) => value.columns)]) if (columns.some((name) => !own(name)) || new Set(columns.map((name) => request.dialect === "mySql" ? name.toLowerCase() : name)).size !== columns.length) throw new Error("A key/index references missing or duplicate source columns; statement omitted.");
        const fkNames = table.foreignKeys.map((value) => value.name); const ixNames = table.indexes.map((value) => value.name);
        if (new Set(fkNames).size !== fkNames.length || new Set(ixNames).size !== ixNames.length) throw new Error("Duplicate key/index names; statement omitted.");
        for (const name of table.primaryKey?.columns ?? []) table.columns.find((value) => request.dialect === "mySql" ? value.name.toLowerCase() === name.toLowerCase() : value.name === name)!.nullable = false;
        if (table.primaryKey) table.primaryKey.columns = table.primaryKey.columns.map((name) => columnName(table, name, request));
        for (const foreign of table.foreignKeys) foreign.columns = foreign.columns.map((name) => columnName(table, name, request));
        for (const value of table.indexes) value.columns = value.columns.map((name) => columnName(table, name, request));
        if (request.dialect === "postgreSql" && table.columns.some((value) => ["serial", "bigserial", "smallserial"].includes(value.typeName))) notes.push("Serial pseudo-types remain declared type text; sequences and expanded defaults are not modeled.");
        tables.set(id, table); columnCount += table.columns.length; locations.push(...localLocations); accepted++;
        for (const note of new Set(notes)) diagnostic(unit, note.startsWith("Unnamed") ? "info" : "warning", "projection", note);
      } else {
        const unique = cursor.take("UNIQUE");
        if (!cursor.take("INDEX")) { skipped++; diagnostic(unit, "warning", "unsupported-create", "CREATE kind omitted. Only ordinary CREATE TABLE and simple CREATE [UNIQUE] INDEX are covered; VIEW, TYPE/ENUM, routines and other objects are not modeled."); continue; }
        const name = cursor.identifier(); cursor.need("ON"); const table = cursor.name(); let method = "btree";
        if (cursor.take("USING")) method = cursor.identifier(); const columns = cursor.columns(); cursor.end();
        pendingIndexes.push({ table, index: index(name, columns, unique, false, method), unit });
      }
    } catch (reason) { skipped++; diagnostic(unit, "error", "unsupported-or-invalid", reason instanceof Error ? reason.message : "Statement omitted."); }
  }
  for (const pending of pendingIndexes) {
    const table = tables.get(key(pending.table.schema, pending.table.name));
    if (!table || pending.index.columns.some((name) => !table.columns.some((column) => columnMatch(column.name, name, request))) || table.indexes.some((value) => value.name === pending.index.name)) { skipped++; diagnostic(pending.unit, "error", "index-target", "Index target/columns are unavailable or the name is duplicated; index omitted."); }
    else { pending.index.columns = pending.index.columns.map((name) => columnName(table, name, request)); table.indexes.push(pending.index); accepted++; }
  }
  for (const table of tables.values()) for (const foreign of table.foreignKeys) {
    const target = tables.get(key(foreign.referencedSchema, foreign.referencedTable));
    if (target) foreign.referencedColumns = foreign.referencedColumns.map((name) => columnName(target, name, request));
    if (!target || foreign.referencedColumns.some((name) => !target.columns.some((column) => column.name === name))) {
      const location = locations.find((value) => value.schema === table.key.schema && value.table === table.key.name && !value.columnName)!;
      diagnostics.push({ ...range(location), statement: scanned.units.find((unit) => unit.start === location.start)?.number ?? 1, level: "warning", code: "fk-target", message: "A declared foreign key target/column is absent from this preview; no database compatibility or integrity is inferred." });
    }
  }
  const schemas = new Map<string, SchemaDefinition>();
  for (const table of tables.values()) { const schema = schemas.get(table.key.schema) ?? { name: table.key.schema, tables: [], views: [], enums: [] }; schema.tables.push(table); schemas.set(schema.name, schema); table.foreignKeys.sort((a, b) => compare(a.name, b.name)); table.indexes.sort((a, b) => compare(a.name, b.name)); }
  for (const schema of schemas.values()) schema.tables.sort((a, b) => compare(a.key.name, b.key.name));
  return { schemas: [...schemas.values()].sort((a, b) => compare(a.name, b.name)), diagnostics, locations, coverage: { accepted, skipped, errors: diagnostics.filter((value) => value.level === "error").length, warnings: diagnostics.filter((value) => value.level === "warning").length } };
}
