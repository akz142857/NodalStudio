import { Position } from "@xyflow/react";
import { expect, it } from "vitest";
import { buildSchemaGraph } from "./schema-graph";
import { applyStoredPositions, serializeCanvasLayout } from "./elk-layout";
import { reportSnapshot } from "../test/schema-report-fixture";
import { diagramTable } from "../test/diagram-comparison-fixture";

it.each([true, false])("gives large offscreen nodes usable sizes and ports, restoring resized and pinned geometry (field=%s)", (fieldLevelEdges) => {
  const snapshot = { ...reportSnapshot, schemas: [{ ...reportSnapshot.schemas[0], tables: [...reportSnapshot.schemas[0].tables, ...Array.from({ length: 98 }, (_, i) => diagramTable(`padding_${i}`))] }] };
  const graph = buildSchemaGraph(snapshot, { fieldLevelEdges, showTableComments: false });
  const orders = graph.nodes.find((node) => node.id === "public.orders")!;
  expect(orders.measured?.width).toBe(280);
  expect(orders.handles?.some((handle) => handle.id === (fieldLevelEdges ? "source:customer_id:right" : "table-source-right"))).toBe(true);
  expect(orders.data.initialColumnCenters?.id).toBe(55.5);
  const stored = serializeCanvasLayout(graph.nodes);
  stored[orders.id] = { x: -100, y: 500, width: 440, height: 800, pinned: true };
  const restored = applyStoredPositions(graph.nodes, stored)!.find((node) => node.id === orders.id)!;
  expect(restored.measured).toEqual({ width: 440, height: 800 });
  expect(restored.width).toBe(440); expect(restored.height).toBe(800);
  expect(restored.handles?.filter((handle) => handle.position === Position.Right).every((handle) => handle.x === 440)).toBe(true);
  expect(restored.data.layoutPinned).toBe(true);
  expect(restored.data.initialColumnCenters?.id).toBe(55.5);
  expect(restored.position).toEqual({ x: -100, y: 500 });
});
