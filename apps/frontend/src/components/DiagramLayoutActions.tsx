import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { ActionIcon } from "./ActionIcon";
import { tableArrangementLabels, type TableArrangement } from "../graph/arrange-tables";
import type { OperationFeedbackState } from "./OperationFeedback";
import { DiagramToolbarMenu } from "./DiagramToolbarMenu";

const actions = Object.entries(tableArrangementLabels) as [TableArrangement, string][];

export function DiagramLayoutActions({ selectedCount, movableCount = selectedCount, pinnedCount = 0, onPin, onUnpin, onAutoLayoutSelected, disabled, waitingForLayout, temporaryReason, feedback, onArrange, onRetry, retryLabel, undoLabel, redoLabel, onUndo, onRedo, part }: {
  part: "history" | "selection" | "status";
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
  const { t: bt } = useI18n();
  const persistence = temporaryReason ? bt("business.layoutChangesAreTemporary", { value0: temporaryReason }) : waitingForLayout ? bt("business.waitingForTheSavedLayoutToLoad") : bt("business.positionsFixedStatesTableSizesAndYourViewSave");
  if (part === "status") return <div className="workspace-layout-status" role="group" aria-label={bt("business.diagramLayoutOperation")} data-phase={feedback?.phase} title={persistence}>
    <span role={feedback?.phase === "error" ? "alert" : "status"} aria-live={feedback?.phase === "error" ? "assertive" : "polite"}>
      {feedback?.summaryKey ? bt(feedback.summaryKey) : feedback?.phase === "success" && !temporaryReason && feedback.summary.startsWith(bt("business.layoutSavedOnThisDevice")) ? bt("business.savedOnThisDevice") : feedback?.phase === "success" && !temporaryReason && feedback.summary.startsWith(bt("business.layoutSavedInThisBrowser")) ? bt("business.savedInThisBrowser") : feedback?.summary ?? (waitingForLayout ? bt("business.loadingSavedLayout") : temporaryReason ? bt("business.layoutChangesAreTemporary", { value0: temporaryReason }) : bt("business.layoutChangesSaveAutomaticallyOnThisDevice"))}
      {feedback?.details ? <span className="workspace-layout-detail"> · {feedback.details}</span> : null}
    </span>
    {feedback?.phase === "error" && onRetry ? <button type="button" disabled={disabled} onClick={onRetry}>{retryLabel ?? bt("business.retryLayoutSave")}</button> : null}
  </div>;
  return <div className="diagram-layout-tools" role={part === "selection" ? undefined : "group"} aria-label={part === "selection" ? undefined : bt("business.diagramLayout")} title={persistence}>
    {part !== "selection" ? <>

      <button type="button" aria-label={bt("business.undoLayout")} disabled={disabled || !undoLabel || !onUndo} onClick={onUndo} title={undoLabel ? bt("business.undoCtrlZ", { value0: translateUiLabel(undoLabel, bt) }) : bt("business.noLayoutChangesToUndo")}><ActionIcon name="undo" /></button>
      <button type="button" aria-label={bt("business.redoLayout")} disabled={disabled || !redoLabel || !onRedo} onClick={onRedo} title={redoLabel ? bt("business.redoCtrlShiftZCtrlY", { value0: translateUiLabel(redoLabel, bt) }) : bt("business.noLayoutChangesToRedo")}><ActionIcon name="redo" /></button>
    </> : null}
    {part !== "history" && selectedCount > 0 ? <>
        {movableCount > 0 ? <button type="button" aria-label={bt("business.fixTablePositions")} title={bt("business.fixSelectedTablePositionsAndSizes")} disabled={disabled || !onPin} onClick={onPin}>{bt("business.fixPositions")}</button> : null}
        {pinnedCount > 0 ? <button type="button" aria-label={bt("business.unlockTablePositions")} title={bt("business.unlockSelectedTablesForEditing")} disabled={disabled || !onUnpin} onClick={onUnpin}>{bt("business.unlockPositions")}</button> : null}
        <button type="button" aria-label={bt("business.autoLayoutSelected")} title={bt("business.arrangeMovableSelectedTablesSkipFixedTables", { value0: movableCount, value1: pinnedCount })} disabled={disabled || !movableCount || !onAutoLayoutSelected} onClick={onAutoLayoutSelected}>{bt("business.layoutSelected")}</button>
      <DiagramToolbarMenu inline label={bt("business.alignDistribute")} title={bt("business.fixedMovableSelected", { value0: pinnedCount, value1: movableCount, value2: persistence })}>
        {actions.map(([action, label]) => <button key={action} type="button" disabled={disabled || movableCount < (action.startsWith("distribute-") ? 3 : 2)} title={action.startsWith("distribute-") ? bt("business.equalGapsBetweenTableEdgesKeepTheOuterTables") : bt("business.alignSelectedTableBoundsRequires2MovableTables")} onClick={() => onArrange(action)}>{translateUiLabel(label, bt)}</button>)}
      </DiagramToolbarMenu>
    </> : null}

  </div>;
}
