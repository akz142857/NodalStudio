import type { DatabaseSnapshot, SchemaChangeSet, TableDefinition } from "../platform";
import type { ForeignKeyDefinition } from "../platform/types";

export type ChangeStatus = "added" | "modified" | "deleted";

export interface ComparisonRelation {
  foreignKey: ForeignKeyDefinition;
  changeStatus?: ChangeStatus;
  snapshotSide?: "before" | "after";
  replaced?: boolean;
}

export interface ComparisonTable {
  schema: string;
  table: TableDefinition;
  inspectionTable: TableDefinition;
  changeStatus?: ChangeStatus;
  columnChanges?: Record<string, ChangeStatus | undefined>;
  columnNotes?: Record<string, string>;
  relations: ComparisonRelation[];
}

const keyOf = (table: TableDefinition) => JSON.stringify([table.key.schema, table.key.name]);
const sameDefinition = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** A display projection only: the stored Before and After snapshots stay intact. */
export function comparisonTables(
  after: DatabaseSnapshot,
  before: DatabaseSnapshot | undefined,
  changes: SchemaChangeSet | undefined,
): ComparisonTable[] {
  const comparing = Boolean(changes && changes.afterSnapshotId === after.id);
  const baseline = comparing && before?.id === changes?.beforeSnapshotId ? before : undefined;
  const afterTables = after.schemas.flatMap((schema) => schema.tables);
  const beforeTables = baseline?.schemas.flatMap((schema) => schema.tables) ?? [];
  const oldTables = new Map(beforeTables.map((table) => [keyOf(table), table]));
  const newTables = new Map(afterTables.map((table) => [keyOf(table), table]));
  const allTables = [...afterTables, ...beforeTables.filter((table) => !newTables.has(keyOf(table)))];

  return allTables.map((definition): ComparisonTable => {
    const current = newTables.get(keyOf(definition));
    const previous = oldTables.get(keyOf(definition));
    const tableId = `${definition.key.schema}.${definition.key.name}`;
    const operations = comparing ? changes?.operations.filter((operation) =>
      operation.object.kind === "table"
        ? operation.object.schema === definition.key.schema && operation.object.name === definition.key.name
        : ["column", "primaryKey", "foreignKey", "index", "constraint"].includes(operation.object.kind) && operation.object.schema === tableId) ?? [] : [];
    const changeStatus: ChangeStatus | undefined = !comparing ? undefined : baseline && !current ? "deleted"
      : (baseline && !previous) || operations.some((operation) => operation.operationType === "addTable") ? "added"
      : operations.length || (previous && current && !sameDefinition(previous, current)) ? "modified" : undefined;

    const relations: ComparisonRelation[] = (current?.foreignKeys ?? []).map((foreignKey) => {
      const old = previous?.foreignKeys.find((candidate) => candidate.name === foreignKey.name);
      const matchingOperations = operations.filter((operation) => operation.object.kind === "foreignKey" && operation.object.name === foreignKey.name);
      const status = !comparing ? undefined : baseline
        ? !old ? "added" : !sameDefinition(old, foreignKey) ? "modified" : undefined
        : matchingOperations.some((operation) => operation.operationType === "addForeignKey")
          ? matchingOperations.some((operation) => operation.operationType === "dropForeignKey") ? "modified" : "added" : undefined;
      return { foreignKey, changeStatus: status, snapshotSide: status ? "after" : undefined };
    });
    for (const foreignKey of previous?.foreignKeys ?? []) {
      const replacement = current?.foreignKeys.find((candidate) => candidate.name === foreignKey.name);
      if (!replacement || !sameDefinition(foreignKey, replacement)) {
        relations.push({ foreignKey, changeStatus: "deleted", snapshotSide: "before", replaced: Boolean(replacement) });
      }
    }

    if (!comparing) return { schema: definition.key.schema, table: definition, inspectionTable: definition, relations };

    const columns = [...(current?.columns ?? []), ...(previous?.columns.filter((column) =>
      !current?.columns.some((candidate) => candidate.name === column.name)) ?? [])]
      .sort((left, right) => left.ordinalPosition - right.ordinalPosition);
    const renames = new Map<string, string>();
    for (const operation of operations.filter((operation) => operation.operationType === "renameColumn")) {
      const matches = current?.columns.filter((column) => operation.after ===
        `${column.name}: ${column.formattedType}${column.nullable ? " nullable" : " not null"}`) ?? [];
      if (matches.length === 1) renames.set(operation.object.name, matches[0].name);
    }
    const columnChanges = Object.fromEntries(columns.map((column) => {
      const old = previous?.columns.find((candidate) => candidate.name === column.name);
      const next = current?.columns.find((candidate) => candidate.name === column.name);
      const status: ChangeStatus | undefined = changeStatus === "deleted" ? "deleted" : changeStatus === "added" ? "added"
        : baseline ? !next ? "deleted" : !old ? [...renames.values()].includes(column.name) ? "modified" : "added"
          : !sameDefinition(old, next) ? "modified" : undefined
        : operations.some((operation) => operation.object.kind === "column" && operation.object.name === column.name && operation.operationType === "addColumn") ? "added"
          : operations.some((operation) => operation.object.kind === "column" && operation.object.name === column.name && operation.operationType === "alterColumn") || [...renames.values()].includes(column.name) ? "modified" : undefined;
      return [column.name, status];
    }));
    const columnNotes = Object.fromEntries<string>([
      ...columns.map((column): [string, string] => {
        const old = previous?.columns.find((candidate) => candidate.name === column.name);
        const next = current?.columns.find((candidate) => candidate.name === column.name);
        const describe = (value: typeof column) => `${value.formattedType}, ${value.nullable ? "nullable" : "not null"}, default: ${value.defaultValue ?? "none"}, comment: ${value.comment ?? "none"}`;
        return [column.name, old && next && columnChanges[column.name] === "modified" ? `Before: ${describe(old)}\nAfter: ${describe(next)}` : columnChanges[column.name] === "deleted" ? "Deleted field · Before snapshot" : ""];
      }),
      ...[...renames].flatMap(([oldName, newName]): [string, string][] => [
      [oldName, `Before name; inferred rename to ${newName}`],
      [newName, `Inferred rename from ${oldName}`],
      ]),
    ]);
    return {
      schema: definition.key.schema,
      table: { ...definition, columns, foreignKeys: relations.map((relation) => relation.foreignKey) },
      inspectionTable: current ?? definition,
      changeStatus,
      columnChanges,
      columnNotes,
      relations,
    };
  });
}
