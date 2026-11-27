import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeDefinitionPosition, CodeReviewPlatform, CodeSearchMatch } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import { Segmented } from "../Segmented";

function score(path: string, query: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const lower = path.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  let next = 0;
  for (const letter of query) {
    const index = lower.indexOf(letter, next);
    if (index < 0) return Infinity;
    next = index + 1;
  }
  return 4 + next / 2048;
}

export function CodeQuickOpen({ api, projectId, visible, anchor, contentPane, contentQuery, onContentQuery, recent, untracked, unavailable, onOpen, onHit, onFind, onDismiss }: {
  api: CodeReviewPlatform;
  projectId: string;
  visible: boolean;
  anchor?: RefObject<HTMLButtonElement | null>;
  contentPane: HTMLElement | null;
  contentQuery: string;
  onContentQuery: (query: string) => void;
  recent: readonly string[];
  untracked: readonly string[];
  unavailable: ReadonlySet<string>;
  onOpen: (path: string, position?: CodeDefinitionPosition) => void;
  onHit: (path: string, match: CodeSearchMatch) => void;
  onFind?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  const field = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"files" | "content">("files");
  const [fileQuery, setFileQuery] = useState("");
  const [submitted, setSubmitted] = useState(contentQuery);
  const [selectedFile, setSelectedFile] = useState(0);
  const [selectedHit, setSelectedHit] = useState(0);
  const searchingContent = mode === "content";
  const contentInPopup = visible && searchingContent;
  const contentVisible = contentInPopup || Boolean(contentPane);
  useLayoutEffect(() => {
    if (visible) field.current?.focus({ preventScroll: true });
  }, [mode, visible]);
  useEffect(() => {
    if (!contentVisible || !contentQuery.trim()) return;
    const timer = window.setTimeout(() => setSubmitted(contentQuery), 250);
    return () => window.clearTimeout(timer);
  }, [contentQuery, contentVisible]);
  useLayoutEffect(() => {
    const panel = popup.current;
    const overlay = panel?.parentElement;
    const trigger = anchor?.current;
    if (!visible || !panel || !overlay || !trigger) return;
    const update = () => {
      if (!overlay.clientWidth) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = overlay.getBoundingClientRect();
      const scale = viewport.width / overlay.clientWidth || 1;
      const gutter = 12;
      const width = Math.min(Math.max(rect.width / scale, 480), 720, overlay.clientWidth - gutter * 2);
      const left = Math.max(gutter, Math.min((rect.left - viewport.left) / scale, overlay.clientWidth - width - gutter));
      panel.style.setProperty("--code-quick-open-top", `${Math.max(4, (rect.top - viewport.top) / scale - 7)}px`);
      panel.style.setProperty("--code-quick-open-width", `${width}px`);
      panel.style.setProperty("--code-quick-open-left", `${left}px`);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(overlay);
    observer?.observe(trigger);
    const topbar = trigger.closest("header");
    if (topbar) observer?.observe(topbar);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchor, visible]);
  const content = useQuery({
    queryKey: ["code-review", projectId, "content", submitted],
    queryFn: () => api.searchContent?.(projectId, submitted) ?? Promise.reject(new Error("Content search unavailable")),
    enabled: contentVisible && Boolean(submitted.trim()) && submitted === contentQuery,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const contentFiles = contentQuery.trim() && contentQuery === submitted ? content.data?.files ?? [] : [];
  const hits = contentFiles.flatMap(({ path, matches }) => matches.map((match) => ({ path, match })));
  const hitIndex = new Map(hits.map(({ match }, position) => [match, position]));
  const index = useQuery({
    queryKey: ["code-review", projectId, "paths"],
    queryFn: () => api.paths?.(projectId) ?? Promise.resolve({ paths: [], limited: false }),
    staleTime: 30_000,
    enabled: visible && !searchingContent,
    retry: false,
  });
  const input = fileQuery.trim();
  const target = /^(.*?):([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/.exec(input);
  const needle = (target?.[1] ?? input).toLowerCase();
  const candidates = !visible || searchingContent ? [] : [...new Set([...recent, ...untracked, ...(index.data?.paths ?? [])])].filter((path) => !unavailable.has(path));
  const matches = (needle ? candidates.map((path) => ({ path, score: score(path, needle) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .map((item) => item.path) : candidates).slice(0, 40);
  const activeFile = Math.min(selectedFile, matches.length - 1);
  const activeHit = Math.min(selectedHit, hits.length - 1);
  const fileListId = `${listId}-files`;
  const contentListId = `${listId}-content`;
  const results = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    results.current?.querySelector("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [activeHit, contentInPopup, contentPane]);
  const closePopup = () => {
    setFileQuery("");
    setSelectedFile(0);
    onDismiss();
  };
  const open = (path: string) => {
    onOpen(path, target ? { line: Number(target[2]) - 1, character: Number(target[3] ?? 1) - 1 } : undefined);
    closePopup();
  };
  const openHit = (hit: number) => {
    setSelectedHit(hit);
    onHit(hits[hit].path, hits[hit].match);
    if (contentInPopup) closePopup();
  };
  const refreshContent = () => {
    if (!contentQuery.trim()) return;
    if (contentQuery === submitted) void content.refetch();
    else setSubmitted(contentQuery);
  };
  function navigate(event: KeyboardEvent<HTMLInputElement>, contentMode: boolean) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && contentMode && contentQuery.trim() && (contentQuery !== submitted || content.isError)) {
      event.preventDefault();
      refreshContent();
      return;
    }
    const count = contentMode ? hits.length : matches.length;
    if (!count) return;
    const active = contentMode ? activeHit : activeFile;
    const select = contentMode ? setSelectedHit : setSelectedFile;
    switch (event.key) {
      case "ArrowDown": select((active + 1) % count); break;
      case "ArrowUp": select((active + count - 1) % count); break;
      case "Enter":
        if (contentMode) openHit(active);
        else open(matches[active]);
        break;
      default: return;
    }
    event.preventDefault();
    if (!contentMode && event.key !== "Enter") requestAnimationFrame(() =>
      document.getElementById(fileListId)?.querySelector("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest" }));
  }
  const contentStatus = !contentQuery.trim() ? ""
    : contentQuery !== submitted || content.isFetching || content.isPending ? t("codeReview.contentSearching")
    : content.isError ? t("codeReview.contentFailed")
    : hits.length ? t("codeReview.contentCount", {
      lines: t(hits.length === 1 ? "codeReview.contentSingleLine" : "codeReview.contentLines", { count: hits.length }),
      files: t(contentFiles.length === 1 ? "codeReview.contentSingleFile" : "codeReview.contentFiles", { count: contentFiles.length }),
    })
    : t("codeReview.contentEmpty");
  const contentField = <div className="code-quick-open-field">
    <ActionIcon name="search" />
    <input ref={contentInPopup ? field : undefined} data-modal-focus={contentInPopup || undefined} data-code-content-field role="combobox" aria-expanded={true}
      aria-controls={contentListId} aria-activedescendant={activeHit < 0 ? undefined : `${contentListId}-${activeHit}`}
      maxLength={128} aria-label={t("codeReview.projectContent")} placeholder={t("codeReview.contentPlaceholder")} value={contentQuery}
      onChange={(event) => { onContentQuery(event.target.value); setSelectedHit(0); }} onKeyDown={(event) => navigate(event, true)} />
    <IconButton icon="refresh" className="code-review-tool" label={t("codeReview.refreshSearch")} onClick={refreshContent}
      disabled={!contentQuery.trim() || content.isFetching} />
  </div>;
  const limited = content.data?.limited && contentQuery === submitted && !content.isFetching;
  const contentBody = <>
    <div ref={results} id={contentListId} className="code-content-results" role="listbox" aria-label={t("codeReview.projectContent")}>
      {contentFiles.map(({ path, matches }) => <div key={path} role="group" aria-label={path} className="code-content-group">
        <div className="code-content-path" title={path} aria-hidden="true">
          <ActionIcon name="document" /><span>{contentInPopup ? path : path.slice(path.lastIndexOf("/") + 1)}</span>
        </div>
        {matches.map((match) => {
          const hit = hitIndex.get(match)!;
          return <div key={match.line} id={`${contentListId}-${hit}`} role="option" aria-selected={hit === activeHit} className="code-content-result"
            onMouseDown={(event) => event.preventDefault()} onClick={() => openHit(hit)}>
            <span className="code-content-line">{match.line + 1}</span>
            <code title={contentInPopup ? undefined : match.before + match.matched + match.after}>
              {contentInPopup ? match.before : match.before.trimStart()}<mark>{match.matched}</mark>{match.after}
            </code>
          </div>;
        })}
      </div>)}
    </div>
    <div className="code-quick-open-status" role="status" hidden={!contentStatus}>
      {contentStatus}
      {limited && <div title={t("codeReview.contentLimited")}>{t(contentInPopup ? "codeReview.contentLimited" : "codeReview.contentPartial")}</div>}
    </div>
  </>;
  return <>
    {contentPane && !contentInPopup && createPortal(<>{contentField}{contentBody}</>, contentPane)}
    {visible && <ModalSurface label={t("codeReview.quickOpen")} onDismiss={closePopup}>
      <div className="code-quick-open-overlay" onClick={(event) => { if (event.target === event.currentTarget) closePopup(); }}>
        <div ref={popup} className="code-quick-open ds-surface">
          {searchingContent ? contentField : <div className="code-quick-open-field">
            <ActionIcon name="search" />
            <input ref={field} data-modal-focus role="combobox" aria-expanded={true} aria-controls={fileListId}
              aria-activedescendant={activeFile < 0 ? undefined : `${fileListId}-${activeFile}`}
              aria-label={t("codeReview.quickOpen")} placeholder={t("codeReview.quickOpenPlaceholder")} value={fileQuery}
              onChange={(event) => { setFileQuery(event.target.value); setSelectedFile(0); }} onKeyDown={(event) => navigate(event, false)} />
            {onFind && <Button size="small" onClick={() => { closePopup(); onFind(); }}>{t("codeReview.menu.findInFile")}</Button>}
          </div>}
          {api.searchContent && <Segmented className="code-quick-open-scope" label={t("codeReview.searchScope")} value={mode}
            options={[{ value: "files", label: t("codeReview.files") }, { value: "content", label: t("codeReview.projectContent") }]}
            onChange={setMode} />}
          {searchingContent ? contentBody : <>
            <ul id={fileListId} role="listbox" aria-label={t("codeReview.files")}>
              {matches.map((path, position) => <li key={path} id={`${fileListId}-${position}`} role="option" aria-selected={position === activeFile}
                onMouseDown={(event) => event.preventDefault()} onClick={() => open(path)}>
                <ActionIcon name="document" />
                <strong>{path.slice(path.lastIndexOf("/") + 1)}</strong>
                <span>{path}</span>
              </li>)}
            </ul>
            <div className="code-quick-open-status" role="status">
              {index.isError ? t("codeReview.quickOpenUnavailable")
                : index.isPending ? t("navigation.loadingWorkspace")
                : matches.length === 0 ? t("codeReview.quickOpenEmpty")
                : index.data.limited ? t("codeReview.limited") : t("codeReview.quickOpenHint")}
            </div>
          </>}
        </div>
      </div>
    </ModalSurface>}
  </>;
}
