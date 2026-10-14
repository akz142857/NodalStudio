import { useState, type ReactNode } from "react";
import type { DatabaseSnapshot, DomainGroup, ObjectKey } from "../platform";
import { domainMembershipAddition, tableKeyIdentity } from "../graph/table-selection";
import { OperationFeedback } from "./OperationFeedback";
import { useOperation } from "./use-operation";

export interface DiagramSelectionActionsProps {
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
}

export function DiagramSelectionActions({ snapshot, selectedCount, selectedTableKeys, domainGroups, disabled, readOnlyReason, onClear, boxSelectionActive, onToggleBoxSelection, onAddTablesToDomain, layoutActions }: DiagramSelectionActionsProps) {
  const [domainId, setDomainId] = useState("");
  const groups = domainGroups.filter((group) => group.sourceId === snapshot.sourceId);
  const group = groups.find((candidate) => candidate.id === domainId);
  const context = JSON.stringify([snapshot.sourceId, snapshot.id, domainId, selectedTableKeys.map(tableKeyIdentity).sort(), readOnlyReason]);
  const operation = useOperation(context);
  const busy = operation.busy;
  const existing = new Set(group?.tableKeys.map(tableKeyIdentity));
  const newCount = selectedTableKeys.filter((key) => !existing.has(tableKeyIdentity(key))).length;
  const canSave = !disabled && !readOnlyReason && Boolean(onAddTablesToDomain && group && newCount > 0);

  async function addToDomain() {
    if (!canSave || !group || !onAddTablesToDomain) return;
    await operation.run(async () => {
      const addition = domainMembershipAddition(snapshot, group, selectedTableKeys);
      const saved = await onAddTablesToDomain(group.id, selectedTableKeys);
      return `Added ${addition.addedCount} table${addition.addedCount === 1 ? "" : "s"} to ${saved.name}.${addition.alreadyMemberCount ? ` ${addition.alreadyMemberCount} already in the domain.` : ""}`;
    }, { running: `Adding ${newCount} table${newCount === 1 ? "" : "s"} to ${group.name}…`, success: (message) => message, failure: `Unable to add tables to ${group.name}.` });
  }

  return <section className="diagram-selection-actions" aria-label="Diagram table selection">
    {onToggleBoxSelection ? <button type="button" className="diagram-box-select" aria-pressed={boxSelectionActive} disabled={busy} onClick={onToggleBoxSelection}>Box select</button> : null}
    <p className="diagram-selection-hint">Shift / ⌘ / Ctrl-click to select tables · Shift-drag to box select</p>
    {boxSelectionActive ? <p>Drag on empty canvas to select tables. Hold Space to pan.</p> : null}
    {selectedCount > 0 ? <>
      <div className="diagram-selection-controls">
        <strong>{selectedCount} table{selectedCount === 1 ? "" : "s"} selected</strong>
        <button type="button" disabled={busy} onClick={onClear}>Clear selection</button>
      </div>
      {readOnlyReason ? <p>{readOnlyReason}</p> : <>
        <div className="diagram-selection-controls">
          <select aria-label="Existing business domain" value={group ? domainId : ""} disabled={disabled || busy || !groups.length || !onAddTablesToDomain} onChange={(event) => setDomainId(event.target.value)}>
            <option value="">Choose business domain…</option>
            {groups.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          <button type="button" disabled={!canSave || busy} onClick={() => void addToDomain()}>{busy ? "Adding…" : "Add to domain"}</button>
        </div>
        {!groups.length ? <p>Create a business domain in Semantics first.</p> : !onAddTablesToDomain ? <p>Business semantics must finish loading before editing domains.</p> : group && !newCount ? <p>All selected tables already belong to {group.name}.</p> : null}
      </>}
      <OperationFeedback label="Business domain update" state={operation.state} onRetry={() => void addToDomain()} retryLabel="Retry domain update" retryDisabled={!canSave} onDismiss={operation.dismiss} />
    </> : null}
    {layoutActions}
  </section>;
}
