import { z } from "zod";

const savedQuery = z.object({ id: z.string(), name: z.string(), sql: z.string() });
export type SavedQuery = z.infer<typeof savedQuery>;
export type SaveQueryOutcome = { query: SavedQuery } | { error: "nameTaken" | "storageError" };

const prefix = "nodalstudio.saved-queries.v1:";
const keyFor = (sourceId: string) => prefix + encodeURIComponent(sourceId);

function read(sourceId: string): SavedQuery[] {
  return z.array(savedQuery).parse(JSON.parse(localStorage.getItem(keyFor(sourceId)) ?? "[]"));
}

export function listSavedQueries(sourceId: string): SavedQuery[] {
  try { return read(sourceId); } catch { return []; }
}

export function saveNamedQuery(sourceId: string, name: string, sql: string, id?: string): SaveQueryOutcome {
  try {
    const queries = read(sourceId);
    const cleanName = name.trim();
    if (queries.some((query) => query.id !== id && query.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      return { error: "nameTaken" };
    }
    const query = { id: id ?? crypto.randomUUID(), name: cleanName, sql };
    const index = queries.findIndex((entry) => entry.id === query.id);
    if (index < 0) queries.push(query);
    else queries[index] = query;
    localStorage.setItem(keyFor(sourceId), JSON.stringify(queries));
    return { query };
  } catch {
    return { error: "storageError" };
  }
}

export function deleteNamedQuery(sourceId: string, id: string): boolean {
  try {
    const key = keyFor(sourceId);
    const queries = read(sourceId).filter((query) => query.id !== id);
    if (queries.length) localStorage.setItem(key, JSON.stringify(queries));
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function clearSavedQueries(sourceId?: string): void {
  try {
    if (sourceId !== undefined) {
      localStorage.removeItem(keyFor(sourceId));
      return;
    }
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* Storage may be unavailable when clearing a source or workspace. */ }
}
