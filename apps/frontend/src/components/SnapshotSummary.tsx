import type { DatabaseSnapshot } from "../platform";

interface SnapshotSummaryProps {
  snapshot: DatabaseSnapshot;
  refreshState: "idle" | "refreshing" | "error";
  canRefresh: boolean;
  onRefresh: () => void;
}

function formatCapturedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Which snapshot the canvas is showing, pinned below the tree.
 *
 * "What am I looking at, and how old is it" is asked constantly and answered
 * nowhere on the first screen otherwise — the same facts live in the inspector,
 * but only while nothing is selected.
 */
export function SnapshotSummary({
  snapshot,
  refreshState,
  canRefresh,
  onRefresh,
}: SnapshotSummaryProps) {
  const tables = snapshot.schemas.reduce((total, schema) => total + schema.tables.length, 0);

  return (
    <section className="snapshot-card" aria-label="Active snapshot">
      <div className="section-heading">
        <h2>Snapshot</h2>
        <span data-status={refreshState}>
          {refreshState === "refreshing"
            ? "Refreshing…"
            : refreshState === "error"
              ? "Refresh failed"
              : formatCapturedAt(snapshot.capturedAt)}
        </span>
      </div>
      <p className="snapshot-card-meta">
        <span>{tables} tables</span>
        <span title={snapshot.fingerprint}>{snapshot.fingerprint.slice(0, 8)}</span>
      </p>
      <div className="snapshot-card-actions">
        <button
          type="button"
          disabled={!canRefresh || refreshState === "refreshing"}
          onClick={onRefresh}
        >
          Refresh
        </button>
        <button
          type="button"
          title="Open the history segment of the inspector"
          onClick={() => window.dispatchEvent(new Event("nodalstudio:inspect-history"))}
        >
          Compare…
        </button>
      </div>
    </section>
  );
}
