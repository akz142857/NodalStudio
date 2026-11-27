import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { sql } from "@codemirror/lang-sql";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { foldGutter, syntaxHighlighting } from "@codemirror/language";
import { getChunks, goToNextChunk, goToPreviousChunk, uncollapseUnchanged, unifiedMergeView } from "@codemirror/merge";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { gotoLine, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type KeyBinding } from "@codemirror/view";
import { sqlHighlightStyle } from "../../design-system/sql-highlight";
import { useI18n } from "../../i18n";
import type { CodeDefinitionPosition, CodeDocumentHighlightRange, CodeExtension, CodeExtensionPlatform } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import { CODE_SHORTCUTS, formatCommandShortcut } from "../command-shortcuts";
import { codeDefinitionLinks } from "./code-definition-links";
import { contentDigest, normalizeReviewText, reviewDiffCollapse, reviewDiffConfig, type CheckRange } from "./code-review-checks";
import type { CheckedFile } from "./use-code-review-checks";
import { codeFileType, fileExtension, supportsCodeNavigation } from "./code-review-file-types";
import { createCodeFindPanel } from "./code-review-find";
import { codeReferenceHighlights } from "./code-review-references";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";
import type { ExtensionActivity } from "./CodeReviewExtensions";
import { useExtensionSyntax } from "./use-extension-syntax";

const contributedSyntax = new Compartment();
const noExtensions: CodeExtension[] = [];
const readerSearchKeys: readonly KeyBinding[] = [
  { key: "Ctrl-g", scope: "editor search-panel", run: openLinePrompt },
  ...searchKeymap,
];

function openLinePrompt(view: EditorView) {
  if (!gotoLine(view)) return false;
  view.dom.querySelector<HTMLInputElement>(".cm-goto-line input")?.focus();
  return true;
}
const languages: Record<string, () => Promise<Extension>> = {
  go: () => import("@codemirror/lang-go").then(({ go }) => go()),
  java: () => import("@codemirror/lang-java").then(({ java }) => java()),
  php: () => import("@codemirror/lang-php").then(({ php }) => php()),
  py: () => import("@codemirror/lang-python").then(({ python }) => python()),
  rs: () => import("@codemirror/lang-rust").then(({ rust }) => rust()),
  js: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript()),
  jsx: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true })),
  ts: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ typescript: true, jsx: true })),
  json: () => import("@codemirror/lang-json").then(({ json }) => json()),
  md: () => import("@codemirror/lang-markdown").then(({ markdown }) => markdown()),
  yaml: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml()),
  sql: () => Promise.resolve(sql()),
};

const sourceTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--ds-text)", background: "var(--ds-surface)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--ds-font-mono)", fontSize: "max(12px, var(--monospace-font-size, 12px))", lineHeight: "1.55", cursor: "text" },
  ".cm-gutters": { background: "var(--ds-surface)", color: "var(--ds-tertiary)", border: "none", cursor: "default" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "36px", paddingInlineEnd: "9px" },
  ".cm-foldGutter .cm-gutterElement": { paddingInlineEnd: "5px", cursor: "pointer" },
  ".cm-content": { paddingBlock: "8px" },
  ".cm-line": { paddingInline: "10px" },
  ".cm-activeLine": { backgroundColor: "var(--ds-subtle)" },
  ".cm-activeLineGutter": { color: "var(--ds-text)", backgroundColor: "var(--ds-subtle)" },
  ".cm-inlineChangedLine": { backgroundColor: "var(--ds-positive-soft)" },
  ".cm-inlineChangedLineGutter": { backgroundColor: "var(--ds-positive)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--ds-danger)" },
  ".cm-deletedChunk": { backgroundColor: "var(--ds-danger-soft)" },
  ".cm-changedText": { backgroundImage: "none", textDecoration: "underline" },
  ".cm-deletedText": { backgroundImage: "none", textDecoration: "line-through" },
});

function readerPhrases(locale: string) {
  return EditorState.phrases.of(locale === "zh-CN" ? {
    "Find in file": "在文件中查找", "Search options": "查找选项", "Match case": "区分大小写",
    "Match whole word": "全字匹配", "Use regular expression": "使用正则表达式",
    "Invalid regular expression": "正则表达式无效", "No matches": "无匹配项",
    "1 match": "1 项匹配", "$ matches": "$ 项匹配", "Match $1 of $2": "第 $1 项，共 $2 项",
    "Previous match": "上一个匹配项", "Next match": "下一个匹配项", "Close find": "关闭查找面板", close: "关闭",
    "current match": "当前匹配", "on line": "所在行", "Go to line": "跳转到行", go: "跳转",
    "$ unchanged lines": "$ 行未更改",
  } : {});
}

export function CodeReviewDraft({ title, text, onEdit, outline, dock, footer }: {
  title: string;
  text: string;
  onEdit: (text: string) => void;
  outline: ReactNode;
  dock: ReactNode;
  footer: ReactNode;
}) {
  const { t, locale } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const draft = useRef({ text, onEdit });
  useLayoutEffect(() => { draft.current = { text, onEdit }; }, [text, onEdit]);
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      doc: draft.current.text,
      extensions: [
        EditorView.contentAttributes.of({ "aria-label": title, role: "textbox", spellcheck: "false" }),
        readerPhrases(locale), sourceTheme, lineNumbers(), history(), highlightActiveLine(),
        search({ createPanel: createCodeFindPanel }), keymap.of([...readerSearchKeys, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) draft.current.onEdit(update.state.doc.toString());
        }),
      ],
    });
    editor.current = view;
    view.focus();
    return () => { editor.current = null; view.destroy(); };
  }, [locale, title]);
  return <>
    <div className="code-review-reader-toolbar">
      <div className="code-review-reader-context"><span className="code-review-status-context">{t("codeReview.draftSession")}</span></div>
      <div className="code-review-reader-actions" role="group" aria-label={t("codeReview.readerActions")}>
        <IconButton icon="search" className="code-review-tool" data-code-find="" label={t("codeReview.find")}
          onClick={() => { if (editor.current) openSearchPanel(editor.current); }} />
      </div>
    </div>
    <div className="code-review-reader-body"><div className="code-review-reader-host" ref={host} />{outline}</div>
    {dock}
    <div className="code-review-reading-status">
      {footer}
      <button type="button" className="code-review-position" data-code-go-to-line="" aria-keyshortcuts="Control+G"
        title={formatCommandShortcut(CODE_SHORTCUTS["go-to-line"])}
        onClick={() => { if (editor.current) openLinePrompt(editor.current); }}>{t("codeReview.goToLine")}</button>
      <span>{t("codeReview.plainText")}</span>
    </div>
  </>;
}

export interface ReadingPosition {
  anchor: number;
  head: number;
  length: number;
  scroll: ReturnType<EditorView["scrollSnapshot"]>;
}

export type DefinitionArrival = { position: CodeDefinitionPosition; match?: string } | { viewport: ReadingPosition }
  | { check: { mode: "diff" | "source"; evidence: string | null; indexOnly: boolean; text: string; range?: CheckRange } };

export interface DefinitionGesture {
  position: CodeDefinitionPosition;
  text: string;
  viewport: ReadingPosition;
}

export function CodeFileIcon({ path }: { path: string }) {
  return <ActionIcon name={codeFileType(path) ? "codeDocument" : "document"} />;
}

function diagnosticSpan(doc: EditorState["doc"], range: CheckRange) {
  const line = doc.line(range.line + 1);
  const from = range.column === undefined ? line.from : line.from + range.column;
  const to = range.endLine !== undefined ? doc.line(range.endLine + 1).from + (range.endColumn ?? 0)
    : range.column === undefined ? line.to : from + (range.length ?? 0);
  return { from, to };
}

function expandCheckLine(view: EditorView, lineNumber: number) {
  const chunks = getChunks(view.state)?.chunks;
  if (!chunks) return;
  const { doc } = view.state;
  const { margin, minSize } = reviewDiffCollapse;
  let from = 1;
  for (const chunk of [...chunks, null]) {
    const to = chunk ? doc.lineAt(chunk.fromB).number - 1 - margin : doc.lines;
    if (to - from + 1 >= minSize && from <= lineNumber && lineNumber <= to) {
      view.dispatch({ effects: uncollapseUnchanged.of(doc.line(from).from) });
      return;
    }
    if (chunk) from = doc.lineAt(Math.min(doc.length, chunk.toB)).number + margin;
  }
}

export function CodeReviewReader({ path, text, original, onCopy, viewSwitcher, heading, fallbackCopy, footer, dock, comparison, readPosition, onPosition,
  onDefinition, onReferences, onBack, arrival, onArrival, outline, checkResult, projectId = "", extensionsApi, extensions = noExtensions, onSyntaxActivity }: {
  path: string;
  text: string;
  original?: string;
  onCopy: (text: string) => void;
  viewSwitcher?: ReactNode;
  heading: ReactNode;
  fallbackCopy?: string;
  footer?: ReactNode;
  dock?: ReactNode;
  comparison: string;
  readPosition: () => ReadingPosition | undefined;
  onPosition: (position: ReadingPosition) => void;
  onDefinition?: (gesture: DefinitionGesture) => void;
  onReferences?: (position: CodeDefinitionPosition, text: string) => Promise<CodeDocumentHighlightRange[]>;
  onBack?: () => void;
  arrival?: DefinitionArrival;
  onArrival: (found?: boolean) => void;
  outline?: ReactNode;
  checkResult?: CheckedFile;
  projectId?: string;
  extensionsApi?: CodeExtensionPlatform;
  extensions?: CodeExtension[];
  onSyntaxActivity?: (path: string, activity: ExtensionActivity) => void;
}) {
  const { t, locale } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const location = useRef({ readPosition, onPosition, onDefinition, onReferences, onBack });
  const contextMenu = useCodeContextMenu();
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const syntax = useExtensionSyntax(extensionsApi, extensions, projectId, path, text, onSyntaxActivity);
  const tokens = syntax?.tokens;
  const extension = fileExtension(path);
  const highlightsAvailable = Boolean(onReferences);
  const canNavigate = Boolean(onDefinition && supportsCodeNavigation(path));
  useLayoutEffect(() => { location.current = { readPosition, onPosition, onDefinition, onReferences, onBack }; },
    [readPosition, onPosition, onDefinition, onReferences, onBack]);
  const definitionAt = useCallback((view: EditorView, offset: number) => {
    const word = view.state.wordAt(offset);
    const visit = location.current.onDefinition;
    if (!word || !visit) return false;
    const line = view.state.doc.lineAt(word.from);
    visit({
      position: { line: line.number - 1, character: word.from - line.from },
      text: view.state.doc.toString(),
      viewport: { anchor: word.from, head: word.from, length: view.state.doc.length, scroll: view.scrollSnapshot() },
    });
    return true;
  }, []);

  useLayoutEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const { readPosition: restore, onPosition: remember } = location.current;
    const saved = restore();
    const document = normalizeReviewText(text);
    const selection = saved ? {
      anchor: Math.min(saved.anchor, document.length),
      head: Math.min(saved.head, document.length),
    } : undefined;
    const updateCursor = (state: EditorState) => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      setCursor({ line: line.number, column: head - line.from + 1 });
    };
    const view = new EditorView({
      parent: host.current,
      scrollTo: saved?.length === document.length ? saved.scroll
        : selection ? EditorView.scrollIntoView(selection.head, { y: "center" }) : undefined,
      state: EditorState.create({
        doc: document,
        selection,
        extensions: [
          EditorState.readOnly.of(true),
          readerPhrases(locale),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": path, "aria-readonly": "true", role: "textbox", tabindex: "0" }),
          lineNumbers(),
          ...(original === undefined ? [foldGutter(), highlightActiveLine(), highlightActiveLineGutter()] : []),
          EditorView.updateListener.of((update) => { if (update.selectionSet) updateCursor(update.state); }),
          search({ createPanel: createCodeFindPanel }),
          ...(highlightsAvailable ? [codeReferenceHighlights((position) =>
            location.current.onReferences?.(position, document) ?? Promise.resolve([]))] : []),
          keymap.of(readerSearchKeys),
          keymap.of([
            { key: "F12", run: (view) => definitionAt(view, view.state.selection.main.head) },
            { key: "Alt-ArrowLeft", run: () => {
              const back = location.current.onBack;
              if (!back) return false;
              back();
              return true;
            } },
          ]),
          ...(canNavigate ? [codeDefinitionLinks(definitionAt)] : []),
          sourceTheme,
          language.of([]),
          contributedSyntax.of([]),
          syntaxHighlighting(sqlHighlightStyle),
          ...(original === undefined ? [] : unifiedMergeView({
            original: normalizeReviewText(original),
            mergeControls: false,
            collapseUnchanged: reviewDiffCollapse,
            diffConfig: reviewDiffConfig,
          })),
        ],
      }),
    });
    editor.current = view;
    updateCursor(view.state);
    let active = true;
    const alias = extension === "yml" ? "yaml"
      : ["pyw", "pyi"].includes(extension) ? "py"
      : ["cjs", "mjs"].includes(extension) ? "js"
      : ["cts", "mts"].includes(extension) ? "ts"
      : extension === "phtml" ? "php" : extension === "markdown" ? "md" : extension;
    if (Object.hasOwn(languages, alias)) void languages[alias]().then((support) => {
      if (active) view.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => { /* The document remains readable as plain text. */ });
    return () => {
      active = false;
      const { anchor, head } = view.state.selection.main;
      remember({ anchor, head, length: view.state.doc.length, scroll: view.scrollSnapshot() });
      editor.current = null;
      view.destroy();
    };
  }, [canNavigate, definitionAt, extension, highlightsAvailable, locale, original, path, text]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const ranges = (tokens ?? []).map(({ from, to, style }) => Decoration.mark({ class: "cm-vsix-" + style }).range(from, to));
    view.dispatch({ effects: contributedSyntax.reconfigure(ranges.length ? EditorView.decorations.of(Decoration.set(ranges)) : []) });
  }, [canNavigate, definitionAt, extension, highlightsAvailable, locale, original, path, text, tokens]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || !checkResult) return;
    let active = true;
    let applied = false;
    void contentDigest(normalizeReviewText(text)).then((digest) => {
      if (!active || digest !== checkResult.digest) return;
      const diagnostics = checkResult.findings.flatMap<Diagnostic>((finding) => finding.range
        ? [{ ...diagnosticSpan(view.state.doc, finding.range), severity: finding.severity,
          source: `${checkResult.provider ?? "markdownlint"} · ${finding.rule}`, message: finding.message }] : []);
      if (diagnostics.length) {
        view.dispatch(setDiagnostics(view.state, diagnostics));
        applied = true;
      }
    }).catch(() => { /* Leave the reader usable when diagnostic verification fails. */ });
    return () => {
      active = false;
      if (applied && editor.current === view) view.dispatch(setDiagnostics(view.state, []));
    };
  }, [checkResult, canNavigate, extension, highlightsAvailable, locale, original, path, text]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || !arrival) return;
    const { doc } = view.state;
    if ("viewport" in arrival) {
      const saved = arrival.viewport;
      const head = Math.min(saved.head, doc.length);
      view.dispatch({
        selection: { anchor: Math.min(saved.anchor, doc.length), head },
        effects: saved.length === doc.length ? saved.scroll : EditorView.scrollIntoView(head, { y: "center" }),
      });
    } else if ("check" in arrival) {
      if (normalizeReviewText(text) === arrival.check.text && arrival.check.range) {
        const { range } = arrival.check;
        expandCheckLine(view, range.line + 1);
        const { from, to } = diagnosticSpan(doc, range);
        view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
      }
    } else {
      const line = doc.line(Math.min(arrival.position.line + 1, doc.lines));
      const offset = Math.min(line.from + arrival.position.character, line.to);
      const end = Math.min(offset + (arrival.match?.length ?? 0), line.to);
      if (arrival.match !== undefined && (line.number !== arrival.position.line + 1 || doc.sliceString(offset, end) !== arrival.match)) {
        onArrival(false);
        return;
      }
      view.dispatch({ selection: { anchor: offset, head: end },
        effects: EditorView.scrollIntoView(offset, { y: "center" }) });
    }
    view.focus();
    onArrival();
  }, [arrival, text, onArrival]);

  function showContextMenu(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    const view = editor.current;
    if (!view || !(event.target instanceof Element) || !event.target.closest(".cm-content")) return;
    const { from, to, head } = view.state.selection.main;
    const point = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0)
      ? view.posAtCoords({ x: event.clientX, y: event.clientY }, false) : head;
    const offset = event.target.closest(".cm-deletedChunk, .cm-collapsedLines") ? null : point;
    const line = offset === null ? undefined : view.state.doc.lineAt(offset);
    contextMenu.show(event, path, [
      { label: t("codeReview.menu.copySelection"), disabled: from === to, run: () => onCopy(view.state.sliceDoc(from, to)) },
      ...(line ? [{ label: t("codeReview.menu.copyLocation"), run: () => onCopy(`${path}:${line.number}`) }] : []),
      { label: t("codeReview.menu.findInFile"), separatorBefore: true, run: () => openSearchPanel(view) },
      { label: t("codeReview.goToLine"), run: () => openLinePrompt(view) },
      ...(canNavigate && offset !== null && view.state.wordAt(offset) ? [
        { label: t("codeReview.definition"), run: () => definitionAt(view, offset) },
      ] : []),
    ], view.contentDOM);
  }

  return <>
    <div className="code-review-reader-toolbar">
      <div className="code-review-reader-context">
        {viewSwitcher}
        {heading}
      </div>
      <div className="code-review-reader-actions" role="group" aria-label={t("codeReview.readerActions")}>
        {original !== undefined && original !== text && <div className="code-review-change-actions">
          <IconButton icon="chevronUp" className="code-review-tool" label={t("codeReview.previous")}
            onClick={() => { if (editor.current) goToPreviousChunk(editor.current); }} />
          <IconButton icon="chevronDown" className="code-review-tool" label={t("codeReview.next")}
            onClick={() => { if (editor.current) goToNextChunk(editor.current); }} />
        </div>}
        <IconButton icon="search" className="code-review-tool" data-code-find="" label={t("codeReview.find")}
          onClick={() => { if (editor.current) openSearchPanel(editor.current); }} />
        <IconButton icon="copy" className="code-review-tool" label={t("codeReview.copy")} onClick={() => {
          const state = editor.current?.state;
          const selection = state && state.sliceDoc(state.selection.main.from, state.selection.main.to);
          onCopy(selection || (fallbackCopy ?? text));
        }} />
      </div>
    </div>
    <div className="code-review-reader-body">
      <div className="code-review-reader-host" ref={host}
        onContextMenu={showContextMenu}
        onKeyDown={(event) => { if (isCodeContextMenuKey(event)) showContextMenu(event); }} />
      {outline}
    </div>
    {contextMenu.surface}
    {dock}
    <div className="code-review-reading-status">
      {footer}
      <span className="code-review-status-context">{comparison}</span>
      <button type="button" className="code-review-position" data-code-go-to-line="" aria-keyshortcuts="Control+G"
        title={`${t("codeReview.goToLine")} (${formatCommandShortcut(CODE_SHORTCUTS["go-to-line"])})`} aria-label={t("codeReview.goToLine")}
        onClick={() => { if (editor.current) openLinePrompt(editor.current); }}>{t("codeReview.caret", cursor)}</button>
      <span title={syntax?.extension}>{syntax?.name ?? codeFileType(path) ?? t("codeReview.plainText")}</span>
    </div>
  </>;
}
