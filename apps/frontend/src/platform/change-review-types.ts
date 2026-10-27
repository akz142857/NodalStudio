import type { ObjectKey } from "./types";
export interface ChangeReviewItem {
  key: string; kind: string; title: string; object: ObjectKey | null; reason: string;
  before: unknown; after: unknown; evidence: string; status: string; note: string; actions: string[];
}
export interface ChangeReviewEvent { id: string; at: string; action: string; item: ChangeReviewItem | null; text: string; items?: ChangeReviewItem[]; restorable?: boolean }
export interface ChangeReviewWorkspace {
  sourceId: string; roundId: string | null; baseline: string | null; target: string;
  baselineAt: string | null; targetAt: string; revision: string; initialized: boolean;
  pendingCount: number; impactCount: number; structureCount: number; total: number; nextCursor: string | null;
  completed: boolean; identityChanged: boolean; items: ChangeReviewItem[]; events: ChangeReviewEvent[]; coverage: string;
}
export interface ChangeReviewRequest {
  sourceId: string; revision: string; preparedAt: string; operationId: string; action: string; itemKey: string | null; itemKeys?: string[]; text: string | null;
}

export interface ChangeReviewQuery { view?: string; search?: string; cursor?: string | null; limit?: number }
