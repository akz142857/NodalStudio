import { z } from "zod";

const noteSchema = z.object({
  evidence: z.string(),
  status: z.enum(["reviewed", "needsChanges"]),
  note: z.string(),
  at: z.string(),
});

const historySchema = z.array(noteSchema);
export type ReviewNote = z.infer<typeof noteSchema>;

function storageKey(projectKey: string, path: string) {
  return `nodalstudio:code-review:${projectKey}:${path}`;
}

export function reviewHistory(projectKey: string, path: string): ReviewNote[] {
  try {
    const result = historySchema.safeParse(JSON.parse(localStorage.getItem(storageKey(projectKey, path)) ?? "[]"));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function saveReviewNote(projectKey: string, path: string, note: ReviewNote) {
  const history = reviewHistory(projectKey, path).filter((entry) => entry.evidence !== note.evidence);
  localStorage.setItem(storageKey(projectKey, path), JSON.stringify([...history, note]));
}

export function reviewNoteDraft(projectKey: string, path: string, evidence: string | null) {
  const key = JSON.stringify([storageKey(projectKey, path), evidence]);
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function saveReviewDraft(projectKey: string, path: string, evidence: string | null, note: string, saved = "") {
  const key = JSON.stringify([storageKey(projectKey, path), evidence]);
  try {
    if (note === saved) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, note);
  } catch { /* The open note remains usable when session storage is unavailable. */ }
}
