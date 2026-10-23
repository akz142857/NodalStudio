import type { ReactNode } from "react";
import type { DatabaseSnapshot } from "../platform";
import { ActionIcon } from "./ActionIcon";
import { formatSnapshotTime } from "./snapshot-presentation";

export function DatabaseSnapshotHeader({ snapshot, latestSnapshotId, refreshState = "idle", onOpenHistory, title, tableCount, tools, viewActions }: {
  snapshot: DatabaseSnapshot;
  latestSnapshotId?: string;
  refreshState?: "idle" | "refreshing" | "error";
  onOpenHistory?: () => void;
  title?: ReactNode;
  tableCount?: number;
  tools?: ReactNode;
  viewActions?: ReactNode;
}) {
  const historical = Boolean(latestSnapshotId && latestSnapshotId !== snapshot.id);
  // File/DDL previews deliberately have no database capture timestamp.
  const hasCaptureTime = Number.isFinite(Date.parse(snapshot.capturedAt));
  const captured = hasCaptureTime ? `Schema captured ${formatSnapshotTime(snapshot.capturedAt)}` : "Capture time unavailable";
  return <header className="model-workspace-header" aria-label="Database snapshot context">
    <div className="model-workspace-title">
      {title ?? <h2>{historical ? "Historical model" : "Full model"}</h2>}
      <div className="model-workspace-subtitle"><span title={snapshot.database.name}>{snapshot.database.name}</span>
        {tableCount !== undefined ? <span> · {tableCount} tables</span> : null}
        {historical ? <span className="snapshot-version-badge">Historical snapshot</span> : null}
        {hasCaptureTime
          ? <time className="visually-hidden" dateTime={snapshot.capturedAt}>{captured}</time>
          : <span className="visually-hidden">{captured}</span>}
      </div>
      {refreshState !== "idle" ? <span className="workspace-refresh-status" role={refreshState === "error" ? "alert" : "status"}>{refreshState === "refreshing" ? "Refreshing schema…" : "Refresh failed · showing captured model"}</span> : null}
    </div>
    <div className="model-workspace-actions" role="toolbar" aria-label="Diagram tools">
      {tools}
      {onOpenHistory ? <button className="workspace-icon-button" type="button" onClick={onOpenHistory} aria-label="Open schema history" title={`${captured} · View snapshot details and compare versions`}><ActionIcon name="history" /></button> : null}
      {viewActions}
    </div>
  </header>;
}
