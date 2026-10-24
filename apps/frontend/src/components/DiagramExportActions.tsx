import { useI18n } from "../i18n";
import { useRef } from "react";
import type { NodalStudioPlatform } from "../platform";
import { diagramPng, type DiagramSvg } from "../graph/diagram-export";
import { prepareSvgBytes } from "../graph/svg-bytes";
import { OperationFeedback } from "./OperationFeedback";
import { useOperation } from "./use-operation";

interface DiagramExportActionsProps {
  platform: NodalStudioPlatform;
  disabled?: boolean;
  capture: () => DiagramSvg | Promise<DiagramSvg>;
  fileName: (format: "svg" | "png") => string;
  scope?: string;
}

export function DiagramExportActions({ platform, disabled, capture, fileName, scope = "diagram" }: DiagramExportActionsProps) {
  const { t: bt } = useI18n();
  const operation = useOperation(scope);
  const formatRef = useRef<"svg" | "png">("svg");
  const exportDiagram = async (format: "svg" | "png") => {
    if (operation.busy || disabled) return;
    await operation.run(async (isCurrent) => {
      formatRef.current = format;
      await document.fonts?.ready;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      if (!isCurrent()) return "";
      for (const entry of performance.getEntriesByType("measure")) if (entry.name.startsWith("diagram-export:")) performance.clearMeasures(entry.name);
      const captureStarted = performance.now();
      const diagram = await capture();
      performance.measure("diagram-export:capture", { start: captureStarted, end: performance.now() });
      const bytesStarted = performance.now();
      const artifact = format === "png" ? await diagramPng(diagram) : diagram;
      const data = "blob" in artifact ? new Uint8Array(await artifact.blob.arrayBuffer()) : await prepareSvgBytes(diagram, isCurrent);
      performance.measure("diagram-export:bytes", { start: bytesStarted, end: performance.now() });
      if (!data || !isCurrent()) return "";
      const saveStarted = performance.now();
      const receipt = await platform.saveDiagramExport({ fileName: fileName(format), format, data });
      performance.measure("diagram-export:save", { start: saveStarted, end: performance.now() });
      return `${receipt.path ? `Saved to ${receipt.path}` : `Download started: ${fileName(format)}`} · ${artifact.width} × ${artifact.height}`;
    }, { running: bt("business.exportingDiagram", { value0: format.toUpperCase() }), success: (message) => message, failure: bt("business.unableToExportDiagram", { value0: format.toUpperCase() }) });
  };
  return <div className="diagram-export-actions" role="group" aria-label={bt("business.exportCurrentDiagram")}>
    <div>
      <button type="button" disabled={disabled || operation.busy} onClick={() => void exportDiagram("svg")} title={bt("business.exportAllTablesInTheCurrentDiagramIncludingThose")}>{bt("business.exportSVG")}</button>
      <button type="button" disabled={disabled || operation.busy} onClick={() => void exportDiagram("png")} title={bt("business.exportTheCurrentDiagramAsAPNGWithIts")}>{bt("business.exportPNG")}</button>
    </div>
    <OperationFeedback label={bt("business.diagramExport")} state={operation.state} onRetry={() => void exportDiagram(formatRef.current)} retryLabel={bt("business.retryDiagramExport")} retryDisabled={disabled} onDismiss={operation.dismiss} />
  </div>;
}
