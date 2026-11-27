import { z } from "zod";
import { codeQueryHandoffSchema } from "../../platform/code-view";
import type { QueryExecutionResult } from "../../platform";
import { setUpdateBlocker } from "../../platform/update-guard";
import type { SavedQuery } from "./saved-queries";

const draftOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), handoff: codeQueryHandoffSchema, sql: z.string() }),
  z.object({ kind: z.literal("ontology"), target: z.object({ id: z.string(), revision: z.number().int() }), sql: z.string() }),
  z.object({ kind: z.literal("unavailable") }),
]);
export type DraftOrigin = z.infer<typeof draftOriginSchema>;

function readOrigin(raw: unknown): DraftOrigin | undefined {
  if (raw === undefined) return undefined;
  const result = draftOriginSchema.safeParse(raw);
  return result.success ? result.data : { kind: "unavailable" };
}

export type QueryTab = "results" | "message" | "history";

export interface QuerySession {
  draft: string;
  previousDraft?: { sql: string; rowLimit: number; origin?: DraftOrigin };
  origin?: DraftOrigin;
  savedQuery?: Pick<SavedQuery, "id" | "name">;
  outputSourceId?: string;
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
export const legacyQueryWorkspaceKey = "query-workspace";
export const queryWorkspaceKey = (sourceId: string) => `${legacyQueryWorkspaceKey}:${sourceId}`;
export const unboundQueryWorkspaceKey = queryWorkspaceKey("no-source");

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
  let savedQuery: QuerySession["savedQuery"];
  let restoreFailed = false;
  let origin: DraftOrigin | undefined;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(draftKey(sourceId)) ?? "null");
    if (stored && typeof stored === "object" && "draft" in stored && typeof stored.draft === "string") draft = stored.draft;
    if (stored && typeof stored === "object" && "origin" in stored) origin = readOrigin(stored.origin);
    if (stored && typeof stored === "object" && "previousDraft" in stored) {
      const previous = stored.previousDraft;
      if (previous && typeof previous === "object" && "sql" in previous && typeof previous.sql === "string"
        && "rowLimit" in previous && typeof previous.rowLimit === "number" && Number.isInteger(previous.rowLimit)
        && previous.rowLimit >= 1 && previous.rowLimit <= 5000) {
        previousDraft = { sql: previous.sql, rowLimit: previous.rowLimit };
        if ("origin" in previous) previousDraft.origin = readOrigin(previous.origin);
      }
    }
    if (stored && typeof stored === "object" && "savedQuery" in stored) {
      const saved = stored.savedQuery;
      if (saved && typeof saved === "object" && "id" in saved && "name" in saved
        && typeof saved.id === "string" && typeof saved.name === "string") savedQuery = { id: saved.id, name: saved.name };
    }
  } catch { restoreFailed = true; }
  return {
    draft,
    previousDraft,
    origin,
    savedQuery,
    message: restoreFailed ? "The saved SQL draft could not be restored from local storage." : "Ready. Only one read-only SELECT statement can be executed.",
    activeTab: restoreFailed ? "message" : "results",
    rowLimit: 100,
    resultHeight: 310,
    outputCollapsed: false,
  };
}

export function saveQuerySession(sourceId: string, session: QuerySession): boolean {
  sessions.set(sourceId, session);
  // Persist only the editor draft, never query results or database row contents.
  // The blocker survives QueryPage unmounting when Settings is opened.
  try {
    if (session.draft || session.previousDraft || session.savedQuery) localStorage.setItem(draftKey(sourceId), JSON.stringify({ draft: session.draft, previousDraft: session.previousDraft, savedQuery: session.savedQuery, origin: session.origin }));
    else localStorage.removeItem(draftKey(sourceId));
    setUpdateBlocker(`query-draft:${sourceId}`, undefined);
    return true;
  } catch {
    setUpdateBlocker(`query-draft:${sourceId}`, "save your SQL draft locally (open Query and edit it to retry, or copy and clear it)");
    return false;
  }
}

export function recoverQueryDraft(fromWorkspace: string, workspace: string, current: QuerySession): QuerySession {
  const previous = loadQuerySession(fromWorkspace);
  if (current.draft || current.previousDraft || (!previous.draft && !previous.previousDraft)) return current;
  const recovered = { ...current, draft: previous.draft, previousDraft: previous.previousDraft, savedQuery: undefined, origin: previous.origin };
  if (saveQuerySession(workspace, recovered)) {
    saveQuerySession(fromWorkspace, { ...previous, draft: "", previousDraft: undefined, savedQuery: undefined, origin: undefined });
  }
  return recovered;
}

/** Called after an explicitly requested factory reset. Other preferences are untouched. */
export function clearQuerySessions(): void {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  keys.filter((key): key is string => Boolean(key?.startsWith(draftPrefix))).forEach((key) => localStorage.removeItem(key));
  for (const workspace of sessions.keys()) setUpdateBlocker(`query-draft:${workspace}`, undefined);
  sessions.clear();
}
