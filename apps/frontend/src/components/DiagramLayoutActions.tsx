import { tableArrangementLabels, type TableArrangement } from "../graph/arrange-tables";
import { OperationFeedback, type OperationFeedbackState } from "./OperationFeedback";
import { DiagramToolbarMenu } from "./DiagramToolbarMenu";

const actions = Object.entries(tableArrangementLabels) as [TableArrangement, string][];

export function DiagramLayoutActions({ selectedCount, movableCount = selectedCount, pinnedCount = 0, onPin, onUnpin, onAutoLayoutSelected, disabled, waitingForLayout, temporaryReason, feedback, onArrange, onRetry, retryLabel, undoLabel, redoLabel, onUndo, onRedo, onDismissFeedback }: {
  selectedCount: number;
  movableCount?: number;
  pinnedCount?: number;
  onPin?: () => void;
  onUnpin?: () => void;
  onAutoLayoutSelected?: () => void;
  disabled?: boolean;
  waitingForLayout?: boolean;
  temporaryReason?: string;
  feedback?: OperationFeedbackState;
  onArrange: (action: TableArrangement) => void;
  onRetry?: () => void;
  retryLabel?: string;
  undoLabel?: string;
  redoLabel?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onDismissFeedback?: () => void;
}) {
  const persistence = temporaryReason ? `${temporaryReason} Layout changes are temporary.` : waitingForLayout ? "Waiting for the saved layout to load." : "Positions, fixed states, table sizes and your view save automatically on this device. Selection is temporary.";
  return <div className="diagram-layout-tools" role="group" aria-label="Diagram layout" title={persistence}>
      <button type="button" aria-label="Undo layout" disabled={disabled || !undoLabel || !onUndo} onClick={onUndo} title={undoLabel ? `Undo ${undoLabel} · ⌘/Ctrl+Z` : "No layout changes to undo"}>↶</button>
      <button type="button" aria-label="Redo layout" disabled={disabled || !redoLabel || !onRedo} onClick={onRedo} title={redoLabel ? `Redo ${redoLabel} · ⌘/Ctrl+Shift+Z / Ctrl+Y` : "No layout changes to redo"}>↷</button>
    {selectedCount > 0 ? <>
        {movableCount > 0 ? <button type="button" aria-label="Fix table positions" title="Fix selected table positions and sizes" disabled={disabled || !onPin} onClick={onPin}>Fix positions</button> : null}
        {pinnedCount > 0 ? <button type="button" aria-label="Unlock table positions" title="Unlock selected tables for editing" disabled={disabled || !onUnpin} onClick={onUnpin}>Unlock positions</button> : null}
        <button type="button" aria-label="Auto layout selected" title={`Arrange ${movableCount} movable selected tables; skip ${pinnedCount} fixed tables`} disabled={disabled || !movableCount || !onAutoLayoutSelected} onClick={onAutoLayoutSelected}>Layout selected</button>
      <DiagramToolbarMenu label="Align / distribute" title={`${pinnedCount} fixed · ${movableCount} movable selected. ${persistence}`}>
        {actions.map(([action, label]) => <button key={action} type="button" disabled={disabled || movableCount < (action.startsWith("distribute-") ? 3 : 2)} title={action.startsWith("distribute-") ? "Equal gaps between table edges; keep the outer tables fixed. Requires 3 movable tables." : "Align selected table bounds. Requires 2 movable tables."} onClick={() => onArrange(action)}>{label}</button>)}
      </DiagramToolbarMenu>
    </> : null}
    <OperationFeedback autoDismissMs={5000} label="Diagram layout operation" state={feedback} onRetry={onRetry} retryLabel={retryLabel ?? "Retry layout save"} retryDisabled={disabled} onDismiss={onDismissFeedback} dismissLabel="Dismiss layout result" />
  </div>;
}
