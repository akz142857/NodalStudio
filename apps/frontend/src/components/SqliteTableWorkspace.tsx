import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { DataColumnHeader } from "./DataColumnHeader";
import { TableDataSplit } from "./TableDataSplit";
import { TableFilterEditor } from "./TableFilterEditor";
import { TableDataPagination } from "./TableDataPagination";
import { TableDataFooter } from "./TableDataFooter";
import { IconButton } from "./IconButton";
import { useTableColumnWidths } from "./use-table-column-widths";
import { useTableFilter } from "./use-table-filter";
import { useTableSort } from "./use-table-sort";
import { useTablePagination } from "./use-table-pagination";
import { isDataRowMenuShortcut, useDataRowCopy, type DataRowMenuEvent } from "./use-data-row-copy";
import { sqliteRowStatements } from "./query/row-statements";
import { quoteIdentifier } from "./query/query-format";
import type { NodalStudioPlatform } from "../platform";
import type { ColumnDefinition } from "../platform/types";
import { sqliteTableSourceKey } from "../platform/sqlite-table";
import type { TableFilterSettings } from "../platform/table-data-filter";
import type { TableSort } from "../platform/table-data-preferences";
import type {
  SqliteCell, SqliteField, SqliteRowChange, SqliteRowIdentity, SqliteTableColumn, SqliteTableData,
  SqlitePageCursor, SqliteTableTarget, SqliteValue,
} from "../platform/sqlite-table";
import "./sqlite-table-workspace.css";

const CHANGE_LIMIT = 100;

interface PageStart {
  offset: number;
  cursor?: SqlitePageCursor;
}

type SourceRow = SqliteTableData["rows"][number];
type EditableRow = SourceRow & { identity: SqliteRowIdentity };
type Fields = Map<number, SqliteValue>;
type Draft =
  | { kind: "insert"; fields: Fields }
  | { kind: "update"; original: EditableRow; fields: Fields }
  | { kind: "delete"; original: EditableRow; previous?: Fields };

interface Batch {
  version: string;
  columns: SqliteTableColumn[];
  drafts: Map<string, Draft>;
}

interface EditorRow {
  id: string;
  number: number;
  original?: SourceRow;
}

function errorMessage(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
}

function valueText(value: SqliteCell | undefined, defaultText: string, unavailable: string) {
  if (!value) return defaultText;
  if (value.kind === "null") return "NULL";
  if (value.kind === "unavailable") return unavailable;
  return value.value;
}

function rowFields(draft: Draft | undefined) {
  return draft?.kind === "delete" ? draft.previous : draft?.fields;
}

function originalForDraft(draft: Draft | undefined) {
  return draft && draft.kind !== "insert" ? draft.original : undefined;
}

function equivalent(value: SqliteValue, original: SqliteCell | undefined) {
  return original !== undefined && value.kind === original.kind
    && (value.kind === "null" || ("value" in original && value.value === original.value));
}

function changesForSave(drafts: Map<string, Draft>): SqliteRowChange[] {
  return [...drafts.values()].map((draft) => {
    if (draft.kind === "delete") return { kind: "delete", identity: draft.original.identity };
    const fields: SqliteField[] = [...draft.fields].map(([column, value]) => ({ column, value }));
    return draft.kind === "insert" ? { kind: "insert", fields } : { kind: "update", identity: draft.original.identity, fields };
  });
}

export function SqliteTableWorkspace({ platform, target, binding, activeTable, pageVisible = true, modelColumns, onShowDdl, onRetainChange, panelWidth, onPanelWidthChange }: {
  platform: NodalStudioPlatform;
  target: SqliteTableTarget;
  binding: string;
  activeTable: boolean;
  pageVisible?: boolean;
  modelColumns?: readonly Pick<ColumnDefinition, "name" | "comment">[];
  onShowDdl?: () => void;
  onRetainChange?: (target: SqliteTableTarget, binding: string, retain: boolean) => void;
  panelWidth: number;
  onPanelWidthChange: (width: number) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const filterId = useId();
  const rowPanelId = useId();
  const pagination = useTablePagination<PageStart>(target.sourceId, "main", target.table);
  const { page, pageSize, start, confirm, scrollRef } = pagination;
  const [sort, setSort] = useTableSort(target.sourceId, "main", target.table);
  const columnWidths = useTableColumnWidths(target.sourceId, "main", target.table);
  const { filter, settings: filterSettings, changeFilter } = useTableFilter(target.sourceId, "main", target.table);
  const [filterOpen, setFilterOpen] = useState(false);
  const offset = start?.offset ?? (page - 1) * pageSize;
  const queryKey = [...sqliteTableSourceKey(target.sourceId, binding), target.table];
  const options = { offset, pageSize, ...(start?.cursor && { cursor: start.cursor }), sort, filter };
  const table = useQuery({
    queryKey: [...queryKey, page, options],
    queryFn: async () => ({ data: await platform.loadSqliteTable(target, options), offset, sort, page, pageSize }),
    placeholderData: keepPreviousData,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    gcTime: 0,
  });
  const [batch, setBatch] = useState<Batch>();
  const [discardedBatch, setDiscardedBatch] = useState<Batch>();
  const [showPending, setShowPending] = useState(false);
  const [rowPanel, setRowPanel] = useState<"details" | "edit">();
  const [selected, setSelected] = useState<string>();
  const [selectedColumn, setSelectedColumn] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number>();
  const [saveError, setSaveError] = useState<unknown>();
  const saveInProgress = useRef(false);
  const undoDiscardButton = useRef<HTMLButtonElement>(null);
  const retain = Boolean(batch || discardedBatch || saving);
  useLayoutEffect(() => {
    onRetainChange?.(target, binding, retain);
  }, [binding, onRetainChange, retain, target]);
  useLayoutEffect(() => {
    if (discardedBatch) undoDiscardButton.current?.focus();
  }, [discardedBatch]);

  const data = table.data?.data;
  const shownOffset = table.data?.offset ?? offset;
  const shownPage = table.data?.page ?? page;
  const shownSort = table.data?.sort;
  const drafts = batch?.drafts;
  const pendingCount = drafts?.size ?? 0;
  const pendingView = showPending && pendingCount > 0;
  useLayoutEffect(() => {
    if (activeTable && pageVisible && !pendingView && table.isSuccess && !table.isFetching && !table.isPlaceholderData) {
      return confirm(table.data.page, table.data.data.rows.length > 0);
    }
  }, [activeTable, confirm, pageVisible, pendingView, table.data, table.isFetching, table.isPlaceholderData, table.isSuccess]);
  const columns = pendingView ? batch?.columns : data?.columns;
  const comments = useMemo(() => new Map(modelColumns?.map(({ name, comment }) => [name, comment])), [modelColumns]);
  const rowCopy = useDataRowCopy(activeTable ? (pendingView ? batch : table.data) : undefined);
  const highlightedColumn = columns?.some((column) => column.name === selectedColumn) ? selectedColumn : undefined;
  const widths = columns?.map((column) => columnWidths.widths.get(column.name)
    ?? Math.min(260, Math.max(140, column.name.length * 8 + 50))) ?? [];
  const schemaChanged = Boolean(batch && data && batch.version !== data.version);
  const atLimit = pendingCount >= CHANGE_LIMIT;
  const editingReady = !saving && !schemaChanged && (pendingView || (Boolean(data) && !table.isFetching && !table.isError));

  const existing: EditorRow[] = (data?.rows ?? []).map((original, index) => {
    const id = original.identity ? `pk:${JSON.stringify(original.identity.key)}` : `readonly:${shownOffset}:${index}`;
    const staged = !schemaChanged ? originalForDraft(drafts?.get(id)) : undefined;
    return { id, number: shownOffset + index + 1, original: staged ?? original };
  });
  const pendingRows: EditorRow[] = [...(drafts ?? [])].map(([id, draft], index) => ({
    id, number: index + 1, original: originalForDraft(draft),
  }));
  const inserted = pendingRows.filter((row) => !row.original).map((row, index) => ({ ...row, number: index + 1 }));
  const rows = pendingView ? pendingRows : [...existing, ...inserted];
  const active = rows.find((row) => row.id === selected) ?? (rowPanel ? rows[0] : undefined);
  const editing = rowPanel === "edit";
  const showRowPanel = Boolean(rowPanel && active);
  const visibleDraft = (id: string) => pendingView || !schemaChanged ? drafts?.get(id) : undefined;
  const activeDraft = active && visibleDraft(active.id);
  const activeEditable = Boolean(active?.original?.identity || (active && !active.original))
    && (!atLimit || Boolean(activeDraft));

  function changeDraft(id: string, next?: Draft) {
    setDiscardedBatch(undefined);
    setSavedCount(undefined);
    setSaveError(undefined);
    if (!next && pendingCount === 1 && drafts?.has(id)) setShowPending(false);
    setBatch((current) => {
      const reference = current ?? data;
      if (!reference) return current;
      const updated = new Map(current?.drafts);
      if (next) updated.set(id, next);
      else updated.delete(id);
      return updated.size ? { version: reference.version, columns: reference.columns, drafts: updated } : undefined;
    });
  }

  function setCell(row: EditorRow, column: number, value: SqliteValue | undefined) {
    const fields = new Map(rowFields(drafts?.get(row.id)));
    if (value && !equivalent(value, row.original?.cells[column])) fields.set(column, value);
    else fields.delete(column);
    if (!row.original) changeDraft(row.id, { kind: "insert", fields });
    else if (row.original.identity) {
      const original = { ...row.original, identity: row.original.identity };
      changeDraft(row.id, fields.size ? { kind: "update", original, fields } : undefined);
    }
  }

  function addRow() {
    const id = crypto.randomUUID();
    changeDraft(id, { kind: "insert", fields: new Map() });
    setRowPanel("edit");
    selectRow(id);
  }

  function reload() {
    if (table.isError) {
      void table.refetch();
      return;
    }
    resetPosition({ keepScroll: true });
    if (page === 1) void table.refetch();
  }

  function toggleDelete(row: EditorRow) {
    if (!row.original) {
      changeDraft(row.id);
      return;
    }
    if (!row.original.identity) return;
    const draft = drafts?.get(row.id);
    const original = { ...row.original, identity: row.original.identity };
    if (draft?.kind === "delete") {
      changeDraft(row.id, draft.previous ? { kind: "update", original, fields: draft.previous } : undefined);
    } else {
      changeDraft(row.id, { kind: "delete", original, previous: draft?.fields });
    }
  }

  function discard() {
    setDiscardedBatch(batch);
    setBatch(undefined);
    setShowPending(false);
    setSaveError(undefined);
    setSavedCount(undefined);
  }

  function undoDiscard() {
    if (!discardedBatch) return;
    setBatch(discardedBatch);
    setDiscardedBatch(undefined);
    setShowPending(true);
  }

  function selectRow(id: string) {
    setSelected(id);
    setSelectedColumn(undefined);
  }

  function navigateRows(event: KeyboardEvent<HTMLTableRowElement>, index: number) {
    const { key } = event;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      selectRow(rows[index].id);
      return;
    }
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    event.preventDefault();
    const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : index + (key === "ArrowDown" ? 1 : -1);
    if (!rows[next]) return;
    selectRow(rows[next].id);
    event.currentTarget.closest("tbody")?.rows[next]?.focus();
  }

  function resetPosition(options?: { keepScroll?: boolean }) {
    pagination.reset(options);
    setSelected(undefined);
  }

  function applyFilter(next?: TableFilterSettings) {
    if (changeFilter(next)) resetPosition();
  }

  function changeSort(column: string, direction?: TableSort["direction"]) {
    resetPosition();
    setSort(direction ? { column, direction } : undefined);
  }

  async function save() {
    if (!batch || schemaChanged || table.isFetching || saveInProgress.current) return;
    saveInProgress.current = true;
    setSaving(true);
    setSaveError(undefined);
    setSavedCount(undefined);
    try {
      await platform.saveSqliteTable({ target, version: batch.version, changes: changesForSave(batch.drafts) });
    } catch (error) {
      setSaveError(error);
      saveInProgress.current = false;
      setSaving(false);
      return;
    }
    setSavedCount(batch.drafts.size);
    setBatch(undefined);
    setShowPending(false);
    resetPosition({ keepScroll: true });
    // Rebuild page boundaries after writes can change sort keys or membership.
    // When returning to page one, let the new query load it once.
    try {
      await queryClient.invalidateQueries({ queryKey, refetchType: offset > 0 ? "none" : "active" });
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }

  const rowLabel = (row: EditorRow) => t(row.original ? "tableData.row" : "tableData.newRow", { value0: row.number });
  const rowInspector = showRowPanel && active && columns && (pendingView || !table.isError) && (
    <section id={rowPanelId} className="table-data-fields inspector-surface" aria-label={t(editing ? "tableData.editor" : "tableData.rowDetails")}>
      <header>
        <h3>{rowLabel(active)}</h3>
        {editing && activeDraft?.kind === "update" && <button type="button" disabled={saving} onClick={() => changeDraft(active.id)}>{t("tableData.discardRow")}</button>}
      </header>
      <div className="table-data-field-list" key={active.id}>
        {editing && active.original && !active.original.identity && <p>{t("tableData.rowReadOnly")}</p>}
        {columns.map((column, index) => {
          const cell = rowFields(activeDraft)?.get(index) ?? active.original?.cells[index];
          const editable = editing && activeEditable && !column.generated && activeDraft?.kind !== "delete";
          if (!editable) {
            return (
              <div className="table-data-field table-data-value" key={column.name}>
                <strong>{column.name}<small>{column.declaredType}</small></strong>
                <div data-kind={cell?.kind}>{valueText(cell, t("tableData.default"), t("tableData.unavailable"))}</div>
              </div>
            );
          }
          const kind = cell?.kind === "integer" || cell?.kind === "real" ? cell.kind : "text";
          const fieldId = `${rowPanelId}-field-${index}`;
          const valueProps = {
            id: fieldId,
            value: cell && "value" in cell ? cell.value : "",
            placeholder: !cell ? t("tableData.default") : cell.kind === "null" ? "NULL" : undefined,
            disabled: !editingReady,
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setCell(active, index, { kind, value: event.target.value }),
          };
          return (
            <div className="table-data-field" key={column.name}>
              <label htmlFor={fieldId}>{column.name}</label>
              {column.primaryKey && <small>{t("tableData.primaryKey")}</small>}
              <div className="table-data-field-controls">
                {kind === "text" ? <textarea rows={1} {...valueProps} />
                  : <input type="text" inputMode={kind === "integer" ? "numeric" : "decimal"} {...valueProps} />}
                <select className="ds-select" aria-label={t("tableData.valueType", { value0: column.name })} value={cell?.kind ?? "default"} disabled={!editingReady}
                  onChange={(event) => {
                    const kind = event.target.value as SqliteValue["kind"] | "default";
                    setCell(active, index, kind === "default" ? undefined : kind === "null" ? { kind } : {
                      kind, value: cell && "value" in cell ? cell.value : kind === "text" ? "" : "0",
                    });
                  }}>
                  {!active.original && <option value="default">{t("tableData.default")}</option>}
                  <option value="text">{t("tableData.text")}</option>
                  <option value="integer">{t("tableData.integer")}</option>
                  <option value="real">{t("tableData.real")}</option>
                  <option value="null">NULL</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );

  return (
    <section className="table-data-workspace ds-surface" aria-label={t("tableData.workspace")}>
      <header className="table-data-toolbar">
        <div className="table-data-heading">
          <h2 title={target.table}>{target.table}</h2>
          <span className="table-data-mode" data-mode={editing ? "write" : "read"} title={t(editing ? "tableData.writeModeHint" : "tableData.readModeHint")}>
            {t(editing ? "tableData.writeMode" : "tableData.readMode")}
          </span>
        </div>
        <div className="table-data-actions table-data-controls">
          <button type="button" aria-expanded={!pendingView && filterOpen} aria-controls={filterId} disabled={pendingView || saving}
            data-filter-active={Boolean(filter)} onClick={() => setFilterOpen(!filterOpen)}>
            {filter ? t("tableData.filterCount", { value0: filter.rules.length }) : t("tableData.filters")}
          </button>
          {onShowDdl && <button type="button" onClick={onShowDdl}>{t("tableDdl.view")}</button>}
          {!editing && <button type="button" aria-expanded={rowPanel === "details" && showRowPanel} aria-controls={rowPanelId} disabled={!rows.length}
            onClick={() => setRowPanel(rowPanel === "details" ? undefined : "details")}>{t("tableData.rowDetails")}</button>}
          <button type="button" onClick={() => setRowPanel(editing ? undefined : "edit")} disabled={saving || (!editing && !editingReady)}>
            {t(editing ? "tableData.doneEditing" : "tableData.editData")}
          </button>
        </div>
      </header>

      {activeTable && <TableFilterEditor id={filterId} columns={(data?.columns ?? modelColumns ?? []).map(({ name }) => name)}
        hidden={pendingView || !filterOpen} applied={filterSettings} busy={table.isFetching} failed={table.isError}
        disabled={saving || pendingView} onChange={applyFilter} />}

      {table.isFetching && !saving && !pendingView && <p role="status">{t(table.isPlaceholderData ? "tableData.updating" : "tableData.loading")}</p>}
      {savedCount !== undefined && <p role="status">{t("tableData.saved", { value0: savedCount })}</p>}
      {table.isError && <div className="table-data-feedback"><p role="alert">{t("tableData.loadFailed")} {errorMessage(table.error)}</p>
        {!pendingView && sort && <button type="button" onClick={() => changeSort(sort.column)} disabled={saving}>{t("tableData.clearSort")}</button>}
      </div>}
      {saveError !== undefined && <p role="alert">{t("tableData.saveFailed")} {errorMessage(saveError)}</p>}
      {schemaChanged && <p role="alert">{t("tableData.schemaChanged")}</p>}
      {atLimit && <p role="status">{t("tableData.changeLimit")}</p>}
      {rowCopy.error && <p role="alert">{rowCopy.error}</p>}
      {rowCopy.overlay}

      <TableDataSplit inspectorId={rowPanelId} inspector={rowInspector} preferredWidth={panelWidth} onWidthChange={onPanelWidthChange}>
        {columns && (pendingView || !table.isError) && (
          <div ref={scrollRef} className="table-data-grid" tabIndex={0} role="region" aria-busy={!pendingView && (saving || table.isFetching)} aria-label={t("tableData.rows")}>
            <table style={{ width: widths.reduce((total, width) => total + width, 0) }}>
              <colgroup>{columns.map((column, index) => <col key={column.name} style={{ width: widths[index] }} />)}</colgroup>
              <thead><tr>
                {columns.map((column, index) => <DataColumnHeader key={column.name} name={column.name} databaseType={column.declaredType}
                  comment={comments.get(column.name)}
                  width={widths[index]} onResize={(width) => columnWidths.resize(column.name, width)}
                  onResizeCommit={(width) => columnWidths.save(column.name, width)}
                  selected={highlightedColumn === column.name}
                  onSelect={() => setSelectedColumn((current) => current === column.name ? undefined : column.name)}
                  direction={!pendingView && shownSort?.column === column.name ? shownSort.direction : undefined} canClearSort={sort?.column === column.name}
                  sortDisabled={saving} onSort={pendingView ? undefined : (direction) => changeSort(column.name, direction)} />)}
              </tr></thead>
              <tbody>
                {rows.map((row, index) => {
                  const draft = visibleDraft(row.id);
                  const fields = rowFields(draft);
                  const cellAt = (index: number) => fields?.get(index) ?? row.original?.cells[index];
                  const draftStatus = draft && t(`tableData.state.${draft.kind}`);
                  const rowSelected = active?.id === row.id && (showRowPanel || highlightedColumn === undefined);
                  const openCopyMenu = (event: DataRowMenuEvent) => {
                    selectRow(row.id);
                    rowCopy.open(event, rowLabel(row), columns.map(({ name }) => name),
                      columns.map((_, columnIndex) => valueText(cellAt(columnIndex), t("tableData.default"), t("tableData.unavailable"))),
                      sqliteRowStatements(target.table, columns, row.original, fields, draft?.kind === "delete"));
                  };
                  return (
                    <tr key={row.id} aria-label={rowLabel(row)} aria-description={draftStatus} aria-selected={rowSelected}
                      aria-keyshortcuts="Shift+F10" onContextMenu={openCopyMenu}
                      data-selected={rowSelected || undefined} data-change={draft?.kind} tabIndex={(active?.id ?? rows[0]?.id) === row.id ? 0 : -1}
                      onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        selectRow(row.id);
                      }} onKeyDown={(event) => {
                        if (isDataRowMenuShortcut(event)) openCopyMenu(event);
                        else navigateRows(event, index);
                      }}>
                      {columns.map((column, index) => {
                        const cell = cellAt(index);
                        const text = valueText(cell, t("tableData.default"), t("tableData.unavailable"));
                        return <td key={column.name} data-kind={cell?.kind} data-column-selected={highlightedColumn === column.name || undefined} title={text}>
                          <span className="table-data-cell-value">{text}</span>
                          {index === 0 && draftStatus && <small className="table-data-row-status" aria-hidden="true">{draftStatus}</small>}
                        </td>;
                      })}
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={Math.max(1, columns.length)}>
                  {t(shownPage > 1 ? "tableData.emptyPage" : filter ? "tableData.noMatches" : "tableData.empty")}
                </td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </TableDataSplit>
      <TableDataFooter statement={!pendingView && data?.statement ? {
        sql: data.statement, sqlite: true, preview: `SELECT … FROM main.${quoteIdentifier(target.table, "sqlite")}`,
      } : undefined} actions={<>
        <IconButton icon="add" label={t("tableData.addRow")} onClick={addRow} disabled={!editingReady || atLimit} />
        <IconButton icon={activeDraft?.kind === "delete" ? "undo" : "remove"}
          label={t(activeDraft?.kind === "delete" ? "tableData.undoDelete" : active && !active.original ? "tableData.removeNew" : "tableData.deleteRow")}
          disabled={!editingReady || !activeEditable || (!selected && !editing)} onClick={() => { if (active) toggleDelete(active); }} />
        <IconButton icon="refresh" label={t(table.isError ? "tableData.retry" : "tableData.reload")} onClick={reload} disabled={saving || table.isFetching} />
        {pendingCount > 0 ? <>
          <IconButton icon="check" label={t(saving ? "tableData.saving" : "tableData.save")} onClick={() => void save()}
            disabled={saving || table.isFetching || schemaChanged} className="table-data-footer-save" />
          <IconButton icon="close" label={t("tableData.discard")} onClick={discard} disabled={saving} />
          <button type="button" className="ds-button" data-variant="ghost" aria-label={t("tableData.pendingOnly")}
            aria-pressed={pendingView} disabled={saving} onClick={() => setShowPending(!pendingView)}>
            <span role="status">{t("tableData.pending", { value0: pendingCount })}</span>
          </button>
        </> : discardedBatch ? <>
          <span className="visually-hidden" role="status">{t("tableData.discarded")}</span>
          <button key="undo-discard" ref={undoDiscardButton} type="button" className="ds-button" data-variant="ghost" onClick={undoDiscard}>{t("tableData.undoDiscard")}</button>
        </> : null}
      </>}>
        {!pendingView && <TableDataPagination page={shownPage} pageSize={pageSize} busy={saving || table.isFetching}
          canNext={!table.isError && data?.nextOffset != null}
          lastPage={{ scope: JSON.stringify([filter, sort, page, pageSize]), available: activeTable && pageVisible && !table.isError && Boolean(data),
            count: () => platform.countSqliteTableRows(target, filter),
            goTo: (destination) => {
              pagination.goToCountedPage(destination);
              setSelected(undefined);
            },
          }}
          onPageSizeChange={(size) => {
            pagination.changePageSize(size);
            setSelected(undefined);
          }} onJump={(destination) => {
            pagination.goTo(destination);
            setSelected(undefined);
          }} onPrevious={() => {
            pagination.goTo(shownPage - 1);
            setSelected(undefined);
          }} onNext={() => {
            if (data?.nextOffset == null) return;
            pagination.next({ offset: data.nextOffset, cursor: data.nextCursor });
            setSelected(undefined);
          }} />}
      </TableDataFooter>
    </section>
  );
}
