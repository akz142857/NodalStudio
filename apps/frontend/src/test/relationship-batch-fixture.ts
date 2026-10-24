// Synthetic in-memory backend used only by interaction tests and the development preview.
import type { DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship, SaveLogicalRelationshipInput } from "../platform";
import type { ApplyReviewBatch, RelationshipBatchApi, ReviewBatch } from "../platform/relationship-batches";
import { candidateNeedsReview, relationshipCandidates } from "../components/relationships/inferred-review";

export function createRelationshipBatchFixture(snapshot: DatabaseSnapshot, changed: () => void) {
  let relationships: LogicalRelationship[] = [];
  let ignored: IgnoredRelationshipInference[] = [];
  let fail = false;
  const batches: ReviewBatch[] = [];
  const records = new Map<string, { input: ApplyReviewBatch; beforeRelationships: LogicalRelationship[]; beforeIgnored: IgnoredRelationshipInference[] }>();
  const save = (input: SaveLogicalRelationshipInput) => {
    const relation: LogicalRelationship = { ...input, id: input.id ?? crypto.randomUUID(), origin: input.origin ?? "manual", note: input.note ?? null, evidence: input.evidence ?? [], status: input.allowTypeMismatch ? "conflicted" : "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    relationships = [...relationships.filter((row) => row.id !== relation.id), relation]; return relation;
  };
  const api: RelationshipBatchApi = {
    preview: (request) => {
      const candidates = relationshipCandidates(snapshot, relationships).available;
      return Promise.resolve({ revision: JSON.stringify([relationships, ignored]), checks: request.entries.map((entry) => {
        const candidate = candidates.find((row) => row.key === entry.key);
        const reason = request.action === "confirm" && (!candidate || candidateNeedsReview(candidate)) ? "Type mismatch or ambiguous mapping; review individually" : null;
        return { entry, reason, cardinality: "manyToOne" as const };
      }) });
    },
    apply: (input) => {
      if (fail) return Promise.reject(new Error("Simulated batch write failure; no changes saved."));
      const previous = batches.find((batch) => batch.id === input.batchId); if (previous) return Promise.resolve(previous);
      if (input.revision !== JSON.stringify([relationships, ignored])) return Promise.reject(new Error("Model changed. Refresh the preview."));
      records.set(input.batchId, { input, beforeRelationships: [...relationships], beforeIgnored: [...ignored] });
      const now = new Date().toISOString();
      for (const entry of input.request.entries.filter((row) => input.approvedKeys.includes(row.key))) {
        if (input.request.action === "confirm" && entry.source && entry.target) save({ sourceId: snapshot.sourceId, name: entry.key, source: entry.source, target: entry.target, origin: "confirmedInference", cardinality: "manyToOne" });
        if (input.request.action === "ignore") ignored = [...ignored, { sourceId: snapshot.sourceId, relationshipKey: entry.key, ignoredAt: now }];
        if (input.request.action === "restore") ignored = ignored.filter((row) => row.relationshipKey !== entry.key);
      }
      const batch: ReviewBatch = { id: input.batchId, sourceId: snapshot.sourceId, action: input.request.action, keys: input.approvedKeys, createdAt: now, undoneAt: null, skippedKeys: [] }; batches.unshift(batch); changed(); return Promise.resolve(batch);
    },
    list: () => Promise.resolve([...batches]),
    undo: (_source, id) => {
      if (fail) return Promise.reject(new Error("Simulated undo failure"));
      const batch = batches.find((row) => row.id === id); const record = records.get(id);
      if (!batch || !record) return Promise.reject(new Error("Missing batch"));
      if (!batch.undoneAt) {
        relationships = record.beforeRelationships; ignored = record.beforeIgnored; batch.undoneAt = new Date().toISOString(); changed();
      }
      return Promise.resolve({ ...batch });
    },
  };
  return { api, get relationships() { return relationships; }, get ignored() { return ignored; }, setFailure(value: boolean) { fail = value; },
    save(input: SaveLogicalRelationshipInput) { if (fail) return Promise.reject(new Error("Simulated write failure")); const relation = save(input); changed(); return Promise.resolve(relation); },
    ignore(key: string) { ignored = [...ignored, { sourceId: snapshot.sourceId, relationshipKey: key, ignoredAt: new Date().toISOString() }]; changed(); return Promise.resolve(); },
    restore(key: string) { ignored = ignored.filter((row) => row.relationshipKey !== key); changed(); return Promise.resolve(); },
  };
}
