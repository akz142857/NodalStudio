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
    }, { running: `Exporting diagram… ${format.toUpperCase()}`, success: (message) => message, failure: `Unable to export ${format.toUpperCase()} diagram.` });
  };
  return <div className="diagram-export-actions" role="group" aria-label="Export current diagram">
    <div>
      <button type="button" disabled={disabled || operation.busy} onClick={() => void exportDiagram("svg")} title="Export all tables in the current diagram, including those outside the viewport, with the current layout and legend">Export SVG</button>
      <button type="button" disabled={disabled || operation.busy} onClick={() => void exportDiagram("png")} title="Export the current diagram as a PNG with its theme and legend">Export PNG</button>
    </div>
    <OperationFeedback label="Diagram export" state={operation.state} onRetry={() => void exportDiagram(formatRef.current)} retryLabel="Retry diagram export" retryDisabled={disabled} onDismiss={operation.dismiss} />
  </div>;
}
