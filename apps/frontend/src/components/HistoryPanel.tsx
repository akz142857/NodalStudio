import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import type {
  DatabaseSnapshot,
  SchemaChangeSet,
  SnapshotSummary,
  NodalStudioPlatform,
} from "../platform";

interface HistoryPanelProps {
  sourceId: string;
  revision: string;
  activeSnapshot?: DatabaseSnapshot;
  platform: NodalStudioPlatform;
  onSelect: (snapshot: DatabaseSnapshot) => void;
  onCompare: (snapshot: DatabaseSnapshot, changeSet: SchemaChangeSet) => void;
}


export function HistoryPanel({
  sourceId,
  revision,
  activeSnapshot,
  platform,
  onSelect,
  onCompare,
}: HistoryPanelProps) {
  const { t: bt, formatDate } = useI18n();
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const requestRevision = useRef(0);

  useEffect(() => {
    requestRevision.current += 1;
    let active = true;
    void platform
      .listSnapshots(sourceId)
      .then((items) => {
        if (!active) return;
        setSnapshots(items);
        setAfterId(items[0]?.id ?? "");
        setBeforeId(items[1]?.id ?? "");
        setPending(false);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setPending(false);
        }
      });
    return () => {
      active = false;
      requestRevision.current += 1;
    };
  }, [platform, revision, sourceId]);

  async function selectSnapshot(id: string) {
    const revision = requestRevision.current;
    setPending(true);
    setError(undefined);
    try {
      const snapshot = await platform.getSnapshot(id);
      if (revision === requestRevision.current) onSelect(snapshot);
    } catch (reason) {
      if (revision === requestRevision.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (revision === requestRevision.current) setPending(false);
    }
  }

  async function compare() {
    if (!beforeId || !afterId || beforeId === afterId) return;
    const revision = requestRevision.current;
    setPending(true);
    setError(undefined);
    try {
      const [snapshot, changeSet] = await Promise.all([
        platform.getSnapshot(afterId),
        platform.compareSnapshots(beforeId, afterId),
      ]);
      if (revision === requestRevision.current) onCompare(snapshot, changeSet);
    } catch (reason) {
      if (revision === requestRevision.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (revision === requestRevision.current) setPending(false);
    }
  }

  return (
    <section className="history-panel" aria-label={bt("business.schemaHistory")}>
      <div className="section-heading">
        <h2>{bt("business.history")}</h2>
        <span>{snapshots.length}</span>
      </div>
      {activeSnapshot ? <section className="history-current-snapshot" aria-label={bt("business.viewingSnapshotDetails")}>
        <div className="history-current-heading"><strong>{bt("business.viewingSnapshot")}</strong>{snapshots[0] ? <span className="snapshot-version-badge">{snapshots[0].id === activeSnapshot.id ? bt("business.latestCaptured") : bt("business.historical")}</span> : null}</div>
        <dl><div><dt>{bt("business.captured")}</dt><dd><time dateTime={activeSnapshot.capturedAt}>{formatDate(activeSnapshot.capturedAt)}</time></dd></div>
          <div><dt>{bt("business.tables")}</dt><dd>{activeSnapshot.schemas.reduce((n,schema) => n + schema.tables.length,0)}</dd></div>
          <div><dt>{bt("business.fingerprint")}</dt><dd className="history-fingerprint">{activeSnapshot.fingerprint}</dd></div></dl>
        <p>{bt("business.aSavedSchemaNotADataBackupUseRefresh")}</p>
      </section> : null}
      {snapshots.length === 0 ? (
        <p className="muted-copy">{bt("business.captureASchemaToEstablishItsBaseline")}</p>
      ) : (
        <>
          <div className="timeline-list">
            {snapshots.map((snapshot, index) => (
              <button
                type="button"
                key={snapshot.id}
                disabled={pending}
                aria-current={snapshot.id === (activeSnapshot?.id ?? revision) ? "true" : undefined}
                onClick={() => void selectSnapshot(snapshot.id)}
              >
                <span className="timeline-dot" />
                <span>
                  <strong>{formatDate(snapshot.capturedAt)}</strong>
                  {index === 0 ? <small>{bt("business.latestCaptured")}</small> : null}
                  {snapshot.id === (activeSnapshot?.id ?? revision) ? <small className="history-viewing-label">{bt("business.viewing")}</small> : null}
                  <small>
                    {snapshot.tableCount} {bt("business.tablesDetailDetailDetail")} {snapshot.fingerprint.slice(0, 8)}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {snapshots.length > 1 ? (
            <div className="compare-controls">
              <label>
                {bt("business.beforeBaseline")}<select className="ds-select" disabled={pending} value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
                  {snapshots.map((snapshot) => (
                    <option value={snapshot.id} key={snapshot.id}>
                      {formatDate(snapshot.capturedAt)} · {snapshot.fingerprint.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {bt("business.afterTarget")}<select className="ds-select" disabled={pending} value={afterId} onChange={(event) => setAfterId(event.target.value)}>
                  {snapshots.map((snapshot) => (
                    <option value={snapshot.id} key={snapshot.id}>
                      {formatDate(snapshot.capturedAt)} · {snapshot.fingerprint.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted-copy">{bt("business.beforeAfterAdditionsAndRemovalsAreRelativeToThe")}</p>
              <button
                type="button"
                disabled={pending}
                onClick={() => { setBeforeId(afterId); setAfterId(beforeId); }}
              >
                {bt("business.swapDirection")}</button>
              <button
                type="button"
                disabled={pending || !beforeId || !afterId || beforeId === afterId}
                onClick={() => void compare()}
              >
                {bt("business.compareVersions")}</button>
            </div>
          ) : null}
        </>
      )}
      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
