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
  selectedTable?: TableDefinition;
  semantics: SemanticBundle;
  platform: NodalStudioPlatform;
  onChange: (semantics: SemanticBundle) => void;
  onApplyView: (view: SavedView | undefined) => void;
}

export function KnowledgePanel({
  sourceId,
  selectedTable,
  semantics,
  platform,
  onChange,
  onApplyView,
}: KnowledgePanelProps) {
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
    if (!selectedTable || !viewName.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const view = await platform.saveView({
        sourceId,
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
    <section className="knowledge-panel" aria-label="Semantic model">
      <div className="section-heading">
        <h2>Knowledge</h2>
        <button type="button" onClick={() => onApplyView(undefined)}>
          Clear view
        </button>
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
              <span>{view.relationshipDepth} hops</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="semantic-create">
        <p>
          {selectedTable
            ? `Use ${selectedTable.key.name} as the selected root.`
            : "Select a table to create a group or relationship view."}
        </p>
        <div>
          <input
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="Business group"
            disabled={!selectedTable || pending}
          />
          <input
            className="color-input"
            type="color"
            value={groupColor}
            onChange={(event) => setGroupColor(event.target.value)}
            disabled={!selectedTable || pending}
          />
          <button
            type="button"
            disabled={!selectedTable || !groupName.trim() || pending}
            onClick={() => void createGroup()}
          >
            Add group
          </button>
        </div>
        <div>
          <input
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            placeholder="Saved relationship view"
            disabled={!selectedTable || pending}
          />
          <select
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            disabled={!selectedTable || pending}
          >
            <option value={0}>Root</option>
            <option value={1}>1 hop</option>
            <option value={2}>2 hops</option>
            <option value={3}>3 hops</option>
          </select>
          <button
            type="button"
            disabled={!selectedTable || !viewName.trim() || pending}
            onClick={() => void createView()}
          >
            Save view
          </button>
        </div>
      </div>
      {semantics.orphanedAnnotations.length > 0 ? (
        <p className="semantic-warning">
          {semantics.orphanedAnnotations.length} annotations reference removed objects and remain
          preserved.
        </p>
      ) : null}
      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
