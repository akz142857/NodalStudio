import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotResult, DomainGroup, ObjectKey } from "./platform";
import { getPlatform } from "./platform";
import { reportSnapshot, reportSemantics } from "./test/schema-report-fixture";
import { DiagramSelectionActions } from "./components/DiagramSelectionActions";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { App } from "./App";

vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, changeSet: null, stored: true })}>Capture first source</button>
  <button onClick={() => onSnapshot({ snapshot: { ...reportSnapshot, id: "other-snapshot", sourceId: "other-source" }, changeSet: null, stored: true })}>Capture other source</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => {
  const [selected, setSelected] = useState<ObjectKey[]>([]);
  return <>
    <button onClick={() => setSelected([props.snapshot.schemas[0].tables[1].key, props.snapshot.schemas[1].tables[0].key])}>Select both orders tables</button>
    <p>Domain members: {props.semantics?.domainGroups[0]?.tableKeys.length}</p>
    <p>Domain description: {props.semantics?.domainGroups[0]?.description}</p>
    <p>Annotation: {props.semantics?.annotations[0]?.description}</p>
    <DiagramSelectionActions snapshot={props.snapshot} selectedCount={selected.length} selectedTableKeys={selected} domainGroups={props.semantics?.domainGroups ?? []} onClear={() => setSelected([])} onAddTablesToDomain={props.onAddTablesToDomain} />
  </>;
} }));

function mount() {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
  const firstSemantics = { ...reportSemantics, domainGroups: [{ ...reportSemantics.domainGroups[0], tableKeys: [reportSnapshot.schemas[0].tables[0].key] }] };
  vi.spyOn(platform, "getSemantics").mockImplementation((sourceId) => Promise.resolve(sourceId === reportSnapshot.sourceId ? firstSemantics : { ...firstSemantics, domainGroups: [{ ...firstSemantics.domainGroups[0], sourceId: "other-source", description: "Other source meaning" }] }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return { platform, firstSemantics };
}

async function selectTablesAndDomain() {
  await screen.findByText("Desktop runtime");
  fireEvent.click(screen.getByRole("button", { name: "Capture first source" }));
  await screen.findByText("Domain members: 1");
  fireEvent.click(screen.getByRole("button", { name: "Select both orders tables" }));
  fireEvent.click(screen.getByRole("button", { name: "Business domain" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Existing business domain" }), { target: { value: reportSemantics.domainGroups[0].id } });
}

describe("App batch domain membership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves a union into the existing domain and updates its color/membership data without replacing other semantics", async () => {
    const { platform, firstSemantics } = mount();
    const save = vi.spyOn(platform, "saveDomainGroup").mockImplementation((input) => Promise.resolve({ ...input, id: input.id!, updatedAt: "2026-10-13T12:00:00Z" }));
    await selectTablesAndDomain();
    fireEvent.click(screen.getByRole("button", { name: "Add to domain" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toEqual({ id: firstSemantics.domainGroups[0].id, sourceId: reportSnapshot.sourceId, name: "Commerce", description: firstSemantics.domainGroups[0].description, color: firstSemantics.domainGroups[0].color,
      tableKeys: [reportSnapshot.schemas[0].tables[0].key, reportSnapshot.schemas[0].tables[1].key, reportSnapshot.schemas[1].tables[0].key] });
    expect(await screen.findByText("Domain members: 3")).toBeVisible();
    expect(screen.getByText("Annotation: 订单：记录已确认的购买意图")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Added 2 tables to Commerce.");
    expect(screen.getByRole("button", { name: "Add to domain" })).toBeDisabled();
  });

  it("does not apply a pending save result to a subsequently opened data source", async () => {
    const { platform, firstSemantics } = mount();
    let finish!: (group: DomainGroup) => void;
    const save = vi.spyOn(platform, "saveDomainGroup").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await selectTablesAndDomain();
    fireEvent.click(screen.getByRole("button", { name: "Add to domain" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Capture other source" }));
    expect(await screen.findByText("Domain description: Other source meaning")).toBeVisible();
    await act(() => Promise.resolve(finish({ ...firstSemantics.domainGroups[0], tableKeys: save.mock.calls[0][0].tableKeys })));
    expect(screen.getByText("Domain description: Other source meaning")).toBeVisible();
    expect(screen.getByText("Domain members: 1")).toBeVisible();
  });
});
