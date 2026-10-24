import { useI18n, useEventTranslator, type Translate } from "../../i18n";
import { autocompletion, type Completion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, lineNumbers, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { DatabaseSnapshot } from "../../platform";
import { executableSql, quoteIdentifier } from "./query-format";
import { currentSqlStatement, sqlLanguage, sqlSyntaxDiagnostics } from "./sql-validation";


export interface SqlEditorHandle {
  getCurrentStatementSql(): string;
  getExecutableSql(): string;
  focus(): void;
}

interface SqlEditorProps {
  value: string;
  snapshot?: DatabaseSnapshot;
  onChange: (value: string) => void;
  onRun: (sqlText: string) => void;
  executing: boolean;
  disabled: boolean;
  onStop: () => void;
}

function completions(snapshot: DatabaseSnapshot | undefined, t: Translate): Completion[] {
  if (!snapshot) return [];
  const quote = (value: string) => quoteIdentifier(value, snapshot.database.databaseType);
  return snapshot.schemas.flatMap((schema) => [
    { label: schema.name, apply: quote(schema.name), type: "namespace", detail: t("business.schemas") },
    ...schema.tables.flatMap((table) => [
      { label: `${schema.name}.${table.key.name}`, apply: `${quote(schema.name)}.${quote(table.key.name)}`, type: "class", detail: t("business.table") },
      { label: table.key.name, apply: quote(table.key.name), type: "class", detail: schema.name },
      ...table.columns.map((column) => ({ label: column.name, apply: quote(column.name), type: "property", detail: `${table.key.name} · ${column.formattedType}` })),
    ]),
  ]);
}

const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--ds-syntax-keyword)", fontWeight: "650" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--ds-syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ds-syntax-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--ds-tertiary)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--ds-syntax-function)" },
  { tag: [tags.typeName, tags.className], color: "var(--ds-syntax-type)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--ds-secondary)" },
  { tag: tags.variableName, color: "var(--ds-text)" },
]);

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, snapshot, onChange },
  ref,
) {
  const { t: bt } = useI18n();
  const eventBt = useEventTranslator(bt);
  const language = useMemo(() => new Compartment(), []);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const dialect = snapshot?.database.databaseType ?? "postgreSql";
  const currentValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  currentValueRef.current = value;
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    getCurrentStatementSql() {
      const view = viewRef.current;
      return view ? currentSqlStatement(view.state.doc.toString(), view.state.selection.main.head, dialect) : "";
    },
    getExecutableSql() {
      const view = viewRef.current;
      if (!view) return "";
      const selection = view.state.selection.main;
      return executableSql(view.state.doc.toString(), selection.from, selection.to);
    },
    focus() { viewRef.current?.focus(); },
  }), [dialect]);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: currentValueRef.current,
      extensions: [
        sqlLanguage(dialect),
        syntaxHighlighting(sqlHighlightStyle),
        history(),
        language.of([EditorState.phrases.of({ Completions: eventBt("queryEditor.completions") }), placeholder(eventBt("business.writeAReadOnlySELECTQuery")), EditorView.contentAttributes.of({ "aria-label": eventBt("business.sQLEditor") })]),
        linter((view) => sqlSyntaxDiagnostics(view.state), { delay: 250 }),
        lineNumbers(),
        highlightActiveLine(),
        lintGutter(),
        autocompletion({
          override: [(context) => ({
            from: context.matchBefore(/[\w."`]*/)?.from ?? context.pos,
            options: completions(snapshot, eventBt),
          })],
        }),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", color: "var(--ds-text)", backgroundColor: "var(--ds-field)" },
          ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
          ".cm-content": { minHeight: "100%", padding: "14px 0", caretColor: "var(--ds-accent)" },
          ".cm-activeLine": { backgroundColor: "var(--ds-subtle)" },
          ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px", minWidth: "36px" },
          ".cm-line": { padding: "0 14px" },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ds-accent)" },
          ".cm-placeholder": { color: "var(--ds-tertiary)", fontStyle: "italic" },
          ".cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--ds-selection) !important" },
          ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--ds-selection)", color: "var(--ds-selection-text)" },
          ".cm-searchMatch": { backgroundColor: "var(--ds-warning-soft)" },
          ".cm-diagnostic-error": { borderLeftColor: "var(--ds-danger)" },
          ".cm-gutters": { backgroundColor: "var(--ds-subtle)", color: "var(--ds-tertiary)", border: "none" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = undefined;
    };
  }, [snapshot, dialect, language, eventBt]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: language.reconfigure([EditorState.phrases.of({ Completions: bt("queryEditor.completions") }), placeholder(bt("business.writeAReadOnlySELECTQuery")), EditorView.contentAttributes.of({ "aria-label": bt("business.sQLEditor") })]) });
  }, [bt, language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div className="query-sql-editor-shell" onContextMenu={(event) => event.preventDefault()}>
    <div className="query-sql-editor" ref={hostRef} aria-label={bt("business.sQLEditor")} />
  </div>;
});
