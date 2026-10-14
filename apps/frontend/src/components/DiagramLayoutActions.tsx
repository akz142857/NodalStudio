import { tableArrangementLabels, type TableArrangement } from "../graph/arrange-tables";
import { OperationFeedback, type OperationFeedbackState } from "./OperationFeedback";

const actions = Object.entries(tableArrangementLabels) as [TableArrangement, string][];

export function DiagramLayoutActions({ selectedCount, movableCount = selectedCount, pinnedCount = 0, onPin, onUnpin, onAutoLayoutSelected, disabled, waitingForLayout, temporaryReason, feedback, onArrange, onRetry, retryLabel, undoLabel, redoLabel, onUndo, onRedo }: {
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
}) {
  return <div className="diagram-layout-actions" aria-label="Diagram layout">
    <div className="diagram-selection-controls">
      <button type="button" disabled={disabled || !undoLabel || !onUndo} onClick={onUndo} title={undoLabel ? `Undo ${undoLabel} · ⌘/Ctrl+Z` : "No layout changes to undo"}>Undo layout</button>
      <button type="button" disabled={disabled || !redoLabel || !onRedo} onClick={onRedo} title={redoLabel ? `Redo ${redoLabel} · ⌘/Ctrl+Shift+Z / Ctrl+Y` : "No layout changes to redo"}>Redo layout</button>
    </div>
    {selectedCount > 0 ? <>
      <div className="diagram-selection-controls">
        <button type="button" disabled={disabled || !movableCount || !onPin} onClick={onPin}>Fix table positions</button>
        <button type="button" disabled={disabled || !pinnedCount || !onUnpin} onClick={onUnpin}>Unlock table positions</button>
        <button type="button" disabled={disabled || !movableCount || !onAutoLayoutSelected} onClick={onAutoLayoutSelected}>Auto layout selected</button>
      </div>
      <p>{pinnedCount} fixed · {movableCount} movable selected. Fixed tables keep their position and size; unlock to edit.</p>
      <div className="diagram-selection-controls diagram-alignment-controls">
        {actions.map(([action, label]) => <button key={action} type="button" disabled={disabled || movableCount < (action.startsWith("distribute-") ? 3 : 2)} title={action.startsWith("distribute-") ? "Equal gaps between table edges; keep the outer tables fixed. Requires 3 movable tables." : "Align selected table bounds. Requires 2 movable tables."} onClick={() => onArrange(action)}>{label}</button>)}
      </div>
      <p>Align: 2+ movable tables · Equal gaps: 3+ movable tables, outer tables stay in place.</p>
    </> : null}
    <p>{temporaryReason ? `${temporaryReason} Layout changes are temporary and reset when leaving this view; the full diagram is unchanged.` : waitingForLayout ? "Full diagram: waiting for the saved layout to load before arranging or saving." : "Full diagram: positions, fixed states and table sizes save automatically on this device. Pan, zoom and selection are not saved."}</p>
    <OperationFeedback label="Diagram layout operation" state={feedback} onRetry={onRetry} retryLabel={retryLabel ?? "Retry layout save"} retryDisabled={disabled} />
  </div>;
}
