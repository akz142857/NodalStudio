import { EmptyState } from "../../design-system/EmptyState";
import { useI18n, useEventTranslator } from "../../i18n";
import type { NodalStudioPlatform, QueryExecutionResult } from "../../platform";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { ColumnProfileDetails } from "./ColumnProfileDetails";
import { ResultExportDialog } from "./ResultExportDialog";
import { resultCellText, type ColumnProfile } from "./result-profile";
import "./query-result-tools.css";

import { ActionIcon } from "../ActionIcon";

const PAGE_SIZE = 200;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 640;

function defaultColumnWidth(name: string, databaseType: string): number {
  const contentHint = /uuid|timestamp|json|text/i.test(databaseType) ? 220 : 130;
  return Math.max(contentHint, Math.min(280, Math.max(name.length, databaseType.length) * 9 + 32));
}

function clampColumnWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
}

export function QueryResultGrid({ result, platform }: { result?: QueryExecutionResult; platform?: NodalStudioPlatform }) {
  const { t: bt } = useI18n();
  if (!result) return <EmptyState className="query-empty-state" icon={<ActionIcon name="grid" />} title={bt("business.yourResultsAppearHere")} description={bt("business.runAQueryToInspectItsResult")} />;
  return <ResultGrid key={result.queryId} result={result} platform={platform} />;
}
function ResultGrid({ result, platform }: { result: QueryExecutionResult; platform?: NodalStudioPlatform }) {
  const { t: bt, formatNumber } = useI18n();
  const eventBt = useEventTranslator(bt);
  const [selected, setSelected] = useState<number[]>([]);
  const [profiling, setProfiling] = useState(false);
  const [profiles, setProfiles] = useState<ColumnProfile[]>();
  const [profileError, setProfileError] = useState("");
  const [column, setColumn] = useState<number>();
  const [exporting, setExporting] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  useEffect(() => {
    if (!profiling) return;
    const worker = new Worker(new URL("./result-profile.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{profiles?: ColumnProfile[]; error?: string}>) => { setProfiles(event.data.profiles); setProfileError(event.data.error ?? ""); };
    worker.onerror = () => setProfileError(eventBt("business.unableToProfileThisResultTurnProfileOffAnd"));
    worker.postMessage(result);
    return () => worker.terminate();
  }, [result, profiling, eventBt]);
  function selectRow(index: number, toggle: boolean, range: boolean) {
    setSelected((previous) => range && gridState.selectedRow !== null ? [...new Set([...previous, ...Array.from({ length: Math.abs(index-gridState.selectedRow)+1 }, (_,i) => Math.min(index,gridState.selectedRow!)+i)])].sort((a,b) => a-b) : toggle ? previous.includes(index) ? previous.filter((i) => i !== index) : [...previous,index].sort((a,b) => a-b) : [index]);
    setGridState((current) => ({ ...current, selectedRow: index }));
  }
  async function copyRows() {
    try { await navigator.clipboard.writeText(JSON.stringify({ columns: result.columns, rows: selected.map((i) => result.rows[i].map(resultCellText)) }, null, 2)); setCopyMessage(bt("business.copiedSelectedRowsAsDisplayTextInJSON", { value0: selected.length })); }
    catch { setCopyMessage(bt("business.unableToCopyCheckClipboardAccessAndRetry")); }
  }
  const [gridState, setGridState] = useState<{ queryId?: string; page: number; selectedRow: number | null; widths: Record<number, number> }>({ queryId: result?.queryId, page: 0, selectedRow: null, widths: {} });
  const stopColumnResizeRef = useRef<(() => void) | undefined>(undefined);
  if (gridState.queryId !== result?.queryId) setGridState({ queryId: result?.queryId, page: 0, selectedRow: null, widths: {} });
  useEffect(() => () => stopColumnResizeRef.current?.(), []);
  const page = gridState.page;
  const setPage = (update: (value: number) => number) => setGridState((current) => ({ ...current, page: update(current.page), selectedRow: null }));
  if (!result) return <EmptyState className="query-empty-state" icon={<ActionIcon name="grid" />} title={bt("business.yourResultsAppearHere")} description={bt("business.runAQueryToInspectItsResult")} />;
  if (!result.columns.length) return <div className="query-empty-state">{bt("business.queryReturnedNoRows")}</div>;
  const pageCount = Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE));
  const visibleRows = result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const widths = result.columns.map((column, index) => gridState.widths[index] ?? Math.max(profiling ? 220 : 0, defaultColumnWidth(column.name, column.databaseType)));
  const tableWidth = 88 + widths.reduce((total, width) => total + width, 0);
  function beginColumnResize(event: ReactMouseEvent<HTMLSpanElement>, columnIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    stopColumnResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = widths[columnIndex];
    document.body.classList.add("is-resizing-query-column");
    const move = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const width = clampColumnWidth(startWidth + moveEvent.clientX - startX);
      setGridState((current) => current.widths[columnIndex] === width ? current : { ...current, widths: { ...current.widths, [columnIndex]: width } });
    };
    const finish = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      document.body.classList.remove("is-resizing-query-column");
      stopColumnResizeRef.current = undefined;
    };
    stopColumnResizeRef.current = finish;
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("mouseup", finish, { once: true });
  }
  return (
    <div className="query-result-frame">
    <div className="query-result-tools" role="group" aria-label={bt("business.resultActions")}>
      <div className="query-result-context"><span className="query-result-count">{formatNumber(result.rows.length)} {result.rows.length === 1 ? bt("businessExtra.row") : bt("business.rows")}</span><span className="query-result-scope">{bt("business.currentResultAllPages")}</span>{result.truncated ? <span className="query-result-limit">{bt("business.resultLimitReached")}</span> : null}</div>
      <div className="query-result-actions">
        {selected.length ? <div className="query-selection-actions"><span aria-live="polite">{selected.length} {bt("businessExtra.selected")}</span><button type="button" aria-label={bt("business.copySelectedRows")} title={bt("business.copySelectedRowsAsJSONDisplayText")} onClick={() => void copyRows()}><ActionIcon name="copy" />{bt("business.copyDetail")}</button><button type="button" aria-label={bt("business.clearSelection")} onClick={() => setSelected([])}>{bt("business.clear")}</button></div> : null}
        <div className="query-standard-actions"><button type="button" aria-pressed={profiling} onClick={() => { setProfiling(!profiling); setColumn(undefined); setProfileError(""); }}><ActionIcon name="chart" />{bt("business.profile")}</button>
        <button type="button" disabled={!platform} onClick={() => setExporting(true)}><ActionIcon name="export" />{bt("business.export")}</button></div>
      </div>
    </div>
    {copyMessage ? <p className="result-inline-message" aria-live="polite">{copyMessage}</p> : null}
    {profiling ? <p className="result-profile-scope">{profileError || (profiles ? bt("business.profileBasedOnReturnedRowsNotTheFullDatabase", { value0: result.rows.length }) : bt("business.profilingReturnedRowsLocally"))}</p> : null}
    <div className="query-result-content">
    <div className="query-result-scroll" role="region" aria-label={bt("business.queryResults")} tabIndex={0}>
      <table className="query-result-table" style={{ width: tableWidth, minWidth: tableWidth }}>
        <colgroup><col style={{ width: 88 }} />{widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
        <thead><tr><th className="query-row-heading" scope="col"><div className="query-row-selector"><input type="checkbox" aria-label={bt("business.selectAllReturnedRows")} title={bt("business.selectAllReturnedRowsAcrossAllPages")} disabled={!result.rows.length} checked={selected.length === result.rows.length && result.rows.length > 0} ref={(el) => { if (el) el.indeterminate = selected.length > 0 && selected.length < result.rows.length; }} onChange={() => setSelected(selected.length === result.rows.length ? [] : result.rows.map((_,i) => i))} /><span aria-label={bt("business.rowNumber")}>#</span></div></th>{result.columns.map((column, index) => <th key={`${column.name}:${index}`} title={column.databaseType}><span>{column.name}</span><small>{column.databaseType}</small><span className="query-column-resizer" role="separator" aria-label={bt("business.resizeColumn", { value0: column.name })} aria-orientation="vertical" aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={widths[index]} tabIndex={0} onMouseDown={(event) => beginColumnResize(event, index)} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          const width = clampColumnWidth(widths[index] + (event.key === "ArrowRight" ? 16 : -16));
          setGridState((current) => ({ ...current, widths: { ...current.widths, [index]: width } }));
        }} /></th>)}</tr>
        {profiling && profiles ? <tr className="query-profile-row"><th aria-label={bt("business.columnProfiles")} />{profiles.map((p,i) => <th key={i}><button type="button" aria-label={bt("business.profileDetail", { value0: result.columns[i].name })} aria-expanded={column === i} onClick={() => setColumn(column === i ? undefined : i)}><span className="profile-quality" aria-hidden="true"><i style={{ width: `${p.total ? (p.total-p.nulls)/p.total*100 : 0}%` }} /></span><span>{bt("business.notNULL")} {p.total ? ((p.total-p.nulls)/p.total*100).toFixed(0) : 0}{bt("business.nULL")} {p.nulls}</span><small>{p.distinct === null ? bt("business.incompleteUnavailable") : bt("business.distinctOccurOnce", { value0: p.distinct, value1: p.unique ?? "—" })}</small><span className="profile-spark" aria-hidden="true">{(p.numeric?.bins ?? p.top).map((v,j,all) => <i key={j} style={{ height: `${Math.max(5, v.count/Math.max(1,...all.map((b) => b.count))*100)}%` }} />)}</span></button></th>)}</tr> : null}</thead>
        <tbody>{visibleRows.map((row, rowIndex) => {
          const absoluteRowIndex = page * PAGE_SIZE + rowIndex;
          return <tr key={absoluteRowIndex} aria-selected={selected.includes(absoluteRowIndex)} data-selected={selected.includes(absoluteRowIndex) || undefined} tabIndex={0} onClick={(event) => selectRow(absoluteRowIndex, event.metaKey || event.ctrlKey, event.shiftKey)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRow(absoluteRowIndex, event.metaKey || event.ctrlKey, event.shiftKey); }
          }}><th scope="row" className="query-row-heading"><div className="query-row-selector"><input type="checkbox" aria-label={bt("business.selectRow", { value0: absoluteRowIndex+1 })} checked={selected.includes(absoluteRowIndex)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => selectRow(absoluteRowIndex,true,false)} /><span>{absoluteRowIndex + 1}</span></div></th>{row.map((cell, columnIndex) => <td key={columnIndex} className={cell.kind === "null" ? "query-null" : ""} title={resultCellText(cell)}>{resultCellText(cell)}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
    {profiling && profiles && column !== undefined ? <ColumnProfileDetails key={column} column={result.columns[column]} profile={profiles[column]} limited={result.truncated} onClose={() => setColumn(undefined)} /> : null}
    </div>
    {exporting && platform ? <ResultExportDialog result={result} selected={selected} platform={platform} onClose={() => setExporting(false)} /> : null}
    {pageCount > 1 ? <footer className="query-result-pagination"><span>{bt("business.rowsDetailDetail")} {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, result.rows.length)} {bt("business.of")} {result.rows.length}</span><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{bt("business.previous")}</button><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>{bt("business.next")}</button></footer> : null}
    </div>
  );
}
