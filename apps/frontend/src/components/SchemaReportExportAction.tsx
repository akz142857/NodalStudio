import { useState } from "react";
import type { DatabaseSnapshot, NodalStudioPlatform, SemanticBundle } from "../platform";
import { createSchemaReport, schemaReportFileName } from "../reports/schema-report";
import { OperationFeedback } from "./OperationFeedback";
import { IconButton } from "./IconButton";
import { useOperation } from "./use-operation";

interface SchemaReportExportActionProps {
  snapshot: DatabaseSnapshot;
  semantics?: SemanticBundle;
  platform: NodalStudioPlatform;
}

export function SchemaReportExportAction({ snapshot, semantics, platform }: SchemaReportExportActionProps) {
  const operation = useOperation(JSON.stringify([snapshot.sourceId, snapshot.id, snapshot.fingerprint]));
  const [format, setFormat] = useState<"report" | "viewer">("report");

  const exportReport = async (kind: "report" | "viewer" = "report") => {
    if (!semantics || operation.busy) return;
    setFormat(kind);
    await operation.run(async (isCurrent) => {
      // Paint the pending state before generating a potentially large dictionary.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      if (!isCurrent()) return "";
      const viewer = kind === "viewer" ? await import("../reports/offline-viewer") : undefined;
      const report = viewer ? await viewer.createOfflineViewer(snapshot, semantics) : createSchemaReport(snapshot, semantics);
      const fileName = viewer ? viewer.offlineViewerFileName(snapshot) : schemaReportFileName(snapshot);
      if (!isCurrent()) return "";
      const receipt = await platform.saveSchemaReport({ fileName, html: report.html });
      return `${receipt.path ? `Saved to ${receipt.path}` : `Download started: ${fileName}`} · ${report.tableCount} tables · ${report.columnCount} columns`;
    }, { running: kind === "viewer" ? "Exporting offline Viewer…" : "Exporting report…", success: (message) => message, failure: kind === "viewer" ? "Unable to export offline Viewer." : "Unable to export HTML report." });
  };

  return <div className="schema-report-export">
    <IconButton icon="report" label={operation.busy && format === "report" ? "Exporting report…" : "Export HTML report"}
      aria-busy={operation.busy && format === "report"} disabled={!semantics || operation.busy} onClick={() => void exportReport()}
      description={!semantics ? "The semantic model must finish loading before exporting a report" : "Export a standalone HTML data dictionary for the entire loaded snapshot, with saved business semantics"} />
    <IconButton icon="viewer" label={operation.busy && format === "viewer" ? "Exporting offline Viewer…" : "Export offline Viewer"}
      aria-busy={operation.busy && format === "viewer"} disabled={!semantics || operation.busy} onClick={() => void exportReport("viewer")}
      description={!semantics ? "The current semantic model must finish loading before export" : "Export one entire loaded snapshot and current saved semantics as a read-only offline HTML Viewer; no history, database access or writeback. Independent of Diagram filters; maximum 500 tables / 5,000 columns / 5,000 relationships."} />
    {operation.state ? <div className="schema-report-result">
      <OperationFeedback label="HTML export" state={operation.state} onRetry={() => void exportReport(format)} retryLabel={format === "viewer" ? "Retry Viewer export" : "Retry report export"} retryDisabled={!semantics} onDismiss={operation.dismiss} dismissLabel="Dismiss report export result" />
    </div> : null}
  </div>;
}
