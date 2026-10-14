import { useRef } from "react";
import type { NodalStudioPlatform } from "../platform";
import { diagramPng, type DiagramSvg } from "../graph/diagram-export";
import { OperationFeedback } from "./OperationFeedback";
import { useOperation } from "./use-operation";

interface DiagramExportActionsProps {
  platform: NodalStudioPlatform;
  disabled?: boolean;
  capture: () => DiagramSvg;
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
      const diagram = capture();
      const artifact = format === "png" ? await diagramPng(diagram) : { blob: new Blob([diagram.svg], { type: "image/svg+xml;charset=utf-8" }), width: diagram.width, height: diagram.height };
      const data = Array.from(new Uint8Array(await artifact.blob.arrayBuffer()));
      if (!isCurrent()) return "";
      const receipt = await platform.saveDiagramExport({ fileName: fileName(format), format, data });
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
