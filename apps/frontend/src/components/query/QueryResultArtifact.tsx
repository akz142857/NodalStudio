import { useId, useState } from "react";
import { ActionIcon } from "../ActionIcon";
import type { ChartPoint, ResultPresentation } from "./result-presentation";
import "./query-result-artifact.css";

export interface QueryResultArtifactProps {
  queryId: string; columns: string[]; rows: string[][]; total: number; columnCount: number; duration: number; truncated: boolean;
  presentation: ResultPresentation;
}
const tick = (value: number) => value !== 0 && Math.abs(value) < .01 ? value.toExponential(1) : Math.abs(value) < 1 ? new Intl.NumberFormat("en", { maximumSignificantDigits: 3 }).format(value) : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

function ResultChart({ presentation, mode }: { presentation: Extract<ResultPresentation, { kind: "chart" }>; mode: "line" | "bar" }) {
  const titleId = useId(); const descriptionId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const { points, temporal } = presentation;
  const W = 640; const H = 232; const left = 58; const right = 20; const top = 20; const bottom = 38;
  const width = W - left - right; const height = H - top - bottom;
  const min = Math.min(0, ...points.map((p) => p.value)); const max = Math.max(0, ...points.map((p) => p.value)) || (min === 0 ? 1 : 0);
  const range = max - min || 1;
  const y = (value: number) => top + (max - value) / range * height;
  const position = (point: ChartPoint, index: number) => temporal ? (point.order - points[0].order) / (points.at(-1)!.order - points[0].order) : index / (points.length - 1);
  const step = temporal ? width / (points.at(-1)!.order - points[0].order + 1) : width / points.length;
  const pad = Math.max(6, Math.min(28, step / 2));
  const x = (point: ChartPoint, index: number) => left + pad + position(point, index) * (width - pad * 2);
  const shown = selected ?? points.length - 1;
  const active = points[shown];
  const labelIndices = points.length <= 5 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  return <div className="query-artifact-chart">
    <div className="query-chart-reading" aria-live="polite"><strong>{active.exact}</strong><span>{active.label}{selected === null && temporal ? " · Latest returned period" : ""}</span></div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
      <title id={titleId}>{presentation.title} by {presentation.dimension} · {mode === "line" ? "Line chart" : "Bar chart"}</title>
      <desc id={descriptionId}>Values from {points.length} returned rows. {temporal ? "Chronological order; missing periods are not filled." : "Query order preserved."} Exact values are available in Data view.</desc>
      {[max, min + range / 2, min].filter((value, i, all) => all.indexOf(value) === i).map((value) => <g key={value}><line className="query-chart-grid" x1={left} x2={W - right} y1={y(value)} y2={y(value)} /><text className="query-chart-label" x={left - 10} y={y(value) + 4} textAnchor="end">{tick(value)}</text></g>)}
      <line className="query-chart-baseline" x1={left} x2={W - right} y1={y(0)} y2={y(0)} />
      {mode === "line" ? points.slice(1).map((point, i) => !temporal || point.order - points[i].order === 1 ? <line key={point.label} className="query-chart-line" x1={x(points[i], i)} y1={y(points[i].value)} x2={x(point, i + 1)} y2={y(point.value)} /> : null) : null}
      {points.map((point, i) => <g key={point.label} className="query-chart-point" data-active={i === shown || undefined} tabIndex={0} role="button" aria-label={`${point.label}: ${point.exact}`} onFocus={() => setSelected(i)} onBlur={() => setSelected(null)} onMouseEnter={() => setSelected(i)} onMouseLeave={() => setSelected(null)} onClick={() => setSelected(i)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(i); } }}>
        <title>{point.label}: {point.exact}</title>
        {mode === "bar" ? <rect className="query-chart-bar" x={x(point, i) - Math.min(44, step * .7) / 2} y={Math.min(y(point.value), y(0))} width={Math.min(44, step * .7)} height={Math.max(1, Math.abs(y(point.value) - y(0)))} rx={3} /> : <circle className="query-chart-dot" cx={x(point, i)} cy={y(point.value)} r={i === shown ? 5 : 3.5} />}
        <rect fill="transparent" x={x(point, i) - Math.min(22, step / 2)} y={top} width={Math.min(44, step)} height={height} />
      </g>)}
      {labelIndices.map((i) => <text key={i} className="query-chart-label" x={x(points[i], i)} y={H - 12} textAnchor="middle">{points[i].label.length > 16 ? `${points[i].label.slice(0, 14)}…` : points[i].label}</text>)}
    </svg>
  </div>;
}

export function QueryResultArtifact(props: QueryResultArtifactProps) { return <ResultArtifact key={props.queryId} {...props} />; }
function ResultArtifact({ columns, rows, total, columnCount, duration, truncated, presentation }: QueryResultArtifactProps) {
  const [view, setView] = useState<"chart" | "data">(presentation.kind === "table" ? "data" : "chart");
  const [mode, setMode] = useState<"line" | "bar">(presentation.kind === "chart" && presentation.temporal ? "line" : "bar");
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const title = presentation.kind === "table" ? "Query result" : presentation.title;
  const chart = presentation.kind === "chart" ? presentation : undefined;
  const caption = chart ? `${chart.dimension} · ${chart.temporal ? `${chart.points[0].label} – ${chart.points.at(-1)!.label}` : `${chart.points.length} categories`}` : presentation.kind === "metric" ? "Single value returned" : `${total} rows returned`;
  return <section className="query-result-artifact" aria-label="Executed query result" data-expanded={expanded || undefined}>
    <div className="query-artifact-toolbar"><span><ActionIcon name={view === "data" ? "table" : "chart"} />{truncated ? "Partial result" : "Query result"}</span><div className="query-artifact-controls">
      {presentation.kind !== "table" ? <div className="query-artifact-switch" role="group" aria-label="Result display"><button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>{presentation.kind === "metric" ? "Metric" : "Chart"}</button><button type="button" aria-pressed={view === "data"} onClick={() => setView("data")}>Data</button></div> : null}
      {chart?.temporal && view === "chart" ? <select aria-label="Chart type" value={mode} onChange={(event) => setMode(event.target.value as "line" | "bar")}><option value="line">Line</option><option value="bar">Bar</option></select> : null}
    </div></div>
    <div className="query-artifact-body" id={bodyId}>
      {view === "chart" && chart ? <ResultChart presentation={chart} mode={mode} /> : view === "chart" && presentation.kind === "metric" ? <div className="query-artifact-metric"><strong>{presentation.value}</strong><span>{presentation.title}</span></div> : <><div className="query-answer-table-scroll"><table><thead><tr>{columns.map((name, i) => <th key={i}>{name}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table></div>{presentation.kind === "table" ? <p className="query-artifact-note">{presentation.reason}</p> : null}{total > rows.length || columnCount > columns.length ? <p className="query-artifact-note">Preview: first {rows.length} of {total} rows · {columns.length} of {columnCount} columns. Full result in SQL editor.</p> : null}</>}
      {chart && view === "chart" ? <p className="query-artifact-note">{chart.temporal ? "Time order · missing periods are not filled" : "Query order · no additional aggregation"}</p> : null}
      {truncated ? <p className="query-artifact-limit">Row limit reached. This preview shows only the returned subset.</p> : null}
    </div>
    <footer className="query-artifact-footer"><div><h4>{title}</h4><p>{caption}</p><small>{total} rows · {duration} ms · Local result, not sent to AI</small></div><button type="button" aria-label={expanded ? "Collapse result card" : "Expand result card"} aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}><ActionIcon name={expanded ? "chevronUp" : "expand"} /></button></footer>
  </section>;
}
