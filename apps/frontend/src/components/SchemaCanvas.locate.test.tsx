import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { layoutSchemaGraph } from "../graph/elk-layout";
import type { TableNode } from "../graph/schema-graph";
import { SchemaCanvas, type CanvasLocateRequest } from "./SchemaCanvas";

const viewport = vi.hoisted(() => ({ fit: vi.fn().mockResolvedValue(true), measured: true }));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return { ...actual, useNodesInitialized: () => viewport.measured, useReactFlow: () => ({ ...actual.useReactFlow(), fitView: viewport.fit }) };
});
vi.mock("../graph/elk-layout", async (original) => {
  const actual = await original<typeof import("../graph/elk-layout")>();
  return { ...actual, layoutSchemaGraph: vi.fn((nodes: TableNode[]) => Promise.resolve(nodes)) };
});
const canvas = defaultAppSettings().canvas;
const select = vi.fn();
const request = (revision = 1, nodeId = "archive.orders"): CanvasLocateRequest => ({ sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, revision, nodeId });
const fits = () => viewport.fit.mock.calls.filter(([options]) => (options as { nodes?: { id: string }[] }).nodes?.[0]?.id === "archive.orders");
function Diagram({ locate, snapshot = reportSnapshot, done, ready = true }: { locate?: CanvasLocateRequest; snapshot?: typeof reportSnapshot; done?: (request: CanvasLocateRequest) => void; ready?: boolean }) {
  return <SchemaCanvas runtimeKind="web" snapshot={snapshot} semantics={reportSemantics} query="" canvasSettings={canvas} onSelectTable={select} locateRequest={locate} onLocateComplete={done} navigationReady={ready} />;
}

describe("SchemaCanvas requested navigation", () => {
  beforeEach(() => {
    viewport.fit.mockClear(); viewport.measured = true;
    vi.mocked(layoutSchemaGraph).mockImplementation((nodes) => Promise.resolve(nodes));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("waits for final layout and node measurement before centering and selecting the requested table", async () => {
    let finish!: (nodes: TableNode[]) => void;
    let layoutNodes!: TableNode[];
    vi.mocked(layoutSchemaGraph).mockImplementationOnce((nodes) => { layoutNodes = nodes; return new Promise((resolve) => { finish = resolve; }); });
    viewport.measured = false;
    const done = vi.fn(); const locate = request();
    const { container, rerender } = render(<Diagram locate={locate} done={done} ready={false} />);
    expect(fits()).toHaveLength(0);
    await act(async () => { finish(layoutNodes.map((node) => ({ ...node, position: { x: 6000, y: 2000 } }))); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto layout" })).toBeEnabled());
    expect(fits()).toHaveLength(0);
    viewport.measured = true; rerender(<Diagram locate={locate} done={done} ready={false} />);
    expect(fits()).toHaveLength(0);
    rerender(<Diagram locate={locate} done={done} />);
    await waitFor(() => expect(fits()).toHaveLength(1));
    const options = fits()[0][0] as { nodes: TableNode[]; maxZoom: number };
    expect(options.nodes[0].position).toEqual({ x: 6000, y: 2000 });
    expect(options.maxZoom).toBe(1); expect(done).toHaveBeenCalledWith(locate);
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).toHaveClass("selected");
  });

  it("exits an isolated graph, restores a hidden table and supports locating it again", async () => {
    const { container, rerender } = render(<Diagram />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto layout" })).toBeEnabled());
    fireEvent.doubleClick(container.querySelector('.react-flow__node[data-id="public.customers"]')!);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).toBeNull());
    rerender(<Diagram locate={request(1)} />);
    await waitFor(() => expect(fits()).toHaveLength(1));
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).not.toBeNull();
    rerender(<Diagram locate={request(2)} />);
    await waitFor(() => expect(fits()).toHaveLength(2));
  });

  it("never replays an old source request after a snapshot switch or late layout completion", async () => {
    let finish!: (nodes: TableNode[]) => void; let layoutNodes!: TableNode[];
    vi.mocked(layoutSchemaGraph).mockImplementationOnce((nodes) => { layoutNodes = nodes; return new Promise((resolve) => { finish = resolve; }); });
    const locate = request(); const done = vi.fn();
    const { rerender } = render(<Diagram locate={locate} done={done} />);
    rerender(<Diagram snapshot={{ ...reportSnapshot, id: "other-snapshot", sourceId: "other-source" }} locate={locate} done={done} />);
    await act(async () => { finish(layoutNodes); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto layout" })).toBeEnabled());
    expect(fits()).toHaveLength(0); expect(done).not.toHaveBeenCalled();
  });
});
