import { useI18n } from "../i18n";
import { useState } from "react";
import type {
  DomainGroup,
  SavedView,
  SemanticBundle,
  NodalStudioPlatform,
  TableDefinition,
} from "../platform";

interface KnowledgePanelProps {
  sourceId: string;
  snapshotId?: string;
  readOnly?: boolean;
  selectedTable?: TableDefinition;
  semantics: SemanticBundle;
  platform: NodalStudioPlatform;
  onChange: (semantics: SemanticBundle) => void;
  onApplyView: (view: SavedView | undefined) => void;
}

export function KnowledgePanel({
  sourceId,
  snapshotId,
  readOnly,
  selectedTable,
  semantics,
  platform,
  onChange,
  onApplyView,
}: KnowledgePanelProps) {
  const { t: bt } = useI18n();
  const [groupName, setGroupName] = useState("");
  const [groupColor, setGroupColor] = useState("#77e08a");
  const [viewName, setViewName] = useState("");
  const [depth, setDepth] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function createGroup() {
    if (!selectedTable || !groupName.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const group = await platform.saveDomainGroup({
        sourceId,
        name: groupName,
        description: null,
        color: groupColor,
        tableKeys: [selectedTable.key],
      });
      onChange({
        ...semantics,
        domainGroups: [group, ...semantics.domainGroups.filter((item) => item.id !== group.id)],
      });
      setGroupName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  async function createView() {
    if (readOnly || !selectedTable || !viewName.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const view = await platform.saveView({
        sourceId,
        snapshotId,
        name: viewName,
        rootTableKeys: [selectedTable.key],
        relationshipDepth: depth,
      });
      onChange({
        ...semantics,
        savedViews: [view, ...semantics.savedViews.filter((item) => item.id !== view.id)],
      });
      onApplyView(view);
      setViewName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  function domainAsView(group: DomainGroup): SavedView {
    return {
      id: `domain:${group.id}`,
      sourceId: group.sourceId,
      name: group.name,
      rootTableKeys: group.tableKeys,
      relationshipDepth: 0,
      updatedAt: group.updatedAt,
    };
  }

  return (
    <section className="knowledge-panel" aria-label={bt("businessSupport.semanticModel")}>
      <div className="section-heading">
        <h2>{bt("businessSupport.groupsViews")}</h2>
        <button type="button" onClick={() => onApplyView(undefined)}>
          {bt("businessSupport.clearView")}</button>
      </div>

      {semantics.domainGroups.length > 0 ? (
        <div className="semantic-chips">
          {semantics.domainGroups.map((group) => (
            <button
              type="button"
              key={group.id}
              onClick={() => onApplyView(domainAsView(group))}
            >
              <span style={{ background: group.color }} />
              {group.name}
              <small>{group.tableKeys.length}</small>
            </button>
          ))}
        </div>
      ) : null}

      {semantics.savedViews.length > 0 ? (
        <div className="saved-view-list">
          {semantics.savedViews.map((view) => (
            <button type="button" key={view.id} onClick={() => onApplyView(view)}>
              <strong>{view.name}</strong>
              <span>{view.relationshipDepth} {bt("businessSupport.hops")}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="semantic-create">
        <p>
          {selectedTable
            ? bt("businessSupport.useAsTheSelectedRoot", { value0: selectedTable.key.name })
            : bt("businessSupport.selectATableToCreateAGroupOrRelationship")}
        </p>
        <div className="semantic-create-row">
          <label className="semantic-name">{bt("businessSupport.businessGroup")}<input
            aria-label={bt("businessSupport.businessGroup")}
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={bt("businessSupport.businessGroup")}
            disabled={!selectedTable || pending}
          /></label>
          <label>{bt("businessSupport.color")}<input
            aria-label={bt("businessSupport.groupColor")}
            className="color-input"
            type="color"
            value={groupColor}
            onChange={(event) => setGroupColor(event.target.value)}
            disabled={!selectedTable || pending}
          /></label>
          <button
            type="button"
            disabled={!selectedTable || !groupName.trim() || pending}
            onClick={() => void createGroup()}
          >
            {bt("businessSupport.addGroup")}</button>
        </div>
        <div className="semantic-create-row">
          <label className="semantic-name">{bt("businessSupport.relationshipView")}<input
            aria-label={bt("businessSupport.savedRelationshipView")}
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            placeholder={bt("businessSupport.savedRelationshipView")}
            disabled={!selectedTable || pending}
          /></label>
          <label>{bt("businessSupport.depth")}<select
            aria-label={bt("businessSupport.relationshipDepth")}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            disabled={!selectedTable || pending}
          >
            <option value={0}>{bt("businessSupport.root")}</option>
            <option value={1}>{bt("businessSupport.1Hop")}</option>
            <option value={2}>{bt("businessSupport.2Hops")}</option>
            <option value={3}>{bt("businessSupport.3Hops")}</option>
          </select></label>
          <button
            type="button"
            disabled={readOnly || !selectedTable || !viewName.trim() || pending}
            onClick={() => void createView()}
          >
            {bt("businessSupport.saveView")}</button>
        </div>
      </div>
      {semantics.orphanedAnnotations.length > 0 ? (
        <p className="semantic-warning">
          {semantics.orphanedAnnotations.length} {bt("businessSupport.annotationsReferenceRemovedObjectsAndRemainPreserved")}</p>
      ) : null}
      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
