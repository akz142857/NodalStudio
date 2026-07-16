import { useEffect, useState } from "react";
import type {
  DatabaseSnapshot,
  SchemaChangeSet,
  SnapshotSummary,
  NodalStudioPlatform,
} from "../platform";

interface HistoryPanelProps {
  sourceId: string;
  revision: string;
  platform: NodalStudioPlatform;
  onSelect: (snapshot: DatabaseSnapshot) => void;
  onCompare: (snapshot: DatabaseSnapshot, changeSet: SchemaChangeSet) => void;
}

function formatCapturedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function HistoryPanel({
  sourceId,
  revision,
  platform,
  onSelect,
  onCompare,
}: HistoryPanelProps) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void platform
      .listSnapshots(sourceId)
      .then((items) => {
        if (!active) return;
        setSnapshots(items);
        setAfterId(items[0]?.id ?? "");
        setBeforeId(items[1]?.id ?? "");
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [platform, revision, sourceId]);

  async function selectSnapshot(id: string) {
    setPending(true);
    setError(undefined);
    try {
      onSelect(await platform.getSnapshot(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  async function compare() {
    if (!beforeId || !afterId || beforeId === afterId) return;
    setPending(true);
    setError(undefined);
    try {
      const [snapshot, changeSet] = await Promise.all([
        platform.getSnapshot(afterId),
        platform.compareSnapshots(beforeId, afterId),
      ]);
      onCompare(snapshot, changeSet);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="history-panel" aria-label="Schema history">
      <div className="section-heading">
        <h2>History</h2>
        <span>{snapshots.length}</span>
      </div>
      {snapshots.length === 0 ? (
        <p className="muted-copy">Capture a schema to establish its baseline.</p>
      ) : (
        <>
          <div className="timeline-list">
            {snapshots.map((snapshot, index) => (
              <button
                type="button"
                key={snapshot.id}
                disabled={pending}
                onClick={() => void selectSnapshot(snapshot.id)}
              >
                <span className="timeline-dot" />
                <span>
                  <strong>{index === 0 ? "Current" : formatCapturedAt(snapshot.capturedAt)}</strong>
                  <small>
                    {snapshot.tableCount} tables · {snapshot.fingerprint.slice(0, 8)}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {snapshots.length > 1 ? (
            <div className="compare-controls">
              <label>
                Before
                <select value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
                  {snapshots.map((snapshot) => (
                    <option value={snapshot.id} key={snapshot.id}>
                      {formatCapturedAt(snapshot.capturedAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                After
                <select value={afterId} onChange={(event) => setAfterId(event.target.value)}>
                  {snapshots.map((snapshot) => (
                    <option value={snapshot.id} key={snapshot.id}>
                      {formatCapturedAt(snapshot.capturedAt)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={pending || !beforeId || !afterId || beforeId === afterId}
                onClick={() => void compare()}
              >
                Compare versions
              </button>
            </div>
          ) : null}
        </>
      )}
      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
