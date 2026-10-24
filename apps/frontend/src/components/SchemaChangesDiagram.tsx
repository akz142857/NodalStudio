import { useI18n } from "../i18n";
import type { NodalStudioPlatform, RuntimeInfo } from "../platform";
import { SchemaCanvas, type SchemaCanvasProps } from "./SchemaCanvas";
import { useComparisonSnapshot } from "./use-comparison-snapshot";
import { OperationFeedback } from "./OperationFeedback";

interface SchemaChangesDiagramProps extends SchemaCanvasProps {
  platform: NodalStudioPlatform;
  runtimeKind?: RuntimeInfo["kind"];
}

export function SchemaChangesDiagram({ platform, runtimeKind, ...props }: SchemaChangesDiagramProps) {
  const { t: bt } = useI18n();
  const { snapshot, changeSet } = props;
  const before = useComparisonSnapshot(changeSet?.beforeSnapshotId ?? snapshot.id, snapshot, platform, runtimeKind);
  const after = useComparisonSnapshot(changeSet?.afterSnapshotId ?? snapshot.id, snapshot, platform, runtimeKind);
  if (!changeSet) return <SchemaCanvas {...props} platform={platform} runtimeKind={runtimeKind} />;
  return (
    <section className="schema-changes-diagram" aria-label={bt("business.schemaComparisonDiagram")} data-color-blind={props.colorBlindPalette || undefined}>
      <div className="diagram-comparison-context">
        <div className="diagram-change-legend" aria-label={bt("business.diagramChangeLegend")}>
          <strong>{bt("business.beforeAfterDetail")}</strong>
          <span className="comparison-badge" data-change="added">{bt("business.added")}</span>
          <span className="comparison-badge" data-change="modified">{bt("business.modified")}</span>
          <span className="comparison-badge" data-change="deleted">{bt("business.deletedBefore")}</span>
          <span>{bt("business.unmarkedUnchanged")}</span>
        </div>
        <p>{bt("business.deletedObjectsUseBeforeDefinitionsReplacedForeignKeysShow")}</p>
        {!before.snapshot ? <OperationFeedback label={bt("business.beforeSnapshotLoad")} state={before.loading ? { phase: "running", summary: bt("business.loadingBeforeSnapshotDeletedObjectsWillAppearWhenIt") } : { phase: runtimeKind === "web" ? "info" : "error", summary: bt("business.beforeSnapshotUnavailableDeletedObjectsCannotBeReconstructedFrom", { value0: runtimeKind === "web" ? " This share includes only one snapshot." : "" }), details: before.error }} onRetry={runtimeKind === "desktop" ? before.retry : undefined} retryLabel={bt("business.retryBeforeSnapshot")} /> : null}
      </div>
      {after.snapshot ? <div className="comparison-canvas"><SchemaCanvas {...props} platform={platform} runtimeKind={runtimeKind} snapshot={after.snapshot} beforeSnapshot={before.snapshot} /></div> : (
        <div className="diagram-unavailable">
          <OperationFeedback label={bt("business.afterSnapshotLoad")} state={after.loading ? { phase: "running", summary: bt("business.loadingAfterSnapshot") } : { phase: runtimeKind === "web" ? "info" : "error", summary: bt("business.afterSnapshotUnavailableOpenTheChangeListToInspect"), details: after.error }} onRetry={runtimeKind === "desktop" ? after.retry : undefined} retryLabel={bt("business.retryAfterSnapshot")} />
        </div>
      )}
    </section>
  );
}
