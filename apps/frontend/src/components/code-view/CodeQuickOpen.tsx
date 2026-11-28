import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeDefinitionPosition, CodeReviewPlatform, CodeSearchMatch } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import { Segmented } from "../Segmented";
import { codeReviewKeys } from "./code-review-query-keys";

interface IndexedCandidate {
  path: string;
  lower: string;
  nameLower: string;
}

function scoreCandidate(candidate: IndexedCandidate, query: string) {
  const { nameLower, lower } = candidate;
  if (nameLower === query) return 0;
  if (nameLower.startsWith(query)) return 1;
  if (nameLower.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  let next = 0;
  for (const letter of query) {
    const index = lower.indexOf(letter, next);
    if (index < 0) return Infinity;
    next = index + 1;
  }
  return 4 + next / 2048;
}

function topFileMatches(candidates: readonly IndexedCandidate[], needle: string, limit: number): string[] {
  if (!needle) return candidates.slice(0, limit).map((item) => item.path);
  const top: { path: string; rank: number }[] = [];
  let worst = Infinity;
  let worstIndex = -1;
  const better = (aRank: number, aPath: string, bRank: number, bPath: string) =>
    aRank < bRank || (aRank === bRank && aPath < bPath);
  for (const candidate of candidates) {
    const rank = scoreCandidate(candidate, needle);
    if (!Number.isFinite(rank)) continue;
    if (top.length < limit) {
      top.push({ path: candidate.path, rank });
      if (top.length === limit) {
        worstIndex = 0;
        worst = top[0].rank;
        for (let i = 1; i < top.length; i += 1) {
          if (better(worst, top[worstIndex].path, top[i].rank, top[i].path)) {
            worst = top[i].rank;
            worstIndex = i;
          }
        }
      }
    } else if (better(rank, candidate.path, worst, top[worstIndex].path)) {
      top[worstIndex] = { path: candidate.path, rank };
      worstIndex = 0;
      worst = top[0].rank;
      for (let i = 1; i < top.length; i += 1) {
        if (better(worst, top[worstIndex].path, top[i].rank, top[i].path)) {
          worst = top[i].rank;
          worstIndex = i;
        }
      }
    }
  }
  top.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  return top.map((item) => item.path);
}

export function CodeContentSearch({ api, projectId, query, onQuery, inPopup = false, autoFocus = false, fieldRef, onHit }: {
  api: CodeReviewPlatform;
  projectId: string;
  query: string;
  onQuery: (query: string) => void;
  inPopup?: boolean;
  autoFocus?: boolean;
  fieldRef?: RefObject<HTMLInputElement | null>;
  onHit: (path: string, match: CodeSearchMatch) => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  const results = useRef<HTMLDivElement>(null);
  const [submitted, setSubmitted] = useState(query);
  const [selectedHit, setSelectedHit] = useState(0);

  useEffect(() => {
    if (!query.trim()) return;
    const timer = window.setTimeout(() => setSubmitted(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const content = useQuery({
    queryKey: codeReviewKeys.content(projectId, submitted),
    queryFn: () => api.searchContent?.(projectId, submitted) ?? Promise.reject(new Error("Content search unavailable")),
    enabled: Boolean(submitted.trim()) && submitted === query,
    staleTime: Infinity,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const contentFiles = useMemo(
    () => (query.trim() && query === submitted ? content.data?.files ?? [] : []),
    [content.data?.files, query, submitted],
  );
  const { hits, hitIndex } = useMemo(() => {
    const flat = contentFiles.flatMap(({ path, matches }) => matches.map((match) => ({ path, match })));
    return { hits: flat, hitIndex: new Map(flat.map(({ match }, position) => [match, position])) };
  }, [contentFiles]);

  const activeHit = Math.min(selectedHit, hits.length - 1);

  useLayoutEffect(() => {
    results.current?.querySelector("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [activeHit, inPopup]);

  const refreshContent = () => {
    if (!query.trim()) return;
    if (query === submitted) void content.refetch();
    else setSubmitted(query);
  };

  const openHit = (hit: number) => {
    setSelectedHit(hit);
    onHit(hits[hit].path, hits[hit].match);
  };

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && query.trim() && (query !== submitted || content.isError)) {
      event.preventDefault();
      refreshContent();
      return;
    }
    if (!hits.length) return;
    switch (event.key) {
      case "ArrowDown": setSelectedHit((activeHit + 1) % hits.length); break;
      case "ArrowUp": setSelectedHit((activeHit + hits.length - 1) % hits.length); break;
      case "Enter": openHit(activeHit); break;
      default: return;
    }
    event.preventDefault();
  }

  const contentStatus = !query.trim() ? ""
    : query !== submitted || content.isFetching || content.isPending ? t("codeReview.contentSearching")
    : content.isError ? t("codeReview.contentFailed")
    : hits.length ? t("codeReview.contentCount", {
      lines: t(hits.length === 1 ? "codeReview.contentSingleLine" : "codeReview.contentLines", { count: hits.length }),
      files: t(contentFiles.length === 1 ? "codeReview.contentSingleFile" : "codeReview.contentFiles", { count: contentFiles.length }),
    })
    : t("codeReview.contentEmpty");

  const limited = content.data?.limited && query === submitted && !content.isFetching;
  const refresh = <IconButton icon="refresh" className="code-review-tool" label={t("codeReview.refreshSearch")}
    onClick={refreshContent} disabled={!query.trim() || content.isFetching} aria-busy={content.isFetching || undefined} />;

  const body = <>
    <div className="code-quick-open-field">
      <ActionIcon name="search" />
      <input ref={fieldRef} data-modal-focus={autoFocus || undefined} data-code-content-field role="combobox"
        aria-expanded={hits.length > 0} aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={activeHit < 0 ? undefined : `${listId}-${activeHit}`}
        maxLength={128} aria-label={t("codeReview.projectContent")} placeholder={t("codeReview.contentPlaceholder")} value={query}
        onChange={(event) => { onQuery(event.target.value); setSelectedHit(0); }} onKeyDown={navigate} />
      {inPopup && refresh}
    </div>
    <div ref={results} id={listId} className="code-content-results" role="listbox" aria-label={t("codeReview.projectContent")}>
      {contentFiles.map(({ path, matches }) => <div key={path} role="group" aria-label={path} className="code-content-group">
        <div className="code-content-path" title={path} aria-hidden="true">
          <ActionIcon name="document" /><span>{inPopup ? path : path.slice(path.lastIndexOf("/") + 1)}</span>
        </div>
        {matches.map((match) => {
          const hit = hitIndex.get(match)!;
          return <div key={match.line} id={`${listId}-${hit}`} role="option" aria-selected={hit === activeHit} className="code-content-result"
            onMouseDown={(event) => event.preventDefault()} onClick={() => openHit(hit)}>
            <span className="code-content-line">{match.line + 1}</span>
            <code title={inPopup ? undefined : match.before + match.matched + match.after}>
              {inPopup ? match.before : match.before.trimStart()}<mark>{match.matched}</mark>{match.after}
            </code>
          </div>;
        })}
      </div>)}
    </div>
    <div className="code-quick-open-status" role="status" hidden={!contentStatus}>
      {contentStatus}
      {limited && <div title={t("codeReview.contentLimited")}>{t(inPopup ? "codeReview.contentLimited" : "codeReview.contentPartial")}</div>}
    </div>
  </>;
  const title = t("codeReview.searchResults");
  return inPopup ? body : <>
    <header className="code-review-header">
      <h1>{title}</h1>
      <div className="code-review-header-actions" role="group" aria-label={t("codeReview.panelActions", { name: title })}>{refresh}</div>
    </header>
    <div className="code-content-pane">{body}</div>
  </>;
}

export function CodeQuickOpen({ api, projectId, visible, anchor, contentQuery, onContentQuery, recent, untracked, unavailable, onOpen, onHit, onFind, onDismiss }: {
  api: CodeReviewPlatform;
  projectId: string;
  visible: boolean;
  anchor?: RefObject<HTMLButtonElement | null>;
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
  const [selectedFile, setSelectedFile] = useState(0);
  const searchingContent = mode === "content";

  useLayoutEffect(() => {
    if (visible) field.current?.focus({ preventScroll: true });
  }, [mode, visible]);

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

  const index = useQuery({
    queryKey: codeReviewKeys.paths(projectId),
    queryFn: () => api.paths?.(projectId) ?? Promise.resolve({ paths: [], limited: false }),
    staleTime: 30_000,
    enabled: visible && !searchingContent,
    retry: false,
  });

  const input = fileQuery.trim();
  const target = /^(.*?):([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/.exec(input);
  const needle = (target?.[1] ?? input).toLowerCase();

  const indexedPaths = index.data?.paths;
  const candidates = useMemo<IndexedCandidate[]>(() => {
    if (!visible || searchingContent) return [];
    const seen = new Set<string>();
    const list: IndexedCandidate[] = [];
    const append = (paths: readonly string[]) => {
      for (const path of paths) {
        if (seen.has(path) || unavailable.has(path)) continue;
        seen.add(path);
        const lower = path.toLowerCase();
        const slash = lower.lastIndexOf("/");
        list.push({ path, lower, nameLower: slash >= 0 ? lower.slice(slash + 1) : lower });
      }
    };
    append(recent);
    append(untracked);
    if (indexedPaths) append(indexedPaths);
    return list;
  }, [indexedPaths, recent, searchingContent, unavailable, untracked, visible]);

  const matches = useMemo(() => topFileMatches(candidates, needle, 40), [candidates, needle]);
  const activeFile = Math.min(selectedFile, matches.length - 1);
  const fileListId = `${listId}-files`;

  const closePopup = () => {
    setFileQuery("");
    setSelectedFile(0);
    onDismiss();
  };

  const open = (path: string) => {
    onOpen(path, target ? { line: Number(target[2]) - 1, character: Number(target[3] ?? 1) - 1 } : undefined);
    closePopup();
  };

  function navigateFiles(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || !matches.length) return;
    switch (event.key) {
      case "ArrowDown": setSelectedFile((activeFile + 1) % matches.length); break;
      case "ArrowUp": setSelectedFile((activeFile + matches.length - 1) % matches.length); break;
      case "Enter": open(matches[activeFile]); break;
      default: return;
    }
    event.preventDefault();
    if (event.key !== "Enter") requestAnimationFrame(() =>
      document.getElementById(fileListId)?.querySelector("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest" }));
  }

  if (!visible) return null;
  return <ModalSurface label={t("codeReview.quickOpen")} onDismiss={closePopup}>
    <div className="code-quick-open-overlay" onClick={(event) => { if (event.target === event.currentTarget) closePopup(); }}>
      <div ref={popup} className="code-quick-open ds-surface">
        {searchingContent ? <>
          {api.searchContent && <Segmented className="code-quick-open-scope" label={t("codeReview.searchScope")} value={mode}
            options={[{ value: "files", label: t("codeReview.searchFilesScope") }, { value: "content", label: t("codeReview.projectContent") }]}
            onChange={setMode} />}
          <CodeContentSearch api={api} projectId={projectId} query={contentQuery} onQuery={onContentQuery}
            inPopup autoFocus fieldRef={field} onHit={(path, match) => { onHit(path, match); closePopup(); }} />
        </> : <>
          <div className="code-quick-open-field">
            <ActionIcon name="search" />
            <input ref={field} data-modal-focus role="combobox" aria-expanded={matches.length > 0} aria-autocomplete="list" aria-controls={fileListId}
              aria-activedescendant={activeFile < 0 ? undefined : `${fileListId}-${activeFile}`}
              aria-label={t("codeReview.quickOpen")} placeholder={t("codeReview.quickOpenPlaceholder")} value={fileQuery}
              onChange={(event) => { setFileQuery(event.target.value); setSelectedFile(0); }} onKeyDown={navigateFiles} />
            {onFind && <Button size="small" onClick={() => { closePopup(); onFind(); }}>{t("codeReview.menu.findInFile")}</Button>}
          </div>
          {api.searchContent && <Segmented className="code-quick-open-scope" label={t("codeReview.searchScope")} value={mode}
            options={[{ value: "files", label: t("codeReview.searchFilesScope") }, { value: "content", label: t("codeReview.projectContent") }]}
            onChange={setMode} />}
          <ul id={fileListId} role="listbox" aria-label={t("codeReview.searchFilesScope")}>
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
  </ModalSurface>;
}
