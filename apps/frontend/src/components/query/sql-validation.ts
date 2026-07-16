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
