import { SchemaIndexDetails } from "./SchemaIndexDetails";
import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { memo, useCallback, useMemo, useState, type MouseEvent, type KeyboardEvent, type ReactNode, type CSSProperties } from "react";
import type { DatabaseSnapshot, ObjectKey, TableDefinition } from "../platform";
import type { EnumDefinition, ViewDefinition, ProgramDefinition, SchemaDefinition } from "../platform/types";
import { ActionIcon, type ActionIconName } from "./ActionIcon";
import { OperationFeedback } from "./OperationFeedback";
import { SchemaObjectMenu, type SchemaObjectMenuAction } from "./SchemaObjectMenu";
import { useOperation } from "./use-operation";
import { TreeDisclosureIcon } from "./TreeDisclosureIcon";
import { ObjectDependencies, ProgramDetails } from "./SchemaProgramDetails";
import { SchemaEnumDetails } from "./SchemaEnumDetails";
import { findDocumentObject } from "./object-document-model";

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
const OBJECT_TYPE_ICONS: Record<ObjectType, ActionIconName> = {
  tables: "table", views: "copy", enums: "list",
  functions: "function", procedures: "procedure", triggers: "trigger",
};
type SchemaObject = TableDefinition | ViewDefinition | EnumDefinition | ProgramDefinition;
type MenuTarget = { object: SchemaObject; trigger: HTMLButtonElement; x: number; y: number; scope: string };
type RowEvent = MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>;
type ObjectGroup = { type: ObjectType; objects: readonly SchemaObject[] };

const OBJECT_TYPES: Partial<Record<ObjectKey["kind"], ObjectType>> = {
  table: "tables", view: "views", enum: "enums", function: "functions", procedure: "procedures", trigger: "triggers",
};

function schemaGroups(schema: SchemaDefinition): ObjectGroup[] {
  const functions: ProgramDefinition[] = [];
  const procedures: ProgramDefinition[] = [];
  const triggers: ProgramDefinition[] = [];
  for (const program of schema.programs ?? []) {
    if (program.key.kind === "function") functions.push(program);
    if (program.key.kind === "procedure") procedures.push(program);
    if (program.key.kind === "trigger") triggers.push(program);
  }
  const groups: ObjectGroup[] = [
    { type: "tables", objects: schema.tables },
    { type: "views", objects: schema.views },
    { type: "enums", objects: schema.enums },
    { type: "functions", objects: functions },
    { type: "procedures", objects: procedures },
    { type: "triggers", objects: triggers },
  ];
  return groups.filter(({ objects }) => objects.length > 0);
}

const SchemaObjectRows = memo(function SchemaObjectRows({ objects, selectedName, selectedProgram, menuObject, onSelectTable, onOpenObject, onShowMenu }: {
  objects: readonly SchemaObject[];
  selectedName?: string;
  selectedProgram?: ProgramDefinition;
  menuObject?: SchemaObject;
  onSelectTable: (table: TableDefinition) => void;
  onOpenObject: (key: ObjectKey) => void;
  onShowMenu: (event: RowEvent, object: SchemaObject) => void;
}) {
  const { t } = useI18n();
  const rows = objects.map((object) => {
    const { schema, name } = object.key;
    const table = "columns" in object ? object : undefined;
    const selected = "arguments" in object ? selectedProgram === object : name === selectedName;
    return <div className="tree-object-row" key={name}>
      <button type="button" className="tree-row tree-row-object" title={name}
        aria-current={selected ? "true" : undefined}
        onClick={() => table ? onSelectTable(table) : onOpenObject(object.key)}
        onDragStart={"arguments" in object ? undefined : (event) => event.preventDefault()}>
        <span className="tree-label">{name}</span>
        {table ? <small>{table.columns.length}</small> : "materialized" in object && object.materialized ? <small>{t("business.materializedView")}</small> : null}
      </button>
      <button type="button" className="tree-object-actions"
        aria-label={t("business.actionsFor", { value0: schema, value1: name })}
        aria-haspopup="menu" aria-expanded={menuObject === object} onClick={(event) => onShowMenu(event, object)}><ActionIcon name="more" /></button>
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
  // Disclosure and menu state share the same groups until the model or filter changes.
  const catalog = useMemo(() => snapshot.schemas.map((schema) => {
    const groups = schemaGroups(schema);
    return { name: schema.name, groups, count: groups.reduce((total, group) => total + group.objects.length, 0) };
  }), [snapshot.schemas]);
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
  const totals = filtering ? visible.reduce((sum, schema) => sum + schema.count, 0) : 0;
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
  const selectedKey = (activeObject ?? selectedTable)?.key;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setContext(undefined);
    if (restoreFocus && context?.trigger.isConnected) context.trigger.focus();
  }, [context]);
  const showMenu = useCallback((event: RowEvent, object: SchemaObject) => {
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
  const actions: SchemaObjectMenuAction[] = menuObject ? [
      ...("columns" in menuObject ? [
        { label: bt("business.locateInDiagram"), run: () => chooseTable(menuObject) },
        ...(onOpenQuery ? [{ label: bt("business.openReadOnlyQuery"), run: () => onOpenQuery(menuObject) }] : []),
      ] : "values" in menuObject ? [{ label: bt("business.showEnumDetails"), run: () => openObject(menuObject.key) }]
        : "arguments" in menuObject ? [{ label: bt("objects.showDetails"), run: () => openObject(menuObject.key) }]
        : [{ label: bt("business.showViewDefinition"), run: () => openObject(menuObject.key) }]),
      { label: bt("business.copyQualifiedName"), run: () => copyName(menuObject.key) },
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
    {visible.map(({ name, groups, count }) => {
      const schemaOpen = expanded(name);
      return <div className="tree-node" key={name}>
        <button type="button" className="tree-row tree-row-schema" title={name} aria-expanded={schemaOpen} onClick={() => toggle(name)}>
          <TreeDisclosureIcon open={schemaOpen} /><span className="tree-label">{name}</span><small>{count}</small>
        </button>
        {schemaOpen ? groups.map(({ type, objects }) => {
          const key = `${name}:${type}`;
          const typeOpen = expanded(key);
          const selectedName = selectedKey?.schema === name && OBJECT_TYPES[selectedKey.kind] === type ? selectedKey.name : undefined;
          const selectedProgram = selectedName !== undefined ? programPreview : undefined;
          const groupMenu = menuObject && menuObject.key.schema === name && OBJECT_TYPES[menuObject.key.kind] === type
            ? menuObject : undefined;
          return <div className="tree-node tree-node-type" key={key}>
            <button type="button" className="tree-row tree-row-type" aria-expanded={typeOpen} onClick={() => toggle(key)}>
              <TreeDisclosureIcon open={typeOpen} /><ActionIcon name={OBJECT_TYPE_ICONS[type]} /><span className="tree-label">{TYPE_LABEL[type]}</span><small>{objects.length}</small>
            </button>
            {typeOpen ? <SchemaObjectRows objects={objects} selectedName={selectedName} selectedProgram={selectedProgram} menuObject={groupMenu}
              onSelectTable={chooseTable} onOpenObject={openObject} onShowMenu={showMenu} /> : null}
          </div>;
        }) : null}
      </div>;
    })}
    {activeMenu ? <SchemaObjectMenu x={activeMenu.x} y={activeMenu.y}
      name={`${activeMenu.object.key.schema}.${activeMenu.object.key.name}`} actions={actions} onClose={closeMenu} /> : null}
  </section>;
}
