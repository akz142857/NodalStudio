import { z } from "zod";

const noteSchema = z.object({
  evidence: z.string(),
  status: z.enum(["reviewed", "needsChanges"]),
  note: z.string(),
  at: z.string(),
});

const historySchema = z.array(noteSchema);
export type ReviewNote = z.infer<typeof noteSchema>;

const historyCache = new Map<string, { raw: string; data: ReviewNote[] }>();

function storageKey(projectKey: string, path: string) {
  return `nodalstudio:code-review:${projectKey}:${path}`;
}

export function reviewHistory(projectKey: string, path: string): ReviewNote[] {
  const key = storageKey(projectKey, path);
  try {
    const raw = localStorage.getItem(key) ?? "[]";
    const cached = historyCache.get(key);
    if (cached && cached.raw === raw) return cached.data;
    const result = historySchema.safeParse(JSON.parse(raw));
    const data = result.success ? result.data : [];
    if (historyCache.size >= 2_000) historyCache.clear();
    historyCache.set(key, { raw, data });
    return data;
  } catch {
    return [];
  }
}

export function saveReviewNote(projectKey: string, path: string, note: ReviewNote) {
  const key = storageKey(projectKey, path);
  const next = [...reviewHistory(projectKey, path).filter((entry) => entry.evidence !== note.evidence), note];
  const raw = JSON.stringify(next);
  localStorage.setItem(key, raw);
  historyCache.set(key, { raw, data: next });
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
