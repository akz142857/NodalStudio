import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { CodeChangeComparison, CodeReviewGit } from "../../platform/code-review";
import { Segmented } from "../Segmented";
import type { NoteStatus } from "./CodeFileReview";

export type GitReviewScope = "all" | CodeChangeComparison;
export type GitReviewFilter = "all" | NoteStatus;

type ReviewCounts = Record<NoteStatus, number>;

export function CodeGitReviewControls({ git, scope, filter, counts, busy, canAdvance, canUpdateBaseline,
  showNavigation = true, previous = false, onPrevious, onScope, onFilter, onNext, onUpdateBaseline }: {
  git: CodeReviewGit;
  scope: GitReviewScope;
  filter: GitReviewFilter;
  counts: ReviewCounts;
  busy: boolean;
  canAdvance: boolean;
  canUpdateBaseline: boolean;
  showNavigation?: boolean;
  previous?: boolean;
  onPrevious?: () => void;
  onScope: (scope: GitReviewScope) => void;
  onFilter: (filter: GitReviewFilter) => void;
  onNext: () => void;
  onUpdateBaseline: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const total = counts.pending + counts.reviewed + counts.needsChanges + counts.recheck;
  const summary = t("codeReview.gitReview.progress", { reviewed: formatNumber(counts.reviewed), total: formatNumber(total) });
  return <div className="code-review-git-controls">
    {(showNavigation || previous) && <div className="code-review-git-base">
      <strong title={git.branch ?? undefined}>{git.branch ?? t("codeReview.gitReview.detached")}</strong>
      <span title={git.baseline ?? undefined}>{git.baseline
        ? t("codeReview.compareBase", { commit: git.baseline.slice(0, 10) })
        : t("codeReview.gitReview.emptyBase")}</span>
    </div>}
    {git.baselineChanged && (showNavigation || onPrevious || previous) && <div className="code-review-git-notice">
      <p role="status">{t(showNavigation || previous ? "codeReview.gitReview.baselineChanged" : "codeReview.worktrees.previousAvailable")}</p>
      {!previous && onPrevious && <Button size="small" disabled={busy} onClick={onPrevious}>{t("codeReview.worktrees.previous")}</Button>}
      {(showNavigation || previous) && canUpdateBaseline && <Button size="small" disabled={busy} onClick={onUpdateBaseline}>{t("codeReview.gitReview.updateBaseline")}</Button>}
    </div>}
    {showNavigation && <Segmented label={t("codeReview.gitReview.scope")} value={scope} className="code-review-git-scopes" onChange={onScope}
      options={[
        { value: "all", label: t("codeReview.gitReview.all") },
        { value: "unstaged", label: t("codeReview.gitReview.unstaged") },
        { value: "staged", label: t("codeReview.gitReview.staged") },
      ]} />}
    <div className="code-review-git-progress">
      <span role="status">{summary}</span>
      <Button size="small" variant="ghost" disabled={!canAdvance} onClick={onNext}>{t("codeReview.gitReview.next")}</Button>
    </div>
    <select className="ds-select" aria-label={t("codeReview.gitReview.filter")} value={filter}
      onChange={(event) => onFilter(event.target.value as GitReviewFilter)}>
      <option value="all">{t("codeReview.gitReview.allStatuses")}</option>
      {(["pending", "reviewed", "needsChanges", "recheck"] as const).map((status) =>
        <option key={status} value={status}>{t(`codeReview.${status}`)} ({formatNumber(counts[status])})</option>)}
    </select>
  </div>;
}
