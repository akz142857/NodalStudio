import { useI18n } from "../i18n";
import type { ReactNode } from "react";
import type { DatabaseSnapshot } from "../platform";
import { ActionIcon } from "./ActionIcon";

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
  const { t: bt, formatDate } = useI18n();
  const historical = Boolean(latestSnapshotId && latestSnapshotId !== snapshot.id);
  // File/DDL previews deliberately have no database capture timestamp.
  const hasCaptureTime = Number.isFinite(Date.parse(snapshot.capturedAt));
  const captured = hasCaptureTime ? bt("business.schemaCaptured", { value0: formatDate(snapshot.capturedAt) }) : bt("business.captureTimeUnavailable");
  return <header className="model-workspace-header" aria-label={bt("business.databaseSnapshotContext")}>
    <div className="model-workspace-title">
      {title ?? <h2>{historical ? bt("business.historicalModel") : bt("business.fullModel")}</h2>}
      <div className="model-workspace-subtitle"><span title={snapshot.database.name}>{snapshot.database.name}</span>
        {tableCount !== undefined ? <span> · {tableCount} {bt("business.tablesDetail")}</span> : null}
        {historical ? <span className="snapshot-version-badge">{bt("business.historicalSnapshot")}</span> : null}
        {hasCaptureTime
          ? <time className="visually-hidden" dateTime={snapshot.capturedAt}>{captured}</time>
          : <span className="visually-hidden">{captured}</span>}
      </div>
      {refreshState !== "idle" ? <span className="workspace-refresh-status" role={refreshState === "error" ? "alert" : "status"}>{refreshState === "refreshing" ? bt("business.refreshingSchema") : bt("business.refreshFailedShowingCapturedModel")}</span> : null}
    </div>
    <div className="model-workspace-actions" role="toolbar" aria-label={bt("business.diagramTools")}>
      {tools}
      {onOpenHistory ? <button className="workspace-icon-button" type="button" onClick={onOpenHistory} aria-label={bt("business.openSchemaHistory")} title={bt("business.viewSnapshotDetailsAndCompareVersions", { value0: captured })}><ActionIcon name="history" /></button> : null}
      {viewActions}
    </div>
  </header>;
}
