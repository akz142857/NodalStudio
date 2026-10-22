import type { DatabaseSnapshot } from "../platform";
import { ActionIcon } from "./ActionIcon";

import { formatSnapshotTime } from "./snapshot-presentation";

export function DatabaseSnapshotHeader({ snapshot, latestSnapshotId, refreshState, onOpenHistory }: {
  snapshot: DatabaseSnapshot;
  latestSnapshotId?: string;
  refreshState: "idle" | "refreshing" | "error";
  onOpenHistory: () => void;
}) {
  const historical = Boolean(latestSnapshotId && latestSnapshotId !== snapshot.id);
  return <header className="database-snapshot-header" aria-label="Database snapshot context">
    <ActionIcon name="database" />
    <div className="database-snapshot-title"><div><h2>{snapshot.database.name}</h2>{historical ? <span className="snapshot-version-badge">Historical snapshot</span> : null}</div>
      <p>Schema captured <time dateTime={snapshot.capturedAt}>{formatSnapshotTime(snapshot.capturedAt)}</time>{refreshState !== "idle" ? <span role="status"> · {refreshState === "refreshing" ? "Refreshing schema…" : "Refresh failed"}</span> : null}</p>
    </div>
    <button type="button" onClick={onOpenHistory} aria-label="Open schema history" title="View snapshot details and compare schema versions"><ActionIcon name="history" /><span>History</span></button>
  </header>;
}
