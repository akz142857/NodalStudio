import type { DatabaseSnapshot } from "../platform";
import type { PreflightFinding } from "./schema-preflight";

export interface PreflightReview { reason: string; evidence: string }
export type PreflightReviews = Record<string, PreflightReview>;
export const reviewEvidence = (finding: PreflightFinding) => JSON.stringify([finding.outcome, finding.message, finding.evidence]);
const storageKey = (snapshot: DatabaseSnapshot) => `nodalstudio:preflight-reviews:v1:${JSON.stringify([snapshot.sourceId, snapshot.fingerprint])}`;

/** Source + fingerprint isolation, with an evidence guard when rules evolve. */
export function loadPreflightReviews(snapshot: DatabaseSnapshot): PreflightReviews {
  const raw = localStorage.getItem(storageKey(snapshot));
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Saved review notes are malformed.");
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, PreflightReview] => {
    const value: unknown = entry[1];
    return Boolean(value && typeof value === "object" && "reason" in value && typeof value.reason === "string" && value.reason.trim() && value.reason.length <= 500 && "evidence" in value && typeof value.evidence === "string");
  }));
}
export function savePreflightReviews(snapshot: DatabaseSnapshot, reviews: PreflightReviews): void {
  localStorage.setItem(storageKey(snapshot), JSON.stringify(reviews));
}
export function findingReview(finding: PreflightFinding, reviews: PreflightReviews): PreflightReview | undefined {
  const review = reviews[finding.id];
  return review?.evidence === reviewEvidence(finding) ? review : undefined;
}
