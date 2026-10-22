import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";

export const postgresSqlLanguage = sql({ dialect: PostgreSQL });

export function postgresSqlSyntaxDiagnostics(state: EditorState): Diagnostic[] {
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
  return postgresSqlSyntaxDiagnostics(EditorState.create({ doc: sqlText, extensions: [postgresSqlLanguage] }));
}

/** Use PostgreSQL lexical boundaries, so semicolons in literals/comments never split a statement. */
export function currentPostgresStatement(document: string, position: number): string {
  const statements: { from: number; to: number }[] = [];
  const tree = PostgreSQL.language.parser.parse(document);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Statement" && document.slice(node.from, node.to).replaceAll(";", "").trim()) statements.push({ from: node.from, to: node.to });
  }
  const cursor = Math.max(0, Math.min(document.length, position));
  const statement = statements.find((item) => cursor < item.to) ?? statements.at(-1);
  if (!statement) return "";
  return document.slice(statement.from, statement.to).trim();
}
