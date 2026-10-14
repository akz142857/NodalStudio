import { ddlLimits, type DdlDiagnostic, type DdlDialect, type SourceRange } from "./ddl-types";
export interface Token extends SourceRange { value: string; kind: "word" | "identifier" | "string" | "symbol" }
export interface Unit extends SourceRange { tokens: Token[]; number: number; blocked?: string }
export function scanDdl(text: string, dialect: DdlDialect): { units: Unit[]; diagnostics: DdlDiagnostic[] } {
  const units: Unit[] = []; const diagnostics: DdlDiagnostic[] = [];
  let i = 0; let line = 1; let column = 1; let count = 0; let depth = 0; let tokens: Token[] = [];
  const position = () => ({ start: i, end: i, line, column });
  const advance = () => { if (text[i++] === "\n") { line++; column = 1; } else column++; };
  const emit = (blocked?: string) => { if (!tokens.length) return; units.push({ ...tokens[0], end: i, tokens, number: units.length + 1, blocked }); tokens = []; depth = 0; if (units.length >= ddlLimits.statements) throw new Error("Statement limit exceeded (5,000)."); };
  const fatal = (start: SourceRange, message: string) => { diagnostics.push({ ...start, end: i, statement: units.length + 1, level: "error", code: "lexical", message }); tokens = []; };
  try {
    while (i < text.length) {
      if (/\s|\uFEFF/u.test(text[i])) { advance(); continue; }
      if (text.startsWith("--", i) && (dialect === "postgreSql" || /\s/u.test(text[i + 2] ?? " ")) || dialect === "mySql" && text[i] === "#") { while (i < text.length && text[i] !== "\n") advance(); continue; }
      if (text.startsWith("/*", i)) {
        const start = position(); const executable = dialect === "mySql" && text[i + 2] === "!";
        advance(); advance(); let nesting = 1;
        while (i < text.length && nesting) {
          if (dialect === "postgreSql" && text.startsWith("/*", i)) { if (++nesting > ddlLimits.depth) throw new Error("Comment nesting limit exceeded (64)."); advance(); advance(); }
          else if (text.startsWith("*/", i)) { advance(); advance(); nesting--; }
          else advance();
        }
        if (nesting) { fatal(start, "Unterminated block comment; remaining input was not parsed."); break; }
        if (executable) diagnostics.push({ ...start, end: i, statement: units.length + 1, level: "warning", code: "executable-comment", message: "MySQL executable comment omitted; its SQL is not part of this preview." });
        continue;
      }
      const start = position(); const char = text[i]; let value = ""; let kind: Token["kind"] = "symbol";
      const dollar = dialect === "postgreSql" && char === "$" ? text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0] : undefined;
      if (dollar) {
        for (let k = 0; k < dollar.length; k++) advance();
        while (i < text.length && !text.startsWith(dollar, i)) { value += text[i]; advance(); }
        if (i === text.length) { fatal(start, "Unterminated dollar-quoted literal; remaining input was not parsed."); break; }
        for (let k = 0; k < dollar.length; k++) advance(); kind = "string";
      } else if (char === "'" || char === '"' || char === "`") {
        const quote = char; kind = char === "'" ? "string" : "identifier"; advance(); let closed = false;
        while (i < text.length) {
          if (text[i] === quote) { advance(); if (text[i] === quote) { value += quote; advance(); } else { closed = true; break; } }
          else if (text[i] === "\\" && (dialect === "mySql" || text[start.start - 1]?.toUpperCase() === "E")) { value += text[i]; advance(); if (i < text.length) { value += text[i]; advance(); } }
          else { value += text[i]; advance(); }
        }
        if (!closed) { fatal(start, "Unterminated quoted token; remaining input was not parsed."); break; }
      } else if (/[\p{L}\p{N}_$]/u.test(char)) {
        kind = "word"; while (i < text.length && /[\p{L}\p{N}_$]/u.test(text[i])) { value += text[i]; advance(); }
      } else { value = char; advance(); }
      if (value === ";" && kind === "symbol") {
        const copy = tokens[0]?.value.toUpperCase() === "COPY" && tokens.some((token, index) => token.value.toUpperCase() === "FROM" && tokens[index + 1]?.value.toUpperCase() === "STDIN");
        if (copy) { while (i < text.length) { const end = text.indexOf("\n", i); const row = text.slice(i, end < 0 ? text.length : end).trim(); while (i < text.length && text[i] !== "\n") advance(); if (i < text.length) advance(); if (row === "\\.") break; } emit("COPY data omitted, including all rows through the \\. terminator (or end of input)."); }
        else if (depth) { emit("Unbalanced parentheses; statement omitted."); }
        else emit();
        continue;
      }
      if (kind === "word" && value.toUpperCase() === "DELIMITER" && !tokens.length) {
        tokens.push({ ...start, end: i, value, kind }); while (i < text.length) advance(); emit("Custom DELIMITER input and the remaining region are unsupported; procedure contents were not interpreted as tables."); break;
      }
      if (kind === "symbol" && value === "(" && ++depth > ddlLimits.depth) throw new Error("Parenthesis nesting limit exceeded (64).");
      if (kind === "symbol" && value === ")") depth--;
      tokens.push({ ...start, end: i, value, kind }); if (++count > ddlLimits.tokens) throw new Error("Token limit exceeded (100,000).");
      if (keywordRoutine(tokens)) { while (i < text.length) advance(); emit("Routine/trigger input and the remaining region are unsupported; routine bodies were not interpreted as tables."); break; }
    }
    if (tokens.length) emit(depth ? "Unbalanced parentheses; trailing statement omitted." : undefined);
  } catch (reason) { fatal(position(), reason instanceof Error ? reason.message : String(reason)); }
  return { units, diagnostics };
}
function keywordRoutine(tokens: Token[]) {
  return tokens[0]?.kind === "word" && tokens[0].value.toUpperCase() === "CREATE"
    && tokens.at(-1)?.kind === "word" && ["FUNCTION", "PROCEDURE", "TRIGGER", "EVENT"].includes(tokens.at(-1)!.value.toUpperCase())
    && !tokens.some((token) => token.kind === "word" && ["TABLE", "INDEX"].includes(token.value.toUpperCase()));
}
