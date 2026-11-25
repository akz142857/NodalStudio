import { SchemaIndexDetails } from "./SchemaIndexDetails";
import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { memo, useCallback, useContext, useId, useMemo, useState, type MouseEvent, type KeyboardEvent, type ReactNode, type CSSProperties } from "react";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform";
import type { EnumDefinition, ViewDefinition, ProgramDefinition, SchemaDefinition } from "../platform/types";
import { ActionIcon, type ActionIconName } from "./ActionIcon";
import { OperationFeedback } from "./OperationFeedback";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "./SchemaObjectMenu";
import { useOperation } from "./use-operation";
import { TreeDisclosureIcon } from "./TreeDisclosureIcon";
import { ObjectDependencies, ProgramDetails } from "./SchemaProgramDetails";
import { SchemaEnumDetails } from "./SchemaEnumDetails";
import { dumpSqlMenu } from "./database-export-menu";
import { ConnectionSourceContext } from "./connection-source-context";
import { findDocumentObject } from "./object-document-model";
import { tableRowCountKey } from "../platform/table-row-counts";
import type { TableRowCounts } from "./use-table-row-counts";
import type { SavedQuery } from "./query/saved-queries";
import type { DumpMode } from "../platform/database-export";

interface SchemaTreeProps {
  snapshot: DatabaseSnapshot;
  navigation?: ReactNode;
  databaseMode?: boolean;
  queriesBeforeObjects?: boolean;
  savedQueries?: readonly SavedQuery[];
  onOpenSavedQuery?: (query: SavedQuery) => void;
  onNewQuery?: () => void;
  onDeleteSavedQuery?: (query: SavedQuery) => void;
  selectedTable?: TableDefinition;
  rowCounts?: TableRowCounts;
  selectedObject?: ObjectKey;
  onCloseObject?: () => void;
  onOpenObject?: (key: ObjectKey) => void;
  onSelectTable: (table: TableDefinition) => void;
  onOpenTable?: (table: TableDefinition) => void;
  onOpenView?: (view: ViewDefinition) => void;
  onShowDefinition?: (key: ObjectKey) => void;
  onExportTable?: (table: TableDefinition) => void;
  onDumpSchema?: (schema: string, mode: DumpMode) => void;
  onOpenQuery?: (table: TableDefinition) => void;
}

type OpenState = Record<string, boolean>;

type ObjectType = "tables" | "views" | "materializedViews" | "enums" | "functions" | "procedures" | "triggers" | "events";
const OBJECT_TYPE_ICONS: Record<ObjectType, ActionIconName> = {
  tables: "table", views: "copy", materializedViews: "grid", enums: "list",
  functions: "function", procedures: "procedure", triggers: "trigger", events: "history",
};
type SchemaObject = TableDefinition | ViewDefinition | EnumDefinition | ProgramDefinition;
type MenuObject = string | SchemaObject;
type MenuTarget = { object: MenuObject; trigger: HTMLButtonElement; x: number; y: number; scope: string };
type RowEvent = MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>;
type ObjectGroup = { type: ObjectType; objects: readonly SchemaObject[] };

const OBJECT_TYPES: Partial<Record<ObjectKey["kind"], ObjectType>> = {
  table: "tables", view: "views", enum: "enums", function: "functions", procedure: "procedures", trigger: "triggers", event: "events",
};

function objectType(object: SchemaObject, databaseMode: boolean) {
  return databaseMode && "materialized" in object && object.materialized ? "materializedViews" : OBJECT_TYPES[object.key.kind];
}

function schemaGroups(schema: SchemaDefinition, dialect: DatabaseSnapshot["database"]["databaseType"], databaseMode: boolean): ObjectGroup[] {
  const programs = schema.programs ?? [];
  const groups: ObjectGroup[] = [
    { type: "tables", objects: schema.tables },
    { type: "views", objects: databaseMode ? schema.views.filter((view) => !view.materialized) : schema.views },
    { type: "materializedViews", objects: databaseMode ? schema.views.filter((view) => view.materialized) : [] },
    { type: "functions", objects: programs.filter(({ key }) => key.kind === "function") },
    { type: "procedures", objects: programs.filter(({ key }) => key.kind === "procedure") },
    { type: "events", objects: programs.filter(({ key }) => key.kind === "event") },
    { type: "enums", objects: schema.enums },
    { type: "triggers", objects: programs.filter(({ key }) => key.kind === "trigger") },
  ];
  return groups.filter(({ type, objects }) => objects.length > 0 || (databaseMode && (
    type === "tables" || type === "views" || (type === "functions" && dialect !== "sqlite")
    || (type === "materializedViews" && dialect === "postgreSql") || (type === "events" && dialect === "mySql")
  )));
}

const SchemaObjectRows = memo(function SchemaObjectRows({ objects, selectedName, selectedProgram, menuObject, rowCounts, onSelectTable, onOpenObject, onOpenView, onShowMenu, databaseMode }: {
  objects: readonly SchemaObject[];
  selectedName?: string;
  selectedProgram?: ProgramDefinition;
  menuObject?: SchemaObject;
  rowCounts?: TableRowCounts;
  onSelectTable: (table: TableDefinition) => void;
  onOpenObject: (key: ObjectKey) => void;
  onOpenView?: (view: ViewDefinition) => void;
  onShowMenu: (event: RowEvent, object: MenuObject) => void;
  databaseMode: boolean;
}) {
  const { t, locale } = useI18n();
  const formatCount = rowCounts && new Intl.NumberFormat(locale);
  const rows = objects.map((object) => {
    const { schema, name } = object.key;
    const table = "columns" in object ? object : undefined;
    const selected = "arguments" in object ? selectedProgram === object : name === selectedName;
    const countKey = table && rowCounts ? tableRowCountKey(table.key) : undefined;
    const count = countKey ? rowCounts?.values.get(countKey) : undefined;
    const countText = count && formatCount?.format(BigInt(count.count));
    const counting = countKey !== undefined && rowCounts?.pending === countKey;
    const countFailed = countKey !== undefined && rowCounts?.failed === countKey;
    const countHint = counting ? t("tableData.countingRows") : countFailed ? t("tableData.rowCountFailed")
      : countText === undefined ? undefined : t(count?.exact ? "tableData.lastRowCount" : "tableData.estimatedRowCount", {
        value0: countText, value1: t(count?.count === "1" ? "businessExtra.row" : "business.rows"),
      });
    const countLabel = table && rowCounts ? t("tableData.countTableRows", { value0: name }) : undefined;
    return <div className="tree-object-row" key={name}>
      <button type="button" className="tree-row tree-row-object" title={name}
        aria-current={selected ? "true" : undefined} aria-keyshortcuts={table ? "Shift+F10" : undefined}
        onClick={() => table ? onSelectTable(table) : onOpenView && "materialized" in object ? onOpenView(object) : onOpenObject(object.key)}
        onDragStart={"arguments" in object ? undefined : (event) => event.preventDefault()}
        onContextMenu={table ? (event) => onShowMenu(event, table) : undefined}
        onKeyDown={table ? (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) onShowMenu(event, table);
        } : undefined}>
        <span className="tree-label">{name}</span>
        {!databaseMode && "materialized" in object && object.materialized ? <small>{t("business.materializedView")}</small> : null}
      </button>
      {table && rowCounts && <button type="button" className="tree-row-count" aria-label={countLabel}
        aria-description={countHint} title={countHint ? `${countHint} · ${countLabel}` : countLabel} aria-busy={counting || undefined}
        data-failed={countFailed || undefined} disabled={rowCounts.busy} onClick={() => rowCounts.request(table.key)}>
        {counting ? "…" : countText === undefined ? (countFailed ? "!" : "—") : count?.exact ? countText : `≈${countText}`}
      </button>}
      {table ? null : <button type="button" className="tree-object-actions"
        aria-label={t("business.actionsFor", { value0: schema, value1: name })}
        aria-haspopup="menu" aria-expanded={menuObject === object} onClick={(event) => onShowMenu(event, object)}><ActionIcon name="more" /></button>}
    </div>;
  });
  // The first rows must paint with the branch disclosure. Only later chunks can
  // defer their layout until they approach the scroll viewport.
  const chunkSize = 32;
  if (rows.length <= chunkSize) return rows;
  return Array.from({ length: Math.ceil(rows.length / chunkSize) }, (_, index) => {
    const chunk = rows.slice(index * chunkSize, (index + 1) * chunkSize);
    return <div className="tree-object-chunk" key={index} data-deferred={index > 0 || undefined}
      style={{ "--object-chunk-rows": chunk.length } as CSSProperties}>{chunk}</div>;
  });
});

/** Filtering expands matches without changing the user's normal disclosure state. */
export function SchemaTree({ snapshot, databaseMode = false, queriesBeforeObjects = false, savedQueries, onOpenSavedQuery, onNewQuery, onDeleteSavedQuery, selectedTable, rowCounts, onSelectTable, onOpenTable, onOpenView, onShowDefinition, onExportTable, onDumpSchema, onOpenQuery, navigation, selectedObject, onOpenObject, onCloseObject }: SchemaTreeProps) {
  const { t: bt } = useI18n();
  const source = useContext(ConnectionSourceContext);
  const TYPE_LABEL = { tables: bt("business.tables"), views: bt("business.views"), materializedViews: bt("objects.materializedViews"), enums: bt("business.enums"), functions: bt("objects.functions"), procedures: bt("objects.procedures"), triggers: bt("objects.triggers"), events: bt("objects.events") } as const;
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
  const expanded = (key: string, filtered = filtering) => filtered ? (searchOpen[key] ?? true) : (effectiveOpen[key] ?? false);
  const toggle = (key: string, filtered = filtering) => {
    if (filtered) setSearchOpen((current) => ({ ...current, [key]: !(current[key] ?? true) }));
    else setOpen((current) => ({ ...current, [key]: !current[key] }));
  };
  // Disclosure and menu state share the same groups until the model or filter changes.
  const catalog = useMemo(() => snapshot.schemas.map((schema) => {
    const groups = schemaGroups(schema, snapshot.database.databaseType, databaseMode);
    return { name: schema.name, groups, count: groups.reduce((total, group) => total + group.objects.length, 0) };
  }), [snapshot.schemas, snapshot.database.databaseType, databaseMode]);
  const visible = useMemo(() => {
    if (!normalized) return catalog;
    const terms = normalized.split(/\s+/);
    return catalog.flatMap(({ name, groups }) => {
      const matches = groups.flatMap(({ type, objects }) => {
        const filtered = objects.filter(({ key }) => {
          const qualified = `${key.schema}.${key.name}`.toLocaleLowerCase();
          return terms.every((term) => qualified.includes(term));
        });
        return filtered.length ? [{ type, objects: filtered }] : [];
      });
      return matches.length ? [{ name, groups: matches, count: matches.reduce((total, group) => total + group.objects.length, 0) }] : [];
    });
  }, [catalog, normalized]);
  const queryFiltering = filtering && !queriesBeforeObjects;
  const visibleQueries = queryFiltering ? savedQueries?.filter(({ name }) => normalized.split(/\s+/).every((term) => name.toLocaleLowerCase().includes(term))) : savedQueries;
  const savedQueryListId = useId();
  const queriesExpanded = expanded(":savedQueries", queryFiltering);
  const totals = filtering ? visible.reduce((sum, schema) => sum + schema.count, 0) + (queryFiltering ? visibleQueries?.length ?? 0 : 0) : 0;
  const activeKey = selectedObject ?? previewKey;
  const openObject = useCallback((key: ObjectKey) => {
    if (onOpenObject && key.kind !== "enum") { setPreviewKey(undefined); onOpenObject(key); }
    else { onCloseObject?.(); setPreviewKey(key); }
  }, [onCloseObject, onOpenObject]);
  const activeObject = activeKey && findDocumentObject(snapshot, activeKey);
  const preview = activeObject && !("arguments" in activeObject) && !("values" in activeObject) ? activeObject : undefined;
  const enumPreview = activeObject && "values" in activeObject ? activeObject : undefined;
  const programPreview = activeObject && "arguments" in activeObject ? activeObject : undefined;
  if (previewKey && !activeObject) setPreviewKey(undefined);
  const selectedEntry = activeObject ?? selectedTable;
  const selectedKey = selectedEntry?.key;
  const selectedType = selectedEntry && objectType(selectedEntry, databaseMode);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setContext(undefined);
    if (restoreFocus && context?.trigger.isConnected) context.trigger.focus();
  }, [context]);
  const showMenu = useCallback((event: RowEvent, object: MenuObject) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setContext({ object, trigger: event.currentTarget, scope: menuScope,
      x: pointer ? event.clientX : rect.left + 16, y: pointer ? event.clientY : rect.bottom });
  }, [menuScope]);
  const chooseTable = useCallback((table: TableDefinition) => { setPreviewKey(undefined); onSelectTable(table); }, [onSelectTable]);
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
  const menuObject = activeMenu?.object;
  const menuName = typeof menuObject === "string" ? menuObject : menuObject && `${menuObject.key.schema}.${menuObject.key.name}`;
  const actions: SchemaObjectMenuAction[] = typeof menuObject === "string"
    ? (onDumpSchema ? [dumpSqlMenu(bt, (mode) => onDumpSchema(menuObject, mode), Boolean(source?.security?.ssh))] : [])
    : menuObject ? [
      ...("columns" in menuObject ? [
        ...(onOpenTable ? [{ label: bt("databaseExport.openTable"), run: () => onOpenTable(menuObject) }] : []),
        ...(rowCounts ? [{ label: bt("tableData.countExactRows"), disabled: rowCounts.busy, run: () => rowCounts.request(menuObject.key) }] : []),
        ...(onExportTable && menuObject.tableKind !== "foreign"
          ? [{ label: bt("databaseExport.wizard"), run: () => onExportTable(menuObject) }] : []),
        { label: bt("business.locateInDiagram"), run: () => chooseTable(menuObject) },
        ...(onOpenQuery ? [{ label: bt("business.openReadOnlyQuery"), run: () => onOpenQuery(menuObject) }] : []),
      ] : "values" in menuObject ? [{ label: bt("business.showEnumDetails"), run: () => openObject(menuObject.key) }]
        : "arguments" in menuObject ? [{ label: bt("objects.showDetails"), run: () => openObject(menuObject.key) }]
        : [
          ...(onOpenView ? [{ label: bt("objects.openViewData"), run: () => onOpenView(menuObject) }] : []),
          { label: bt("business.showViewDefinition"), run: () => onShowDefinition ? onShowDefinition(menuObject.key) : openObject(menuObject.key) },
        ]),
      { label: bt("business.copyQualifiedName"), run: () => copyName(menuObject.key) },
    ] : [];

  const savedQuerySection = visibleQueries && (!queryFiltering || visibleQueries.length > 0) && <div className="saved-query-section" data-before-objects={queriesBeforeObjects || undefined}>
    <button type="button" className="tree-row saved-query-heading" aria-label={bt("savedQueries.count", { count: visibleQueries.length })}
      aria-expanded={queriesExpanded} aria-controls={savedQueryListId} onClick={() => toggle(":savedQueries", queryFiltering)}>
      <TreeDisclosureIcon open={queriesExpanded} /><ActionIcon name="codeDocument" /><span className="tree-label">{bt("savedQueries.label")}</span><small>{visibleQueries.length}</small>
    </button>
    <div id={savedQueryListId} hidden={!queriesExpanded} className="saved-query-list">
      {queriesExpanded && <>
        {visibleQueries.map((query) => <div key={query.id} className="saved-query-row">
          <button type="button" className="tree-row saved-query-item" onClick={() => onOpenSavedQuery?.(query)} title={query.name}><ActionIcon name="codeDocument" /><span className="tree-label">{query.name}</span></button>
          {onDeleteSavedQuery && <button type="button" className="saved-query-delete" aria-label={bt("savedQueries.delete", { value0: query.name })}
            title={bt("savedQueries.delete", { value0: query.name })} onClick={() => onDeleteSavedQuery(query)}><ActionIcon name="trash" /></button>}
        </div>)}
        {!queryFiltering && onNewQuery && <button type="button" className="tree-row saved-query-new" onClick={onNewQuery}><ActionIcon name="add" />{bt("savedQueries.new")}</button>}
      </>}
    </div>
  </div>;

  return <section className="schema-tree" aria-label={bt("business.databaseStructure")} onContextMenu={(event) => {
    event.preventDefault();
  }}>
    {navigation}
    {queriesBeforeObjects && savedQuerySection}
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
    {visible.map(({ name, groups, count }) => {
      const schemaOpen = expanded(name);
      return <div className="tree-node" key={name}>
        <button type="button" className="tree-row tree-row-schema" title={name} aria-expanded={schemaOpen} onClick={() => toggle(name)}
          onContextMenu={onDumpSchema ? (event) => showMenu(event, name) : undefined}
          onKeyDown={(event) => {
            if (onDumpSchema && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) showMenu(event, name);
          }}>
          <TreeDisclosureIcon open={schemaOpen} /><span className="tree-label">{name}</span><small>{count}</small>
        </button>
        {schemaOpen ? groups.map(({ type, objects }) => {
          const key = `${name}:${type}`;
          const typeOpen = expanded(key);
          const selectedName = selectedKey?.schema === name && selectedType === type ? selectedKey.name : undefined;
          const selectedProgram = selectedName !== undefined ? programPreview : undefined;
          const groupMenu = menuObject && typeof menuObject !== "string" && menuObject.key.schema === name && objectType(menuObject, databaseMode) === type
            ? menuObject : undefined;
          return <div className="tree-node tree-node-type" key={key}>
            <button type="button" className="tree-row tree-row-type" aria-expanded={typeOpen} onClick={() => toggle(key)}>
              <TreeDisclosureIcon open={typeOpen} /><ActionIcon name={OBJECT_TYPE_ICONS[type]} /><span className="tree-label">{TYPE_LABEL[type]}</span><small>{objects.length}</small>
            </button>
            {typeOpen ? objects.length > 0 ? <SchemaObjectRows objects={objects} selectedName={selectedName} selectedProgram={selectedProgram} menuObject={groupMenu}
              rowCounts={type === "tables" ? rowCounts : undefined} onSelectTable={chooseTable} onOpenObject={openObject} onOpenView={onOpenView} onShowMenu={showMenu} databaseMode={databaseMode} />
              : <p className="tree-group-empty">{bt("objects.emptyGroup")}</p> : null}
          </div>;
        }) : null}
      </div>;
    })}
    {!queriesBeforeObjects && savedQuerySection}
    {activeMenu && menuName && actions.length > 0 ? <SchemaObjectMenu key={JSON.stringify(typeof menuObject === "string" ? menuObject : menuObject?.key)}
      x={activeMenu.x} y={activeMenu.y} name={menuName} actions={actions} onClose={closeMenu} /> : null}
  </section>;
}
