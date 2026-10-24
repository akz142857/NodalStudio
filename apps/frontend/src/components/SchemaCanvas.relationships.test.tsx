import { canvasToolButton } from "../test/canvas-tools";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldEdge, TableNode } from "../graph/schema-graph";
import { defaultAppSettings } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { SchemaCanvas, type SchemaCanvasProps } from "./SchemaCanvas";

// Keep the real store and components; deliver edge activation without jsdom geometry.
const flow = vi.hoisted(() => ({ props: undefined as ReactFlowProps<TableNode, FieldEdge> | undefined }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  const { forwardRef, useLayoutEffect } = await import("react");
  return { ...actual, ReactFlow: forwardRef<HTMLDivElement, ReactFlowProps<TableNode, FieldEdge>>((props, ref) => {
    useLayoutEffect(() => { flow.props = props; });
    return <actual.ReactFlow {...props} ref={ref} />;
  }) };
});
vi.mock("../graph/elk-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph/elk-layout")>();
  return { ...actual, layoutSchemaGraph: (nodes: TableNode[]) => Promise.resolve(nodes) };
});
function CanvasHarness(props: Partial<SchemaCanvasProps>) {
  return <div style={{ width: 1200, height: 700 }}><SchemaCanvas snapshot={reportSnapshot} semantics={reportSemantics} query="" canvasSettings={defaultAppSettings().canvas} onSelectTable={() => {}} runtimeKind="desktop" {...props} /></div>;
}
const logicalEdge = () => flow.props?.edges?.find((edge) => edge.id === "logical.private-logical-id.0");
async function selectLogicalEdge() {
  await waitFor(() => expect(logicalEdge()).toBeDefined());
  act(() => { flow.props!.onEdgeClick!(new MouseEvent("click", { clientX: 400, clientY: 300 }) as unknown as ReactMouseEvent, logicalEdge()!); });
}
describe("Model relationship deletion", () => {
  beforeEach(() => {
    // jsdom has no native dialog top layer; browser fixture covers actual modality.
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    localStorage.clear();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });
  const relationshipActions = {
    onValidateLogicalRelationship: vi.fn(),
    onCreateLogicalRelationship: vi.fn(),
  };

  it("deletes a model relationship through app confirmation even when window.confirm is unavailable", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const removed = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    function DeletionHarness() {
      const [semantics, setSemantics] = useState(reportSemantics);
      return <CanvasHarness {...relationshipActions} semantics={semantics} onDeleteLogicalRelationship={async (id) => {
        await removed(id);
        setSemantics((current) => ({ ...current, logicalRelationships: current.logicalRelationships.filter((item) => item.id !== id) }));
      }} />;
    }
    render(<DeletionHarness />);
    await selectLogicalEdge();
    fireEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete model relationship?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).getByText(/Database tables, data and foreign key constraints stay unchanged/)).toBeVisible();
    expect(removed).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(logicalEdge()).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete relationship" }));
    await waitFor(() => expect(logicalEdge()).toBeUndefined());
    expect(removed).toHaveBeenCalledExactlyOnceWith("private-logical-id");
    expect(confirm).not.toHaveBeenCalled();
    expect(flow.props!.edges!.some((edge) => edge.data?.relationshipKind === "physical")).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the same confirmation for keyboard deletion, shows failures and permits retry", async () => {
    let reject!: (reason: Error) => void;
    const remove = vi.fn<(id: string) => Promise<void>>().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
    render(<CanvasHarness {...relationshipActions} onDeleteLogicalRelationship={remove} />);
    await selectLogicalEdge();
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.click(screen.getByRole("button", { name: "Delete relationship" }));
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(remove).toHaveBeenCalledOnce();
    await act(async () => { reject(new Error("Local model is temporarily locked")); await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("Local model is temporarily locked");
    expect(logicalEdge()).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete relationship" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("confirms manager deletion and drops the pending request when the source changes", () => {
    const remove = vi.fn();
    const { rerender } = render(<CanvasHarness {...relationshipActions} onDeleteLogicalRelationship={remove} />);
    fireEvent.click(canvasToolButton("Manage logical relationships"));
    fireEvent.click(screen.getByLabelText("More relationship actions"));
    fireEvent.click(screen.getByRole("button", { name: "Delete relationship…" }));
    expect(screen.getByRole("dialog", { name: "Delete model relationship?" })).toBeVisible();
    rerender(<CanvasHarness {...relationshipActions} snapshot={{ ...reportSnapshot, sourceId: "other-source" }} onDeleteLogicalRelationship={remove} />);
    expect(screen.queryByRole("dialog", { name: "Delete model relationship?" })).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["physical", "read-only"])("never offers deletion for %s relationships", async (kind) => {
    const remove = vi.fn();
    render(<CanvasHarness {...(kind === "physical" ? relationshipActions : {})} onDeleteLogicalRelationship={remove} />);
    await waitFor(() => expect(flow.props?.edges?.length).toBeGreaterThan(0));
    const edge = flow.props!.edges!.find((item) => item.data?.relationshipKind === (kind === "physical" ? "physical" : "logical"))!;
    act(() => { flow.props!.onEdgeClick!(new MouseEvent("click", { clientX: 400, clientY: 300 }) as unknown as ReactMouseEvent, edge); });
    expect(screen.getByRole("complementary", { name: "Relationship details" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete…" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(screen.queryByRole("dialog", { name: "Delete model relationship?" })).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });
});
