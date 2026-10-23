import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotResult, SemanticBundle } from "./platform";
import { getPlatform } from "./platform";
import { reportSnapshot, reportSemantics } from "./test/schema-report-fixture";
import type { ComponentProps } from "react";
import type { InspectorPanel } from "./components/InspectorPanel";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { App } from "./App";

vi.mock("./components/InspectorPanel", () => ({ InspectorPanel: (props: ComponentProps<typeof InspectorPanel>) => <button onClick={() => props.onSelectSnapshot({ ...reportSnapshot, id: "older-snapshot" })}>Open historical model</button> }));

const positions = { "public.orders": { x: 100, y: 200, width: 280, height: 300 } };
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <button onClick={() => onSnapshot({ snapshot: reportSnapshot, changeSet: null, stored: true })}>Capture layout source</button> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => {
  const [result, setResult] = useState("");
  return <><p>{props.layoutLoaded ? "Layout loaded" : "Layout loading"}</p>
    <p>{props.savedView?.name ?? "Full workspace"}</p>
    <p>{props.temporaryViewLabel}</p>
    <button onClick={() => props.onApplyView?.(props.semantics?.savedViews[0])}>Open saved workspace</button>
    <button disabled={!props.layoutLoaded} onClick={() => {
      void Promise.resolve(props.onSaveLayout?.(positions)).then(() => setResult("Save completed"), (reason: unknown) => setResult(reason instanceof Error ? reason.message : "Save failed"));
    }}>Save test layout</button><p role="status">{result}</p></>;
} }));

function mount() {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
  const getSemantics = vi.spyOn(platform, "getSemantics");
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return { platform, getSemantics };
}

describe("App layout persistence wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens layout saving only after the loaded snapshot's semantics finish loading", async () => {
    const { getSemantics } = mount();
    let finish!: (bundle: SemanticBundle) => void;
    getSemantics.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture layout source" }));
    expect(screen.getByText("Layout loading")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save test layout" })).toBeDisabled();
    act(() => { finish(reportSemantics); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save test layout" })).toBeEnabled());
  });

  it("saves independent view layouts and blocks historical writes even when invoked directly", async () => {
    const { platform, getSemantics } = mount();
    const view = { id: "view-a", sourceId: reportSnapshot.sourceId, name: "Orders workspace", rootTableKeys: [reportSnapshot.schemas[0].tables[0].key], relationshipDepth: 0, updatedAt: "now" };
    getSemantics.mockResolvedValue({ ...reportSemantics, savedViews: [view] });
    const save = vi.spyOn(platform, "saveLayout").mockResolvedValue(undefined);
    vi.spyOn(platform, "listSnapshots").mockResolvedValue([{ id: reportSnapshot.id, sourceId: reportSnapshot.sourceId, fingerprint: reportSnapshot.fingerprint, capturedAt: reportSnapshot.capturedAt, databaseName: reportSnapshot.database.name, schemaCount: 2, tableCount: 3 }]);
    vi.spyOn(platform, "getSnapshot").mockResolvedValue(reportSnapshot);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture layout source" }));
    await screen.findByText("Layout loaded");
    fireEvent.click(screen.getByRole("button", { name: "Open saved workspace" }));
    await screen.findByText("Orders workspace");
    fireEvent.click(screen.getByRole("button", { name: "Save test layout" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(reportSnapshot.sourceId, view.id, positions, undefined, reportSnapshot.id));
    fireEvent.click(screen.getByRole("button", { name: "Open historical model" }));
    await screen.findByText("Historical snapshot.");
    await screen.findByText("Layout loaded");
    fireEvent.click(screen.getByRole("button", { name: "Save test layout" }));
    await screen.findByText(/Historical layouts are temporary/);
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Return to latest model" }));
    await screen.findByText("Orders workspace");
    expect(screen.queryByText("Historical snapshot.")).not.toBeInTheDocument();
  });

  it("returns platform failures to the canvas and saves with the current source's global view id", async () => {
    const { platform, getSemantics } = mount();
    getSemantics.mockResolvedValue(reportSemantics);
    const save = vi.spyOn(platform, "saveLayout").mockRejectedValueOnce(new Error("layout storage failed")).mockResolvedValue(undefined);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture layout source" }));
    await screen.findByText("Layout loaded");
    fireEvent.click(screen.getByRole("button", { name: "Save test layout" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("layout storage failed"));
    expect(save).toHaveBeenCalledWith(reportSnapshot.sourceId, null, positions, undefined, reportSnapshot.id);
    fireEvent.click(screen.getByRole("button", { name: "Save test layout" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save completed"));
  });
});
