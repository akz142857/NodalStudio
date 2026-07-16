import type { QueryExecutionResult } from "../../platform";

export type QueryTab = "results" | "message" | "history";

export interface QuerySession {
  draft: string;
  result?: QueryExecutionResult;
  message: string;
  activeTab: QueryTab;
  rowLimit: number;
  resultHeight: number;
  outputCollapsed: boolean;
}

const sessions = new Map<string, QuerySession>();

export const MIN_QUERY_RESULT_HEIGHT = 120;
export const MAX_QUERY_RESULT_HEIGHT = 650;

export function resizedQueryResultHeight(startHeight: number, startY: number, currentY: number): number {
  return Math.max(
    MIN_QUERY_RESULT_HEIGHT,
    Math.min(MAX_QUERY_RESULT_HEIGHT, startHeight + startY - currentY),
  );
}

export function loadQuerySession(sourceId: string): QuerySession {
  return sessions.get(sourceId) ?? {
    draft: "",
    message: "Ready. Only one read-only SELECT statement can be executed.",
    activeTab: "results",
    rowLimit: 100,
    resultHeight: 310,
    outputCollapsed: false,
  };
}

export function saveQuerySession(sourceId: string, session: QuerySession): void {
  sessions.set(sourceId, session);
}
