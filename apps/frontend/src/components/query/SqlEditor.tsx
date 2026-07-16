import { autocompletion, type Completion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { DatabaseSnapshot } from "../../platform";
import { executableSql } from "./query-format";
import { postgresSqlLanguage, postgresSqlSyntaxDiagnostics } from "./sql-validation";

export interface SqlEditorHandle {
  getExecutableSql(): string;
  focus(): void;
}

interface SqlEditorProps {
  value: string;
  snapshot?: DatabaseSnapshot;
  onChange: (value: string) => void;
  onRun: (sqlText: string) => void;
}

function completions(snapshot?: DatabaseSnapshot): Completion[] {
  if (!snapshot) return [];
  return snapshot.schemas.flatMap((schema) => [
    { label: schema.name, type: "namespace", detail: "schema" },
    ...schema.tables.flatMap((table) => [
      { label: `${schema.name}.${table.key.name}`, apply: `"${schema.name}"."${table.key.name}"`, type: "class", detail: "table" },
      { label: table.key.name, type: "class", detail: schema.name },
      ...table.columns.map((column) => ({ label: column.name, type: "property", detail: `${table.key.name} · ${column.formattedType}` })),
    ]),
  ]);
}

const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#7aa2f7", fontWeight: "650" },
  { tag: [tags.string, tags.special(tags.string)], color: "#9ece6a" },
  { tag: [tags.number, tags.bool, tags.null], color: "#ff9e64" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#667085", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "#7dcfff" },
  { tag: [tags.typeName, tags.className], color: "#bb9af7" },
  { tag: [tags.operator, tags.punctuation], color: "#89a4c7" },
  { tag: tags.variableName, color: "#c9d3e4" },
]);

function selectedSql(view: EditorView): string {
  const selection = view.state.selection.main;
  return view.state.sliceDoc(selection.from, selection.to).trim();
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, snapshot, onChange, onRun },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const currentValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sql: string }>();
  currentValueRef.current = value;
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useImperativeHandle(ref, () => ({
    getExecutableSql() {
      const view = viewRef.current;
      if (!view) return "";
      const selection = view.state.selection.main;
      return executableSql(view.state.doc.toString(), selection.from, selection.to);
    },
    focus() { viewRef.current?.focus(); },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: currentValueRef.current,
      extensions: [
        postgresSqlLanguage,
        syntaxHighlighting(sqlHighlightStyle),
        history(),
        placeholder("Write a read-only SELECT query…"),
        linter((view) => postgresSqlSyntaxDiagnostics(view.state), { delay: 250 }),
        lintGutter(),
        autocompletion({
          override: [(context) => ({
            from: context.matchBefore(/[\w."]*/)?.from ?? context.pos,
            options: completions(snapshot),
          })],
        }),
        keymap.of([
          { key: "Mod-Enter", run: (view) => {
            const selection = view.state.selection.main;
            onRunRef.current(executableSql(view.state.doc.toString(), selection.from, selection.to));
            return true;
          } },
          { key: "Mod-r", preventDefault: true, run: (view) => {
            const sqlText = selectedSql(view);
            if (sqlText) onRunRef.current(sqlText);
            return true;
          } },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", color: "#dce2ec", backgroundColor: "#15181e" },
          ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
          ".cm-content": { minHeight: "100%", padding: "14px 0", caretColor: "#7ea8ff" },
          ".cm-placeholder": { color: "#657083", fontStyle: "italic" },
          ".cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(62, 111, 205, .38) !important" },
          ".cm-gutters": { backgroundColor: "var(--panel-strong)", color: "var(--muted)", border: "none" },
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
  }, [snapshot]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(undefined);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const sqlText = viewRef.current ? selectedSql(viewRef.current) : "";
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 210)),
      y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 54)),
      sql: sqlText,
    });
  }

  return <div className="query-sql-editor-shell" onContextMenu={openContextMenu}>
    <div className="query-sql-editor" ref={hostRef} aria-label="SQL editor" />
    {contextMenu ? <div className="query-editor-menu" ref={menuRef} role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" disabled={!contextMenu.sql} onClick={() => { if (contextMenu.sql) onRunRef.current(contextMenu.sql); setContextMenu(undefined); }}><span>Run Selected</span><kbd>⌘/Ctrl R</kbd></button>
    </div> : null}
  </div>;
});
