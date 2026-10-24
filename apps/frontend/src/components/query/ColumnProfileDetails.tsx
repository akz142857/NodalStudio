import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n } from "../../i18n";
import { useEffect, useRef } from "react";
import type { QueryColumn } from "../../platform";
import type { ColumnProfile } from "./result-profile";
export function ColumnProfileDetails({ column, profile: p, limited, onClose }: { column: QueryColumn; profile: ColumnProfile; limited: boolean; onClose: () => void }) {
  const { t: bt, formatNumber } = useI18n();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement; close.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const bars = p.numeric?.bins ?? p.top;
  const max = Math.max(1, ...bars.map((v) => v.count));
  return <aside className="column-profile-details" aria-label={bt("business.profileOf", { value0: column.name })} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <header><div><strong>{column.name}</strong><small>{column.databaseType}</small></div><button ref={close} type="button" onClick={onClose} aria-label={bt("business.closeColumnProfile")}>×</button></header>
    <p>{bt("business.basedOn")} {formatNumber(p.total)} {bt("business.returnedRowsAllLoadedPages")}{limited ? bt("business.resultLimitReachedNotTheFullDataset") : bt("business.notAWholeTableAssessment")}</p>
    <dl><dt>{bt("business.notNULL")}</dt><dd>{p.total-p.nulls}</dd><dt>NULL</dt><dd>{p.nulls} ({p.total ? (p.nulls/p.total*100).toFixed(1) : "0"}%)</dd><dt>{bt("business.emptyStrings")}</dt><dd>{p.empty}</dd><dt>{bt("business.distinctNonNULLValues")}</dt><dd>{p.distinct ?? bt("business.unavailable")}</dd><dt>{bt("business.valuesOccurringOnce")}</dt><dd>{p.unique ?? bt("business.unavailable")}</dd>{p.incomplete ? <><dt>{bt("business.incompleteValues")}</dt><dd>{p.incomplete}</dd></> : null}
    {p.numeric ? <><dt>{bt("business.minimum")}</dt><dd>{p.numeric.min}</dd><dt>{bt("business.maximum")}</dt><dd>{p.numeric.max}</dd><dt>{bt("business.mean")}</dt><dd>{p.numeric.mean}</dd></> : null}
    {p.dates ? <><dt>{bt("business.earliest")}</dt><dd>{p.dates.min}</dd><dt>{bt("business.latest")}</dt><dd>{p.dates.max}</dd></> : null}</dl>
    {p.note ? <p className="result-hint">{translateUiLabel(p.note, bt)}</p> : null}
    {bars.length ? <section aria-label={bt("business.valueDistribution")}><h3>{p.numeric ? bt("business.numericDistribution") : bt("business.mostFrequentValues")}</h3>{bars.map((v,i) => <div className="profile-frequency" key={i}><span title={v.label}>{v.label}</span><b>{v.count}</b><div><i style={{ width: `${v.count/max*100}%` }} /></div></div>)}{!p.numeric ? <p>{bt("business.top")} {bars.length} {bt("business.valuesDetail")} {p.total-p.nulls-bars.reduce((n,v) => n+v.count,0)} {bt("business.otherNonNULLRows")}</p> : null}</section> : null}
    <p className="result-hint">{bt("business.computedLocallyDistinctValuesExcludeNULLOccurringOnceIs")}</p>
  </aside>;
}
