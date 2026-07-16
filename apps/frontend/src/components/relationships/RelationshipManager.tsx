import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LogicalRelationship, LogicalRelationshipStatus } from "../../platform";

interface RelationshipManagerProps {
  relationships: LogicalRelationship[];
  onSelect: (relationship: LogicalRelationship) => void;
  onEdit: (relationship: LogicalRelationship) => void;
  onRebindTarget: (relationship: LogicalRelationship) => void;
  onToggle: (relationship: LogicalRelationship) => void;
  onDelete: (relationship: LogicalRelationship) => void;
  onClose: () => void;
}

type RelationshipFilter = "all" | "active" | "attention" | "disabled";

const attentionStatuses = new Set<LogicalRelationshipStatus>(["orphaned", "conflicted", "supersededByPhysical"]);

const statusLabels: Record<LogicalRelationshipStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  orphaned: "Missing endpoint",
  conflicted: "Needs review",
  supersededByPhysical: "Physical FK exists",
};

function endpointSearchText(value: LogicalRelationship["source"]) {
  return `${value.schema}.${value.table}.${value.columns.join(",")}`;
}

function cardinalityLabel(value: LogicalRelationship["cardinality"]) {
  return ({
    oneToOne: "One to one",
    oneToMany: "One to many",
    manyToOne: "Many to one",
    manyToMany: "Many to many",
    unspecified: "Cardinality unspecified",
  } as const)[value];
}

function Endpoint({ label, value }: { label: "From" | "To"; value: LogicalRelationship["source"] }) {
  return <div className="relationship-manager-endpoint">
    <span>{label}</span>
    <div><strong>{value.schema}.{value.table}</strong><code>{value.columns.join(", ")}</code></div>
  </div>;
}

export function RelationshipManager({ relationships, onSelect, onEdit, onRebindTarget, onToggle, onDelete, onClose }: RelationshipManagerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RelationshipFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const counts = useMemo(() => ({
    all: relationships.length,
    active: relationships.filter((item) => item.status === "active").length,
    attention: relationships.filter((item) => attentionStatuses.has(item.status)).length,
    disabled: relationships.filter((item) => item.status === "disabled").length,
  }), [relationships]);
  const visibleRelationships = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return relationships
      .filter((relationship) => {
        if (filter === "active" && relationship.status !== "active") return false;
        if (filter === "attention" && !attentionStatuses.has(relationship.status)) return false;
        if (filter === "disabled" && relationship.status !== "disabled") return false;
        if (!normalizedQuery) return true;
        return [
          relationship.name,
          endpointSearchText(relationship.source),
          endpointSearchText(relationship.target),
          relationship.note ?? "",
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        const priority = (item: LogicalRelationship) => attentionStatuses.has(item.status) ? 0 : item.status === "active" ? 1 : 2;
        return priority(left) - priority(right) || left.name.localeCompare(right.name);
      });
  }, [filter, query, relationships]);

  useEffect(() => {
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(<div className="relationship-manager-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="relationship-manager nodrag nopan" role="dialog" aria-modal="true" aria-labelledby="logical-relationships-title">
      <header>
        <div><p>MODEL-ONLY METADATA</p><h2 id="logical-relationships-title">Logical relationships</h2><span>{relationships.length} relationships · never alters the connected database</span></div>
        <button type="button" aria-label="Close logical relationships" onClick={onClose}>×</button>
      </header>
      <div className="relationship-manager-tools">
        <label><span>Search</span><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Relationship, table, or field…" /></label>
        <div className="relationship-manager-filters" aria-label="Relationship status filter">
          {(["all", "active", "attention", "disabled"] as const).map((value) => <button key={value} type="button" data-active={filter === value || undefined} onClick={() => setFilter(value)}>{value === "all" ? "All" : value === "attention" ? "Needs attention" : value[0].toUpperCase() + value.slice(1)} <span>{counts[value]}</span></button>)}
        </div>
      </div>
      <div className="relationship-manager-list">
        {visibleRelationships.length ? visibleRelationships.map((relationship) => <article key={relationship.id} data-status={relationship.status}>
          <header><strong title={relationship.name}>{relationship.name}</strong><span className="relationship-status-badge">{statusLabels[relationship.status]}</span></header>
          <div className="relationship-manager-endpoints"><Endpoint label="From" value={relationship.source} /><span className="relationship-manager-arrow">→</span><Endpoint label="To" value={relationship.target} /></div>
          <div className="relationship-manager-meta"><span>{cardinalityLabel(relationship.cardinality)}</span><span>{relationship.origin === "confirmedInference" ? "Confirmed inference" : relationship.origin[0].toUpperCase() + relationship.origin.slice(1)}</span>{relationship.evidence.length ? <span>{relationship.evidence.length} evidence</span> : null}</div>
          {relationship.note ? <p className="relationship-manager-note">{relationship.note}</p> : null}
          <footer><div><button type="button" className="primary" onClick={() => onSelect(relationship)}>Show on canvas</button><button type="button" onClick={() => onEdit(relationship)}>Edit</button><button type="button" onClick={() => onRebindTarget(relationship)}>Rebind target</button>{relationship.status === "active" || relationship.status === "conflicted" || relationship.status === "disabled" ? <button type="button" onClick={() => onToggle(relationship)}>{relationship.status === "disabled" ? "Enable" : "Disable"}</button> : null}</div><button type="button" className="danger" onClick={() => onDelete(relationship)}>Delete</button></footer>
        </article>) : <div className="relationship-manager-empty"><strong>{relationships.length ? "No matching relationships" : "No logical relationships yet"}</strong><p>{relationships.length ? "Try another search or status filter." : "Drag from a field connection point to create a model-only relationship."}</p>{query || filter !== "all" ? <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button> : null}</div>}
      </div>
    </section>
  </div>, document.body);
}
