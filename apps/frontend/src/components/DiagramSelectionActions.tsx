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
  const [domainId, setDomainId] = useState("");
  const groups = domainGroups.filter((group) => group.sourceId === snapshot.sourceId);
  const group = groups.find((candidate) => candidate.id === domainId);
  const context = JSON.stringify([snapshot.sourceId, snapshot.id, domainId, selectedTableKeys.map(tableKeyIdentity).sort(), readOnlyReason]);
  const operation = useOperation(context);
  const busy = operation.busy;
  const existing = new Set(group?.tableKeys.map(tableKeyIdentity));
  const newCount = selectedTableKeys.filter((key) => !existing.has(tableKeyIdentity(key))).length;
  const canSave = !disabled && !readOnlyReason && Boolean(onAddTablesToDomain && group && newCount > 0);
  const domainReason = readOnlyReason ?? (!groups.length ? "Create a business domain in Semantics first." : !onAddTablesToDomain ? "Business semantics must finish loading before editing domains." : "Add selected tables to an existing business domain.");

  async function addToDomain() {
    if (!canSave || !group || !onAddTablesToDomain) return;
    await operation.run(async () => {
      const addition = domainMembershipAddition(snapshot, group, selectedTableKeys);
      const saved = await onAddTablesToDomain(group.id, selectedTableKeys);
      return `Added ${addition.addedCount} table${addition.addedCount === 1 ? "" : "s"} to ${saved.name}.${addition.alreadyMemberCount ? ` ${addition.alreadyMemberCount} already in the domain.` : ""}`;
    }, { running: `Adding ${newCount} table${newCount === 1 ? "" : "s"} to ${group.name}…`, success: (message) => message, failure: `Unable to add tables to ${group.name}.` });
  }

  return <div className={`diagram-toolbar${inline ? " canvas-selection-tools" : ""}`} role="toolbar" aria-label="Selected tables">
    {onToggleBoxSelection ? <button type="button" className="diagram-box-select" title={boxSelectionActive ? "Drag empty canvas to select tables. Hold Space to pan." : "Box select · Shift-drag, or Shift / ⌘ / Ctrl-click to add tables to selection"} aria-pressed={boxSelectionActive} disabled={busy} onClick={onToggleBoxSelection}>Box select</button> : null}
    {selectedCount > 0 ? <>
      <strong className="diagram-selected-count">{inline ? "Selected tables" : `${selectedCount} table${selectedCount === 1 ? "" : "s"} selected`}</strong>
      {createViewAction}
      {layoutActions}
      <DiagramToolbarMenu inline={inline} label="Business domain" title={domainReason} disabled={disabled || Boolean(readOnlyReason) || !groups.length || !onAddTablesToDomain}>
          <select aria-label="Existing business domain" value={group ? domainId : ""} disabled={disabled || busy || !groups.length || !onAddTablesToDomain} onChange={(event) => setDomainId(event.target.value)}>
            <option value="">Choose business domain…</option>
            {groups.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          <button type="button" disabled={!canSave || busy} title={group && !newCount ? `All selected tables already belong to ${group.name}.` : "Add the selected tables; existing members are preserved."} onClick={() => void addToDomain()}>{busy ? "Adding…" : "Add to domain"}</button>
      </DiagramToolbarMenu>
    </> : null}
    {selectedCount > 0 ? <button type="button" className="workspace-clear-selection" aria-label="Clear selection" title="Clear selection" disabled={busy} onClick={onClear}>{inline ? "Clear selection" : <ActionIcon name="close" />}</button> : null}
    {selectedCount > 0 ? <OperationFeedback label="Business domain update" state={operation.state} onRetry={() => void addToDomain()} retryLabel="Retry domain update" retryDisabled={!canSave} onDismiss={operation.dismiss} /> : null}
  </div>;
}
