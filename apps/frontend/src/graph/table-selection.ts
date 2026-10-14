import type { DatabaseSnapshot, DomainGroup, ObjectKey, SaveDomainGroupInput } from "../platform";
import type { TableNode } from "./schema-graph";

export const tableKeyIdentity = (key: ObjectKey) => JSON.stringify([key.kind, key.schema, key.name]);

export function retainTableSelection(next: TableNode[], previous: TableNode[]): TableNode[] {
  const selectedIds = new Set(previous.filter((node) => node.selected).map((node) => node.id));
  return next.map((node) => ({ ...node, selected: selectedIds.has(node.id) }));
}

/** Return canonical current keys only: comparison ghosts never become semantic members. */
export function selectedCurrentTableKeys(nodes: TableNode[], snapshot: DatabaseSnapshot): ObjectKey[] {
  const current = new Map(snapshot.schemas.flatMap((schema) => schema.tables.map((table) => [tableKeyIdentity(table.key), table.key] as const)));
  const result = new Map<string, ObjectKey>();
  for (const node of nodes) {
    if (!node.selected || node.data.changeStatus === "deleted") continue;
    const identity = tableKeyIdentity(node.data.table.key);
    const key = current.get(identity);
    if (key) result.set(identity, key);
  }
  return [...result.values()];
}

export function domainMembershipAddition(snapshot: DatabaseSnapshot, group: DomainGroup, selected: ObjectKey[]): {
  input: SaveDomainGroupInput;
  addedCount: number;
  alreadyMemberCount: number;
} {
  if (group.sourceId !== snapshot.sourceId) throw new Error("This business domain belongs to another data source.");
  const current = new Set(snapshot.schemas.flatMap((schema) => schema.tables.map((table) => tableKeyIdentity(table.key))));
  const selectedKeys = new Map(selected.map((key) => [tableKeyIdentity(key), key]));
  const members = new Map(group.tableKeys.map((key) => [tableKeyIdentity(key), key]));
  let addedCount = 0;
  for (const [identity, key] of selectedKeys) {
    if (key.kind !== "table" || !current.has(identity)) throw new Error("A selected table is no longer present in this snapshot. Select current tables and try again.");
    if (!members.has(identity)) { members.set(identity, key); addedCount += 1; }
  }
  return {
    input: { id: group.id, sourceId: group.sourceId, name: group.name, description: group.description, color: group.color, tableKeys: [...members.values()] },
    addedCount,
    alreadyMemberCount: selectedKeys.size - addedCount,
  };
}
