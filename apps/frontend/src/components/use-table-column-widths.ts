import { useState } from "react";
import { readTableColumnWidths, saveTableColumnWidth, tableColumnWidthsKey } from "../platform/table-data-preferences";

export function useTableColumnWidths(sourceId: string, schema: string, table: string) {
  const key = tableColumnWidthsKey(sourceId, schema, table);
  const [widths, setWidths] = useState(() => readTableColumnWidths(key));
  return {
    widths,
    resize: (column: string, width: number) => setWidths((current) => new Map(current).set(column, width)),
    save: (column: string, width: number) => saveTableColumnWidth(key, column, width),
  };
}
