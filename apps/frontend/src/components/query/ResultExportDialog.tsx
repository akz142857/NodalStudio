import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import type { NodalStudioPlatform, QueryExecutionResult, QueryExportInput } from "../../platform/types";
import { ActionIcon } from "../ActionIcon";
import { incompleteCell } from "./result-profile";



export function ResultExportDialog({ result, selected, platform, onClose }: { result: QueryExecutionResult; selected: number[]; platform: NodalStudioPlatform; onClose: () => void }) {
  const { t: bt, formatNumber, locale } = useI18n();
  const formats = [
  { value: "csv", name: "CSV", description: bt("business.spreadsheetText"), extension: ".csv" },
  { value: "json", name: "JSON", description: bt("business.structuredData"), extension: ".json" },
  { value: "xlsx", name: "Excel", description: bt("business.excelWorkbook"), extension: ".xlsx" },
] as const;
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<QueryExportInput["format"]>("csv");
  const [scope, setScope] = useState("all");
  const [protect, setProtect] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const el = dialog.current; const previous = document.activeElement;
    el?.showModal(); el?.querySelector<HTMLInputElement>('input[name="export-format"]:checked')?.focus();
    return () => { el?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const indices = scope === "all" ? result.rows.map((_,i) => i) : selected;
  const incomplete = indices.reduce((n,i) => n + result.rows[i].filter(incompleteCell).length,0);
  async function save() {
    if (busy || (incomplete && !acknowledged)) return;
    setBusy(true); setMessage(""); setSaved(false); setFailed(false);
    try {
      const path = await platform.exportQueryResult({ result, format, locale, selectedRows: scope === "all" ? null : selected, protectFormulas: protect });
      setSaved(Boolean(path)); setMessage(path ? bt("business.savedRowsTo", { value0: indices.length, value1: path }) : bt("business.saveCancelledNoFileWasWritten"));
    } catch (error) { setFailed(true); setMessage(bt("business.exportFailed", { value0: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="ds-surface result-export-dialog" aria-labelledby="result-export-title" aria-describedby="result-export-description" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <header><div className="result-export-symbol"><ActionIcon name="export" /></div><div><h2 id="result-export-title">{bt("business.exportQueryResult")}</h2><p id="result-export-description">{bt("business.saveACopyOfYourCurrentResult")}</p></div></header>
    <fieldset className="result-format-options" disabled={busy}><legend>{bt("business.fileFormat")}</legend><div>{formats.map((item) => <label key={item.value}>
      <input type="radio" name="export-format" value={item.value} checked={format === item.value} onChange={() => { setFormat(item.value); setMessage(""); setSaved(false); }} />
      <span className="result-format-card"><strong>{item.name}</strong><small>{item.extension}</small><span>{item.description}</span></span>
    </label>)}</div></fieldset>
    <div className="result-export-options">
      <label className="result-export-range"><span>{bt("business.rowsDetailDetail")}</span><span className="result-export-select"><select aria-label={bt("business.rowsDetailDetail")} value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value); setAcknowledged(false); setMessage(""); setSaved(false); }}><option value="all">{bt("resultExport.allRows", { count: formatNumber(result.rows.length) })}</option><option value="selected" disabled={!selected.length}>{bt("resultExport.selectedRows", { count: formatNumber(selected.length) })}</option></select><ActionIcon name="chevronUp" /></span></label>
      {format === "csv" ? <label className="result-check result-export-protection"><span><strong>{bt("business.protectSpreadsheetFormulas")}</strong><small>{bt("business.keepFormulaLikeTextFromRunningInSpreadsheets")}</small></span><input type="checkbox" checked={protect} disabled={busy} onChange={(e) => setProtect(e.target.checked)} /></label> : null}
    </div>
    <p className="result-export-scope"><ActionIcon name="info" /><span><strong>{bt("resultExport.scope", { count: formatNumber(indices.length), total: formatNumber(result.rows.length) })}</strong> {bt("business.allLoadedPages")}<br />{bt("business.thisDoesNotRunSQLAgainOrExportThe")}</span></p>
    {result.truncated ? <p className="result-warning">{bt("business.resultLimitReachedThisExportDoesNotContainEvery")}</p> : null}
    {incomplete ? <div className="result-warning"><p>{incomplete} {bt("business.cellsContainTruncatedValuesOrBinaryDataThatWas")}</p><label className="result-check"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} />{bt("business.exportTheseIncompleteValues")}</label></div> : null}
    <details className="result-format-details"><summary>{bt("business.formatDetails")}</summary><p>{format === "csv" ? bt("business.uTF8WithBOMAndHeadersNULLUnquotedN") : format === "json" ? bt("business.columnOrderAndDuplicateNamesArePreservedNULLRemains") : bt("business.includesResultsAndExportInfoSheetsNULLCellsAre")}</p></details>
    {message ? <p role={failed ? "alert" : "status"} className="result-export-message">{message}</p> : null}
    <footer><Button type="button" disabled={busy} onClick={onClose}>{saved ? bt("business.done") : bt("business.cancel")}</Button><Button type="button" className="result-primary" disabled={busy || Boolean(incomplete && !acknowledged)} onClick={() => void save()}>{busy ? bt("business.exporting") : bt("business.export")}</Button></footer>
  </dialog>;
}
