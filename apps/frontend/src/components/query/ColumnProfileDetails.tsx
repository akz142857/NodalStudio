import { useEffect, useRef } from "react";
import type { QueryColumn } from "../../platform";
import type { ColumnProfile } from "./result-profile";
export function ColumnProfileDetails({ column, profile: p, limited, onClose }: { column: QueryColumn; profile: ColumnProfile; limited: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement; close.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const bars = p.numeric?.bins ?? p.top;
  const max = Math.max(1, ...bars.map((v) => v.count));
  return <aside className="column-profile-details" aria-label={`Profile of ${column.name}`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <header><div><strong>{column.name}</strong><small>{column.databaseType}</small></div><button ref={close} type="button" onClick={onClose} aria-label="Close column profile">×</button></header>
    <p>Based on {p.total.toLocaleString()} returned rows · all loaded pages.{limited ? " Result limit reached; not the full dataset." : " Not a whole-table assessment."}</p>
    <dl><dt>Not NULL</dt><dd>{p.total-p.nulls}</dd><dt>NULL</dt><dd>{p.nulls} ({p.total ? (p.nulls/p.total*100).toFixed(1) : "0"}%)</dd><dt>Empty strings</dt><dd>{p.empty}</dd><dt>Distinct non-NULL values</dt><dd>{p.distinct ?? "Unavailable"}</dd><dt>Values occurring once</dt><dd>{p.unique ?? "Unavailable"}</dd>{p.incomplete ? <><dt>Incomplete values</dt><dd>{p.incomplete}</dd></> : null}
    {p.numeric ? <><dt>Minimum</dt><dd>{p.numeric.min}</dd><dt>Maximum</dt><dd>{p.numeric.max}</dd><dt>Mean</dt><dd>{p.numeric.mean}</dd></> : null}
    {p.dates ? <><dt>Earliest</dt><dd>{p.dates.min}</dd><dt>Latest</dt><dd>{p.dates.max}</dd></> : null}</dl>
    {p.note ? <p className="result-hint">{p.note}</p> : null}
    {bars.length ? <section aria-label="Value distribution"><h3>{p.numeric ? "Numeric distribution" : "Most frequent values"}</h3>{bars.map((v,i) => <div className="profile-frequency" key={i}><span title={v.label}>{v.label}</span><b>{v.count}</b><div><i style={{ width: `${v.count/max*100}%` }} /></div></div>)}{!p.numeric ? <p>Top {bars.length} values; {p.total-p.nulls-bars.reduce((n,v) => n+v.count,0)} other non-NULL rows.</p> : null}</section> : null}
    <p className="result-hint">Computed locally. Distinct values exclude NULL. “Occurring once” is a result statistic, not a database uniqueness constraint.</p>
  </aside>;
}
