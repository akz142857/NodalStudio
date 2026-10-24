import type { QueryCell, QueryExecutionResult } from "../../platform";
import { resultCellText } from "./result-profile";

export interface ChartPoint { label: string; value: number; exact: string; order: number }
export type ResultPresentation =
  | { kind: "table"; reason: string }
  | { kind: "metric"; title: string; value: string }
  | { kind: "chart"; title: string; dimension: string; temporal: boolean; period: "month" | "day" | "category"; points: ChartPoint[] };

const numericType = /^(?:tinyint|smallint|mediumint|bigint|int[248]?|integer|numeric|decimal|float[48]?|real|double(?: precision)?)(?:\b|\()/i;
const identifier = /(?:^|_)(?:id|uuid|key|code)$/i;
export function columnTitle(name: string): string { return name.replace(/_/g, " ").replace(/^\p{L}/u, (letter) => letter.toUpperCase()); }

function numeric(cell: QueryCell | undefined): { value: number; exact: string } | undefined {
  if (!cell || (cell.kind !== "number" && (cell.kind !== "text" || cell.truncated))) return;
  const exact = resultCellText(cell);
  if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(exact)) return;
  const value = Number(exact);
  // Plotting must not silently round high-precision DECIMAL/BIGINT values or underflow.
  const significant = exact.split(/e/i)[0].replace(/^[+-]/, "").replace(".", "").replace(/^0+/, "");
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || significant.length > 15 || (value === 0 && /[1-9]/.test(significant))) return;
  return { value, exact };
}

function period(label: string): { kind: "month" | "day"; order: number } | undefined {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(label);
  if (!match) return;
  const year = Number(match[1]); const month = Number(match[2]); const day = match[3] ? Number(match[3]) : undefined;
  if (year < 1000 || month < 1 || month > 12) return;
  if (day === undefined) return { kind: "month", order: year * 12 + month - 1 };
  const time = Date.UTC(year, month - 1, day);
  if (new Date(time).getUTCDate() !== day || day < 1) return;
  return { kind: "day", order: time / 86_400_000 };
}

/** A local presentation decision, never an AI calculation or an implicit aggregation. */
export function presentResult(result: QueryExecutionResult): ResultPresentation {
  const table = (reason: string): ResultPresentation => ({ kind: "table", reason });
  if (!result.rows.length) return table("No rows matched this query.");
  if (result.rowCount !== result.rows.length || result.rows.some((row) => row.length !== result.columns.length)) return table("The result is incomplete. Review the returned rows in the table.");
  const metrics = result.columns.map((column, index) => ({ column, index })).filter(({ column }) => numericType.test(column.databaseType) && !identifier.test(column.name));
  if (result.rows.length === 1 && result.columns.length === 1 && metrics.length === 1 && !result.truncated) {
    const value = numeric(result.rows[0][0]);
    if (value) return { kind: "metric", title: columnTitle(result.columns[0].name), value: value.exact };
  }
  if (result.columns.length !== 2 || metrics.length !== 1) return table("Table view preserves this result's columns. Charts need one label and one numeric measure.");
  if (result.rows.length < 2 || result.rows.length > 60) return table("Charts are available for 2–60 returned rows. Narrow the query to see a useful comparison.");
  const measure = metrics[0]; const dimension = 1 - measure.index;
  const points: ChartPoint[] = [];
  for (const [index, row] of result.rows.entries()) {
    const cell = row[dimension]; const value = numeric(row[measure.index]);
    if (!value || !cell || cell.kind === "null" || cell.kind === "json" || cell.kind === "binary" || (cell.kind === "text" && cell.truncated)) return table("Some values are missing, incomplete or too precise to plot safely. Original values are kept in the table.");
    const label = resultCellText(cell);
    if (!label.trim()) return table("Some labels are empty. Review the original values in the table.");
    points.push({ label, ...value, order: index });
  }
  if (new Set(points.map((point) => point.label)).size !== points.length) return table("Repeated labels need an explicit grouping in SQL. Values have not been combined.");
  const periods = points.map((point) => period(point.label));
  const temporal = periods.every((item) => item && item.kind === periods[0]?.kind);
  if (!temporal && points.length > 24) return table("More than 24 categories would crowd this chart. Narrow the query or use the table.");
  if (temporal) { points.forEach((point, index) => { point.order = periods[index]!.order; }); points.sort((a, b) => a.order - b.order); }
  return { kind: "chart", title: columnTitle(measure.column.name), dimension: columnTitle(result.columns[dimension].name), temporal, period: temporal ? periods[0]!.kind : "category", points };
}
