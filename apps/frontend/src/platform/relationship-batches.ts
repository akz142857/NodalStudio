import type { RelationshipCardinality, RelationshipEndpoint } from "./types";

export type ReviewAction = "confirm" | "ignore" | "restore";
export interface ReviewEntry { key: string; source?: RelationshipEndpoint | null; target?: RelationshipEndpoint | null }
export interface ReviewRequest { sourceId: string; snapshotId: string; action: ReviewAction; entries: ReviewEntry[] }
export interface ReviewCheck { entry: ReviewEntry; reason: string | null; cardinality: RelationshipCardinality }
export interface ReviewPreview { revision: string; checks: ReviewCheck[] }
export interface ApplyReviewBatch { request: ReviewRequest; revision: string; batchId: string; approvedKeys: string[] }
export interface ReviewBatch { id: string; sourceId: string; action: ReviewAction; createdAt: string; keys: string[]; undoneAt: string | null; skippedKeys: string[] }
export interface RelationshipBatchApi {
  preview(input: ReviewRequest): Promise<ReviewPreview>;
  apply(input: ApplyReviewBatch): Promise<ReviewBatch>;
  list(sourceId: string): Promise<ReviewBatch[]>;
  undo(sourceId: string, batchId: string): Promise<ReviewBatch>;
}

export const batchActionLabels = { confirm: "Confirmed", ignore: "Ignored", restore: "Restored" };
