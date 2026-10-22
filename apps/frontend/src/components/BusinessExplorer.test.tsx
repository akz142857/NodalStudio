import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { discoverySettings } from "../test/discovery-fixture";
import { objectId } from "../graph/business-discovery";
import { BusinessExplorer } from "./BusinessExplorer";
const canvas = vi.hoisted(() => vi.fn<(props: import("./SchemaCanvas").SchemaCanvasProps) => void>());
vi.mock("./SchemaCanvas", () => ({ SchemaCanvas: (props: import("./SchemaCanvas").SchemaCanvasProps) => { canvas(props); return <div aria-label="Temporary graph" />; } }));
function props() {
  const mocks = { listSnapshots: vi.fn().mockResolvedValue([{ id: reportSnapshot.id }]), prepareDiscovery: vi.fn(), runDiscovery: vi.fn(), cancelDiscovery: vi.fn().mockResolvedValue(undefined) };
  return { platform: mocks as unknown as NodalStudioPlatform, mocks, snapshot: reportSnapshot, semantics: reportSemantics, settings: discoverySettings(), desktop: true, onClose: vi.fn(), onLocate: vi.fn(), onExplain: vi.fn(), onOpenSettings: vi.fn() };
}
function search(value: string) { fireEvent.change(screen.getByLabelText("Business question"), { target: { value } }); fireEvent.click(screen.getByRole("button", { name: "Search locally" })); }
describe("business exploration flow", () => {
  it("hands the business question and chosen table to Query without sending to AI", async () => {
    const p = props(); const onDraftQuery = vi.fn(); render(<BusinessExplorer {...p} onDraftQuery={onDraftQuery} />);
    search("orders"); await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "Draft query" })[0]);
    expect(onDraftQuery).toHaveBeenCalledWith(expect.objectContaining({ question: "orders", sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, domainId: null }));
    expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled(); expect(p.mocks.runDiscovery).not.toHaveBeenCalled();
  });
  it("local search/graph never call AI, keep original state immutable, and hand off explicit table actions", async () => {
    const p = props(); const original = JSON.stringify([p.snapshot, p.semantics]); render(<BusinessExplorer {...p} />);
    search("订单"); await waitFor(() => expect(screen.getAllByRole("button", { name: "Explain this table" })[0]).toBeEnabled());
    expect(screen.getByText("public.orders", { selector: "h4" })).toBeVisible(); expect(screen.getByText("archive.orders", { selector: "h4" })).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Expand relationships" })[0]);
    expect(screen.getByLabelText("Local graph depth")).toHaveValue("1"); fireEvent.change(screen.getByLabelText("Local graph depth"), { target: { value: "2" } });
    expect(canvas.mock.lastCall![0].temporaryViewLabel).toContain("temporary local view"); expect(canvas.mock.lastCall![0].onSaveLayout).toBeUndefined();
    expect(JSON.stringify([p.snapshot, p.semantics])).toBe(original); expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled(); expect(p.mocks.runDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Locate table" })[0]); expect(p.onLocate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole("button", { name: "Explain this table" })[0]); expect(p.onExplain).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Back to previous view" })); expect(p.onClose).toHaveBeenCalledOnce();
  });
  it("distinguishes absent paths from business unrelatedness, computes two hops and keeps AI scope", async () => {
    const p = props(); render(<BusinessExplorer {...p} />);
    const root = reportSnapshot.schemas[0].tables[0]; const target = reportSnapshot.schemas[1].tables[0];
    fireEvent.change(screen.getByLabelText("Explicit root table"), { target: { value: objectId(root.key) } });
    fireEvent.change(screen.getByLabelText("Path destination"), { target: { value: objectId(target.key) } });
    expect(screen.getByText(/does not prove the tables are unrelated/)).toBeVisible();
    expect(canvas.mock.lastCall![0].semantics?.logicalRelationships).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Local graph depth"), { target: { value: "2" } });
    expect(screen.getByText("public.customers ↔ public.orders ↔ archive.orders")).toBeVisible();
    expect(canvas.mock.lastCall![0].semantics?.logicalRelationships).toHaveLength(1);
    expect(screen.getByText("Physical FK")).toBeVisible(); expect(screen.getByText("Confirmed logical relationship · model only")).toBeVisible();
    expect(p.settings.source!.ai.contextScope).toBe("oneHop"); await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
  it("keeps local domain separate from explicitly selected AI domain and blocks CurrentTable ranking", async () => {
    const p = props(); p.settings.source!.ai.contextScope = "domain"; render(<BusinessExplorer {...p} />); search("orders");
    fireEvent.change(screen.getByLabelText("Local search domain"), { target: { value: "domain-private-id" } });
    fireEvent.change(screen.getByLabelText("AI operation"), { target: { value: "rank" } });
    expect(screen.getByLabelText("AI send domain")).toHaveValue(""); expect(screen.queryByRole("button", { name: "Prepare discovery preview" })).toBeNull();
    expect(screen.queryByText("archive.orders", { selector: "h4" })).toBeNull();
    await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
  it("reports no result and offers ambiguity choices without network or invented objects", async () => {
    const p = props(); render(<BusinessExplorer {...p} />); search("account unknown_business");
    expect(screen.getByText(/No reliable local candidates/)).toBeVisible(); expect(screen.getByRole("button", { name: "Financial account" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Login identity" })); expect(screen.getByLabelText("Business question")).toHaveValue("account unknown_business login identity 登录");
    expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled(); await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
  it("renders five candidates initially and permits more without auto-ranking", async () => {
    const p = props(); const snapshot = structuredClone(reportSnapshot); snapshot.schemas[0].tables = Array.from({ length: 9 }, (_, i) => ({ ...snapshot.schemas[0].tables[1], key: { kind: "table", schema: "public", name: `orders_${i}` } })); snapshot.schemas[1].tables = [];
    render(<BusinessExplorer {...p} snapshot={snapshot} />); search("orders"); expect(screen.getAllByRole("button", { name: "Locate table" })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show more candidates" })); expect(screen.getAllByRole("button", { name: "Locate table" })).toHaveLength(9);
    expect(p.mocks.runDiscovery).not.toHaveBeenCalled(); await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
  it("does not enable AI for a historical snapshot or restore previous question results after model changes", async () => {
    const p = props(); p.mocks.listSnapshots.mockResolvedValue([{ id: "newer" }]); const view = render(<BusinessExplorer {...p} />); search("orders");
    await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled()); expect(screen.queryByRole("button", { name: "Prepare discovery preview" })).toBeNull();
    view.rerender(<BusinessExplorer {...p} snapshot={{ ...reportSnapshot, id: "another-model" }} />); view.rerender(<BusinessExplorer {...p} />);
    expect(screen.getByLabelText("Business question")).toHaveValue(""); expect(screen.queryByRole("button", { name: "Locate table" })).toBeNull();
  });
});
