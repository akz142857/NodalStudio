import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { useCallback, useState, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform";
import type { EnumDefinition, ViewDefinition } from "../platform/types";
import { ActionIcon } from "./ActionIcon";
import { OperationFeedback } from "./OperationFeedback";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "./SchemaObjectMenu";
import { useOperation } from "./use-operation";
import { TreeDisclosureIcon } from "./TreeDisclosureIcon";
import { SchemaEnumDetails } from "./SchemaEnumDetails";

interface SchemaTreeProps {
  snapshot: DatabaseSnapshot;
  navigation?: ReactNode;
  selectedTable?: TableDefinition;
  onSelectTable: (table: TableDefinition) => void;
  onOpenQuery?: (table: TableDefinition) => void;
}

type OpenState = Record<string, boolean>;

type ObjectType = "tables" | "views" | "enums";
type MenuObject = TableDefinition | ViewDefinition | EnumDefinition;
type MenuTarget = { object: MenuObject; trigger: HTMLButtonElement; x: number; y: number; scope: string };

/** Filtering expands matches without changing the user's normal disclosure state. */
export function SchemaTree({ snapshot, selectedTable, onSelectTable, onOpenQuery, navigation }: SchemaTreeProps) {
  const { t: bt } = useI18n();
  const TYPE_LABEL = { tables: bt("business.tables"), views: bt("business.views"), enums: bt("business.enums") } as const;
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
  const preview = previewKey?.kind === "view" ? snapshot.schemas.flatMap((schema) => schema.views).find((view) => view.key.schema === previewKey.schema && view.key.name === previewKey.name) : undefined;
  const enumPreview = previewKey?.kind === "enum" ? snapshot.schemas.flatMap((schema) => schema.enums).find((item) => item.key.schema === previewKey.schema && item.key.name === previewKey.name) : undefined;
  if (previewKey && !preview && !enumPreview) setPreviewKey(undefined);
  const selectedId = selectedTable && !preview && !enumPreview ? `${selectedTable.key.schema}.${selectedTable.key.name}` : undefined;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setContext(undefined);
    if (restoreFocus && context?.trigger.isConnected) context.trigger.focus();
  }, [context]);
  const showMenu = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, object: MenuObject) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setContext({ object, trigger: event.currentTarget, scope: menuScope,
      x: pointer ? event.clientX : rect.left + 16, y: pointer ? event.clientY : rect.bottom });
  };
  const chooseTable = (table: TableDefinition) => { setPreviewKey(undefined); onSelectTable(table); };
  const showView = (view: ViewDefinition) => setPreviewKey(view.key);
  const showEnum = (item: EnumDefinition) => setPreviewKey(item.key);
  const closePreview = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const tree = event.currentTarget.closest(".schema-tree");
    const target = tree?.querySelector<HTMLButtonElement>('.tree-row[aria-current="true"]') ?? tree?.querySelector<HTMLInputElement>('input[type="search"]');
    setPreviewKey(undefined); target?.focus();
  };
  const copyName = (key: ObjectKey) => {
    setLastCopy(key);
    void copy.run(async () => {
      if (!navigator.clipboard?.writeText) throw new Error(bt("business.clipboardWritingIsUnavailableInThisRuntime"));
      const name = `${key.schema}.${key.name}`;
      await navigator.clipboard.writeText(name);
      return name;
    }, { running: bt("business.copyingObjectName"), success: (name) => bt("business.copied", { value0: name }), failure: bt("business.unableToCopyObjectName") });
  };
  const actions: SchemaObjectMenuAction[] = activeMenu ? [
    ...("columns" in activeMenu.object ? [
      { label: bt("business.locateInDiagram"), run: () => chooseTable(activeMenu.object as TableDefinition) },
      ...(onOpenQuery ? [{ label: bt("business.openReadOnlyQuery"), run: () => onOpenQuery(activeMenu.object as TableDefinition) }] : []),
    ] : "values" in activeMenu.object ? [{ label: bt("business.showEnumDetails"), run: () => showEnum(activeMenu.object as EnumDefinition) }]
      : [{ label: bt("business.showViewDefinition"), run: () => showView(activeMenu.object as ViewDefinition) }]),
    { label: bt("business.copyQualifiedName"), run: () => copyName(activeMenu.object.key) },
  ] : [];

  return <section className="schema-tree" aria-label={bt("business.databaseStructure")} onContextMenu={(event) => {
    event.preventDefault();
  }}>
    {navigation}
    <h2 className="navigation-section-title">{bt("business.databaseObjects")}</h2>
    <div className="schema-object-search">
      <ActionIcon name="search" />
      <input type="search" aria-label={bt("business.searchTablesAndViews")} placeholder={bt("business.searchTablesAndViewsDetail")} value={search}
        onChange={(event) => { setSearch(event.target.value); setSearchOpen({}); setContext(undefined); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearch(""); setSearchOpen({}); } }} />
      {search ? <button type="button" aria-label={bt("business.clearObjectSearch")} onClick={() => { setSearch(""); setSearchOpen({}); }}>×</button> : null}
    </div>
    {filtering ? <p className="schema-search-count" role="status">{totals} {translateUiLabel(totals === 1 ? "match" : "matches", bt)}</p> : null}
    {filtering && !totals ? <p className="schema-search-empty">{bt("business.noMatchingTablesOrViews")}</p> : null}
    {copy.state ? <OperationFeedback label={bt("business.objectNameCopy")} state={copy.state} onRetry={lastCopy ? () => copyName(lastCopy) : undefined} retryLabel={bt("business.retryNameCopy")} onDismiss={copy.dismiss} /> : null}
    {preview ? <section className="schema-object-preview schema-view-preview" aria-label={bt("business.definitionOf", { value0: preview.key.schema, value1: preview.key.name })} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePreview(event); } }}>
      <header><strong>{preview.materialized ? bt("business.materializedView") : bt("business.view")} · {preview.key.schema}.{preview.key.name}</strong><button type="button" aria-label={bt("business.closeViewDefinition")} onClick={closePreview}>×</button></header>
      <p>{bt("business.readOnlyDefinitionViewsAreNotDrawnInDiagram")}</p>
      {preview.comment ? <p>{preview.comment}</p> : null}
      <pre tabIndex={0}>{preview.definition || bt("business.definitionIsNotAvailableInThisSnapshot")}</pre>
    </section> : null}
    {enumPreview ? <SchemaEnumDetails snapshot={snapshot} item={enumPreview} onLocate={onSelectTable} onClose={closePreview} /> : null}
    {visible.map((schema) => {
      const schemaOpen = expanded(schema.name);
      const counts: Record<ObjectType, number> = { tables: schema.tables.length, views: schema.views.length, enums: schema.enums.length };
      return <div className="tree-node" key={schema.name}>
        <button type="button" className="tree-row tree-row-schema" title={schema.name} aria-expanded={schemaOpen} onClick={() => toggle(schema.name)}>
          <TreeDisclosureIcon open={schemaOpen} /><span className="tree-label">{schema.name}</span><small>{counts.tables + counts.views + counts.enums}</small>
        </button>
        {schemaOpen ? (Object.keys(TYPE_LABEL) as ObjectType[]).filter((type) => counts[type] > 0).map((type) => {
          const key = `${schema.name}:${type}`; const typeOpen = expanded(key); const count = counts[type];
          return <div className="tree-node tree-node-type" key={key}>
            <button type="button" className="tree-row tree-row-type" aria-expanded={typeOpen} disabled={count === 0} onClick={() => toggle(key)}>
              <TreeDisclosureIcon open={typeOpen} /><ActionIcon name={type === "tables" ? "table" : type === "views" ? "copy" : "list"} /><span className="tree-label">{TYPE_LABEL[type]}</span><small>{count}</small>
            </button>
            {typeOpen && type === "tables" ? schema.tables.map((table) => <div className="tree-object-row" key={table.key.name}><button type="button" key={table.key.name} className="tree-row tree-row-object" title={table.key.name}
              aria-current={`${schema.name}.${table.key.name}` === selectedId ? "true" : undefined}
              onClick={() => chooseTable(table)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{table.key.name}</span><small>{table.columns.length}</small>
            </button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", { value0: table.key.schema, value1: table.key.name })} aria-haspopup="menu" aria-expanded={activeMenu?.object === table} onClick={(event) => showMenu(event, table)}>…</button></div>) : null}
            {typeOpen && type === "views" ? schema.views.map((view) => <div className="tree-object-row" key={view.key.name}><button type="button" key={view.key.name} className="tree-row tree-row-object" title={view.key.name}
              aria-current={preview?.key.schema === view.key.schema && preview.key.name === view.key.name ? "true" : undefined}
              onClick={() => showView(view)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{view.key.name}</span>
            </button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", { value0: view.key.schema, value1: view.key.name })} aria-haspopup="menu" aria-expanded={activeMenu?.object === view} onClick={(event) => showMenu(event, view)}>…</button></div>) : null}
            {typeOpen && type === "enums" ? schema.enums.map((item) => <div className="tree-object-row" key={item.key.name}><button type="button" className="tree-row tree-row-object" title={item.key.name} key={item.key.name}
              aria-current={enumPreview?.key.schema === item.key.schema && enumPreview.key.name === item.key.name ? "true" : undefined}
              onClick={() => showEnum(item)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{item.key.name}</span>
            </button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", { value0: item.key.schema, value1: item.key.name })} aria-haspopup="menu" aria-expanded={activeMenu?.object === item} onClick={(event) => showMenu(event, item)}>…</button></div>) : null}
          </div>;
        }) : null}
      </div>;
    })}
    {activeMenu ? <SchemaObjectMenu x={activeMenu.x} y={activeMenu.y} name={`${activeMenu.object.key.schema}.${activeMenu.object.key.name}`} actions={actions} onClose={closeMenu} /> : null}
  </section>;
}
