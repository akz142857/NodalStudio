import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import type { DatabaseSnapshot, NodalStudioPlatform, TableDefinition } from "../platform";
import type { DatabaseExport, DatabaseExportProgress, DatabaseExportReceipt, DumpMode, TableExportFormat } from "../platform/database-export";
import "./query/query-result-tools.css";
import "./database-export.css";

export type DatabaseExportTarget =
  | { kind: "tableData"; table: TableDefinition }
  | { kind: "sqlDump"; schema: string; mode: DumpMode };

type State = { stage: "idle" | "selecting" | "stopping" | "cancelled" } | DatabaseExportProgress
  | { stage: "saved"; receipt: DatabaseExportReceipt } | { stage: "failed"; reason: unknown };

const errors = {
  unsupported: "databaseExport.unsupported",
  busy: "databaseExport.busy",
  connection: "databaseExport.connection",
  tls: "databaseExport.tls",
  tableUnavailable: "databaseExport.tableUnavailable",
  schemaUnavailable: "databaseExport.schemaUnavailable",
  columnsUnavailable: "databaseExport.columnsUnavailable",
  permission: "databaseExport.permission",
  pgDumpMissing: "databaseExport.pgDumpMissing",
  pgDumpVersion: "databaseExport.pgDumpVersion",
  sshDumpUnsupported: "databaseExport.sshDumpUnsupported",
  lockTimeout: "databaseExport.lockTimeout",
  readFailed: "databaseExport.readFailed",
  writeFailed: "databaseExport.writeFailed",
  destinationExists: "databaseExport.destinationExists",
} as const;

function errorKey(reason: unknown) {
  return typeof reason === "string" && Object.hasOwn(errors, reason)
    ? errors[reason as keyof typeof errors] : "databaseExport.readFailed";
}

export function DatabaseExportDialog({ platform, snapshot, target, onClose }: {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  target: DatabaseExportTarget;
  onClose: () => void;
}) {
  const { t, locale, formatNumber } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const active = useRef<string | undefined>(undefined);
  const [state, setState] = useState<State>({ stage: "idle" });
  const [format, setFormat] = useState<TableExportFormat>("csv");
  const [protectFormulas, setProtectFormulas] = useState(true);
  const columns = target.kind === "tableData" ? target.table.columns : [];
  const [selected, setSelected] = useState(() => new Set(columns.map((column) => column.name)));
  const busy = ["selecting", "exporting", "stopping", "finalizing"].includes(state.stage);
  const done = state.stage === "saved";
  const objectName = target.kind === "tableData" ? `${target.table.key.schema}.${target.table.key.name}` : target.schema;
  const scope = `${snapshot.database.name} / ${objectName}`;

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => () => {
    if (active.current) {
      void platform.cancelDatabaseExport(active.current).catch(() => {});
      active.current = undefined;
    }
  }, [platform]);

  function size(bytes: number) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit += 1; }
    return `${formatNumber(bytes, { maximumFractionDigits: 1 })} ${units[unit]}`;
  }

  async function save() {
    if (active.current || (target.kind === "tableData" && !selected.size)) return;
    const jobId = crypto.randomUUID();
    active.current = jobId;
    setState({ stage: "selecting" });
    const request: DatabaseExport = target.kind === "tableData"
      ? { kind: target.kind, table: target.table.key, format, protectFormulas, columns: columns.map((column) => column.name).filter((name) => selected.has(name)) }
      : target;
    try {
      const receipt = await platform.exportDatabaseFile({ sourceId: snapshot.sourceId, jobId, export: request, locale }, (progress) => {
        if (active.current === jobId) setState((current) => current.stage === "stopping" && progress.stage === "exporting" ? current : progress);
      });
      if (active.current === jobId) setState(receipt ? { stage: "saved", receipt } : { stage: "cancelled" });
    } catch (reason) {
      if (active.current === jobId) setState(reason === "cancelled" ? { stage: "cancelled" } : { stage: "failed", reason });
    } finally {
      if (active.current === jobId) active.current = undefined;
    }
  }

  function stop() {
    const jobId = active.current;
    if (!jobId || state.stage !== "exporting") return;
    setState({ stage: "stopping" });
    void platform.cancelDatabaseExport(jobId).catch(() => {
      if (active.current === jobId) setState((current) => current.stage === "stopping" ? state : current);
    });
  }

  return <dialog ref={dialog} className="result-export-dialog database-export-dialog" aria-labelledby={title}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div>
      <h2 id={title}>{t(target.kind === "tableData" ? "databaseExport.wizard" : "databaseExport.dump")}</h2>
      <p className="database-export-scope">{scope}</p>
    </div></header>
    {target.kind === "tableData" ? <>
      <p>{t("databaseExport.exportAllRows")}</p>
      <label className="database-export-format">{t("business.fileFormat")} <select value={format} disabled={busy || done}
        onChange={(event) => setFormat(event.target.value as TableExportFormat)}><option value="csv">CSV</option><option value="json">JSON</option></select></label>
      {format === "csv" ? <label className="database-export-formula">
        <input type="checkbox" checked={protectFormulas} disabled={busy || done} onChange={(event) => setProtectFormulas(event.target.checked)} />
        <span>{t("business.protectSpreadsheetFormulas")}<small>{t("business.keepFormulaLikeTextFromRunningInSpreadsheets")}</small></span>
      </label> : null}
      <fieldset className="database-export-columns" disabled={busy || done}>
        <legend>{t("databaseExport.columns")}</legend>
        <div className="database-export-column-actions">
          <Button onClick={() => setSelected(new Set(columns.map((column) => column.name)))}>{t("databaseExport.selectAll")}</Button>
          <Button onClick={() => setSelected(new Set())}>{t("business.clearSelection")}</Button>
        </div>
        <div className="database-export-column-list">{columns.map((column) => <label key={column.name}>
          <input type="checkbox" checked={selected.has(column.name)} onChange={(event) => {
            const checked = event.target.checked;
            setSelected((previous) => {
              const next = new Set(previous);
              if (checked) next.add(column.name); else next.delete(column.name);
              return next;
            });
          }} />{column.name}
        </label>)}</div>
      </fieldset>
    </> : <>
      <p>{t(target.mode === "structureOnly" ? "databaseExport.structureOnly" : "databaseExport.structureAndData")}</p>
      <p>{t("databaseExport.schemaDependencies")}</p>
    </>}
    {state.stage === "selecting" ? <p role="status">{t("databaseExport.selecting")}</p> : null}
    {state.stage === "exporting" ? <div role="status"><progress aria-label={t("business.exporting")} />
      <span>{t("databaseExport.written", { size: size(state.bytes) })}</span></div> : null}
    {state.stage === "stopping" ? <p role="status">{t("databaseExport.stopping")}</p> : null}
    {state.stage === "finalizing" ? <p role="status">{t("databaseExport.finalizing")}</p> : null}
    {state.stage === "cancelled" ? <p role="status">{t("business.saveCancelledNoFileWasWritten")}</p> : null}
    {state.stage === "failed" ? <p className="result-export-message" role="alert">{t(errorKey(state.reason))}</p> : null}
    {state.stage === "saved" ? <p className="result-export-message" role="status">{t("databaseExport.saved", {
      size: size(state.receipt.bytes), path: state.receipt.path,
    })}</p> : null}
    <footer>
      <Button type="button" disabled={busy && state.stage !== "exporting"} onClick={busy ? stop : onClose}>
        {t(done ? "business.done" : "business.cancel")}
      </Button>
      {!done ? <Button type="button" className="result-primary" disabled={busy || (target.kind === "tableData" && !selected.size)}
        onClick={() => void save()}>{t("databaseExport.save")}</Button> : null}
    </footer>
  </dialog>;
}
