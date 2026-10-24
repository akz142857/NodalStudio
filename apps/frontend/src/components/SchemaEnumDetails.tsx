import { useI18n } from "../i18n";
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { DatabaseSnapshot, EnumDefinition, TableDefinition } from "../platform/types";
import { enumReferences } from "./enum-references";

export function SchemaEnumDetails({ snapshot, item, onLocate, onClose }: {
  snapshot: DatabaseSnapshot;
  item: EnumDefinition;
  onLocate: (table: TableDefinition) => void;
  onClose: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void;
}) {
  const { t: bt } = useI18n();
  const uses = useMemo(() => enumReferences(snapshot, item), [snapshot, item]);
  const fields = uses.reduce((total, use) => total + use.fields.length, 0);
  return <section className="schema-object-preview schema-enum-preview" aria-label={bt("business.enumDetailsFor", { value0: item.key.schema, value1: item.key.name })}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(event); } }}>
    <header><strong>{bt("business.enum")} {item.key.schema}.{item.key.name}</strong><button type="button" aria-label={bt("business.closeEnumDetails")} onClick={onClose}>×</button></header>
    <p>{bt("business.readOnlyValuesInDeclaredOrder")}</p>
    <h3>{bt("business.values")}{item.values.length})</h3>
    {item.values.length ? <ol className="schema-enum-values" aria-label={bt("business.enumValues")}>
      {item.values.map((value, index) => <li key={index}><code>{JSON.stringify(value)}</code></li>)}
    </ol> : <p>{bt("business.noValuesRecordedInThisSnapshot")}</p>}
    <h3>{bt("business.usedBy")} {uses.length} {uses.length === 1 ? "table" : "tables"} · {fields} {fields === 1 ? "field" : "fields"}</h3>
    {uses.length ? <ul className="schema-enum-uses" aria-label={bt("business.enumUsage")}>
      {uses.map(({ table, fields }) => <li key={JSON.stringify([table.key.schema, table.key.name])}>
        <button type="button" aria-label={bt("business.locateInDiagramDetail", { value0: table.key.schema, value1: table.key.name })}
          title={bt("business.locateTableInDiagram")} onClick={() => onLocate(table)}>{table.key.schema}.{table.key.name}</button>
        <ul>{fields.map(({ column, array }) => <li key={column.name}><code>{column.name}</code>{array ? <small>{bt("business.array")}</small> : null}</li>)}</ul>
      </li>)}
    </ul> : <p>{bt("business.noCapturedTableFieldsUseThisEnum")}</p>}
    <p>{bt("business.usageFromThisSnapshotSTableFields")}</p>
  </section>;
}
