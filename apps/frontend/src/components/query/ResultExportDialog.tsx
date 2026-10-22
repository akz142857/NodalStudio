import { useEffect, useRef, useState } from "react";
import type { NodalStudioPlatform, QueryExecutionResult, QueryExportInput } from "../../platform/types";
import { ActionIcon } from "../ActionIcon";
import { incompleteCell } from "./result-profile";

const formats = [
  { value: "csv", name: "CSV", description: "Spreadsheet text", extension: ".csv" },
  { value: "json", name: "JSON", description: "Structured data", extension: ".json" },
  { value: "xlsx", name: "Excel", description: "Excel workbook", extension: ".xlsx" },
] as const;

export function ResultExportDialog({ result, selected, platform, onClose }: { result: QueryExecutionResult; selected: number[]; platform: NodalStudioPlatform; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<QueryExportInput["format"]>("csv");
  const [scope, setScope] = useState("all");
  const [protect, setProtect] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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
    setBusy(true); setMessage(""); setSaved(false);
    try {
      const path = await platform.exportQueryResult({ result, format, selectedRows: scope === "all" ? null : selected, protectFormulas: protect });
      setSaved(Boolean(path)); setMessage(path ? `Saved ${indices.length} rows to ${path}` : "Save cancelled. No file was written.");
    } catch (error) { setMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="result-export-dialog" aria-labelledby="result-export-title" aria-describedby="result-export-description" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <header><div className="result-export-symbol"><ActionIcon name="export" /></div><div><h2 id="result-export-title">Export query result</h2><p id="result-export-description">Save a copy of your current result.</p></div></header>
    <fieldset className="result-format-options" disabled={busy}><legend>File format</legend><div>{formats.map((item) => <label key={item.value}>
      <input type="radio" name="export-format" value={item.value} checked={format === item.value} onChange={() => { setFormat(item.value); setMessage(""); setSaved(false); }} />
      <span className="result-format-card"><strong>{item.name}</strong><small>{item.extension}</small><span>{item.description}</span></span>
    </label>)}</div></fieldset>
    <div className="result-export-options">
      <label className="result-export-range"><span>Rows</span><span className="result-export-select"><select aria-label="Rows" value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value); setAcknowledged(false); setMessage(""); setSaved(false); }}><option value="all">All returned rows ({result.rows.length})</option><option value="selected" disabled={!selected.length}>Selected rows ({selected.length})</option></select><ActionIcon name="chevronUp" /></span></label>
      {format === "csv" ? <label className="result-check result-export-protection"><span><strong>Protect spreadsheet formulas</strong><small>Keep formula-like text from running in spreadsheets.</small></span><input type="checkbox" checked={protect} disabled={busy} onChange={(e) => setProtect(e.target.checked)} /></label> : null}
    </div>
    <p className="result-export-scope"><ActionIcon name="info" /><span><strong>{indices.length.toLocaleString()} of {result.rows.length.toLocaleString()} returned rows</strong> · all loaded pages<br />This does not run SQL again or export the full database.</span></p>
    {result.truncated ? <p className="result-warning">Result limit reached. This export does not contain every matching database row.</p> : null}
    {incomplete ? <div className="result-warning"><p>{incomplete} cells contain truncated values or binary data that was not loaded. CSV/XLSX use explicit markers; JSON includes incomplete-cell metadata.</p><label className="result-check"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} />Export these incomplete values</label></div> : null}
    <details className="result-format-details"><summary>Format details</summary><p>{format === "csv" ? "UTF-8 with BOM and headers. NULL = unquoted \\N; strings are quoted. Formula protection prefixes formula-like text with an apostrophe. For long IDs in Excel, choose the Excel format." : format === "json" ? "Column order and duplicate names are preserved. NULL remains null. Exact decimals, large integers and dates stay strings." : "Includes Results and Export info sheets. NULL cells are blank; long IDs, exact decimals and dates stay text. No cell is exported as a formula."}</p></details>
    {message ? <p role={message.startsWith("Export failed") ? "alert" : "status"} className="result-export-message">{message}</p> : null}
    <footer><button type="button" disabled={busy} onClick={onClose}>{saved ? "Done" : "Cancel"}</button><button type="button" className="result-primary" disabled={busy || Boolean(incomplete && !acknowledged)} onClick={() => void save()}>{busy ? "Exporting…" : "Export…"}</button></footer>
  </dialog>;
}
