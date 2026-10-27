import { useI18n, useEventTranslator, type Translate } from "../../i18n";
import { autocompletion, type Completion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, lineNumbers, keymap, placeholder } from "@codemirror/view";
import { sqlHighlightStyle } from "../../design-system/sql-highlight";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SchemaObjectMenu } from "../SchemaObjectMenu";
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



export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, snapshot, onChange, onRun, executing, disabled, onStop },
  ref,
) {
  const { t: bt, locale } = useI18n();
  const tr = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  const [menu, setMenu] = useState<{ x: number; y: number; document: string; snapshotId?: string; selection: string; statement: string }>();
  const [editMessage, setEditMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const editRevision = useRef(0);
  const editBusy = useRef(false);
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
          if (update.docChanged || update.selectionSet) { editRevision.current++; setMenu(undefined); }
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

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  async function edit(action: "copy" | "cut" | "paste" | "format") {
    const view = viewRef.current;
    if (!view || editBusy.current) return;
    const selection = view.state.selection.main;
    const document = view.state.doc.toString();
    const revision = editRevision.current;
    const isCurrent = () => viewRef.current === view && editRevision.current === revision;
    editBusy.current = true; setEditing(true); setEditMessage("");
    try {
      let from = selection.from, to = selection.to, insert = "";
      if (action === "copy" || action === "cut") {
        if (selection.empty) return;
        await navigator.clipboard.writeText(document.slice(from, to));
        if (action === "copy") return;
      } else if (action === "paste") {
        insert = await navigator.clipboard.readText();
        if (!insert) return;
      } else {
        if (selection.empty) { from = 0; to = document.length; }
        const text = document.slice(from, to);
        if (!text.trim()) return;
        const { formatDialect, mysql, postgresql } = await import("sql-formatter");
        const formatted = formatDialect(text.trim(), { dialect: dialect === "mySql" ? mysql : postgresql, tabWidth: 2 });
        // Keep selected fragment boundaries so adjacent SQL tokens cannot merge.
        insert = selection.empty ? formatted : (text.match(/^\s*/)?.[0] ?? "") + formatted + (text.match(/\s*$/)?.[0] ?? "");
      }
      if (!isCurrent()) {
        if (viewRef.current === view) setEditMessage(tr("The editor changed. Please try the action again.", "编辑内容或选区已变化，请重试操作。"));
        return;
      }
      view.dispatch({ changes: { from, to, insert }, selection: action === "format" && !selection.empty ? { anchor: from, head: from + insert.length } : { anchor: from + insert.length }, annotations: isolateHistory.of("full"), userEvent: `input.${action}` });
      view.focus();
    } catch {
      if (viewRef.current === view) setEditMessage(action === "format" ? tr("Unable to format this SQL. The original text is unchanged.", "无法格式化此 SQL，原文已保留。") : tr("Clipboard access failed. The SQL is unchanged; try the keyboard shortcut.", "剪贴板访问失败，SQL 未修改；可尝试键盘快捷键。"));
    } finally {
      editBusy.current = false;
      if (viewRef.current) setEditing(false);
    }
  }

  function openMenu(x: number, y: number) {
    const view = viewRef.current;
    if (!view) return;
    const document = view.state.doc.toString();
    const selection = view.state.selection.main;
    setEditMessage("");
    setMenu({ x, y, document, snapshotId: snapshot?.id, selection: selection.empty ? "" : document.slice(selection.from, selection.to), statement: currentSqlStatement(document, selection.head, dialect) });
  }
  return <div className="query-sql-editor-shell" onMouseDownCapture={event => { if (event.button === 2) event.preventDefault(); }} onContextMenu={event => {
    event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY);
  }} onKeyDown={event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); event.stopPropagation();
      const view = viewRef.current;
      const position = view?.coordsAtPos(view.state.selection.main.head);
      const bounds = hostRef.current?.getBoundingClientRect();
      openMenu(position?.left ?? bounds?.left ?? 0, position?.bottom ?? bounds?.top ?? 0);
    }
  }}>
    {editMessage ? <p className="query-editor-action-message" role="alert">{editMessage}</p> : null}
    <div className="query-sql-editor" ref={hostRef} aria-label={bt("business.sQLEditor")} />
    {menu && menu.document === value && menu.snapshotId === snapshot?.id ? <SchemaObjectMenu x={menu.x} y={menu.y} name={bt("business.sQLEditor")} onClose={restoreFocus => { setMenu(undefined); if (restoreFocus) viewRef.current?.focus(); }} actions={[
      { label: tr("Run selected SQL", "执行选中 SQL"), disabled: disabled || executing || !menu.selection.trim(), run: () => onRun(menu.selection) },
      { label: tr("Run current statement", "执行当前语句"), disabled: disabled || executing || !menu.statement.trim(), run: () => onRun(menu.statement) },
      ...(executing ? [{ label: tr("Stop query", "停止查询"), separatorBefore: true, run: onStop }] : []),
      { label: tr("Copy", "复制"), separatorBefore: true, disabled: editing || !menu.selection, run: () => void edit("copy") },
      { label: tr("Cut", "剪切"), disabled: editing || !menu.selection, run: () => void edit("cut") },
      { label: tr("Paste", "粘贴"), disabled: editing, run: () => void edit("paste") },
      { label: tr("Select all", "全选"), disabled: !menu.document, run: () => { const view = viewRef.current; if (view) { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); } } },
      { label: menu.selection ? tr("Format selected SQL", "格式化选中 SQL") : tr("Format SQL", "格式化 SQL"), separatorBefore: true, disabled: editing || !(menu.selection || menu.document).trim(), run: () => void edit("format") },
    ]} /> : null}
  </div>;
});
