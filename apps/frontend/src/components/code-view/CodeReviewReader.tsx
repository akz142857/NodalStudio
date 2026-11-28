import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import { sql } from "@codemirror/lang-sql";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Text, type Extension } from "@codemirror/state";
import { foldGutter, syntaxHighlighting } from "@codemirror/language";
import { getChunks, goToNextChunk, goToPreviousChunk, uncollapseUnchanged, unifiedMergeView } from "@codemirror/merge";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { gotoLine, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type KeyBinding } from "@codemirror/view";
import { sqlHighlightStyle } from "../../design-system/sql-highlight";
import { useI18n, type Translate } from "../../i18n";
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
import { sourceChangeGutter, sourceChanges, type SourceChange } from "./code-review-source-changes";
import { trackReaderScopes, type ReaderScope } from "./code-review-sticky-scroll";
import { pythonDebugSourceExtension, type PythonDebugSource } from "./python-debug-source";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";
import type { ExtensionActivity } from "./CodeReviewExtensions";
import { useExtensionSyntax } from "./use-extension-syntax";

export interface CodeReaderHandle {
  openFind: () => void;
  openGoToLine: () => void;
}

const noExtensions: CodeExtension[] = [];
const vsixMarks: Record<string, Decoration> = {
  keyword: Decoration.mark({ class: "cm-vsix-keyword" }),
  string: Decoration.mark({ class: "cm-vsix-string" }),
  comment: Decoration.mark({ class: "cm-vsix-comment" }),
  number: Decoration.mark({ class: "cm-vsix-number" }),
  variable: Decoration.mark({ class: "cm-vsix-variable" }),
  type: Decoration.mark({ class: "cm-vsix-type" }),
  tag: Decoration.mark({ class: "cm-vsix-keyword" }),
  property: Decoration.mark({ class: "cm-vsix-variable" }),
  function: Decoration.mark({ class: "cm-vsix-variable" }),
};
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
const plainText: Extension = [];

function useReaderLanguage(extension: string): Extension | undefined {
  const alias = extension === "yml" ? "yaml"
    : ["pyw", "pyi"].includes(extension) ? "py"
    : ["cjs", "mjs"].includes(extension) ? "js"
    : ["cts", "mts"].includes(extension) ? "ts"
    : extension === "phtml" ? "php" : extension === "markdown" ? "md" : extension;
  const load = Object.hasOwn(languages, alias) ? languages[alias] : undefined;
  const [language, setLanguage] = useState<{ load: typeof load; support: Extension }>();
  useEffect(() => {
    if (!load) return;
    let active = true;
    void load().catch(() => plainText).then((support) => {
      if (active) setLanguage({ load, support });
    });
    return () => { active = false; };
  }, [load]);
  if (!load) return plainText;
  return language?.load === load ? language.support : undefined;
}

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

function readerPhrases(t: Translate) {
  return EditorState.phrases.of({
    "Find in file": t("codeReview.editor.findInFile"),
    "Search options": t("codeReview.editor.searchOptions"),
    "Match case": t("codeReview.editor.matchCase"),
    "Match whole word": t("codeReview.editor.matchWholeWord"),
    "Use regular expression": t("codeReview.editor.useRegexp"),
    "Invalid regular expression": t("codeReview.editor.invalidRegexp"),
    "No matches": t("codeReview.editor.noMatches"),
    "1 match": t("codeReview.editor.oneMatch"),
    "$ matches": t("codeReview.editor.manyMatches"),
    "Match $1 of $2": t("codeReview.editor.matchOf"),
    "Previous match": t("codeReview.editor.previousMatch"),
    "Next match": t("codeReview.editor.nextMatch"),
    "Close find": t("codeReview.editor.closeFind"),
    close: t("codeReview.editor.close"),
    "current match": t("codeReview.editor.currentMatch"),
    "on line": t("codeReview.editor.onLine"),
    "Go to line": t("codeReview.editor.goToLine"),
    go: t("codeReview.editor.go"),
    "$ unchanged lines": t("codeReview.editor.unchangedLines"),
  });
}

export function CodeReviewDraft({ title, text, onEdit, outline, dock, footer, readerRef, wrap = false }: {
  title: string;
  text: string;
  onEdit: (text: string) => void;
  outline: ReactNode;
  dock: ReactNode;
  footer: ReactNode;
  readerRef?: Ref<CodeReaderHandle>;
  wrap?: boolean;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const phrases = useRef(new Compartment());
  const contentAttrs = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const draft = useRef({ text, onEdit, title, t });
  useLayoutEffect(() => { draft.current = { text, onEdit, title, t }; }, [text, onEdit, title, t]);
  useImperativeHandle(readerRef, () => ({
    openFind: () => { if (editor.current) openSearchPanel(editor.current); },
    openGoToLine: () => { if (editor.current) openLinePrompt(editor.current); },
  }), []);
  useLayoutEffect(() => {
    if (!host.current) return;
    const phrasesSlot = phrases.current;
    const attrsSlot = contentAttrs.current;
    const view = new EditorView({
      parent: host.current,
      doc: draft.current.text,
      extensions: [
        attrsSlot.of(EditorView.contentAttributes.of({ "aria-label": draft.current.title, role: "textbox", spellcheck: "false" })),
        phrasesSlot.of(readerPhrases(draft.current.t)), wrapping.current.of([]), sourceTheme, lineNumbers(), history(), highlightActiveLine(),
        search({ createPanel: createCodeFindPanel }), keymap.of([...readerSearchKeys, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) draft.current.onEdit(update.state.doc.toString());
        }),
      ],
    });
    editor.current = view;
    view.focus();
    return () => { editor.current = null; view.destroy(); };
  }, []);
  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: [
        phrases.current.reconfigure(readerPhrases(t)),
        contentAttrs.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": title, role: "textbox", spellcheck: "false" })),
        wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
      ],
    });
  }, [t, title, wrap]);
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

export function CodeReviewReader({ path, text, original, sourceBaseline, sourceFileChange, onCopy, viewSwitcher, heading, fallbackCopy, footer, dock, comparison, readPosition, onPosition,
  onDefinition, onReferences, onBack, arrival, onArrival, outline, checkResult, projectId = "", extensionsApi, extensions = noExtensions, onSyntaxActivity, readerRef, debugSource, wrap = false }: {
  path: string;
  text: string;
  original?: string;
  sourceBaseline?: string;
  sourceFileChange?: "added" | "deleted";
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
  readerRef?: Ref<CodeReaderHandle>;
  debugSource?: PythonDebugSource;
  wrap?: boolean;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const sticky = useRef<HTMLElement>(null);
  const editor = useRef<EditorView | null>(null);
  const phrases = useRef(new Compartment());
  const contributedSyntax = useRef(new Compartment());
  const sourceChangesSlot = useRef(new Compartment());
  const debuggerSlot = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const translator = useRef(t);
  const location = useRef({ readPosition, onPosition, onDefinition, onReferences, onBack });
  const contextMenu = useCodeContextMenu();
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [scopes, setScopes] = useState<ReaderScope[]>([]);
  const normalizedText = useMemo(() => normalizeReviewText(text), [text]);
  const normalizedOriginal = useMemo(() => original === undefined ? undefined : normalizeReviewText(original), [original]);
  const doc = useMemo(() => Text.of(normalizedText.split("\n")), [normalizedText]);
  const changes = useMemo(() => sourceChanges(doc, sourceBaseline === undefined ? undefined : normalizeReviewText(sourceBaseline), sourceFileChange),
    [doc, sourceBaseline, sourceFileChange]);
  const syntax = useExtensionSyntax(extensionsApi, extensions, projectId, path, normalizedText, onSyntaxActivity);
  const tokens = syntax?.tokens;
  const language = useReaderLanguage(fileExtension(path));
  const highlightsAvailable = Boolean(onReferences);
  const canNavigate = Boolean(onDefinition && supportsCodeNavigation(path));
  useLayoutEffect(() => {
    translator.current = t;
    location.current = { readPosition, onPosition, onDefinition, onReferences, onBack };
  }, [t, readPosition, onPosition, onDefinition, onReferences, onBack]);
  useImperativeHandle(readerRef, () => ({
    openFind: () => { if (editor.current) openSearchPanel(editor.current); },
    openGoToLine: () => { if (editor.current) openLinePrompt(editor.current); },
  }), []);
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
    if (!host.current || language === undefined) return;
    const phrasesSlot = phrases.current;
    const syntaxSlot = contributedSyntax.current;
    const { readPosition: restore, onPosition: remember } = location.current;
    const saved = restore();
    const document = normalizedText;
    const selection = saved ? {
      anchor: Math.min(saved.anchor, document.length),
      head: Math.min(saved.head, document.length),
    } : undefined;
    const updateCursor = (state: EditorState) => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      setCursor((prev) => prev.line === line.number && prev.column === head - line.from + 1
        ? prev : { line: line.number, column: head - line.from + 1 });
    };
    let active = true;
    const stickyScroll = trackReaderScopes((next) => {
      if (!active) return;
      setScopes((previous) => previous.length === next.length && previous.every((scope, index) =>
        scope.from === next[index].from && scope.text === next[index].text) ? previous : next);
    });
    const view = new EditorView({
      parent: host.current,
      scrollTo: saved?.length === document.length ? saved.scroll
        : selection ? EditorView.scrollIntoView(selection.head, { y: "center" }) : undefined,
      state: EditorState.create({
        doc,
        selection,
        extensions: [
          EditorState.readOnly.of(true),
          phrasesSlot.of(readerPhrases(translator.current)),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": path, "aria-readonly": "true", role: "textbox", tabindex: "0" }),
          debuggerSlot.current.of([]),
          wrapping.current.of([]),
          lineNumbers(),
          ...(normalizedOriginal === undefined ? [foldGutter(), highlightActiveLine(), highlightActiveLineGutter()] : []),
          sourceChangesSlot.current.of([]),
          stickyScroll,
          EditorView.scrollMargins.of(() => ({ top: sticky.current?.offsetHeight ?? 0 })),
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
          // CodeMirror caches deleted-line widgets when the merge view is created.
          language,
          syntaxSlot.of([]),
          syntaxHighlighting(sqlHighlightStyle),
          ...(normalizedOriginal === undefined ? [] : unifiedMergeView({
            original: normalizedOriginal,
            mergeControls: false,
            collapseUnchanged: reviewDiffCollapse,
            diffConfig: reviewDiffConfig,
          })),
        ],
      }),
    });
    editor.current = view;
    updateCursor(view.state);
    return () => {
      active = false;
      setScopes([]);
      const { anchor, head } = view.state.selection.main;
      remember({ anchor, head, length: view.state.doc.length, scroll: view.scrollSnapshot() });
      editor.current = null;
      view.destroy();
    };
  }, [canNavigate, definitionAt, doc, highlightsAvailable, language, normalizedOriginal, normalizedText, path]);

  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: phrases.current.reconfigure(readerPhrases(t)) });
  }, [t]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const ranges = (tokens ?? []).flatMap(({ from, to, style }) => {
      const mark = vsixMarks[style];
      return mark ? [mark.range(from, to)] : [];
    });
    view.dispatch({ effects: contributedSyntax.current.reconfigure(ranges.length ? EditorView.decorations.of(Decoration.set(ranges, true)) : []) });
  }, [canNavigate, definitionAt, highlightsAvailable, language, normalizedOriginal, normalizedText, path, tokens]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view) view.dispatch({ effects: sourceChangesSlot.current.reconfigure(changes.length ? sourceChangeGutter(changes) : []) });
  }, [canNavigate, changes, definitionAt, doc, highlightsAvailable, language, normalizedOriginal, normalizedText, path]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view) view.dispatch({ effects: debuggerSlot.current.reconfigure(debugSource ? pythonDebugSourceExtension(view.state, debugSource) : []) });
  }, [canNavigate, debugSource, definitionAt, doc, highlightsAvailable, language, normalizedOriginal, normalizedText, path]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view) view.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [canNavigate, definitionAt, doc, highlightsAvailable, language, normalizedOriginal, normalizedText, path, wrap]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || !checkResult) return;
    let active = true;
    let applied = false;
    void contentDigest(normalizedText).then((digest) => {
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
  }, [checkResult, canNavigate, highlightsAvailable, language, normalizedOriginal, normalizedText, path]);

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
      if (normalizedText === arrival.check.text && arrival.check.range) {
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
  }, [arrival, changes, language, normalizedText, onArrival]);

  function goToReaderLine(line: number, y: "center" | "start") {
    const view = editor.current;
    if (!view || line > view.state.doc.lines) return;
    expandCheckLine(view, line);
    const anchor = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y }) });
    view.focus();
  }

  function goToChange(direction: "previous" | "next") {
    const view = editor.current;
    if (!view) return;
    if (normalizedOriginal !== undefined) {
      (direction === "previous" ? goToPreviousChunk : goToNextChunk)(view);
      return;
    }
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const change = direction === "previous"
      ? changes.slice().reverse().find((item) => item.from < line) ?? changes.at(-1)
      : changes.find((item) => item.from > line) ?? changes[0];
    if (change) goToReaderLine(change.from, "center");
  }

  function changeMarker(change: SourceChange) {
    const lines = change.from === change.to ? String(change.from) : `${change.from}–${change.to}`;
    const label = t(`codeReview.changeMarker.${change.kind}`, { lines });
    const position = {
      "--code-change-start": `${100 * (change.from - 1) / doc.lines}%`,
      "--code-change-length": `${100 * (change.to - change.from + 1) / doc.lines}%`,
    } as CSSProperties;
    return <button key={`${change.kind}-${change.from}`} type="button" data-kind={change.kind} title={label} aria-label={label}
      style={position} onClick={() => goToReaderLine(change.from, "center")} />;
  }

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
        {(changes.length > 0 || (original !== undefined && original !== text)) && <div className="code-review-change-actions">
          <IconButton icon="chevronUp" className="code-review-tool" label={t("codeReview.previous")}
            onClick={() => goToChange("previous")} />
          <IconButton icon="chevronDown" className="code-review-tool" label={t("codeReview.next")}
            onClick={() => goToChange("next")} />
        </div>}
        {debugSource && <IconButton icon="breakpoint" className="code-review-tool" data-code-breakpoint="" aria-pressed={debugSource.lines.includes(cursor.line)}
          description={formatCommandShortcut(CODE_SHORTCUTS["debug-breakpoint"])}
          label={t("codeReview.debug.breakpoint", { line: cursor.line })} onClick={() => debugSource.toggle(cursor.line)} />}
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
      <div className="code-review-reader-frame">
        <div className="code-review-reader-host" ref={host}
          onContextMenu={showContextMenu}
          onKeyDown={(event) => { if (isCodeContextMenuKey(event)) showContextMenu(event); }} />
        {scopes.length > 0 && <nav ref={sticky} className="code-review-sticky-scopes" aria-label={t("codeReview.stickyScopes")}>
          {scopes.map((scope) => <button type="button" key={scope.from} title={scope.text}
            onClick={() => goToReaderLine(scope.line, "start")}>
            <span aria-hidden="true">{scope.line}</span><code>{scope.text}</code>
          </button>)}
        </nav>}
      </div>
      {changes.length > 0 && <div className="code-review-change-overview" role="group" aria-label={t("codeReview.changeOverview")}>
        {changes.map(changeMarker)}
      </div>}
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
