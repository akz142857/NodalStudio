import type { DatabaseSnapshot, SchemaChangeSet, SchemaOperation, TableDefinition } from "../platform";
import type { ChangeStatus } from "./schema-comparison";

const TABLE_CHILDREN = new Set(["column", "primaryKey", "foreignKey", "index", "constraint"]);

export function modelTableKey({ schema, name }: Pick<TableDefinition["key"], "schema" | "name">): string {
  return JSON.stringify([schema, name]);
}

export interface ModelTableChange {
  key: TableDefinition["key"];
  status: ChangeStatus;
  operations: SchemaOperation[];
}

/** Index the latest operations once, while leaving the live graph's tables intact. */
export function collectModelTableChanges(snapshot: DatabaseSnapshot, changeSet: SchemaChangeSet) {
  const result = new Map<string, ModelTableChange>();
  if (changeSet.afterSnapshotId !== snapshot.id) return result;

  const tables = new Map<string, TableDefinition>();
  const qualifiedTables = new Map<string, TableDefinition | null>();
  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) {
      tables.set(modelTableKey(table.key), table);
      const qualified = `${table.key.schema}.${table.key.name}`;
      // The diff encodes child ownership as a qualified name. Avoid assigning
      // ambiguous names when either identifier contains a dot.
      qualifiedTables.set(qualified, qualifiedTables.has(qualified) ? null : table);
    }
  }

  for (const operation of changeSet.operations) {
    const object = operation.object;
    const table = object.kind === "table" ? tables.get(modelTableKey(object))
      : TABLE_CHILDREN.has(object.kind) ? qualifiedTables.get(object.schema) : undefined;
    if (!table) continue;
    const key = table.key;
    const id = modelTableKey(key);
    const entry: ModelTableChange = result.get(id) ?? { key, status: "modified", operations: [] };
    if (operation.operationType === "addTable") entry.status = "added";
    entry.operations.push(operation);
    result.set(id, entry);
  }
  return result;
}
