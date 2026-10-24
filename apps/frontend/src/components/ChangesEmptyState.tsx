import type { DatabaseSnapshot } from "../platform";
import { ActionIcon } from "./ActionIcon";

export function ChangesEmptyState({ snapshot, desktop, snapshotCount, loading, error, refreshing, onHistory, onRefresh, onRetry }: {
  snapshot?: DatabaseSnapshot;
  desktop: boolean;
  snapshotCount: number;
  loading: boolean;
  error: boolean;
  refreshing: boolean;
  onHistory: () => void;
  onRefresh?: () => void;
  onRetry: () => void;
}) {
  const title = !snapshot ? "Select a database to review changes."
    : !desktop ? "No comparison included in this share."
    : error ? "Snapshot history could not be loaded."
    : loading ? "Checking snapshot history…"
    : snapshotCount < 2 ? "Your first snapshot is the starting point."
    : "Choose two snapshots to compare.";
  const message = !snapshot ? "Open a saved database from the sidebar. Changes compares versions of its schema."
    : !desktop ? "Open this database in the desktop app to browse history and compare schema versions."
    : error ? "Your current model is still available. Retry loading history to see the saved versions."
    : loading ? "Looking for saved versions of this database."
    : snapshotCount < 2 ? "There is no earlier version to compare yet. Refresh after the database structure changes, then compare the saved versions in History."
    : "Open History and select a Before and After version to review changes to tables, columns and indexes.";
  return <section className="changes-empty-state" aria-label="Schema changes">
    <span className="changes-empty-icon"><ActionIcon name="history" /></span>
    <p className="eyebrow">{snapshot ? `${snapshot.database.name} · Schema changes` : "Schema changes"}</p>
    <h2>{title}</h2><p role={error ? "alert" : "status"}>{message}</p>
    {snapshot && desktop ? <div className="changes-empty-actions">
      {error ? <button type="button" onClick={onRetry}>Retry loading history</button> : <button type="button" onClick={onHistory}>Open history</button>}
      {onRefresh ? <button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh schema"}</button> : null}
    </div> : null}
    <p className="changes-empty-note">Tracks schema structure, not changes to individual data rows.</p>
  </section>;
}
