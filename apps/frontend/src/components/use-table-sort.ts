import { useState } from "react";
import { readTableSort, saveTableSort, tableSortKey, type TableSort } from "../platform/table-data-preferences";

export function useTableSort(sourceId: string, schema: string, table: string) {
  const key = tableSortKey(sourceId, schema, table);
  const [sort, setSort] = useState(() => readTableSort(key));

  function changeSort(next?: TableSort) {
    setSort(next);
    saveTableSort(key, next);
  }

  return [sort, changeSort] as const;
}
