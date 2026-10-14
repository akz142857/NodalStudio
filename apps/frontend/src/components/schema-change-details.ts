import type { DatabaseSnapshot, ObjectKey, SchemaOperation, TableDefinition } from "../platform";

export type ObjectProperties = Record<string, unknown>;

export function changeLabel(value: string): string {
  const label = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

export function snapshotDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function tableForChild(snapshot: DatabaseSnapshot, key: ObjectKey): TableDefinition | undefined {
  // Child keys use the qualified table as their schema. Match the whole key:
  // splitting on a dot breaks database identifiers that themselves contain dots.
  const matches = snapshot.schemas.flatMap((schema) => schema.tables)
    .filter((table) => `${table.key.schema}.${table.key.name}` === key.schema);
  return matches.length === 1 ? matches[0] : undefined;
}

function flattenKey(object: { key: ObjectKey }): ObjectProperties {
  const { key, ...properties } = object;
  return { schema: key.schema, name: key.name, ...properties };
}

/** Resolve the actual snapshot definition, rather than the lossy diff summary. */
export function operationProperties(
  snapshot: DatabaseSnapshot,
  operation: SchemaOperation,
  side: "before" | "after",
): ObjectProperties | undefined {
  const key = operation.object;
  if (["table", "view", "enum"].includes(key.kind)) {
    const objects = snapshot.schemas.flatMap((schema) => {
      if (key.kind === "table") return schema.tables.map(flattenKey);
      if (key.kind === "view") return schema.views.map(flattenKey);
      return schema.enums.map(flattenKey);
    });
    return objects.find((object) => object.schema === key.schema && object.name === key.name);
  }
  const table = tableForChild(snapshot, key);
  if (!table) return undefined;
  switch (key.kind) {
    case "column": {
      if (operation.operationType === "renameColumn" && side === "after") {
        // The engine writes "name: type nullable|not null" for inferred renames.
        // Match the full string so names containing colons remain unambiguous.
        const matches = table.columns.filter((column) => operation.after ===
          `${column.name}: ${column.formattedType}${column.nullable ? " nullable" : " not null"}`);
        return matches.length === 1 ? { ...matches[0] } : undefined;
      }
      const column = table.columns.find((item) => item.name === key.name);
      return column ? { ...column } : undefined;
    }
    case "primaryKey":
      return table.primaryKey?.name === key.name ? { ...table.primaryKey } : undefined;
    case "foreignKey": {
      const item = table.foreignKeys.find((item) => item.name === key.name);
      return item ? { ...item } : undefined;
    }
    case "index": {
      const item = table.indexes.find((item) => item.name === key.name);
      return item ? { ...item } : undefined;
    }
    case "constraint": {
      const item = table.constraints.find((item) => item.name === key.name);
      return item ? { ...item } : undefined;
    }
    default:
      return undefined;
  }
}

export const PROPERTY_LABELS: Record<string, string> = {
  name: "Name", schema: "Schema", tableKind: "Table kind", ordinalPosition: "Position",
  formattedType: "Data type", typeSchema: "Type schema", typeName: "Type name",
  nullable: "Nullable", defaultValue: "Default value", identity: "Identity",
  generated: "Generated", comment: "Comment", columns: "Columns", primaryKey: "Primary key",
  foreignKeys: "Foreign keys", indexes: "Indexes", constraints: "Constraints",
  referencedSchema: "Referenced schema", referencedTable: "Referenced table",
  referencedColumns: "Referenced columns", onUpdate: "On update", onDelete: "On delete",
  matchType: "Match type", deferrable: "Deferrable", initiallyDeferred: "Initially deferred",
  method: "Method", unique: "Unique", primary: "Primary", predicate: "Predicate",
  constraintType: "Constraint type", definition: "Definition", materialized: "Materialized",
  values: "Values",
};

export function propertyValue(value: unknown): string {
  if (value === undefined) return "Not present";
  if (value === null) return "None";
  if (value === "") return '"" (empty string)';
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}
