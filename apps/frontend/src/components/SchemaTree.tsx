import { SchemaIndexDetails } from "./SchemaIndexDetails";
import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { useCallback, useState, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform";
import type { EnumDefinition, ViewDefinition, ProgramDefinition } from "../platform/types";
import { ActionIcon } from "./ActionIcon";
import { OperationFeedback } from "./OperationFeedback";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "./SchemaObjectMenu";
import { useOperation } from "./use-operation";
import { TreeDisclosureIcon } from "./TreeDisclosureIcon";
import { ObjectDependencies, ProgramDetails } from "./SchemaProgramDetails";
import { SchemaEnumDetails } from "./SchemaEnumDetails";

interface SchemaTreeProps {
  snapshot: DatabaseSnapshot;
  navigation?: ReactNode;
  selectedTable?: TableDefinition;
  selectedObject?: ObjectKey;
  onCloseObject?: () => void;
  onOpenObject?: (key: ObjectKey) => void;
  onSelectTable: (table: TableDefinition) => void;
  onOpenQuery?: (table: TableDefinition) => void;
}

type OpenState = Record<string, boolean>;

type ObjectType = "tables" | "views" | "enums" | "functions" | "procedures" | "triggers";
type MenuObject = TableDefinition | ViewDefinition | EnumDefinition | ProgramDefinition;
type MenuTarget = { object: MenuObject; trigger: HTMLButtonElement; x: number; y: number; scope: string };

/** Filtering expands matches without changing the user's normal disclosure state. */
export function SchemaTree({ snapshot, selectedTable, onSelectTable, onOpenQuery, navigation, selectedObject, onOpenObject, onCloseObject }: SchemaTreeProps) {
  const { t: bt } = useI18n();
  const TYPE_LABEL = { tables: bt("business.tables"), views: bt("business.views"), enums: bt("business.enums"), functions: bt("objects.functions"), procedures: bt("objects.procedures"), triggers: bt("objects.triggers") } as const;
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
    return { ...schema, tables: schema.tables.filter((table) => matches(table.key)), views: schema.views.filter((view) => matches(view.key)), enums: schema.enums.filter(item => matches(item.key)), programs: (schema.programs ?? []).filter(item => matches(item.key)) };
  }).filter((schema) => !filtering || schema.tables.length + schema.views.length + schema.enums.length + schema.programs.length > 0);
  const totals = visible.reduce((sum, schema) => sum + schema.tables.length + schema.views.length + schema.enums.length + schema.programs.length, 0);
  const activeKey = selectedObject ?? previewKey;
  const openObject = (key: ObjectKey) => {
    if (onOpenObject && key.kind !== "enum") { setPreviewKey(undefined); onOpenObject(key); }
    else { onCloseObject?.(); setPreviewKey(key); }
  };
  const preview = activeKey?.kind === "view" ? snapshot.schemas.flatMap((schema) => schema.views).find((view) => view.key.schema === activeKey.schema && view.key.name === activeKey.name) : undefined;
  const enumPreview = activeKey?.kind === "enum" ? snapshot.schemas.flatMap((schema) => schema.enums).find((item) => item.key.schema === activeKey.schema && item.key.name === activeKey.name) : undefined;
  const programPreview = snapshot.schemas.flatMap(s => s.programs ?? []).find(p => p.key.kind === activeKey?.kind && p.key.schema === activeKey.schema && p.key.name === activeKey.name);
  if (previewKey && !preview && !enumPreview && !programPreview) setPreviewKey(undefined);
  const selectedId = selectedTable && !preview && !enumPreview && !programPreview ? `${selectedTable.key.schema}.${selectedTable.key.name}` : undefined;

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
  const showView = (view: ViewDefinition) => openObject(view.key);
  const showEnum = (item: EnumDefinition) => openObject(item.key);
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
      : "arguments" in activeMenu.object ? [{ label: bt("objects.showDetails"), run: () => openObject(activeMenu.object.key) }]
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
      <input type="search" aria-label={bt("objects.search")} placeholder={bt("objects.search")} value={search}
        onChange={(event) => { setSearch(event.target.value); setSearchOpen({}); setContext(undefined); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearch(""); setSearchOpen({}); } }} />
      {search ? <button type="button" aria-label={bt("business.clearObjectSearch")} onClick={() => { setSearch(""); setSearchOpen({}); }}>×</button> : null}
    </div>
    {filtering ? <p className="schema-search-count" role="status">{totals} {translateUiLabel(totals === 1 ? "match" : "matches", bt)}</p> : null}
    {filtering && !totals ? <p className="schema-search-empty">{bt("objects.empty")}</p> : null}
    {copy.state ? <OperationFeedback label={bt("business.objectNameCopy")} state={copy.state} onRetry={lastCopy ? () => copyName(lastCopy) : undefined} retryLabel={bt("business.retryNameCopy")} onDismiss={copy.dismiss} /> : null}
    {preview && !onOpenObject ? <section className="schema-object-preview schema-view-preview" aria-label={bt("business.definitionOf", { value0: preview.key.schema, value1: preview.key.name })} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePreview(event); } }}>
      <header><strong>{preview.materialized ? bt("business.materializedView") : bt("business.view")} · {preview.key.schema}.{preview.key.name}</strong><button type="button" aria-label={bt("business.closeViewDefinition")} onClick={closePreview}>×</button></header>
      <p>{bt("business.readOnlyDefinitionViewsAreNotDrawnInDiagram")}</p>
      {preview.comment ? <p>{preview.comment}</p> : null}
      <pre tabIndex={0}>{preview.definition || bt("business.definitionIsNotAvailableInThisSnapshot")}</pre>
      <SchemaIndexDetails indexes={preview.indexes ?? []} />
      <ObjectDependencies snapshot={snapshot} objectKey={preview.key} onSelect={key => setPreviewKey(key)} onSelectTable={chooseTable} />
    </section> : null}
    {programPreview && !onOpenObject ? <ProgramDetails snapshot={snapshot} program={programPreview} onClose={closePreview} onSelect={setPreviewKey} onSelectTable={chooseTable} /> : null}
    {enumPreview ? <SchemaEnumDetails snapshot={snapshot} item={enumPreview} onLocate={onSelectTable} onClose={closePreview} /> : null}
    {visible.map((schema) => {
      const schemaOpen = expanded(schema.name);
      const counts: Record<ObjectType, number> = { tables: schema.tables.length, views: schema.views.length, enums: schema.enums.length, functions: schema.programs.filter(p => p.key.kind === "function").length, procedures: schema.programs.filter(p => p.key.kind === "procedure").length, triggers: schema.programs.filter(p => p.key.kind === "trigger").length };
      return <div className="tree-node" key={schema.name}>
        <button type="button" className="tree-row tree-row-schema" title={schema.name} aria-expanded={schemaOpen} onClick={() => toggle(schema.name)}>
          <TreeDisclosureIcon open={schemaOpen} /><span className="tree-label">{schema.name}</span><small>{Object.values(counts).reduce((a,b) => a+b,0)}</small>
        </button>
        {schemaOpen ? (Object.keys(TYPE_LABEL) as ObjectType[]).filter((type) => counts[type] > 0).map((type) => {
          const key = `${schema.name}:${type}`; const typeOpen = expanded(key); const count = counts[type];
          return <div className="tree-node tree-node-type" key={key}>
            <button type="button" className="tree-row tree-row-type" aria-expanded={typeOpen} disabled={count === 0} onClick={() => toggle(key)}>
              <TreeDisclosureIcon open={typeOpen} /><ActionIcon name={type === "tables" ? "table" : type === "views" ? "copy" : "list"} /><span className="tree-label">{TYPE_LABEL[type]}</span><small>{count}</small>
            </button>
            {typeOpen && ["functions", "procedures", "triggers"].includes(type) ? schema.programs.filter(p => `${p.key.kind}s` === type).map(program => <div className="tree-object-row" key={program.key.name}><button type="button" className="tree-row tree-row-object" title={program.key.name} aria-current={program === programPreview ? "true" : undefined} onClick={() => openObject(program.key)}><span className="tree-label">{program.key.name}</span></button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", {value0:program.key.schema,value1:program.key.name})} aria-haspopup="menu" aria-expanded={activeMenu?.object === program} onClick={event => showMenu(event,program)}><ActionIcon name="more" /></button></div>) : null}
            {typeOpen && type === "tables" ? schema.tables.map((table) => <div className="tree-object-row" key={table.key.name}><button type="button" key={table.key.name} className="tree-row tree-row-object" title={table.key.name}
              aria-current={`${schema.name}.${table.key.name}` === selectedId ? "true" : undefined}
              onClick={() => chooseTable(table)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{table.key.name}</span><small>{table.columns.length}</small>
            </button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", { value0: table.key.schema, value1: table.key.name })} aria-haspopup="menu" aria-expanded={activeMenu?.object === table} onClick={(event) => showMenu(event, table)}><ActionIcon name="more" /></button></div>) : null}
            {typeOpen && type === "views" ? schema.views.map((view) => <div className="tree-object-row" key={view.key.name}><button type="button" key={view.key.name} className="tree-row tree-row-object" title={view.key.name}
              aria-current={preview?.key.schema === view.key.schema && preview.key.name === view.key.name ? "true" : undefined}
              onClick={() => showView(view)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{view.key.name}</span>{view.materialized ? <small>{bt("business.materializedView")}</small> : null}
            </button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", { value0: view.key.schema, value1: view.key.name })} aria-haspopup="menu" aria-expanded={activeMenu?.object === view} onClick={(event) => showMenu(event, view)}><ActionIcon name="more" /></button></div>) : null}
            {typeOpen && type === "enums" ? schema.enums.map((item) => <div className="tree-object-row" key={item.key.name}><button type="button" className="tree-row tree-row-object" title={item.key.name} key={item.key.name}
              aria-current={enumPreview?.key.schema === item.key.schema && enumPreview.key.name === item.key.name ? "true" : undefined}
              onClick={() => showEnum(item)} onDragStart={(event) => event.preventDefault()}>
              <span className="tree-label">{item.key.name}</span>
            </button><button type="button" className="tree-object-actions" aria-label={bt("business.actionsFor", { value0: item.key.schema, value1: item.key.name })} aria-haspopup="menu" aria-expanded={activeMenu?.object === item} onClick={(event) => showMenu(event, item)}><ActionIcon name="more" /></button></div>) : null}
          </div>;
        }) : null}
      </div>;
    })}
    {activeMenu ? <SchemaObjectMenu x={activeMenu.x} y={activeMenu.y} name={`${activeMenu.object.key.schema}.${activeMenu.object.key.name}`} actions={actions} onClose={closeMenu} /> : null}
  </section>;
}
