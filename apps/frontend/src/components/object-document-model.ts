import type { DatabaseSnapshot, ObjectKey, ProgramDefinition, ViewDefinition, EnumDefinition } from "../platform/types";
export type DocumentObject = ProgramDefinition | ViewDefinition | EnumDefinition;
export function findDocumentObject(snapshot: DatabaseSnapshot | undefined, key: ObjectKey): DocumentObject | undefined {
  const schema = snapshot?.schemas.find((item) => item.name === key.schema);
  if (key.kind === "view") return schema?.views.find((item) => item.key.name === key.name);
  if (key.kind === "enum") return schema?.enums.find((item) => item.key.name === key.name);
  return schema?.programs?.find((item) => item.key.kind === key.kind && item.key.name === key.name);
}
