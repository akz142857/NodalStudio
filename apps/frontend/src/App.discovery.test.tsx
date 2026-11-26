import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform, type CaptureSnapshotResult } from "./platform";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";
import { discoverySettings } from "./test/discovery-fixture";
let loadedDialect: "postgreSql" | "mySql" | "sqlite" = "postgreSql";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (r: CaptureSnapshotResult) => void }) => <button onClick={() => onSnapshot({ snapshot: { ...reportSnapshot, database: { ...reportSnapshot.database, databaseType: loadedDialect } }, stored: true, changeSet: null })}>Load business fixture</button> }));
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
  vi.spyOn(platform, "listRecentSnapshotIds").mockResolvedValue([latestId]);
  const save = vi.spyOn(platform, "saveLayout");
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return { save };
}
describe("business discovery app integration", () => {
  beforeEach(() => { localStorage.clear(); loadedDialect = "postgreSql"; }); afterEach(() => vi.restoreAllMocks());
  it("retains the mounted full canvas, layout, selection and filter after local graph browsing", async () => {
    const { save } = mount(); await screen.findByText("Discovery runtime"); fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Arrange original view" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "customer" } });
    const original = screen.getByRole("region", { name: "Full model canvas" });
    fireEvent.click(screen.getByRole("button", { name: "View relationships" }));
    expect(screen.getByTestId("original-paused")).toHaveTextContent("true");
    expect(screen.getByLabelText("Local business graph")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Local graph depth"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to previous view" }));
    expect(screen.getByRole("region", { name: "Full model canvas" })).toBe(original); expect(screen.getByTestId("original-viewport")).toHaveTextContent("custom viewport and layout"); expect(screen.getByTestId("original-selection")).toHaveTextContent("customers"); expect(screen.getByTestId("original-query")).toHaveTextContent("customer"); expect(screen.getByTestId("original-paused")).toHaveTextContent("false"); expect(save).not.toHaveBeenCalled();
  });
  it("explaining a candidate opens that table in the existing AI inspector", async () => {
    mount(); await screen.findByText("Discovery runtime"); fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "View relationships" }));
    fireEvent.click(screen.getByText("Advanced table discovery"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Explain this table" })[0]).toBeEnabled());
    const card = screen.getByText("public.orders", { selector: "h4" }).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Explain this table" }));
    expect(screen.queryByRole("region", { name: "View relationships" })).toBeNull(); expect(screen.getByRole("region", { name: "Single-table understanding" })).toBeVisible(); expect(screen.getByTestId("original-selection")).toHaveTextContent("orders");
  });
  it("opens MySQL drafting from a business candidate with its question and table context", async () => {
    loadedDialect = "mySql";
    mount(); await screen.findByText("Discovery runtime");
    fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "订单" } });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("public");
    fireEvent.click(await screen.findByRole("button", { name: "Use in Query" }));
    expect(await screen.findByRole("tab", { name: "Draft query" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Question")).toHaveValue("");
    expect(screen.getByLabelText("Query conversation")).toHaveTextContent("订单");
    expect(screen.getByRole("region", { name: "Query context" })).toHaveTextContent("public.orders");
    expect(screen.getByRole("button", { name: /^Run/ })).toBeDisabled();
  });
  it("keeps Query mounted under relationship browsing and opens a new search seed in Draft query", async () => {
    mount();
    await screen.findByText("Discovery runtime");
    fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Query" }));
    const editorTab = await screen.findByRole("tab", { name: "SQL editor" });
    const search = screen.getByRole("combobox", { name: "Search schema" });
    fireEvent.change(search, { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "View relationships" }));
    const back = screen.getByRole("button", { name: "Back to previous view" });
    expect(back).toHaveFocus();
    expect(editorTab.closest("[inert]")).not.toBeNull();
    fireEvent.keyDown(back, { key: "Escape" });
    expect(screen.getByRole("tab", { name: "SQL editor" })).toBe(editorTab);
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(search, { target: { value: "customers" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use in Query" }));
    expect(screen.getByRole("tab", { name: "Draft query" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Query conversation")).toHaveTextContent("customers");
  });
  it("keeps the query action out of stale snapshots and removes the separate entry", async () => {
    mount("newer-snapshot"); await screen.findByText("Discovery runtime"); fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Full model canvas" })).toBeVisible());
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "orders" } });
    expect(screen.queryByRole("button", { name: "Use in Query" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Business question" })).toBeNull();
  });
});

describe("discovery navigation regression", () => {
  beforeEach(() => { localStorage.clear(); loadedDialect = "postgreSql"; }); afterEach(() => vi.restoreAllMocks());
  it("global table navigation exits discovery so the destination is visible", async () => {
    mount(); await screen.findByText("Discovery runtime");
    fireEvent.click(screen.getByRole("button", { name: "Load business fixture" }));
    const globalSearch = screen.getByRole("combobox", { name: "Search schema" });
    fireEvent.change(globalSearch, { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "View relationships" }));
    fireEvent.change(globalSearch, { target: { value: "customers" } });
    fireEvent.keyDown(globalSearch, { key: "Enter" });
    expect(screen.getByTestId("original-selection")).toHaveTextContent("customers");
    expect(screen.queryByRole("region", { name: "View relationships" })).toBeNull();
    expect(screen.getByTestId("original-paused")).toHaveTextContent("false");
  });
});
