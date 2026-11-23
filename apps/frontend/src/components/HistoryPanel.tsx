import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { Button } from "../design-system/Button";
import { SearchSelect } from "./SearchSelect";
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
  onSelect: (snapshot: DatabaseSnapshot, latest: boolean) => void;
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
  const [selection, setSelection] = useState<{ sourceId: string; before: string; after: string }>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const listKey = JSON.stringify([sourceId, revision, loadAttempt]);
  const [loadedKey, setLoadedKey] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const [action, setAction] = useState<"open" | "compare">();
  const [error, setError] = useState<string>();
  const requestRevision = useRef(0);
  const running = useRef(false);
  const loading = loadedKey !== listKey;
  const pending = action !== undefined;
  const choices = selection?.sourceId === sourceId ? selection : undefined;
  const beforeId = snapshots.some(({ id }) => id === choices?.before) ? choices?.before ?? "" : snapshots[1]?.id ?? "";
  const afterId = snapshots.some(({ id }) => id === choices?.after) ? choices?.after ?? "" : snapshots[0]?.id ?? "";
  const options = snapshots.map((snapshot) => ({
    value: snapshot.id, label: `${formatDate(snapshot.capturedAt, "local", { dateStyle: "short", timeStyle: "medium" })} · ${snapshot.fingerprint.slice(0, 8)}`,
    detail: snapshot.id === snapshots[0]?.id ? bt("business.latestCaptured") : undefined,
  }));

  useEffect(() => {
    requestRevision.current += 1;
    let active = true;
    void platform
      .listSnapshots(sourceId)
      .then((items) => {
        if (!active) return;
        running.current = false;
        setSnapshots(items);
        setLoadedKey(listKey);
        setLoadError(undefined);
        setAction(undefined);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) {
          running.current = false;
          setSnapshots([]);
          setLoadedKey(listKey);
          setLoadError(reason instanceof Error ? reason.message : String(reason));
          setError(undefined);
          setAction(undefined);
        }
      });
    return () => {
      active = false;
      requestRevision.current += 1;
    };
  }, [listKey, platform, sourceId]);

  async function selectSnapshot(id: string) {
    if (loading || running.current) return;
    const revision = requestRevision.current;
    running.current = true;
    setAction("open");
    setError(undefined);
    try {
      const snapshot = await platform.getSnapshot(id);
      if (revision === requestRevision.current) onSelect(snapshot, id === snapshots[0]?.id);
    } catch (reason) {
      if (revision === requestRevision.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (revision === requestRevision.current) { running.current = false; setAction(undefined); }
    }
  }

  async function compare() {
    if (loading || running.current || !beforeId || !afterId || beforeId === afterId) return;
    const revision = requestRevision.current;
    running.current = true;
    setAction("compare");
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
      if (revision === requestRevision.current) { running.current = false; setAction(undefined); }
    }
  }

  return (
    <section className="history-panel" aria-label={bt("business.schemaHistory")} aria-busy={loading || pending}>
      {activeSnapshot ? <section className="history-current-snapshot" aria-label={bt("business.viewingSnapshotDetails")}>
        <div className="history-current-heading"><h3>{bt("business.viewingSnapshot")}</h3>{!loading && snapshots[0] ? <span className="snapshot-version-badge">{snapshots[0].id === activeSnapshot.id ? bt("business.latestCaptured") : bt("business.historical")}</span> : null}</div>
        <dl><div><dt>{bt("business.captured")}</dt><dd><time dateTime={activeSnapshot.capturedAt}>{formatDate(activeSnapshot.capturedAt)}</time></dd></div>
          <div><dt>{bt("business.tables")}</dt><dd>{activeSnapshot.schemas.reduce((n, schema) => n + schema.tables.length, 0)}</dd></div></dl>
        <details className="history-fingerprint"><summary>{bt("business.fingerprint")} <code>{activeSnapshot.fingerprint.slice(0, 8)}</code></summary>
          <code>{activeSnapshot.fingerprint}</code>
        </details>
      </section> : null}
      {loading ? <p role="status">{bt("inspector.loadingHistory")}</p> : loadError !== undefined ? (
        <div className="inspector-empty-state"><p role="alert">{bt("inspector.historyLoadFailed")} {loadError}</p>
          <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{bt("business.retryLoadingHistory")}</Button></div>
      ) : snapshots.length === 0 ? (
        <p className="muted-copy">{bt("business.captureASchemaToEstablishItsBaseline")}</p>
      ) : (
        <>
          {snapshots.length > 1 ? <section className="compare-controls" aria-label={bt("inspector.compareSnapshots")}>
            <h3>{bt("inspector.compareSnapshots")}</h3>
            <SearchSelect label={bt("business.beforeBaseline")} value={beforeId} options={options} disabled={pending}
              searchPlaceholder={bt("inspector.searchSnapshots")} onChange={(before) => setSelection({ sourceId, before, after: afterId })} />
            <SearchSelect label={bt("business.afterTarget")} value={afterId} options={options} disabled={pending}
              searchPlaceholder={bt("inspector.searchSnapshots")} onChange={(after) => setSelection({ sourceId, before: beforeId, after })} />
            {beforeId === afterId ? <p>{bt("inspector.chooseDifferentSnapshots")}</p> : null}
            <div className="inspector-actions">
              <Button disabled={pending || beforeId === afterId} onClick={() => setSelection({ sourceId, before: afterId, after: beforeId })}>
                {bt("business.swapDirection")}
              </Button>
              <Button variant="primary" busy={action === "compare"} disabled={pending || !beforeId || !afterId || beforeId === afterId}
                onClick={() => void compare()}>{bt("business.compareVersions")}</Button>
            </div>
          </section> : null}
          <div className="section-heading"><h3>{bt("inspector.capturedSnapshots")}</h3><span>{snapshots.length}</span></div>
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
                  <small>{snapshot.tableCount} {bt("business.tablesDetailDetailDetail")} {snapshot.fingerprint.slice(0, 8)}</small>
                  {index === 0 || snapshot.id === (activeSnapshot?.id ?? revision) ? <small className="history-viewing-label">
                    {[index === 0 && bt("business.latestCaptured"), snapshot.id === (activeSnapshot?.id ?? revision) && bt("business.viewing")].filter(Boolean).join(" · ")}
                  </small> : null}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {error ? <p className="error-message" role="alert">{error}</p> : null}
    </section>
  );
}
