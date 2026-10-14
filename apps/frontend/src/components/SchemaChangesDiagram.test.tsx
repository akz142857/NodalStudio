import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, NodalStudioPlatform } from "../platform";
import { defaultAppSettings } from "../platform";
import { buildSchemaGraph } from "../graph/schema-graph";
import { diagramAfter, diagramBefore, diagramChangeSet } from "../test/diagram-comparison-fixture";
import type { SchemaCanvasProps } from "./SchemaCanvas";
import { SchemaChangesDiagram } from "./SchemaChangesDiagram";

vi.mock("./SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => {
  const graph = buildSchemaGraph(props.snapshot, { changeSet: props.changeSet, beforeSnapshot: props.beforeSnapshot });
  return <div>{graph.nodes.map((node) => <p key={node.id}>{node.id}: {node.data.changeStatus ?? "unchanged"}</p>)}</div>;
} }));

function mount(getSnapshot: NodalStudioPlatform["getSnapshot"], web = false, snapshot = diagramAfter) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const props = { snapshot, changeSet: diagramChangeSet, query: "", onSelectTable: vi.fn(), canvasSettings: defaultAppSettings().canvas,
    platform: { getSnapshot } as unknown as NodalStudioPlatform, runtimeKind: web ? "web" as const : "desktop" as const };
  return { client, props, ...render(<QueryClientProvider client={client}><SchemaChangesDiagram {...props} /></QueryClientProvider>) };
}

describe("SchemaChangesDiagram", () => {
  it("adds historical objects when the Before snapshot loads and shows a legend", async () => {
    let complete!: (snapshot: DatabaseSnapshot) => void;
    const getSnapshot = vi.fn<NodalStudioPlatform["getSnapshot"]>().mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    mount(getSnapshot);
    expect(screen.getByText(/Loading Before snapshot/)).toBeVisible();
    expect(screen.queryByText("public.audit: deleted")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Diagram change legend")).toBeVisible();
    await act(async () => { complete(diagramBefore); await Promise.resolve(); });
    expect(await screen.findByText("public.audit: deleted")).toBeVisible();
    expect(screen.getByText("public.partners: added")).toBeVisible();
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith(diagramBefore.id);
  });

  it("keeps a partial Web diagram explicit and avoids unavailable history APIs", () => {
    const getSnapshot = vi.fn<NodalStudioPlatform["getSnapshot"]>();
    mount(getSnapshot, true);
    expect(screen.getByText(/Deleted objects cannot be reconstructed from summaries alone/)).toBeVisible();
    expect(screen.queryByText("public.audit: deleted")).not.toBeInTheDocument();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it("supports retry when history is unavailable", async () => {
    const getSnapshot = vi.fn<NodalStudioPlatform["getSnapshot"]>().mockRejectedValueOnce(new Error("History unavailable")).mockResolvedValueOnce(diagramBefore);
    mount(getSnapshot);
    expect(await screen.findByText(/History unavailable/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry Before snapshot" }));
    expect(await screen.findByText("public.audit: deleted")).toBeVisible();
  });

  it("cannot show another snapshot as the After diagram", () => {
    mount(vi.fn(), true, { ...diagramAfter, id: "unrelated" });
    expect(screen.getByText(/After snapshot unavailable/)).toBeVisible();
    expect(screen.queryByText("public.orders: modified")).not.toBeInTheDocument();
  });

  it("ignores a baseline response belonging to a previous comparison", async () => {
    let complete!: (snapshot: DatabaseSnapshot) => void;
    const getSnapshot = vi.fn<NodalStudioPlatform["getSnapshot"]>().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; })).mockResolvedValueOnce({ ...diagramAfter, id: "other-before" });
    const { client, props, rerender } = mount(getSnapshot);
    rerender(<QueryClientProvider client={client}><SchemaChangesDiagram {...props} changeSet={{ ...diagramChangeSet, beforeSnapshotId: "other-before", operations: [] }} /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByText(/Loading Before snapshot/)).not.toBeInTheDocument());
    await act(async () => { complete(diagramBefore); await Promise.resolve(); });
    expect(screen.queryByText("public.audit: deleted")).not.toBeInTheDocument();
  });
});
