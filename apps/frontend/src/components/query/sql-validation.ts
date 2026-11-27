import { SQLite, MySQL, PostgreSQL, SQLDialect, sql } from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";

export type SqlDialect = "postgreSql" | "mySql" | "sqlite";
export const postgresSqlLanguage = sql({ dialect: PostgreSQL });
// Match the backend session mode, including MySQL backslash string escapes.
const mysqlDialect = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true });
export const mysqlSqlLanguage = sql({ dialect: mysqlDialect });
export const sqliteSqlLanguage = sql({ dialect: SQLite });
export function sqlLanguage(dialect: SqlDialect) { return dialect === "sqlite" ? sqliteSqlLanguage : dialect === "mySql" ? mysqlSqlLanguage : postgresSqlLanguage; }

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

type SqlNode = ReturnType<typeof PostgreSQL.language.parser.parse>["topNode"];

function* sqlTokens(start: SqlNode | null) {
  for (let token = start; token; token = token.nextSibling) {
    if (![";", "(", ")", "BlockComment", "LineComment"].includes(token.name)) yield token;
  }
}

function sqlStatements(document: string, dialect: SqlDialect) {
  return sqlLanguage(dialect).language.parser.parse(document).topNode.getChildren("Statement")
    .filter((statement) => !sqlTokens(statement.firstChild).next().done);
}

const writeVerbs = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE"]);

/** Routes the editor action. The native query and DDL validators still decide what can execute. */
export function classifySqlExecution(document: string, dialect: SqlDialect): "empty" | "query" | "ddl" | "multiple" | "unsupported" {
  const [statement, next] = sqlStatements(document, dialect);
  if (next) return "multiple";
  if (!statement) return "empty";
  const tokens = [...sqlTokens(statement.firstChild)];
  let opening: SqlNode | undefined = tokens[0];
  while (opening?.name === "Parens") {
    const inner = sqlTokens(opening.firstChild).next();
    opening = inner.done ? undefined : inner.value;
  }
  const word = (token: SqlNode | undefined) => token && /^(Keyword|Identifier)$/.test(token.name)
    ? document.slice(token.from, token.to).toUpperCase() : "";
  const verb = word(opening);
  if (verb === "SELECT") return "query";
  if (verb === "WITH") {
    const command = tokens.find((token, index) => tokens[index - 1]?.name === "Parens"
      && (word(token) === "SELECT" || writeVerbs.has(word(token))));
    return writeVerbs.has(word(command)) ? "unsupported" : "query";
  }
  if (opening !== tokens[0]) return "unsupported";

  const object = word(tokens[1]);
  if (verb === "ALTER" && object === "TABLE") return "ddl";
  if (verb === "DROP" && (object === "TABLE" || object === "INDEX")) return "ddl";
  if (verb === "CREATE" && (object === "TABLE" || object === "INDEX" || (object === "UNIQUE" && word(tokens[2]) === "INDEX"))) return "ddl";
  return "unsupported";
}

/** Use the source dialect's lexical boundaries for quoted names, literals and comments. */
export function currentSqlStatement(document: string, position: number, dialect: SqlDialect): string {
  const statements = sqlStatements(document, dialect);
  const cursor = Math.max(0, Math.min(document.length, position));
  const statement = statements.find((item) => cursor < item.to) ?? statements.at(-1);
  if (!statement) return "";
  return document.slice(statement.from, statement.to).trim();
}
