import type { QueryHistoryEntry } from "../../platform";

interface QueryHistoryProps {
  entries: QueryHistoryEntry[];
  onRestore: (sql: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

export function QueryHistory({ entries, onRestore, onDelete, onClear }: QueryHistoryProps) {
  return <section className="query-history">
    <header><strong>Local query history</strong><button type="button" onClick={onClear} disabled={!entries.length}>Clear all</button></header>
    {entries.length ? entries.map((entry) => <article key={entry.id}>
      <button type="button" className="query-history-sql" onClick={() => onRestore(entry.sqlText)} title="Restore query">{entry.sqlText}</button>
      <div><span data-status={entry.status}>{entry.status}</span><small>{new Date(entry.executedAt).toLocaleString()} · {entry.durationMs} ms · {entry.rowCount} rows</small><button type="button" aria-label="Delete query history entry" onClick={() => onDelete(entry.id)}>Delete</button></div>
    </article>) : <div className="query-empty-state">History is stored only on this device.</div>}
  </section>;
}
