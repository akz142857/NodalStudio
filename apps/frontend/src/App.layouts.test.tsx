import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotResult, SemanticBundle } from "./platform";
import { getPlatform } from "./platform";
import { reportSnapshot, reportSemantics } from "./test/schema-report-fixture";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { App } from "./App";

const positions = { "public.orders": { x: 100, y: 200, width: 280, height: 300 } };
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <button onClick={() => onSnapshot({ snapshot: reportSnapshot, changeSet: null, stored: true })}>Capture layout source</button> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => {
  const [result, setResult] = useState("");
  return <><p>{props.layoutLoaded ? "Layout loaded" : "Layout loading"}</p>
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

  it("returns platform failures to the canvas and saves with the current source's global view id", async () => {
    const { platform, getSemantics } = mount();
    getSemantics.mockResolvedValue(reportSemantics);
    const save = vi.spyOn(platform, "saveLayout").mockRejectedValueOnce(new Error("layout storage failed")).mockResolvedValue(undefined);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture layout source" }));
    await screen.findByText("Layout loaded");
    fireEvent.click(screen.getByRole("button", { name: "Save test layout" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("layout storage failed"));
    expect(save).toHaveBeenCalledWith(reportSnapshot.sourceId, null, positions);
    fireEvent.click(screen.getByRole("button", { name: "Save test layout" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save completed"));
  });
});
