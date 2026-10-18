import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform, type CaptureSnapshotResult, type SnapshotSummary } from "./platform";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";
import { discoverySettings } from "./test/discovery-fixture";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (r: CaptureSnapshotResult) => void }) => <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load business fixture</button> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => {
  const [viewport, setViewport] = useState("original");
  return props.temporaryViewLabel ? <div aria-label="Local business graph" /> : <section aria-label="Full model canvas" inert={props.interactionPaused}>
    <output data-testid="original-viewport">{viewport}</output><output data-testid="original-selection">{props.selectedTable?.key.name}</output><output data-testid="original-query">{props.query}</output><output data-testid="original-paused">{String(props.interactionPaused)}</output>
    <button onClick={() => { setViewport("custom viewport and layout"); props.onSelectTable(reportSnapshot.schemas[0].tables[0]); }}>Arrange original view</button>
  </section>;
} }));
function mount(latestId = reportSnapshot.id) {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Discovery runtime", version: "test" });
  vi.spyOn(platform, "getSettings").mockResolvedValue(discoverySettings());
  vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics);
  vi.spyOn(platform, "listSnapshots").mockResolvedValue([{ id: latestId } as SnapshotSummary]);
  const save = vi.spyOn(platform, "saveLayout");
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return { save };
}
describe("business discovery app integration", () => {
  beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());
  it("retains the mounted full canvas, layout, selection and filter after local graph browsing", async () => {
    const { save } = mount(); await screen.findByText("Discovery runtime"); fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    await screen.findByRole("button", { name: "Business question" });
    fireEvent.click(screen.getByRole("button", { name: "Arrange original view" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search schema" }), { target: { value: "customer" } });
    const original = screen.getByRole("region", { name: "Full model canvas" });
    fireEvent.click(screen.getByRole("button", { name: "Business question" }));
    expect(screen.getByTestId("original-paused")).toHaveTextContent("true");
    fireEvent.change(screen.getByLabelText("Business question"), { target: { value: "订单" } }); fireEvent.click(screen.getByRole("button", { name: "Search locally" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Expand relationships" })[0]); fireEvent.change(screen.getByLabelText("Local graph depth"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to previous view" }));
    expect(screen.getByRole("region", { name: "Full model canvas" })).toBe(original); expect(screen.getByTestId("original-viewport")).toHaveTextContent("custom viewport and layout"); expect(screen.getByTestId("original-selection")).toHaveTextContent("customers"); expect(screen.getByTestId("original-query")).toHaveTextContent("customer"); expect(screen.getByTestId("original-paused")).toHaveTextContent("false"); expect(save).not.toHaveBeenCalled();
  });
  it("explaining a candidate opens that table in the existing AI inspector", async () => {
    mount(); await screen.findByText("Discovery runtime"); fireEvent.click(screen.getByRole("button", { name: "Load business fixture" })); fireEvent.click(await screen.findByRole("button", { name: "Business question" }));
    fireEvent.change(screen.getByLabelText("Business question"), { target: { value: "orders" } }); fireEvent.click(screen.getByRole("button", { name: "Search locally" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Explain this table" })[0]).toBeEnabled());
    const card = screen.getByText("public.orders", { selector: "h4" }).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Explain this table" }));
    expect(screen.queryByRole("region", { name: "Business table discovery" })).toBeNull(); expect(screen.getByRole("region", { name: "Single-table understanding" })).toBeVisible(); expect(screen.getByTestId("original-selection")).toHaveTextContent("orders");
  });
  it("keeps the business entry out of historical snapshots", async () => {
    mount("newer-snapshot"); await screen.findByText("Discovery runtime"); fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Full model canvas" })).toBeVisible()); expect(screen.queryByRole("button", { name: "Business question" })).toBeNull();
  });
});

describe("discovery navigation regression", () => {
  beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());
  it("global table navigation exits discovery so the destination is visible", async () => {
    mount(); await screen.findByText("Discovery runtime");
    fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Business question" }));
    fireEvent.change(screen.getByLabelText("Business question"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Search locally" }));
    const globalSearch = screen.getByPlaceholderText("Table, field, schema…");
    fireEvent.change(globalSearch, { target: { value: "customers" } });
    fireEvent.keyDown(globalSearch, { key: "Enter" });
    expect(screen.getByTestId("original-selection")).toHaveTextContent("customers");
    expect(screen.queryByRole("region", { name: "Business table discovery" })).toBeNull();
    expect(screen.getByTestId("original-paused")).toHaveTextContent("false");
  });
});
