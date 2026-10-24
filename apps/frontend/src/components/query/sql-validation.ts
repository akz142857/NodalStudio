import { MySQL, PostgreSQL, SQLDialect, sql } from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";

export type SqlDialect = "postgreSql" | "mySql";
export const postgresSqlLanguage = sql({ dialect: PostgreSQL });
// Match the backend session mode, including MySQL backslash string escapes.
const mysqlDialect = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true });
export const mysqlSqlLanguage = sql({ dialect: mysqlDialect });
export function sqlLanguage(dialect: SqlDialect) { return dialect === "mySql" ? mysqlSqlLanguage : postgresSqlLanguage; }

export function sqlSyntaxDiagnostics(state: EditorState): Diagnostic[] {
  if (!state.doc.toString().trim()) return [];
  const diagnostics: Diagnostic[] = [];
  const cursor = syntaxTree(state).cursor();
  do {
    if (!cursor.type.isError) continue;
    const from = Math.min(cursor.from, Math.max(0, state.doc.length - 1));
    const to = Math.max(from + 1, Math.min(state.doc.length, cursor.to || from + 1));
    diagnostics.push({ from, to, severity: "error", message: "SQL syntax appears incomplete or invalid." });
  } while (cursor.next());
  return diagnostics;
}

export function validatePostgresSqlText(sqlText: string): Diagnostic[] {
  return validateSqlText(sqlText, "postgreSql");
}

export function validateSqlText(sqlText: string, dialect: SqlDialect): Diagnostic[] {
  return sqlSyntaxDiagnostics(EditorState.create({ doc: sqlText, extensions: [sqlLanguage(dialect)] }));
}

export function currentPostgresStatement(document: string, position: number): string {
  return currentSqlStatement(document, position, "postgreSql");
}

/** Use the source dialect's lexical boundaries for quoted names, literals and comments. */
export function currentSqlStatement(document: string, position: number, dialect: SqlDialect): string {
  const statements: { from: number; to: number }[] = [];
  const tree = (dialect === "mySql" ? mysqlDialect : PostgreSQL).language.parser.parse(document);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Statement" && document.slice(node.from, node.to).replaceAll(";", "").trim()) statements.push({ from: node.from, to: node.to });
  }
  const cursor = Math.max(0, Math.min(document.length, position));
  const statement = statements.find((item) => cursor < item.to) ?? statements.at(-1);
  if (!statement) return "";
  return document.slice(statement.from, statement.to).trim();
}
