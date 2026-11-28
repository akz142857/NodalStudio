import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import type { CodeBranchChanges, CodeReviewWorktree } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";

export type CodeChangesView = "local" | "branch";

export function CodeWorktreeSwitcher({ worktrees, busy, onSwitch, onRevealInFinder }: {
  worktrees: CodeReviewWorktree[];
  busy: boolean;
  onSwitch: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDetailsElement>(null);
  const contextMenu = useCodeContextMenu();
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const current = worktrees.find((worktree) => worktree.current);
  if (!current) return null;
  const revision = (worktree: CodeReviewWorktree) => worktree.branch
    ?? [t("codeReview.gitReview.detached"), worktree.head?.slice(0, 8)].filter(Boolean).join(" · ");
  return <><details ref={menu} className="code-worktree-switcher" onKeyDown={(event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary title={current.path} aria-label={t("codeReview.worktrees.current", { name: current.name, branch: revision(current) })}
      onContextMenu={onRevealInFinder ? (event) => contextMenu.showFinder(event, current.name, () => onRevealInFinder(current.path)) : undefined}
      onKeyDown={onRevealInFinder ? (event) => {
        if (isCodeContextMenuKey(event)) contextMenu.showFinder(event, current.name, () => onRevealInFinder(current.path));
      } : undefined}
      aria-busy={busy || undefined}>
      <span className="code-worktree-label">
        <span><ActionIcon name="folder" /><strong>{current.name}</strong>
          {current.primary && <small>{t("codeReview.worktrees.primary")}</small>}</span>
        <span className="code-worktree-branch"><ActionIcon name="git" /><span>{revision(current)}</span></span>
      </span>
      <ActionIcon name="chevronDown" />
    </summary>
    <div className="code-worktree-menu ds-surface" role="group" aria-label={t("codeReview.worktrees.title")}>
      <span className="code-worktree-menu-title">{t("codeReview.worktrees.title")}</span>
      {worktrees.map((worktree) => <button key={worktree.path} type="button" aria-current={worktree.current || undefined}
        aria-haspopup={onRevealInFinder ? "menu" : undefined} aria-keyshortcuts={onRevealInFinder ? "Shift+F10" : undefined}
        onContextMenu={onRevealInFinder ? (event) => contextMenu.showFinder(event, worktree.name, () => onRevealInFinder(worktree.path)) : undefined}
        onKeyDown={onRevealInFinder ? (event) => {
          if (isCodeContextMenuKey(event)) contextMenu.showFinder(event, worktree.name, () => onRevealInFinder(worktree.path));
        } : undefined}
        disabled={busy} onClick={() => {
          if (menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
          if (!worktree.current) onSwitch(worktree.path);
        }}>
        {worktree.current ? <ActionIcon name="check" /> : <span />}
        <span className="code-worktree-option">
          <span><strong>{worktree.name}</strong> {worktree.primary && <small>{t("codeReview.worktrees.primary")}</small>}</span>
          <span>{revision(worktree)}</span>
          <span>{worktree.path}</span>
        </span>
      </button>)}
    </div>
  </details>{contextMenu.surface}</>;
}

export function CodeChangesNavigation({ view, branch, localCount, localLimited, head, previous, onView }: {
  view: CodeChangesView;
  branch?: CodeBranchChanges | null;
  localCount: number;
  localLimited: boolean;
  head?: string | null;
  previous: boolean;
  onView: (view: CodeChangesView) => void;
}) {
  const { t, formatNumber } = useI18n();
  const branchLabel = branch ? t("codeReview.worktrees.against", { ref: branch.target }) : t("codeReview.worktrees.noMainBranch");
  const activeBranch = view === "branch" && branch;
  const formatCount = (count: number, limited: boolean) => formatNumber(count) + (limited ? "+" : "");
  return <>
    <nav className="code-changes-sources" aria-label={t("codeReview.worktrees.views")}>
      <button type="button" aria-pressed={view === "local" && !previous} onClick={() => onView("local")}>
        <ActionIcon name="documents" /><span>{t("codeReview.worktrees.local")}</span>
        <span>{formatCount(localCount, localLimited)}</span>
      </button>
      <button type="button" disabled={!branch} aria-pressed={view === "branch"} onClick={() => onView("branch")}>
        <ActionIcon name="git" /><span>{branchLabel}</span>
        <span>{branch ? formatCount(branch.files.length, branch.limited) : "–"}</span>
      </button>
    </nav>
    {!previous && <details className="code-changes-comparison">
      <summary><ActionIcon name="info" />
        {t(activeBranch ? "codeReview.worktrees.committed" : "codeReview.worktrees.uncommitted")}
        <ActionIcon name="chevronDown" />
      </summary>
      <div>{activeBranch ? t("codeReview.worktrees.branchRange", { base: activeBranch.base.slice(0, 10), head: activeBranch.head.slice(0, 10) })
        : head ? t("codeReview.compareBase", { commit: head.slice(0, 10) }) : t("codeReview.gitReview.emptyBase")}</div>
    </details>}
  </>;
}
