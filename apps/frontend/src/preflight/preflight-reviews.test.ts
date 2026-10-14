import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportSnapshot } from "../test/schema-report-fixture";
import { runSchemaPreflight } from "./schema-preflight";
import { findingReview, loadPreflightReviews, reviewEvidence, savePreflightReviews } from "./preflight-reviews";
const snapshot = { ...reportSnapshot, schemas: reportSnapshot.schemas.map((schema) => ({ ...schema, tables: schema.tables.map((table) => ({ ...table, primaryKey: null })) })) };
const finding = runSchemaPreflight(snapshot).findings[0];

describe("local preflight reviews", () => {
  beforeEach(() => localStorage.clear());
  it("persists reasons, isolating sources and fingerprints while allowing the same capture fingerprint", () => {
    const notes = { [finding.id]: { reason: "Intentional staging table", evidence: reviewEvidence(finding) } };
    savePreflightReviews(snapshot, notes);
    expect(loadPreflightReviews({ ...snapshot, id: "recaptured" })).toEqual(notes);
    expect(loadPreflightReviews({ ...snapshot, sourceId: "another-source" })).toEqual({});
    expect(loadPreflightReviews({ ...snapshot, fingerprint: "changed" })).toEqual({});
    expect(findingReview(finding, notes)?.reason).toBe("Intentional staging table");
    savePreflightReviews(snapshot, {});
    expect(loadPreflightReviews(snapshot)).toEqual({});
  });
  it("does not hide findings when their evidence or outcome changes", () => {
    const notes = { [finding.id]: { reason: "Reviewed", evidence: reviewEvidence(finding) } };
    expect(findingReview({ ...finding, evidence: ["changed"] }, notes)).toBeUndefined();
    expect(findingReview({ ...finding, outcome: "suspected" }, notes)).toBeUndefined();
  });
  it("validates local records and rejects malformed storage", () => {
    const key = `nodalstudio:preflight-reviews:v1:${JSON.stringify([snapshot.sourceId, snapshot.fingerprint])}`;
    localStorage.setItem(key, JSON.stringify({ empty: { reason: " ", evidence: "x" }, tooLong: { reason: "x".repeat(501), evidence: "x" }, bad: null, valid: { reason: "reason", evidence: "evidence" } }));
    expect(Object.keys(loadPreflightReviews(snapshot))).toEqual(["valid"]);
    for (const raw of ["not json", "[]", "null"]) { localStorage.setItem(key, raw); expect(() => loadPreflightReviews(snapshot)).toThrow(); }
  });
  it("propagates denied storage so UI can offer retry without discarding the session reason", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => savePreflightReviews(snapshot, {})).toThrow("denied");
    spy.mockRestore();
  });
});
