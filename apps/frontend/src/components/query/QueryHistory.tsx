import { EmptyState } from "../../design-system/EmptyState";
import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n } from "../../i18n";
import type { QueryHistoryEntry } from "../../platform";

interface QueryHistoryProps {
  entries: QueryHistoryEntry[];
  onRestore: (sql: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

export function QueryHistory({ entries, onRestore, onDelete, onClear }: QueryHistoryProps) {
  const { t: bt , formatDate } = useI18n();
  return <section className="query-history">
    <header><strong>{bt("business.localQueryHistory")}</strong><button type="button" onClick={onClear} disabled={!entries.length}>{bt("business.clearAll")}</button></header>
    {entries.length ? entries.map((entry) => <article key={entry.id}>
      <button type="button" className="query-history-sql" onClick={() => onRestore(entry.sqlText)} title={bt("business.restoreQuery")}>{entry.sqlText}</button>
      <div><span data-status={entry.status}>{translateUiLabel(entry.status, bt)}</span><small>{formatDate(entry.executedAt)} · {entry.durationMs} {bt("business.ms")} {entry.rowCount} {bt("business.rows")}</small><button type="button" aria-label={bt("business.deleteQueryHistoryEntry")} onClick={() => onDelete(entry.id)}>{translateUiLabel("Delete", bt)}</button></div>
    </article>) : <EmptyState compact className="query-empty-state" title={bt("business.historyIsStoredOnlyOnThisDevice")} />}
  </section>;
}
