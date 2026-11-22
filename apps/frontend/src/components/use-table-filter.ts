import { useMemo, useState } from "react";
import { enabledTableFilter, type TableFilterSettings } from "../platform/table-data-filter";
import { readTableFilter, saveTableFilter, tableFilterKey } from "../platform/table-data-preferences";

export function useTableFilter(sourceId: string, schema: string, table: string) {
  const key = tableFilterKey(sourceId, schema, table);
  const [settings, setSettings] = useState(() => readTableFilter(key));
  const filter = useMemo(() => enabledTableFilter(settings), [settings]);

  function changeFilter(next?: TableFilterSettings) {
    setSettings(next);
    saveTableFilter(key, next);
    return JSON.stringify(filter) !== JSON.stringify(enabledTableFilter(next));
  }

  return { filter, settings, changeFilter };
}
