import { EmptyState } from "../../design-system/EmptyState";
import { useI18n, useEventTranslator } from "../../i18n";
import type { NodalStudioPlatform, QueryExecutionResult } from "../../platform";
import type { TableSort } from "../../platform/table-data-preferences";
import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";

import { ColumnProfileDetails } from "./ColumnProfileDetails";
import { ResultExportDialog } from "./ResultExportDialog";
import { resultCellText, type ColumnProfile } from "./result-profile";
import { queryRowStatements, type StatementTable } from "./row-statements";
import "./query-result-tools.css";

import { ActionIcon } from "../ActionIcon";
import { DataColumnHeader } from "../DataColumnHeader";
import { isDataRowMenuShortcut, useDataRowCopy, type DataRowMenuEvent } from "../use-data-row-copy";
import type { useTableColumnWidths } from "../use-table-column-widths";

const PAGE_SIZE = 200;

function defaultColumnWidth(name: string, databaseType: string): number {
  const contentHint = /uuid|timestamp|json|text/i.test(databaseType) ? 220 : 130;
  return Math.max(contentHint, Math.min(280, Math.max(name.length, databaseType.length) * 9 + 32));
}

type ColumnSort = {
  applied?: TableSort;
  requested?: TableSort;
  onChange: (sort?: TableSort) => void;
};

export function QueryResultGrid({ result, platform, columnSort, columnComments, tableColumnWidths, statementTable, tablePage, scrollRef }: {
  result?: QueryExecutionResult;
  platform?: NodalStudioPlatform;
  columnSort?: ColumnSort;
  columnComments?: ReadonlyMap<string, string | null>;
  tableColumnWidths?: ReturnType<typeof useTableColumnWidths>;
  statementTable?: StatementTable;
  tablePage?: { rowOffset: number };
  scrollRef?: Ref<HTMLDivElement>;
}) {
  const { t: bt } = useI18n();
  const scope = columnSort ? "table-preview" : result?.queryId;
  const [layout, setLayout] = useState<{ scope?: string; widths: Record<number, number> }>({ scope, widths: {} });
  if (!result) return <EmptyState className="query-empty-state" icon={<ActionIcon name="grid" />} title={bt("business.yourResultsAppearHere")} description={bt("business.runAQueryToInspectItsResult")} />;
  const queryWidths = layout.scope === scope ? layout.widths : {};
  return <ResultGrid key={scope} result={result} platform={platform} columnSort={columnSort} columnComments={columnComments} statementTable={statementTable} scrollRef={scrollRef}
    tableRowOffset={tablePage?.rowOffset}
    columnWidths={result.columns.map(({ name }, index) => tableColumnWidths ? tableColumnWidths.widths.get(name) : queryWidths[index])}
    resizeColumn={(index, width) => {
      if (tableColumnWidths) tableColumnWidths.resize(result.columns[index].name, width);
      else setLayout((current) => ({ scope, widths: { ...(current.scope === scope ? current.widths : {}), [index]: width } }));
    }}
    saveColumnWidth={tableColumnWidths && ((index, width) => tableColumnWidths.save(result.columns[index].name, width))} />;
}
function ResultGrid({ result, platform, columnSort, columnComments, columnWidths, resizeColumn, saveColumnWidth, statementTable, tableRowOffset, scrollRef }: {
  result: QueryExecutionResult; platform?: NodalStudioPlatform; columnSort?: ColumnSort;
  columnComments?: ReadonlyMap<string, string | null>;
  columnWidths: (number | undefined)[]; resizeColumn: (column: number, width: number) => void;
  saveColumnWidth?: (column: number, width: number) => void;
  statementTable?: StatementTable;
  tableRowOffset?: number;
  scrollRef?: Ref<HTMLDivElement>;
}) {
  const { t: bt, formatNumber } = useI18n();
  const eventBt = useEventTranslator(bt);
  const [selected, setSelected] = useState<number[]>([]);
  const [highlightedColumn, setHighlightedColumn] = useState<string>();
  const [profiling, setProfiling] = useState(false);
  const [profiles, setProfiles] = useState<ColumnProfile[]>();
  const [profileError, setProfileError] = useState("");
  const [column, setColumn] = useState<number>();
  const profileTrigger = useRef<HTMLButtonElement>(null);
  const [exporting, setExporting] = useState(false);
  const rowCopy = useDataRowCopy(result.queryId);
  useEffect(() => {
    if (!profiling) return;
    const worker = new Worker(new URL("./result-profile.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{profiles?: ColumnProfile[]; error?: string}>) => { setProfiles(event.data.profiles); setProfileError(event.data.error ?? ""); };
    worker.onerror = () => setProfileError(eventBt("business.unableToProfileThisResultTurnProfileOffAnd"));
    worker.postMessage(result);
    return () => worker.terminate();
  }, [result, profiling, eventBt]);
  function selectRow(index: number, toggle: boolean, range: boolean) {
    setHighlightedColumn(undefined);
    setSelected((previous) => range && gridState.selectedRow !== null ? [...new Set([...previous, ...Array.from({ length: Math.abs(index-gridState.selectedRow)+1 }, (_,i) => Math.min(index,gridState.selectedRow!)+i)])].sort((a,b) => a-b) : toggle ? previous.includes(index) ? previous.filter((i) => i !== index) : [...previous,index].sort((a,b) => a-b) : [index]);
    setGridState((current) => ({ ...current, selectedRow: index }));
  }
  function copyRows() {
    void rowCopy.copy(JSON.stringify({ columns: result.columns, rows: selected.map((i) => result.rows[i].map(resultCellText)) }, null, 2));
  }
  const [gridState, setGridState] = useState<{ page: number; selectedRow: number | null }>({ page: 0, selectedRow: null });
  const [resultId, setResultId] = useState(result.queryId);
  if (resultId !== result.queryId) {
    setResultId(result.queryId);
    setGridState({ page: 0, selectedRow: null });
    setSelected([]);
    setProfiles(undefined);
    setProfileError("");
    setColumn(undefined);
    setExporting(false);
  }
  const page = gridState.page;
  const setPage = (update: (value: number) => number) => setGridState((current) => ({ ...current, page: update(current.page), selectedRow: null }));
  if (!result.columns.length) return <div className="query-empty-state">{bt("business.queryReturnedNoRows")}</div>;
  const pageCount = Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE));
  const visibleRows = result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const widths = result.columns.map((column, index) => columnWidths[index] ?? Math.max(profiling ? 220 : 0, defaultColumnWidth(column.name, column.databaseType)));
  const tableWidth = 88 + widths.reduce((total, width) => total + width, 0);
  function navigateRows(event: KeyboardEvent<HTMLTableRowElement>, index: number) {
    const { key } = event;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      selectRow(page * PAGE_SIZE + index, key === " ", event.shiftKey);
      return;
    }
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    event.preventDefault();
    const next = key === "Home" ? 0 : key === "End" ? visibleRows.length - 1 : index + (key === "ArrowDown" ? 1 : -1);
    if (!visibleRows[next]) return;
    selectRow(page * PAGE_SIZE + next, false, event.shiftKey);
    event.currentTarget.closest("tbody")?.rows[next]?.focus();
  }
  function openCopyMenu(event: DataRowMenuEvent, index: number) {
    if (!selected.includes(index)) selectRow(index, false, false);
    const row = result.rows[index];
    rowCopy.open(event, bt("tableData.row", { value0: (tableRowOffset ?? 0) + index + 1 }),
      result.columns.map(({ name }) => name), row.map(resultCellText),
      statementTable && queryRowStatements(statementTable, result.columns, row));
  }
  return (
    <div className="query-result-frame">
    <div className="query-result-tools" role="group" aria-label={bt("business.resultActions")}>
      <div className="query-result-context"><span className="query-result-count">{formatNumber(result.rows.length)} {result.rows.length === 1 ? bt("businessExtra.row") : bt("business.rows")}</span>{tableRowOffset !== undefined ? <span className="query-result-scope">{bt("tableData.currentPage")}</span> : !columnSort && <span className="query-result-scope">{bt("business.currentResultAllPages")}</span>}{result.truncated ? <span className="query-result-limit">{bt("business.resultLimitReached")}</span> : null}</div>
      <div className="query-result-actions">
        {selected.length ? <div className="query-selection-actions"><span aria-live="polite">{selected.length} {bt("businessExtra.selected")}</span><button type="button" aria-label={bt("business.copySelectedRows")} title={bt("business.copySelectedRowsAsJSONDisplayText")} onClick={copyRows}><ActionIcon name="copy" />{bt("business.copyDetail")}</button><button type="button" aria-label={bt("business.clearSelection")} onClick={() => setSelected([])}>{bt("business.clear")}</button></div> : null}
        <div className="query-standard-actions"><button type="button" aria-pressed={profiling} onClick={() => { setProfiling(!profiling); setColumn(undefined); setProfileError(""); }}><ActionIcon name="chart" />{bt("business.profile")}</button>
        <button type="button" disabled={!platform} onClick={() => setExporting(true)}><ActionIcon name="export" />{bt("business.export")}</button></div>
      </div>
    </div>
    {rowCopy.error ? <p className="result-inline-message" role="alert">{rowCopy.error}</p> : null}
    {rowCopy.overlay}
    {profiling ? <p className="result-profile-scope">{profileError || (profiles ? bt("business.profileBasedOnReturnedRowsNotTheFullDatabase", { value0: result.rows.length }) : bt("business.profilingReturnedRowsLocally"))}</p> : null}
    <div className="query-result-content">
    <div ref={scrollRef} className="query-result-scroll" role="region" aria-label={bt("business.queryResults")} tabIndex={0}>
      <table className="query-result-table" style={{ width: tableWidth, minWidth: tableWidth }}>
        <colgroup><col style={{ width: 88 }} />{widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
        <thead><tr><th className="query-row-heading" scope="col"><div className="query-row-selector"><input type="checkbox" aria-label={bt(tableRowOffset === undefined ? "business.selectAllReturnedRows" : "tableData.selectCurrentPage")} title={bt(tableRowOffset === undefined ? "business.selectAllReturnedRowsAcrossAllPages" : "tableData.selectCurrentPage")} disabled={!result.rows.length} checked={selected.length === result.rows.length && result.rows.length > 0} ref={(el) => { if (el) el.indeterminate = selected.length > 0 && selected.length < result.rows.length; }} onChange={() => setSelected(selected.length === result.rows.length ? [] : result.rows.map((_,i) => i))} /><span aria-label={bt("business.rowNumber")}>#</span></div></th>
          {result.columns.map((column, index) => <DataColumnHeader key={`${column.name}:${index}`} name={column.name} databaseType={column.databaseType}
            comment={columnComments?.get(column.name)}
            width={widths[index]} onResize={(width) => resizeColumn(index, width)}
            onResizeCommit={saveColumnWidth && ((width) => saveColumnWidth(index, width))}
            selected={highlightedColumn === column.name}
            onSelect={columnSort && (() => setHighlightedColumn((current) => current === column.name ? undefined : column.name))}
            direction={columnSort?.applied?.column === column.name ? columnSort.applied.direction : undefined}
            canClearSort={columnSort?.requested?.column === column.name}
            onSort={columnSort && ((direction) => columnSort.onChange(direction ? { column: column.name, direction } : undefined))} />)}
        </tr>
        {profiling && profiles ? <tr className="query-profile-row"><th aria-label={bt("business.columnProfiles")} />{profiles.map((p,i) => <th key={i}><button type="button" aria-label={bt("business.profileDetail", { value0: result.columns[i].name })} aria-expanded={column === i} onClick={(event) => {
          profileTrigger.current = event.currentTarget;
          setColumn(column === i ? undefined : i);
        }}><span className="profile-quality" aria-hidden="true"><i style={{ width: `${p.total ? (p.total-p.nulls)/p.total*100 : 0}%` }} /></span><span>{bt("business.notNULL")} {p.total ? ((p.total-p.nulls)/p.total*100).toFixed(0) : 0}{bt("business.nULL")} {p.nulls}</span><small>{p.distinct === null ? bt("business.incompleteUnavailable") : bt("business.distinctOccurOnce", { value0: p.distinct, value1: p.unique ?? "—" })}</small><span className="profile-spark" aria-hidden="true">{(p.numeric?.bins ?? p.top).map((v,j,all) => <i key={j} style={{ height: `${Math.max(5, v.count/Math.max(1,...all.map((b) => b.count))*100)}%` }} />)}</span></button></th>)}</tr> : null}</thead>
        <tbody>{visibleRows.map((row, rowIndex) => {
          const absoluteRowIndex = page * PAGE_SIZE + rowIndex;
          const rowNumber = (tableRowOffset ?? 0) + absoluteRowIndex + 1;
          return <tr key={absoluteRowIndex} aria-selected={selected.includes(absoluteRowIndex)} data-selected={selected.includes(absoluteRowIndex) || undefined}
            aria-keyshortcuts="Shift+F10" onContextMenu={(event) => openCopyMenu(event, absoluteRowIndex)}
            tabIndex={absoluteRowIndex === (gridState.selectedRow ?? page * PAGE_SIZE) ? 0 : -1}
            onClick={(event) => selectRow(absoluteRowIndex, event.metaKey || event.ctrlKey, event.shiftKey)} onKeyDown={(event) => {
              if (isDataRowMenuShortcut(event)) openCopyMenu(event, absoluteRowIndex);
              else navigateRows(event, rowIndex);
            }}>
            <th scope="row" className="query-row-heading"><div className="query-row-selector"><input type="checkbox" tabIndex={-1} aria-label={bt("business.selectRow", { value0: rowNumber })} checked={selected.includes(absoluteRowIndex)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => selectRow(absoluteRowIndex,true,false)} /><span>{rowNumber}</span></div></th>{row.map((cell, columnIndex) => <td key={columnIndex} className={cell.kind === "null" ? "query-null" : ""}
              data-column-selected={highlightedColumn !== undefined && result.columns[columnIndex]?.name === highlightedColumn || undefined}
              title={resultCellText(cell)}>{resultCellText(cell)}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
    {profiling && profiles && column !== undefined ? <ColumnProfileDetails key={column} column={result.columns[column]} profile={profiles[column]} limited={result.truncated} onClose={() => {
      setColumn(undefined);
      profileTrigger.current?.focus({ preventScroll: true });
    }} /> : null}
    </div>
    {exporting && platform ? <ResultExportDialog result={result} selected={selected} platform={platform} currentTablePage={tableRowOffset !== undefined} onClose={() => setExporting(false)} /> : null}
    {pageCount > 1 ? <footer className="query-result-pagination"><span>{bt("business.rowsDetailDetail")} {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, result.rows.length)} {bt("business.of")} {result.rows.length}</span><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{bt("business.previous")}</button><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>{bt("business.next")}</button></footer> : null}
    </div>
  );
}
