import { useI18n } from "../i18n";
import { ActionIcon } from "./ActionIcon";
import { useState, type ReactNode } from "react";
import type { DatabaseSnapshot, DomainGroup, ObjectKey } from "../platform";
import { domainMembershipAddition, tableKeyIdentity } from "../graph/table-selection";
import { OperationFeedback } from "./OperationFeedback";
import { useOperation } from "./use-operation";
import { DiagramToolbarMenu } from "./DiagramToolbarMenu";

export interface DiagramSelectionActionsProps {
  inline?: boolean;
  snapshot: DatabaseSnapshot;
  selectedCount: number;
  selectedTableKeys: ObjectKey[];
  domainGroups: DomainGroup[];
  disabled?: boolean;
  readOnlyReason?: string;
  onClear: () => void;
  boxSelectionActive?: boolean;
  onToggleBoxSelection?: () => void;
  onAddTablesToDomain?: (domainId: string, tableKeys: ObjectKey[]) => Promise<DomainGroup>;
  layoutActions?: ReactNode;
  createViewAction?: ReactNode;
}

export function DiagramSelectionActions({ inline = false, snapshot, selectedCount, selectedTableKeys, domainGroups, disabled, readOnlyReason, onClear, boxSelectionActive, onToggleBoxSelection, onAddTablesToDomain, layoutActions, createViewAction }: DiagramSelectionActionsProps) {
  const { t: bt, locale } = useI18n();
  const [domainId, setDomainId] = useState("");
  const groups = domainGroups.filter((group) => group.sourceId === snapshot.sourceId);
  const group = groups.find((candidate) => candidate.id === domainId);
  const context = JSON.stringify([snapshot.sourceId, snapshot.id, domainId, selectedTableKeys.map(tableKeyIdentity).sort(), readOnlyReason]);
  const operation = useOperation(context);
  const busy = operation.busy;
  const existing = new Set(group?.tableKeys.map(tableKeyIdentity));
  const newCount = selectedTableKeys.filter((key) => !existing.has(tableKeyIdentity(key))).length;
  const canSave = !disabled && !readOnlyReason && Boolean(onAddTablesToDomain && group && newCount > 0);
  const domainReason = readOnlyReason ?? (!groups.length ? bt("business.createABusinessDomainInSemanticsFirst") : !onAddTablesToDomain ? bt("business.businessSemanticsMustFinishLoadingBeforeEditingDomains") : bt("business.addSelectedTablesToAnExistingBusinessDomain"));

  async function addToDomain() {
    if (!canSave || !group || !onAddTablesToDomain) return;
    await operation.run(async () => {
      const addition = domainMembershipAddition(snapshot, group, selectedTableKeys);
      const saved = await onAddTablesToDomain(group.id, selectedTableKeys);
      return bt("business.addedTableTo", { value0: addition.addedCount, value1: locale === "zh-CN" ? "" : (addition.addedCount === 1 ? "" : "s"), value2: saved.name, value3: addition.alreadyMemberCount ? bt("businessExtra.countAlreadyInTheDomain", { count: addition.alreadyMemberCount }) : "" });
    }, { running: bt("business.addingTableTo", { value0: newCount, value1: locale === "zh-CN" ? "" : (newCount === 1 ? "" : "s"), value2: group.name }), success: (message) => message, failure: bt("business.unableToAddTablesTo", { value0: group.name }) });
  }

  return <div className={`diagram-toolbar${inline ? " canvas-selection-tools" : ""}`} role="toolbar" aria-label={bt("business.selectedTables")}>
    {onToggleBoxSelection ? <button type="button" className="diagram-box-select" title={boxSelectionActive ? bt("business.dragEmptyCanvasToSelectTablesHoldSpaceTo") : bt("business.boxSelectShiftDragOrShiftCtrlClickTo")} aria-pressed={boxSelectionActive} disabled={busy} onClick={onToggleBoxSelection}>{bt("business.boxSelect")}</button> : null}
    {selectedCount > 0 ? <>
      <strong className="diagram-selected-count">{inline ? bt("business.selectedTables") : bt("business.tableSelected", { value0: selectedCount, value1: locale === "zh-CN" ? "" : (selectedCount === 1 ? "" : "s") })}</strong>
      {createViewAction}
      {layoutActions}
      <DiagramToolbarMenu inline={inline} label={bt("business.businessDomainDetail")} title={domainReason} disabled={disabled || Boolean(readOnlyReason) || !groups.length || !onAddTablesToDomain}>
          <select aria-label={bt("business.existingBusinessDomain")} value={group ? domainId : ""} disabled={disabled || busy || !groups.length || !onAddTablesToDomain} onChange={(event) => setDomainId(event.target.value)}>
            <option value="">{bt("business.chooseBusinessDomain")}</option>
            {groups.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          <button type="button" disabled={!canSave || busy} title={group && !newCount ? bt("business.allSelectedTablesAlreadyBelongTo", { value0: group.name }) : bt("business.addTheSelectedTablesExistingMembersArePreserved")} onClick={() => void addToDomain()}>{busy ? bt("business.adding") : bt("business.addToDomain")}</button>
      </DiagramToolbarMenu>
    </> : null}
    {selectedCount > 0 ? <button type="button" className="workspace-clear-selection" aria-label={bt("business.clearSelection")} title={bt("business.clearSelection")} disabled={busy} onClick={onClear}>{inline ? bt("business.clearSelection") : <ActionIcon name="close" />}</button> : null}
    {selectedCount > 0 ? <OperationFeedback label={bt("business.businessDomainUpdate")} state={operation.state} onRetry={() => void addToDomain()} retryLabel={bt("business.retryDomainUpdate")} retryDisabled={!canSave} onDismiss={operation.dismiss} /> : null}
  </div>;
}
