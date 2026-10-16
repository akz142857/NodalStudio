import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { DatabaseSnapshot, EnumDefinition, TableDefinition } from "../platform/types";
import { enumReferences } from "./enum-references";

export function SchemaEnumDetails({ snapshot, item, onLocate, onClose }: {
  snapshot: DatabaseSnapshot;
  item: EnumDefinition;
  onLocate: (table: TableDefinition) => void;
  onClose: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void;
}) {
  const uses = useMemo(() => enumReferences(snapshot, item), [snapshot, item]);
  const fields = uses.reduce((total, use) => total + use.fields.length, 0);
  return <section className="schema-object-preview schema-enum-preview" aria-label={`Enum details for ${item.key.schema}.${item.key.name}`}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(event); } }}>
    <header><strong>Enum · {item.key.schema}.{item.key.name}</strong><button type="button" aria-label="Close enum details" onClick={onClose}>×</button></header>
    <p>Read-only · Values in declared order.</p>
    <h3>Values ({item.values.length})</h3>
    {item.values.length ? <ol className="schema-enum-values" aria-label="Enum values">
      {item.values.map((value, index) => <li key={index}><code>{JSON.stringify(value)}</code></li>)}
    </ol> : <p>No values recorded in this snapshot.</p>}
    <h3>Used by {uses.length} {uses.length === 1 ? "table" : "tables"} · {fields} {fields === 1 ? "field" : "fields"}</h3>
    {uses.length ? <ul className="schema-enum-uses" aria-label="Enum usage">
      {uses.map(({ table, fields }) => <li key={JSON.stringify([table.key.schema, table.key.name])}>
        <button type="button" aria-label={`Locate ${table.key.schema}.${table.key.name} in diagram`}
          title="Locate table in Diagram" onClick={() => onLocate(table)}>{table.key.schema}.{table.key.name}</button>
        <ul>{fields.map(({ column, array }) => <li key={column.name}><code>{column.name}</code>{array ? <small>Array</small> : null}</li>)}</ul>
      </li>)}
    </ul> : <p>No captured table fields use this enum.</p>}
    <p>Usage from this snapshot’s table fields.</p>
  </section>;
}
