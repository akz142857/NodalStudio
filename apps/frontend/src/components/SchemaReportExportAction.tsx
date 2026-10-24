import { useI18n } from "../i18n";
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
  const { t: bt } = useI18n();
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
      return bt("business.tablesColumns", { value0: receipt.path ? `Saved to ${receipt.path}` : `Download started: ${fileName}`, value1: report.tableCount, value2: report.columnCount });
    }, { running: kind === "viewer" ? bt("business.exportingOfflineViewer") : bt("business.exportingReport"), success: (message) => message, failure: kind === "viewer" ? bt("business.unableToExportOfflineViewer") : bt("business.unableToExportHTMLReport") });
  };

  return <div className="schema-report-export">
    <IconButton icon="report" label={operation.busy && format === "report" ? bt("business.exportingReport") : bt("business.exportHTMLReport")}
      aria-busy={operation.busy && format === "report"} disabled={!semantics || operation.busy} onClick={() => void exportReport()}
      description={!semantics ? bt("business.theSemanticModelMustFinishLoadingBeforeExportingA") : bt("business.exportAStandaloneHTMLDataDictionaryForTheEntire")} />
    <IconButton icon="viewer" label={operation.busy && format === "viewer" ? bt("business.exportingOfflineViewer") : bt("business.exportOfflineViewer")}
      aria-busy={operation.busy && format === "viewer"} disabled={!semantics || operation.busy} onClick={() => void exportReport("viewer")}
      description={!semantics ? bt("business.theCurrentSemanticModelMustFinishLoadingBeforeExport") : bt("business.exportOneEntireLoadedSnapshotAndCurrentSavedSemantics")} />
    {operation.state ? <div className="schema-report-result">
      <OperationFeedback label={bt("business.hTMLExport")} state={operation.state} onRetry={() => void exportReport(format)} retryLabel={format === "viewer" ? bt("business.retryViewerExport") : bt("business.retryReportExport")} retryDisabled={!semantics} onDismiss={operation.dismiss} dismissLabel="Dismiss report export result" />
    </div> : null}
  </div>;
}
