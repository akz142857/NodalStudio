import { useCallback, useState, type MouseEvent, type KeyboardEvent } from "react";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform";
import type { ViewDefinition } from "../platform/types";
import { ActionIcon } from "./ActionIcon";
import { OperationFeedback } from "./OperationFeedback";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "./SchemaObjectMenu";
import { useOperation } from "./use-operation";

interface SchemaTreeProps {
  snapshot: DatabaseSnapshot;
  selectedTable?: TableDefinition;
  onSelectTable: (table: TableDefinition) => void;
  onOpenQuery?: (table: TableDefinition) => void;
}

type OpenState = Record<string, boolean>;
const TYPE_LABEL = { tables: "Tables", views: "Views", enums: "Enums" } as const;
type ObjectType = keyof typeof TYPE_LABEL;
type MenuTarget = { object: TableDefinition | ViewDefinition; trigger: HTMLButtonElement; x: number; y: number; scope: string };

/** Filtering expands matches without changing the user's normal disclosure state. */
export function SchemaTree({ snapshot, selectedTable, onSelectTable, onOpenQuery }: SchemaTreeProps) {
  const [open, setOpen] = useState<OpenState>({});
  const [openFor, setOpenFor] = useState<string>();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState<OpenState>({});
  const [context, setContext] = useState<MenuTarget>();
  const [previewKey, setPreviewKey] = useState<ObjectKey>();
  const [lastCopy, setLastCopy] = useState<ObjectKey>();
  const copy = useOperation(JSON.stringify([snapshot.sourceId, snapshot.id]));
  const defaults: OpenState = snapshot.schemas.length === 1 ? { [snapshot.schemas[0].name]: true } : {};
  if (openFor !== snapshot.sourceId) {
    setOpenFor(snapshot.sourceId); setOpen(defaults); setSearch(""); setSearchOpen({}); setContext(undefined); setPreviewKey(undefined);
  }
  const effectiveOpen = openFor === snapshot.sourceId ? open : defaults;
  const normalized = search.trim().toLocaleLowerCase();
  const filtering = Boolean(normalized);
  const menuScope = JSON.stringify([snapshot.sourceId, snapshot.id, normalized]);
  const activeMenu = context?.scope === menuScope ? context : undefined;
  const expanded = (key: string) => filtering ? (searchOpen[key] ?? true) : (effectiveOpen[key] ?? false);
  const toggle = (key: string) => {
    if (filtering) setSearchOpen((current) => ({ ...current, [key]: !(current[key] ?? true) }));
    else setOpen((current) => ({ ...current, [key]: !current[key] }));
  };
  const visible = snapshot.schemas.map((schema) => {
    const matches = (key: ObjectKey) => normalized.split(/\s+/).every((term) => `${key.schema}.${key.name}`.toLocaleLowerCase().includes(term));
    return { ...schema, tables: schema.tables.filter((table) => matches(table.key)), views: schema.views.filter((view) => matches(view.key)), enums: filtering ? [] : schema.enums };
  }).filter((schema) => !filtering || schema.tables.length + schema.views.length > 0);
  const totals = visible.reduce((sum, schema) => sum + schema.tables.length + schema.views.length + schema.enums.length, 0);
  const preview = previewKey ? snapshot.schemas.flatMap((schema) => schema.views).find((view) => view.key.schema === previewKey.schema && view.key.name === previewKey.name) : undefined;
  const selectedId = selectedTable && !preview ? `${selectedTable.key.schema}.${selectedTable.key.name}` : undefined;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setContext(undefined);
    if (restoreFocus && context?.trigger.isConnected) context.trigger.focus();
  }, [context]);
  const showMenu = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, object: TableDefinition | ViewDefinition) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setContext({ object, trigger: event.currentTarget, scope: menuScope,
      x: pointer ? event.clientX : rect.left + 16, y: pointer ? event.clientY : rect.bottom });
  };
  const contextKeys = (event: KeyboardEvent<HTMLButtonElement>, object: TableDefinition | ViewDefinition) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) showMenu(event, object);
  };
  const chooseTable = (table: TableDefinition) => { setPreviewKey(undefined); onSelectTable(table); };
  const showView = (view: ViewDefinition) => setPreviewKey(view.key);
  const closePreview = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.closest(".schema-tree")?.querySelector<HTMLButtonElement>('.tree-row[aria-current="true"]');
    setPreviewKey(undefined); row?.focus();
  };
  const copyName = (key: ObjectKey) => {
    setLastCopy(key);
    void copy.run(async () => {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard writing is unavailable in this runtime.");
      const name = `${key.schema}.${key.name}`;
      await navigator.clipboard.writeText(name);
      return name;
    }, { running: "Copying object name…", success: (name) => `Copied ${name}`, failure: "Unable to copy object name." });
  };
  const actions: SchemaObjectMenuAction[] = activeMenu ? [
    ...("columns" in activeMenu.object ? [
      { label: "Locate in diagram", run: () => chooseTable(activeMenu.object as TableDefinition) },
      ...(onOpenQuery ? [{ label: "Open read-only query…", run: () => onOpenQuery(activeMenu.object as TableDefinition) }] : []),
    ] : [{ label: "Show view definition", run: () => showView(activeMenu.object as ViewDefinition) }]),
    { label: "Copy qualified name", run: () => copyName(activeMenu.object.key) },
  ] : [];

  return <section className="schema-tree" aria-label="Database structure" onContextMenu={(event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest("input, textarea")) event.preventDefault();
  }}>
    <div className="section-heading"><h2>Structure</h2><span>{totals}</span></div>
    <div className="schema-object-search">
      <ActionIcon name="search" />
      <input type="search" aria-label="Search tables and views" placeholder="Search tables and views…" value={search}
        onChange={(event) => { setSearch(event.target.value); setSearchOpen({}); setContext(undefined); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearch(""); setSearchOpen({}); } }} />
      {search ? <button type="button" aria-label="Clear object search" onClick={() => { setSearch(""); setSearchOpen({}); }}>×</button> : null}
    </div>
    {filtering ? <p className="schema-search-count" role="status">{totals} {totals === 1 ? "match" : "matches"}</p> : null}
    {filtering && !totals ? <p className="schema-search-empty">No matching tables or views.</p> : null}
    {copy.state ? <OperationFeedback label="Object name copy" state={copy.state} onRetry={lastCopy ? () => copyName(lastCopy) : undefined} retryLabel="Retry name copy" onDismiss={copy.dismiss} /> : null}
    {preview ? <section className="schema-view-preview" aria-label={`Definition of ${preview.key.schema}.${preview.key.name}`} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePreview(event); } }}>
      <header><strong>{preview.materialized ? "Materialized view" : "View"} · {preview.key.schema}.{preview.key.name}</strong><button type="button" aria-label="Close view definition" onClick={closePreview}>×</button></header>
      <p>Read-only definition · Views are not drawn in Diagram.</p>
      {preview.comment ? <p>{preview.comment}</p> : null}
      <pre tabIndex={0}>{preview.definition || "Definition is not available in this snapshot."}</pre>
    </section> : null}
    {visible.map((schema) => {
      const schemaOpen = expanded(schema.name);
      const counts: Record<ObjectType, number> = { tables: schema.tables.length, views: schema.views.length, enums: schema.enums.length };
      return <div className="tree-node" key={schema.name}>
        <button type="button" className="tree-row tree-row-schema" aria-expanded={schemaOpen} onClick={() => toggle(schema.name)}>
          <span className="tree-twisty" data-open={schemaOpen || undefined} aria-hidden="true" /><span className="tree-label">{schema.name}</span><small>{counts.tables + counts.views + counts.enums}</small>
        </button>
        {schemaOpen ? (Object.keys(TYPE_LABEL) as ObjectType[]).filter((type) => !filtering || counts[type] > 0).map((type) => {
          const key = `${schema.name}:${type}`; const typeOpen = expanded(key); const count = counts[type];
          return <div className="tree-node tree-node-type" key={key}>
            <button type="button" className="tree-row tree-row-type" aria-expanded={typeOpen} disabled={count === 0} onClick={() => toggle(key)}>
              <span className="tree-twisty" data-open={typeOpen || undefined} aria-hidden="true" /><span className="tree-label">{TYPE_LABEL[type]}</span><small>{count}</small>
            </button>
            {typeOpen && type === "tables" ? schema.tables.map((table) => <button type="button" key={table.key.name} className="tree-row tree-row-object"
              aria-current={`${schema.name}.${table.key.name}` === selectedId ? "true" : undefined} aria-haspopup="menu"
              onClick={() => chooseTable(table)} onContextMenu={(event) => showMenu(event, table)} onKeyDown={(event) => contextKeys(event, table)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{table.key.name}</span><small>{table.columns.length}</small>
            </button>) : null}
            {typeOpen && type === "views" ? schema.views.map((view) => <button type="button" key={view.key.name} className="tree-row tree-row-object"
              aria-current={preview?.key.schema === view.key.schema && preview.key.name === view.key.name ? "true" : undefined} aria-haspopup="menu"
              onClick={() => showView(view)} onContextMenu={(event) => showMenu(event, view)} onKeyDown={(event) => contextKeys(event, view)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{view.key.name}</span>
            </button>) : null}
            {typeOpen && type === "enums" ? schema.enums.map((item) => <div className="tree-row tree-row-object is-static" key={item.key.name} onContextMenu={(event) => event.preventDefault()}><span className="tree-label">{item.key.name}</span></div>) : null}
          </div>;
        }) : null}
      </div>;
    })}
    {activeMenu ? <SchemaObjectMenu x={activeMenu.x} y={activeMenu.y} name={`${activeMenu.object.key.schema}.${activeMenu.object.key.name}`} actions={actions} onClose={closeMenu} /> : null}
  </section>;
}
