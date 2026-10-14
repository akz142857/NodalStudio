import type { NodalStudioPlatform, RuntimeInfo } from "../platform";
import { SchemaCanvas, type SchemaCanvasProps } from "./SchemaCanvas";
import { useComparisonSnapshot } from "./use-comparison-snapshot";
import { OperationFeedback } from "./OperationFeedback";

interface SchemaChangesDiagramProps extends SchemaCanvasProps {
  platform: NodalStudioPlatform;
  runtimeKind?: RuntimeInfo["kind"];
}

export function SchemaChangesDiagram({ platform, runtimeKind, ...props }: SchemaChangesDiagramProps) {
  const { snapshot, changeSet } = props;
  const before = useComparisonSnapshot(changeSet?.beforeSnapshotId ?? snapshot.id, snapshot, platform, runtimeKind);
  const after = useComparisonSnapshot(changeSet?.afterSnapshotId ?? snapshot.id, snapshot, platform, runtimeKind);
  if (!changeSet) return <SchemaCanvas {...props} platform={platform} runtimeKind={runtimeKind} />;
  return (
    <section className="schema-changes-diagram" aria-label="Schema comparison diagram" data-color-blind={props.colorBlindPalette || undefined}>
      <div className="diagram-comparison-context">
        <div className="diagram-change-legend" aria-label="Diagram change legend">
          <strong>Before → After</strong>
          <span className="comparison-badge" data-change="added">+ Added</span>
          <span className="comparison-badge" data-change="modified">~ Modified</span>
          <span className="comparison-badge" data-change="deleted">− Deleted · Before</span>
          <span>Unmarked: unchanged</span>
        </div>
        <p>Deleted objects use Before definitions. Replaced foreign keys show the previous and current connections. Logical and inferred relationships use the After model.</p>
        {!before.snapshot ? <OperationFeedback label="Before snapshot load" state={before.loading ? { phase: "running", summary: "Loading Before snapshot; deleted objects will appear when it is ready." } : { phase: runtimeKind === "web" ? "info" : "error", summary: `Before snapshot unavailable. Deleted objects cannot be reconstructed from summaries alone.${runtimeKind === "web" ? " This share includes only one snapshot." : ""}`, details: before.error }} onRetry={runtimeKind === "desktop" ? before.retry : undefined} retryLabel="Retry Before snapshot" /> : null}
      </div>
      {after.snapshot ? <div className="comparison-canvas"><SchemaCanvas {...props} platform={platform} runtimeKind={runtimeKind} snapshot={after.snapshot} beforeSnapshot={before.snapshot} /></div> : (
        <div className="diagram-unavailable">
          <OperationFeedback label="After snapshot load" state={after.loading ? { phase: "running", summary: "Loading After snapshot…" } : { phase: runtimeKind === "web" ? "info" : "error", summary: "After snapshot unavailable. Open the change list to inspect the comparison summaries.", details: after.error }} onRetry={runtimeKind === "desktop" ? after.retry : undefined} retryLabel="Retry After snapshot" />
        </div>
      )}
    </section>
  );
}
