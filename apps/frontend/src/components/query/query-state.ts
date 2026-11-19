import type { QueryExecutionResult } from "../../platform";
import { setUpdateBlocker } from "../../platform/update-guard";

export type QueryTab = "results" | "message" | "history";

export interface QuerySession {
  draft: string;
  previousDraft?: { sql: string; rowLimit: number };
  result?: QueryExecutionResult;
  message: string;
  activeTab: QueryTab;
  rowLimit: number;
  resultHeight: number;
  outputCollapsed: boolean;
  outputResized?: boolean;
  outcome?: "succeeded" | "failed";
}

const sessions = new Map<string, QuerySession>();
const draftPrefix = "nodalstudio.query-draft.v1:";
const draftKey = (workspace: string) => `${draftPrefix}${encodeURIComponent(workspace)}`;

export const MIN_QUERY_RESULT_HEIGHT = 120;
export const MAX_QUERY_RESULT_HEIGHT = 650;

export function resizedQueryResultHeight(startHeight: number, startY: number, currentY: number): number {
  return Math.max(
    MIN_QUERY_RESULT_HEIGHT,
    Math.min(MAX_QUERY_RESULT_HEIGHT, startHeight + startY - currentY),
  );
}

export function loadQuerySession(sourceId: string): QuerySession {
  const existing = sessions.get(sourceId);
  if (existing) return existing;
  let draft = "";
  let previousDraft: QuerySession["previousDraft"];
  let restoreFailed = false;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(draftKey(sourceId)) ?? "null");
    if (stored && typeof stored === "object" && "draft" in stored && typeof stored.draft === "string") draft = stored.draft;
    if (stored && typeof stored === "object" && "previousDraft" in stored) {
      const previous = stored.previousDraft;
      if (previous && typeof previous === "object" && "sql" in previous && typeof previous.sql === "string"
        && "rowLimit" in previous && typeof previous.rowLimit === "number" && Number.isInteger(previous.rowLimit)
        && previous.rowLimit >= 1 && previous.rowLimit <= 5000) {
        previousDraft = { sql: previous.sql, rowLimit: previous.rowLimit };
      }
    }
  } catch { restoreFailed = true; }
  return {
    draft,
    previousDraft,
    message: restoreFailed ? "The saved SQL draft could not be restored from local storage." : "Ready. Only one read-only SELECT statement can be executed.",
    activeTab: restoreFailed ? "message" : "results",
    rowLimit: 100,
    resultHeight: 310,
    outputCollapsed: false,
  };
}

export function saveQuerySession(sourceId: string, session: QuerySession): void {
  sessions.set(sourceId, session);
  // Persist only the editor draft, never query results or database row contents.
  // The blocker survives QueryPage unmounting when Settings is opened.
  try {
    if (session.draft || session.previousDraft) localStorage.setItem(draftKey(sourceId), JSON.stringify({ draft: session.draft, previousDraft: session.previousDraft }));
    else localStorage.removeItem(draftKey(sourceId));
    setUpdateBlocker(`query-draft:${sourceId}`, undefined);
  } catch {
    setUpdateBlocker(`query-draft:${sourceId}`, "save your SQL draft locally (open Query and edit it to retry, or copy and clear it)");
  }
}

/** Called after an explicitly requested factory reset. Other preferences are untouched. */
export function clearQuerySessions(): void {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  keys.filter((key): key is string => Boolean(key?.startsWith(draftPrefix))).forEach((key) => localStorage.removeItem(key));
  for (const workspace of sessions.keys()) setUpdateBlocker(`query-draft:${workspace}`, undefined);
  sessions.clear();
}
