import { beforeEach, describe, expect, it } from "vitest";
import { reviewHistory, reviewNoteDraft, saveReviewDraft, saveReviewNote } from "./code-review-notes";

describe("code-review-notes", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("caches parsed history and reflects updates or external storage edits", () => {
    expect(reviewHistory("proj-1", "src/a.ts")).toEqual([]);
    saveReviewNote("proj-1", "src/a.ts", {
      evidence: "ev-1",
      status: "reviewed",
      note: "Looks good",
      at: "2026-11-27T00:00:00.000Z",
    });
    const first = reviewHistory("proj-1", "src/a.ts");
    const second = reviewHistory("proj-1", "src/a.ts");
    expect(first).toBe(second);
    expect(first).toHaveLength(1);
    expect(first[0].note).toBe("Looks good");

    // Direct external localStorage update invalidates the cached object cleanly.
    localStorage.setItem("nodalstudio:code-review:proj-1:src/a.ts", JSON.stringify([
      { evidence: "ev-2", status: "needsChanges", note: "Fix typo", at: "2026-11-27T01:00:00.000Z" },
    ]));
    const updated = reviewHistory("proj-1", "src/a.ts");
    expect(updated).not.toBe(first);
    expect(updated[0]).toMatchObject({ evidence: "ev-2", status: "needsChanges", note: "Fix typo" });
  });

  it("returns empty history for corrupted JSON payloads", () => {
    localStorage.setItem("nodalstudio:code-review:proj-2:bad.ts", "{broken");
    expect(reviewHistory("proj-2", "bad.ts")).toEqual([]);
  });

  it("stores and clears session review note drafts", () => {
    saveReviewDraft("proj-1", "src/a.ts", "ev-1", "draft note", "");
    expect(reviewNoteDraft("proj-1", "src/a.ts", "ev-1")).toBe("draft note");
    saveReviewDraft("proj-1", "src/a.ts", "ev-1", "saved", "saved");
    expect(reviewNoteDraft("proj-1", "src/a.ts", "ev-1")).toBeNull();
  });
});
