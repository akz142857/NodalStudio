import type { DatabaseSnapshot, ObjectKey, ProgramDefinition, ViewDefinition, EnumDefinition } from "../platform/types";
export type DocumentObject = ProgramDefinition | ViewDefinition | EnumDefinition;
export function findDocumentObject(snapshot: DatabaseSnapshot | undefined, key: ObjectKey): DocumentObject | undefined {
  return snapshot?.schemas.flatMap(s => [...s.views, ...(s.programs ?? []), ...s.enums] as DocumentObject[]).find(o => o.key.kind === key.kind && o.key.schema === key.schema && o.key.name === key.name);
}
