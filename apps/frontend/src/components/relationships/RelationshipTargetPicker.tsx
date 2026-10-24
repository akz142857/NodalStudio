import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n } from "../../i18n";
import { useState } from "react";
import type { DatabaseSnapshot, RelationshipEndpoint } from "../../platform";

interface RelationshipTargetPickerProps {
  snapshot: DatabaseSnapshot;
  source: RelationshipEndpoint;
  onSelect: (target: RelationshipEndpoint) => void;
  onCancel: () => void;
}

export function RelationshipTargetPicker({ snapshot, source, onSelect, onCancel }: RelationshipTargetPickerProps) {
  const { t: bt } = useI18n();
  const [query, setQuery] = useState("");
  const sourceColumn = snapshot.schemas.find((schema) => schema.name === source.schema)
    ?.tables.find((table) => table.key.name === source.table)
    ?.columns.find((column) => column.name === source.columns[0]);
  const results = (() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return snapshot.schemas.flatMap((schema) => schema.tables.flatMap((table) => table.columns.flatMap((column) => {
      const label = `${schema.name}.${table.key.name}.${column.name}`;
      if (!label.toLocaleLowerCase().includes(normalized)) return [];
      if (schema.name === source.schema && table.key.name === source.table && column.name === source.columns[0]) return [];
      return [{
        label,
        formattedType: column.formattedType,
        compatible: sourceColumn?.typeName === column.typeName && sourceColumn.typeSchema === column.typeSchema,
        endpoint: { schema: schema.name, table: table.key.name, columns: [column.name] } satisfies RelationshipEndpoint,
      }];
    }))).slice(0, 10);
  })();

  return <div className="relationship-target-picker nodrag nopan">
    <header><div><strong>{bt("business.selectTargetField")}</strong><span>{source.schema}.{source.table}.{source.columns[0]}</span></div><button type="button" onClick={onCancel}>{bt("business.cancel")}</button></header>
    <input aria-label={bt("business.searchTargetField")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={bt("business.searchSchemaTableOrField")} autoFocus />
    {query.trim() ? <div role="listbox" aria-label={bt("business.targetFields")}>{results.length ? results.map((result) => <button type="button" role="option" aria-selected="false" data-compatible={result.compatible || undefined} key={result.label} onClick={() => onSelect(result.endpoint)}><span>{result.label}</span><small>{result.formattedType} · {result.compatible ? translateUiLabel("compatible", bt) : bt("business.typeDiffers")}</small></button>) : <p>{bt("business.noMatchingFields")}</p>}</div> : <p>{bt("business.clickAFieldOnTheCanvasOrSearchAbove")}</p>}
  </div>;
}
