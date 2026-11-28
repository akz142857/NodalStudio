import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../i18n";
import type {
  CodeReviewChange, CodeReviewCompactFolders, CodeReviewPlatform, CodeReviewProject,
} from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import { SchemaObjectMenu } from "../SchemaObjectMenu";
import type { ReadingMode } from "./code-review-checks";
import { codeReviewKeys } from "./code-review-query-keys";
import { treeEntryKey, type ChangedPaths, type TreeEntry } from "./code-directory-tree-utils";
import { isCodeContextMenuKey } from "./use-code-context-menu";

const fileStatusMarker: Record<CodeReviewChange["kind"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", conflict: "!",
};
const folderStatusMessage = {
  added: "codeReview.folderContainsAdded",
  modified: "codeReview.folderContainsChanges",
  deleted: "codeReview.folderContainsDeleted",
  renamed: "codeReview.folderContainsChanges",
  conflict: "codeReview.folderContainsConflicts",
} as const;
const folderStatusMarker: Partial<Record<CodeReviewChange["kind"], string>> = {
  added: "+", modified: "•", renamed: "•", deleted: "−", conflict: "!",
};

function folderRow(entry: TreeEntry, changedPaths: ChangedPaths, showHidden: boolean, compact: boolean) {
  const names = [entry.name];
  const paths = [entry.path];
  let path = entry.path;
  if (compact && entry.directory) {
    for (const name of entry.compactSegments ?? []) {
      const child = `${path}/${name}`;
      const changed = changedPaths.get(path);
      if ((!showHidden && name.startsWith(".")) || (changed && [...changed.values()].some((sibling) =>
        (showHidden || !sibling.name.startsWith(".")) && (!sibling.directory || sibling.path !== child)))) break;
      names.push(name);
      paths.push(child);
      path = child;
    }
  }
  return { names, paths, tail: path };
}

export function FileViewOptions({ compactFolders, showHidden, toggleCompactFolders, toggleHidden }: {
  compactFolders: boolean;
  showHidden: boolean;
  toggleCompactFolders: () => void;
  toggleHidden: () => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLButtonElement>();
  const label = t("codeReview.fileViewOptions");
  return <>
    <IconButton icon="sliders" label={label} className="code-review-tool" aria-haspopup="menu" aria-expanded={Boolean(anchor)}
      onClick={(event) => setAnchor(anchor ? undefined : event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setAnchor(event.currentTarget);
      }} />
    {anchor && <SchemaObjectMenu anchor={anchor} name={label} showName={false} className="code-review-view-options"
      actions={[
        { label: t("codeReview.compactFolders"), checked: compactFolders, checkbox: true, run: toggleCompactFolders },
        { label: t("codeReview.showHidden"), checked: showHidden, checkbox: true, run: toggleHidden },
      ]} onClose={(restoreFocus) => {
        setAnchor(undefined);
        if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
      }} />}
  </>;
}

export function DirectoryTree({ api, project, path, active, focusedKey, onFocusRow, onOpen, onFileMenu, onFolderMenu, reveal, showHidden, compact, changedPaths, expanded, onToggle, readDirectory = true }: {
  api: CodeReviewPlatform;
  project: CodeReviewProject;
  path: string;
  active?: string;
  focusedKey?: string;
  onFocusRow?: (key: string) => void;
  onOpen: (path: string, mode: ReadingMode) => void;
  onFileMenu: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, path: string, source: "tree") => void;
  onFolderMenu?: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, path: string) => void;
  reveal?: { path: string };
  showHidden: boolean;
  compact?: CodeReviewCompactFolders;
  changedPaths: ChangedPaths;
  expanded: ReadonlySet<string>;
  onToggle: (paths: string[]) => void;
  readDirectory?: boolean;
}) {
  const { t } = useI18n();
  const directory = useQuery({
    queryKey: codeReviewKeys.directory(project.id, path, compact),
    queryFn: () => api.directory(project.id, path, compact),
    placeholderData: (previous, query) => query?.queryKey[3] === path ? previous : undefined,
    retry: false,
    staleTime: Infinity,
    enabled: readDirectory,
  });
  const revealRow = useRef<HTMLButtonElement>(null);
  const lastReveal = useRef<typeof reveal>(undefined);
  useLayoutEffect(() => {
    const row = revealRow.current;
    if (!row || lastReveal.current === reveal) return;
    lastReveal.current = reveal;
    row.scrollIntoView?.({ block: "nearest" });
    row.focus({ preventScroll: true });
  }, [reveal, directory.data, changedPaths]);
  if (readDirectory && directory.isPending) return <p role="status">{t("navigation.loadingWorkspace")}</p>;
  const changed = changedPaths.get(path);
  if (readDirectory && directory.isError && !changed) return <p role="alert">{t("codeReview.folderFailed")}</p>;
  const workingEntries = readDirectory ? directory.data?.entries ?? [] : [];
  const present = new Set(workingEntries.map(treeEntryKey));
  const missing = [...(changed?.values() ?? [])].filter((entry) => !present.has(treeEntryKey(entry)));
  // Changes can contain files absent from the working tree, including a deleted directory's last file.
  const entries = missing.length === 0 ? workingEntries : [...workingEntries, ...missing].sort((a, b) =>
    Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  const visible = entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  const isRoot = path === "";
  const hasVisibleFocused = focusedKey !== undefined && visible.some((entry) => treeEntryKey(entry) === focusedKey);
  return <>
    {readDirectory && directory.isError && <p role="alert">{t("codeReview.folderFailed")}</p>}
    {readDirectory && directory.data?.limited && <p role="status">{t("codeReview.limited")}</p>}
    {visible.length > 0 && <ul className="code-review-tree" role={isRoot ? "tree" : "group"}
      aria-label={isRoot ? t("codeReview.files") : undefined}>{visible.map((entry, index) => {
      const key = treeEntryKey(entry);
      const kind = changed?.get(key)?.kind;
      const status = kind ? t(entry.directory ? folderStatusMessage[kind] : `codeReview.kind.${kind}`) : undefined;
      const onDisk = present.has(key);
      const isOpen = expanded.has(entry.path);
      const { names, paths, tail } = folderRow(entry, changedPaths, showHidden,
        Boolean(compact && onDisk && !directory.isPlaceholderData && !directory.isError));
      const compacted = names.length > 1;
      const menu = entry.directory
        ? onDisk && onFolderMenu && ((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => onFolderMenu(event, tail))
        : (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => onFileMenu(event, entry.path, "tree");
      const tabbable = focusedKey ? key === focusedKey : isRoot && !hasVisibleFocused && (active ? entry.path === active : index === 0)
        ? true : isRoot && index === 0 && !visible.some((item) => !item.directory && item.path === active);
      return <li key={key} role="treeitem" aria-expanded={entry.directory ? isOpen : undefined}
        aria-selected={!entry.directory && entry.path === active ? true : undefined}>
        <button type="button" data-code-row="" tabIndex={tabbable ? 0 : -1}
          aria-current={!entry.directory && entry.path === active ? "true" : undefined}
          data-folder-change={entry.directory ? kind : undefined}
          data-has-status={status ? "true" : undefined}
          ref={reveal && (entry.path === reveal.path || tail === reveal.path) ? revealRow : undefined}
          aria-haspopup={menu ? "menu" : undefined} aria-keyshortcuts={menu ? "Shift+F10" : undefined}
          onFocus={() => onFocusRow?.(key)}
          onContextMenu={menu || undefined}
          onKeyDown={menu ? (event) => { if (isCodeContextMenuKey(event)) menu(event); } : undefined}
          aria-label={compacted ? names.join(" / ") : undefined}
          title={status ? `${tail} · ${status}` : tail} aria-description={status}
          aria-expanded={entry.directory ? isOpen : undefined}
          onClick={() => entry.directory ? onToggle(paths) : onOpen(entry.path, onDisk ? "source" : "diff")}>
          <span className="code-review-disclosure">{entry.directory && <ActionIcon name={isOpen ? "chevronDown" : "chevronRight"} />}</span>
          <ActionIcon className={entry.directory ? "code-review-folder-icon" : undefined} name={entry.directory ? "folder" : "document"} />
          {compacted ? <span className="code-review-compact-name" aria-hidden="true">
            <span className="code-review-filename code-review-compact-prefix">{names.slice(0, -1).join(" / ")}</span>
            <span className="code-review-compact-separator">/</span>
            <span className="code-review-filename code-review-compact-tail">{names.at(-1)}</span>
          </span> : <span className="code-review-filename">{entry.name}</span>}
          {kind && (entry.directory ? <span className="code-review-tree-folder-status" aria-hidden="true">{folderStatusMarker[kind]}</span>
            : <span className="code-review-kind code-review-tree-file-status" data-kind={kind} aria-hidden="true">{fileStatusMarker[kind]}</span>)}
        </button>
        {entry.directory && isOpen && <DirectoryTree api={api} project={project} path={tail} active={active}
          focusedKey={focusedKey} onFocusRow={onFocusRow} onOpen={onOpen}
          onFileMenu={onFileMenu} onFolderMenu={onFolderMenu} reveal={reveal}
          showHidden={showHidden} compact={compact} changedPaths={changedPaths} expanded={expanded} onToggle={onToggle}
          readDirectory={onDisk || Boolean(readDirectory && directory.data?.limited)} />}
      </li>;
    })}</ul>}
  </>;
}
