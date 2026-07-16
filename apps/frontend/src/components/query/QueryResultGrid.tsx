import type { QueryCell, QueryExecutionResult } from "../../platform";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

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

function cellContent(cell: QueryCell): string {
  switch (cell.kind) {
    case "null": return "NULL";
    case "boolean": return cell.value ? "true" : "false";
    case "number": return String(cell.value);
    case "text": return `${cell.value}${cell.truncated ? "…" : ""}`;
    case "json": return `${JSON.stringify(cell.value)}${cell.truncated ? "…" : ""}`;
    case "binary": return `<${cell.byteLength} bytes>`;
  }
}

export function QueryResultGrid({ result }: { result?: QueryExecutionResult }) {
  const [gridState, setGridState] = useState<{ queryId?: string; page: number; selectedRow: number | null; widths: Record<number, number> }>({ queryId: result?.queryId, page: 0, selectedRow: null, widths: {} });
  const stopColumnResizeRef = useRef<(() => void) | undefined>(undefined);
  if (gridState.queryId !== result?.queryId) setGridState({ queryId: result?.queryId, page: 0, selectedRow: null, widths: {} });
  useEffect(() => () => stopColumnResizeRef.current?.(), []);
  const page = gridState.page;
  const setPage = (update: (value: number) => number) => setGridState((current) => ({ ...current, page: update(current.page), selectedRow: null }));
  if (!result) return <div className="query-empty-state">Run a query to inspect its result.</div>;
  if (!result.columns.length) return <div className="query-empty-state">Query returned no rows.</div>;
  const pageCount = Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE));
  const visibleRows = result.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const widths = result.columns.map((column, index) => gridState.widths[index] ?? defaultColumnWidth(column.name, column.databaseType));
  const tableWidth = 44 + widths.reduce((total, width) => total + width, 0);
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
    <div className="query-result-scroll" role="region" aria-label="Query results" tabIndex={0}>
      <table className="query-result-table" style={{ width: tableWidth, minWidth: tableWidth }}>
        <colgroup><col style={{ width: 44 }} />{widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
        <thead><tr><th aria-label="Row number">#</th>{result.columns.map((column, index) => <th key={`${column.name}:${index}`} title={column.databaseType}><span>{column.name}</span><small>{column.databaseType}</small><span className="query-column-resizer" role="separator" aria-label={`Resize ${column.name} column`} aria-orientation="vertical" aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={widths[index]} tabIndex={0} onMouseDown={(event) => beginColumnResize(event, index)} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          const width = clampColumnWidth(widths[index] + (event.key === "ArrowRight" ? 16 : -16));
          setGridState((current) => ({ ...current, widths: { ...current.widths, [index]: width } }));
        }} /></th>)}</tr></thead>
        <tbody>{visibleRows.map((row, rowIndex) => {
          const absoluteRowIndex = page * PAGE_SIZE + rowIndex;
          return <tr key={absoluteRowIndex} aria-selected={gridState.selectedRow === absoluteRowIndex} data-selected={gridState.selectedRow === absoluteRowIndex || undefined} tabIndex={0} onClick={() => setGridState((current) => ({ ...current, selectedRow: absoluteRowIndex }))} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setGridState((current) => ({ ...current, selectedRow: absoluteRowIndex })); }
          }}><th>{absoluteRowIndex + 1}</th>{row.map((cell, columnIndex) => <td key={columnIndex} className={cell.kind === "null" ? "query-null" : ""} title={cellContent(cell)}>{cellContent(cell)}</td>)}</tr>;
        })}</tbody>
      </table>
    </div>
    {pageCount > 1 ? <footer className="query-result-pagination"><span>Rows {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, result.rows.length)} of {result.rows.length}</span><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</button></footer> : null}
    </div>
  );
}
