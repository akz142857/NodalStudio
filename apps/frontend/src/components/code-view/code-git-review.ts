import type { CodeChangeComparison, CodeReviewChange, CodeReviewChanges } from "../../platform/code-review";
import type { NoteStatus } from "./CodeFileReview";
import type { GitReviewScope } from "./CodeGitReviewControls";
import { reviewHistory, saveReviewNote, type ReviewNote } from "./code-review-notes";

export function versionReviewStatus(history: ReviewNote[], evidence: string | null, comparison?: CodeChangeComparison): NoteStatus {
  return history.find((note) => note.evidence === evidence)?.status
    ?? (history.some((note) => note.comparison === comparison || (comparison && note.comparisons?.includes(comparison)))
      ? "recheck" : "pending");
}

export function reviewStatus(projectKey: string, change: CodeReviewChange): NoteStatus {
  return versionReviewStatus(reviewHistory(projectKey, change.path), change.evidence, change.comparison);
}

export function changesInScope(changes: CodeReviewChanges | undefined, scope: GitReviewScope) {
  if (!changes?.git) return changes?.files ?? [];
  if (scope === "staged") return changes.staged ?? [];
  if (scope === "unstaged") return changes.unstaged ?? [];
  // Both versions remain available. In the combined list the working-tree
  // version opens first for a path that has both changes.
  return [...new Map([...(changes.staged ?? []), ...(changes.unstaged ?? [])].map((entry) => [entry.path, entry])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
}


export function rememberReviewedComparisons(projectKey: string, changes: CodeReviewChanges) {
  for (const comparison of ["staged", "unstaged"] as const) {
    for (const change of changes[comparison] ?? []) {
      if (!change.evidence) continue;
      const note = reviewHistory(projectKey, change.path).find(({ evidence }) => evidence === change.evidence);
      if (!note || note.comparison === comparison || note.comparisons?.includes(comparison)) continue;
      try {
        saveReviewNote(projectKey, change.path, { ...note, comparison });
      } catch { /* Local history availability cannot prevent a Git refresh. */ }
    }
  }
}
