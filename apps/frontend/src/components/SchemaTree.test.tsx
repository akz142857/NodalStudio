import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot } from "../platform";
import type { ProgramDefinition } from "../platform/types";
import { SchemaTree } from "./SchemaTree";

function table(name: string) {
  return {
    key: { kind: "table", schema: "public", name },
    tableKind: "ordinary",
    columns: [
      {
        name: "id",
        ordinalPosition: 1,
        formattedType: "uuid",
        typeSchema: "pg_catalog",
        typeName: "uuid",
        nullable: false,
        defaultValue: null,
        identity: null,
        generated: false,
        comment: null,
      },
    ],
    primaryKey: null,
    foreignKeys: [],
    indexes: [],
    constraints: [],
    comment: null,
  };
}

const snapshot = {
  id: "snapshot",
  sourceId: "source",
  capturedAt: "2026-08-30T00:00:00Z",
  fingerprint: "abcdef123456",
  database: { name: "flow", databaseType: "postgres" },
  schemas: [
    {
      name: "public",
      tables: [table("orders"), table("customers")],
      views: [{ key: { kind: "view", schema: "public", name: "order_totals" } }],
      enums: [],
    },
  ],
} as unknown as DatabaseSnapshot;

describe("SchemaTree", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("filters table/view names case-insensitively, opens matches and restores disclosures when cleared", () => {
    const onSelectTable = vi.fn();
    render(<SchemaTree snapshot={snapshot} onSelectTable={onSelectTable} />);
    const search = screen.getByRole("searchbox", { name: "Search database objects" });
    fireEvent.change(search, { target: { value: " ORDER " } });
    expect(screen.getByRole("button", { name: /^orders/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^order_totals/ })).toBeVisible();
    expect(screen.queryByText("customers")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 matches");
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(onSelectTable).toHaveBeenCalledWith(snapshot.schemas[0].tables[0]);
    fireEvent.click(screen.getByRole("button", { name: "Clear object search" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: /Tables/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  it("searches qualified names across schemas and preserves the filter on refresh but clears it for another source", () => {
    const multi = { ...snapshot, schemas: [...snapshot.schemas, { name: "archive", tables: [{ ...table("orders"), key: { kind: "table" as const, schema: "archive", name: "orders" } }], views: [], enums: [] }] } as DatabaseSnapshot;
    const { rerender } = render(<SchemaTree snapshot={multi} onSelectTable={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search database objects" });
    fireEvent.change(search, { target: { value: "ARCHIVE.orders" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 match");
    expect(screen.queryByRole("button", { name: /public/ })).not.toBeInTheDocument();
    rerender(<SchemaTree snapshot={{ ...multi, id: "refresh" }} onSelectTable={vi.fn()} />);
    expect(search).toHaveValue("ARCHIVE.orders");
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No matching objects")).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    fireEvent.change(search, { target: { value: "orders" } });
    rerender(<SchemaTree snapshot={{ ...multi, sourceId: "other" }} onSelectTable={vi.fn()} />);
    expect(search).toHaveValue("");
  });

  it("opens large catalog groups without rescanning closed schemas and retains the last trigger", { timeout: 15_000 }, () => {
    const program = (kind: "function" | "trigger", i: number): ProgramDefinition => ({
      key: { kind, schema: "service", name: `${kind}_${i}` },
      arguments: "", definition: "SELECT 1", language: "sql", owner: "demo", resultType: null, table: null, enabled: null,
    });
    const readClosedTable = vi.fn(() => "orders");
    const closedTable = { ...snapshot.schemas[0].tables[0], key: {
      kind: "table" as const, schema: "public", get name() { return readClosedTable(); },
    } };
    const model = { ...snapshot, schemas: [
      { ...snapshot.schemas[0], tables: [closedTable] },
      { name: "service", tables: [], views: [], enums: [], programs: [
        ...Array.from({ length: 86 }, (_, i) => program("function", i)),
        ...Array.from({ length: 136 }, (_, i) => program("trigger", i)),
      ] },
    ] };
    render(<SchemaTree snapshot={model} onSelectTable={vi.fn()} />);
    readClosedTable.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^service/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Functions/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Triggers/ }));
    expect(readClosedTable).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "trigger_0" }).closest(".tree-object-chunk")).not.toHaveAttribute("data-deferred");
    expect(screen.getByRole("button", { name: "trigger_135" }).closest(".tree-object-chunk")).toHaveAttribute("data-deferred", "true");
    expect(screen.getByRole("button", { name: "trigger_135" })).toBeVisible();
    expect(screen.getByRole("button", { name: "function_85" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "SERVICE trigger_135" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 match");
    expect(screen.getByRole("button", { name: "trigger_135" })).toBeVisible();
  });

  it("provides app actions instead of the WebView menu, supports keyboard navigation and restores focus", () => {
    const select = vi.fn(); const query = vi.fn(); const openTable = vi.fn();
    render(<SchemaTree snapshot={snapshot} onSelectTable={select} onOpenQuery={query} onOpenTable={openTable} />);
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    const row = screen.getByRole("button", { name: /^orders/ });
    expect(screen.queryByRole("button", { name: "Actions for public.orders" })).not.toBeInTheDocument();
    const event = createEvent.contextMenu(row, { clientX: 40, clientY: 80 });
    fireEvent(row, event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Table" }));
    expect(openTable).toHaveBeenCalledWith(snapshot.schemas[0].tables[0]);
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Open Table" })).toHaveFocus();
    const menu = screen.getByRole("menu", { name: "Actions for public.orders" });
    const locate = within(menu).getByRole("menuitem", { name: "Locate in diagram" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Open Table" }), { key: "ArrowDown" });
    expect(locate).toHaveFocus();
    fireEvent.keyDown(locate, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Open read-only query…" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Locate in diagram" }));
    expect(select).toHaveBeenCalledWith(snapshot.schemas[0].tables[0]);
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open read-only query…" }));
    expect(query).toHaveBeenCalledWith(snapshot.schemas[0].tables[0]);
    fireEvent.contextMenu(row);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("copies the selected object's name and exposes clipboard errors with retry", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("Clipboard denied")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.queryByRole("menuitem", { name: "Open read-only query…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy qualified name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard denied");
    fireEvent.click(screen.getByRole("button", { name: "Retry name copy" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied public.orders"));
    expect(writeText).toHaveBeenLastCalledWith("public.orders");
  });

  it("routes both SQL dump modes to the selected schema and keeps table actions scoped to the table", () => {
    const dump = vi.fn();
    const model = { ...snapshot, schemas: [...snapshot.schemas, { name: "service", tables: [], views: [], enums: [] }] };
    render(<SchemaTree snapshot={model} onSelectTable={vi.fn()} onDumpSchema={dump} onOpenTable={vi.fn()} onExportTable={vi.fn()} />);
    const publicSchema = screen.getByRole("button", { name: /^public\s*\d+$/ });
    fireEvent.contextMenu(publicSchema);
    const parent = screen.getByRole("menuitem", { name: "Dump SQL File" });
    fireEvent.keyDown(parent, { key: "ArrowRight" });
    expect(screen.getByRole("menuitem", { name: "Structure and Data…" })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Structure Only…" }));
    expect(publicSchema).toHaveFocus();
    expect(dump).toHaveBeenLastCalledWith("public", "structureOnly");
    expect(publicSchema).toHaveAttribute("aria-expanded", "false");
    const service = screen.getByRole("button", { name: /^service\s*\d+$/ });
    fireEvent.keyDown(service, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Dump SQL File" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Structure and Data…" }));
    expect(dump).toHaveBeenLastCalledWith("service", "structureAndData");
    expect(service).toHaveFocus();

    fireEvent.click(publicSchema);
    const tables = screen.getByRole("button", { name: /^Tables\s*\d+$/ });
    fireEvent.contextMenu(tables);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(tables);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.getByRole("menuitem", { name: "Open Table" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Export Wizard…" })).toBeEnabled();
    expect(screen.queryByRole("menuitem", { name: /Dump SQL File/ })).not.toBeInTheDocument();
  });

  it("keeps the preview available for foreign tables and hides unsupported exports", () => {
    const table = { ...snapshot.schemas[0].tables[0], tableKind: "foreign" as const };
    const model = { ...snapshot, schemas: [{ ...snapshot.schemas[0], tables: [table] }] };
    render(<SchemaTree snapshot={model} onSelectTable={vi.fn()} onOpenTable={vi.fn()}
      onExportTable={vi.fn()} onDumpSchema={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.getByRole("menuitem", { name: "Open Table" })).toBeEnabled();
    expect(screen.queryByRole("menuitem", { name: "Dump SQL File" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Export Wizard…" })).toBeNull();
  });

  it("previews actual view SQL read-only and never treats a view as a physical table", () => {
    const view = { ...snapshot.schemas[0].views[0], definition: "SELECT '<script>unsafe</script>' FROM orders", materialized: true, comment: "Order summary" };
    const model = { ...snapshot, schemas: [{ ...snapshot.schemas[0], views: [view] }] };
    const select = vi.fn();
    render(<SchemaTree snapshot={model} onSelectTable={select} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "totals" } });
    fireEvent.click(screen.getByRole("button", { name: "Actions for public.order_totals" }));
    expect(screen.queryByRole("menuitem", { name: "Locate in diagram" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show view definition" }));
    const preview = screen.getByRole("region", { name: "Definition of public.order_totals" });
    expect(preview).toHaveTextContent(view.definition); expect(preview.querySelector("script")).toBeNull();
    expect(preview).toHaveTextContent("Materialized view"); expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close view definition" }));
    expect(screen.queryByRole("region", { name: "Definition of public.order_totals" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^order_totals/ }));
    expect(screen.getByRole("region", { name: "Definition of public.order_totals" })).toBeVisible();
  });
  it("keeps objects out of the DOM until their type node is opened", () => {
    // A flat list of every table is what made the sidebar thousands of pixels
    // tall, so the tables must not be mounted just because a schema is.
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);

    // Single schema opens itself, but its type nodes stay closed.
    expect(screen.getByRole("button", { name: /public/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("orders")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    expect(screen.getByText("orders")).toBeVisible();
    expect(screen.getByText("customers")).toBeVisible();
    // Opening Tables must not drag the other types in with it.
    expect(screen.queryByText("order_totals")).not.toBeInTheDocument();
  });

  it("counts every object type, not just tables", () => {
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    expect(screen.getByRole("button", { name: /public/ })).toHaveTextContent("3");
  });

  it("omits empty object groups while keeping populated groups available", () => {
    render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Enums/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tables/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Views/ })).toBeEnabled();
  });

  it("reports the chosen table and marks it as current", () => {
    const onSelectTable = vi.fn();
    const { rerender } = render(
      <SchemaTree snapshot={snapshot} onSelectTable={onSelectTable} />,
    );

    const [orders] = snapshot.schemas[0].tables;
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(onSelectTable).toHaveBeenCalledWith(orders);

    rerender(
      <SchemaTree snapshot={snapshot} selectedTable={orders} onSelectTable={onSelectTable} />,
    );
    expect(screen.getByRole("button", { name: /^orders/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("re-applies its defaults for a different source but not for a refresh", () => {
    // The open state used to be computed once on mount, so switching connection
    // left the new tree collapsed and holding schema names that were not in it.
    const other = {
      ...snapshot,
      sourceId: "other-source",
      schemas: [{ name: "billing", tables: [table("invoices")], views: [], enums: [] }],
    } as unknown as DatabaseSnapshot;

    const { rerender } = render(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    expect(screen.getByText("orders")).toBeVisible();

    rerender(<SchemaTree snapshot={other} onSelectTable={vi.fn()} />);
    expect(screen.getByRole("button", { name: /billing/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("invoices")).not.toBeInTheDocument();

    // A new capture of the same source is the same database, so what you had
    // open stays open.
    rerender(<SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    const refreshed = { ...snapshot, id: "later-capture" };
    rerender(<SchemaTree snapshot={refreshed} onSelectTable={vi.fn()} />);
    expect(screen.getByText("orders")).toBeVisible();
  });
});
