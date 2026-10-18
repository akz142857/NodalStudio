import type { ObjectKey } from "./types";
export interface KnowledgeBasis { sourceIdentity?: string | null; tables: [ObjectKey, string][]; relationships: [string, string][]; notes: [ObjectKey, string, string][] }
export interface KnowledgeOrigin { kind: string; requestId: string | null; provider: string | null; model: string | null; generatedAt: string | null; evidence: unknown }
export interface KnowledgeConfirmation { id: string; sourceId: string; objectKey: ObjectKey; finalText: string; descriptionDigest: string; snapshotId: string; fingerprint: string; confirmedAt: string; basis: KnowledgeBasis; origin: KnowledgeOrigin }
export interface KnowledgeState { sourceId: string; objectKey: ObjectKey; status: "confirmed" | "pendingReview" | "unavailable"; reason: string; confirmation: KnowledgeConfirmation | null }
export interface KnowledgeDraftInput { snapshotId: string; target: ObjectKey; requestId: string | null; interpretationIndex: number | null }
export interface KnowledgeDraft { id: string; sourceId: string; snapshotId: string; target: ObjectKey; oldDescription: string | null; draftText: string; expiresAt: string; basis: KnowledgeBasis; origin: KnowledgeOrigin }
