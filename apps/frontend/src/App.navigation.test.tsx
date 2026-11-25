import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, configure, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform, type CaptureSnapshotResult, type DataSourceProfile, type SchemaChangeSet } from "./platform";
import type { SqliteTableData } from "./platform/sqlite-table";
import { saveTableFilter, saveTableSort, tableFilterKey, tablePageNumberKey, tableSortKey } from "./platform/table-data-preferences";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";
import { enumSnapshot } from "./test/enum-fixture";
import type { CanvasLocateRequest, SchemaCanvasProps } from "./components/SchemaCanvas";
import { clearQuerySessions, loadQuerySession, queryWorkspaceKey, saveQuerySession } from "./components/query/query-state";
import { usesAppleKeyboard } from "./components/command-shortcuts";
import { TableDataPreview } from "./components/TableDataPreview";
import { SqliteTableWorkspace } from "./components/SqliteTableWorkspace";
const changes: SchemaChangeSet = { id: "changes", beforeSnapshotId: "before", afterSnapshotId: reportSnapshot.id, createdAt: reportSnapshot.capturedAt, operations: [], riskSummary: { high: 0, medium: 0, low: 0, informational: 0 } };
const sqliteProfile: DataSourceProfile = {
  id: "table-data-source", displayName: "SQLite fixture", databaseType: "sqlite", database: "editor.sqlite",
  host: "", port: 0, username: "", sslMode: "disable", sqlite: { path: "/fixture/editor.sqlite" },
  createdAt: reportSnapshot.capturedAt, updatedAt: reportSnapshot.capturedAt,
};
const sqliteSnapshot: CaptureSnapshotResult["snapshot"] = {
  ...reportSnapshot, id: "table-data-snapshot", sourceId: sqliteProfile.id,
  database: { name: sqliteProfile.database, databaseType: "sqlite", version: "3" },
  schemas: [{
    ...reportSnapshot.schemas[0], name: "main", views: [],
    tables: reportSnapshot.schemas[0].tables.map((table) => ({ ...table, key: { ...table.key, schema: "main" } })),
  }],
};
const ddlFixtures = [
  { engine: "SQLite", profile: sqliteProfile, snapshot: sqliteSnapshot },
  ...(["postgreSql", "mySql"] as const).map((databaseType) => {
    const engine = databaseType === "postgreSql" ? "PostgreSQL" : "MySQL";
    const profile: DataSourceProfile = {
      id: `ddl-${databaseType}`, displayName: `${engine} fixture`, databaseType, database: "ddl_fixture",
      host: "localhost", port: databaseType === "postgreSql" ? 5432 : 3306, username: "fixture_user",
      sslMode: "disable", createdAt: reportSnapshot.capturedAt, updatedAt: reportSnapshot.capturedAt,
    };
    return { engine, profile, snapshot: {
      ...reportSnapshot, id: `${profile.id}-snapshot`, sourceId: profile.id,
      database: { name: profile.database, databaseType, version: "test" },
      schemas: databaseType === "mySql" ? reportSnapshot.schemas.map((schema) => ({
        ...schema, tables: schema.tables.map((table) => ({
          ...table, columns: table.columns.map((column) => ({
            ...column, typeSchema: "mysql",
            ...(column.typeName === "uuid" ? { typeName: "varchar", formattedType: "varchar(36)" } : {}),
          })),
        })),
      })) : reportSnapshot.schemas,
    } };
  }),
];
const objectFixtures = ddlFixtures.map(({ engine, snapshot, profile }) => {
  const sourceId = `objects-${profile.id}`;
  const schema = snapshot.schemas[0];
  const view = { key: { kind: "view" as const, schema: schema.name, name: "recent_orders" }, definition: "SELECT 1 AS order_id", materialized: false, comment: null };
  const program = { key: { kind: "function", schema: schema.name, name: "fixture_function" }, definition: "SELECT 7", arguments: "", language: "SQL", resultType: null, owner: "fixture", table: null, enabled: null };
  return {
    engine, profile: { ...profile, id: sourceId }, snapshot: {
      ...snapshot, id: sourceId, sourceId, schemas: [{
        ...schema,
        views: profile.databaseType === "postgreSql" ? [view, { ...view, key: { ...view.key, name: "monthly_rollup" }, materialized: true }] : [view],
        programs: profile.databaseType === "sqlite" ? [] : profile.databaseType === "mySql" ? [program, {
          ...program, key: { ...program.key, kind: "event", name: "fixture_event" }, definition: "-- Schedule: EVERY 1 DAY\nSELECT 7", enabled: "DISABLED",
        }] : [program],
      }],
    },
  };
});
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot, onOpenDatabase, onSourceSaved, initializingDatabase, children }: {
  onSnapshot: (result: CaptureSnapshotResult) => void; onOpenDatabase: (result: CaptureSnapshotResult) => void;
  onSourceSaved: (source: DataSourceProfile) => void; initializingDatabase: boolean; children: ReactNode;
}) => <>
  <span data-testid="database-initializing">{String(initializingDatabase)}</span>
  <button onClick={() => onOpenDatabase({ snapshot: reportSnapshot, stored: false, changeSet: null })}>Open saved navigation fixture</button>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: false, changeSet: null })}>Load navigation fixture</button>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: false, changeSet: changes })}>Load changed fixture</button>
  <button onClick={() => onSnapshot({ snapshot: enumSnapshot, stored: false, changeSet: null })}>Load enum fixture</button>
  {ddlFixtures.map(({ engine, profile, snapshot }) => <button key={profile.id} onClick={() => {
    onSourceSaved(profile);
    onSnapshot({ snapshot, stored: false, changeSet: null });
  }}>Load {engine} fixture</button>)}
  {objectFixtures.map(({ engine, profile, snapshot }) => <button key={profile.id} onClick={() => {
    onSourceSaved(profile);
    onSnapshot({ snapshot, stored: false, changeSet: null });
  }}>Load {engine} object fixture</button>)}
  {children}
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => <section aria-label="Navigation canvas">
  <output data-testid="canvas-view">{props.savedView?.name ?? "Full model"}</output>
  <output data-testid="canvas-query">{props.query}</output>
  <output data-testid="navigation-ready">{String(props.navigationReady)}</output>
  <output data-testid="locate-request">{props.locateRequest ? JSON.stringify(props.locateRequest) : "none"}</output>
  <button onClick={() => props.locateRequest && props.onLocateComplete?.(props.locateRequest)}>Acknowledge navigation</button>
  <button onClick={() => props.onSelectTable(props.snapshot.schemas[0].tables[1], "total")}>Inspect total field</button>
  <button onClick={() => props.onSelectTable(props.snapshot.schemas[0].tables[1], "customer_id")}>Inspect customer field</button>
  <button onClick={() => props.onSelectTable(props.snapshot.schemas[1].tables[0], "id")}>Inspect archived field</button>
  <button onClick={() => props.onSelectTable(undefined)}>Clear canvas selection</button>
</section> }));
async function mount() {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Navigation runtime", version: "test" });
  vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText("Navigation runtime");
  return platform;
}

function stubClipboard() {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return { writeText, restore: () => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  } };
}
const requested = () => JSON.parse(screen.getByTestId("locate-request").textContent) as CanvasLocateRequest;
const pickOrders = () => {
  const tree = within(screen.getByRole("region", { name: "Database structure" }));
  fireEvent.change(tree.getByRole("searchbox"), { target: { value: "public.orders" } });
  fireEvent.click(tree.getByRole("button", { name: /^orders/ }));
};
describe("App sidebar object navigation", { timeout: 45_000 }, () => {
  // These workflows mount the complete workspace and query paged grids on every
  // transition. Allow the DOM queries to settle on resource-limited CI runners.
  const asyncUtilTimeout = getConfig().asyncUtilTimeout;
  beforeAll(() => configure({ asyncUtilTimeout: 5_000 }));
  afterAll(() => configure({ asyncUtilTimeout }));
  beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("finishes database initialization when model views settle (load fails: %s)", async (loadFails) => {
    const platform = await mount();
    let settle!: () => void;
    vi.spyOn(platform, "getSemantics").mockImplementationOnce(() => new Promise((resolve, reject) => {
      settle = () => { if (loadFails) reject(new Error("View settings unavailable")); else resolve(reportSemantics); };
    }));
    fireEvent.click(screen.getByRole("button", { name: "Open saved navigation fixture" }));
    expect(screen.getByTestId("database-initializing")).toHaveTextContent("true");
    await act(async () => { settle(); await Promise.resolve(); });
    expect(screen.getByTestId("database-initializing")).toHaveTextContent("false");
  });

  it("keeps Database active while the global search is open and locates the keyboard selection", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const database = screen.getByRole("button", { name: "Database" });
    fireEvent.click(database);
    const input = screen.getByRole("combobox", { name: "Search schema" });
    input.focus();
    fireEvent.change(input, { target: { value: "orders" } });
    expect(database).toHaveAttribute("aria-pressed", "true");
    let selected = screen.getByRole("option", { selected: true });
    expect(input).toHaveAttribute("aria-activedescendant", selected.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected).toHaveAttribute("aria-selected", "false");
    selected = screen.getByRole("option", { selected: true });
    expect(input).toHaveAttribute("aria-activedescendant", selected.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox", { name: "Schema search results" })).not.toBeInTheDocument();
  });

  it.each([
    { engine: "SQLite", schema: "main", quote: '"', view: "recent_orders", group: "Views" },
    { engine: "MySQL", schema: "public", quote: "`", view: "recent_orders", group: "Views" },
    { engine: "PostgreSQL", schema: "public", quote: '"', view: "monthly_rollup", group: "Materialized Views" },
  ])("opens $engine views and object definitions within Database", async ({ engine, schema, quote, view, group }) => {
    const platform = await mount();
    const mysql = engine === "MySQL";
    const id = mysql ? "9223372036854775001" : "7";
    if (mysql) {
      const source = objectFixtures.find((fixture) => fixture.engine === engine)!.profile.id;
      saveTableFilter(tableFilterKey(source, schema, view), { match: "all", rules: [{ kind: "equals", column: "order_id", value: id }] });
    }
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockResolvedValue({
      queryId: "view-preview", columns: [{ name: "order_id", databaseType: mysql ? "BIGINT" : "INTEGER" }], rows: [[{ kind: "text", value: id, truncated: false }]],
      rowCount: 1, durationMs: 1, truncated: false, notices: [],
    });
    fireEvent.click(screen.getByRole("button", { name: `Load ${engine} object fixture` }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    expect(tree.getByRole("button", { name: /^Queries/ })).toBeVisible();
    if (engine === "MySQL") {
      fireEvent.click(tree.getByRole("button", { name: /^Events/ }));
      fireEvent.click(tree.getByRole("button", { name: "fixture_event" }));
      expect(screen.getByRole("region", { name: "Object document" })).toHaveTextContent("fixture_event");
    } else {
      expect(tree.queryByRole("button", { name: /^Events/ })).not.toBeInTheDocument();
    }
    if (engine !== "SQLite") expect(tree.getByRole("button", { name: /^Functions/ })).toBeVisible();
    else expect(tree.queryByRole("button", { name: /^Functions/ })).not.toBeInTheDocument();
    fireEvent.click(tree.getByRole("button", { name: new RegExp(`^${group}`) }));
    fireEvent.click(tree.getByRole("button", { name: view }));
    expect(await screen.findByRole("cell", { name: id })).toBeVisible();
    const from = `SELECT *\nFROM ${quote}${schema}${quote}.${quote}${view}${quote}`;
    if (mysql) expect(query).toHaveBeenCalledWith(expect.objectContaining({ sql: `${from}\nLIMIT 0;` }), expect.any(Function));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ sql: `${from}${mysql ? `\nWHERE (\`order_id\` = ${id})` : ""}\nLIMIT 101;` }), expect.any(Function));
    fireEvent.click(within(screen.getByRole("region", { name: "Table data" })).getByRole("button", { name: "Definition (read-only)" }));
    expect(screen.getByRole("textbox", { name: "Read-only object definition" })).toHaveTextContent("SELECT 1 AS order_id");
    expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
  });

  it("saves named queries by data source and opens them without executing or losing the previous draft", async () => {
    clearQuerySessions();
    const platform = await mount();
    const execute = vi.spyOn(platform, "executeReadonlyQuery");
    fireEvent.click(screen.getByRole("button", { name: "Load SQLite object fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    fireEvent.click(screen.getByRole("button", { name: /^Queries/ }));
    fireEvent.click(screen.getByRole("button", { name: "New Query" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }, { timeout: 5000 }));
    const editor = await screen.findByRole("textbox", { name: "SQL editor" });
    const editorView = EditorView.findFromDOM(editor)!;
    const saveShortcut = { key: "s", metaKey: usesAppleKeyboard(), ctrlKey: !usesAppleKeyboard() };
    act(() => editorView.dispatch({ changes: { from: 0, insert: "SELECT 7;" } }));
    expect(screen.getByRole("button", { name: "Queries (0)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Query" })).toHaveAttribute("aria-keyshortcuts", usesAppleKeyboard() ? "Meta+S" : "Control+S");
    fireEvent.keyDown(editor, saveShortcut);
    const dialog = within(screen.getByRole("dialog", { name: "Save Query" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Query name" }), { target: { value: "Orders check" } });
    fireEvent.keyDown(dialog.getByRole("textbox", { name: "Query name" }), saveShortcut);
    expect(dialog.getByRole("button", { name: "Save" })).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Query saved on this device.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Orders check" })).toBeVisible();
    act(() => editorView.dispatch({ changes: { from: 0, to: 9, insert: "SELECT 8;" } }));
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search database objects" }), saveShortcut);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Query saved on this device.")).toBeVisible();
    act(() => editorView.dispatch({ changes: { from: 0, to: 9, insert: "SELECT 9;" } }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    expect(fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search database objects" }), saveShortcut)).toBe(true);
    expect(screen.getByRole("button", { name: "Orders check" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Query" }));
    fireEvent.click(screen.getByRole("button", { name: "Orders check" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }, { timeout: 5000 }));
    expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveTextContent("SELECT 8;");
    expect(execute).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search database objects" }), { target: { value: "missing object" } });
    expect(screen.getByRole("button", { name: "Orders check" })).toBeVisible();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete Orders check" }));
    expect(screen.getByRole("button", { name: "Queries (0)" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveTextContent("SELECT 8;");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "SQL editor" }), saveShortcut);
    const newName = within(screen.getByRole("dialog", { name: "Save Query" }));
    expect(newName.getByRole("textbox", { name: "Query name" })).toHaveValue("");
    fireEvent.click(newName.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore previous SQL draft" }));
    expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveTextContent("SELECT 9;");
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL object fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    fireEvent.click(screen.getByRole("button", { name: /^Queries/ }));
    expect(screen.queryByRole("button", { name: "Orders check" })).not.toBeInTheDocument();
    clearQuerySessions();
  });

  it("shows Quick Query results in the Database grid and keeps the SQL draft with its table", async () => {
    const platform = await mount();
    const run = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId, sql }) => {
      const quick = sql === "SELECT 42 AS answer;";
      return Promise.resolve({
        queryId, columns: [{ name: quick ? "answer" : "id", databaseType: "INT" }],
        rows: [[{ kind: "number", value: quick ? 42 : 7 }]], rowCount: 1, durationMs: 1, truncated: false, notices: [],
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    pickOrders();
    const table = within(await screen.findByRole("region", { name: "Table data" }));
    expect(await table.findByRole("cell", { name: "7" })).toBeVisible();
    const resultGrid = () => table.getByRole("region", { name: "Query results" });
    fireEvent.scroll(resultGrid(), { target: { scrollLeft: 80, scrollTop: 140 } });
    let dock = within(screen.getByRole("region", { name: "Quick Query" }));
    expect(screen.getByRole("region", { name: "Quick Query" }).parentElement).toHaveAttribute("data-docked");
    expect(dock.getByRole("button", { name: "Quick Query" })).toHaveAttribute("aria-expanded", "true");
    const editor = dock.getByRole<HTMLTextAreaElement>("textbox", { name: "SQL editor" });
    expect(editor).toHaveValue("SELECT *\nFROM `public`.`orders`\nLIMIT 100;");
    expect(run).toHaveBeenCalledTimes(1);
    const query = "SELECT 42 AS answer;";
    const draft = `${query}\nSELECT 9;`;
    fireEvent.change(editor, { target: { value: draft } });
    editor.setSelectionRange(0, query.length);
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(await table.findByRole("cell", { name: "42" })).toBeVisible();
    expect(table.getByText("Quick Query results")).toBeVisible();
    fireEvent.click(table.getByRole("button", { name: "Current SQL" }));
    const statement = screen.getByRole("dialog", { name: "Current SQL" });
    expect(statement).toHaveTextContent(query);
    expect(statement).not.toHaveTextContent("SELECT 9;");
    fireEvent.click(within(statement).getByRole("button", { name: "Close" }));
    const placeQuickQuery = (name: string) => {
      fireEvent.click(dock.getByRole("button", { name: "Position Quick Query" }));
      fireEvent.click(screen.getByRole("menuitem", { name }));
    };
    placeQuickQuery("Float Quick Query");
    expect(screen.getByRole("region", { name: "Quick Query" }).parentElement).not.toHaveAttribute("data-docked");
    expect(table.getByRole("cell", { name: "42" })).toBeVisible();
    expect(editor).toHaveValue(draft);
    placeQuickQuery("Dock at Top");
    expect(screen.getByRole("region", { name: "Quick Query" }).parentElement).toHaveAttribute("data-docked");
    expect(table.getByRole("cell", { name: "42" })).toBeVisible();
    fireEvent.scroll(resultGrid(), { target: { scrollLeft: 160, scrollTop: 280 } });
    expect(dock.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ sourceId: "ddl-mySql", sql: query, rowLimit: 100 }), expect.any(Function));
    expect(table.queryByRole("cell", { name: "7" })).not.toBeInTheDocument();
    expect(table.queryByRole("button", { name: "Filter" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(dock.getByRole("button", { name: "Quick Query" })).toHaveFocus();
    expect(dock.queryByRole("textbox")).toBeNull();
    expect(table.getByRole("cell", { name: "42" })).toBeVisible();
    fireEvent.click(table.getByRole("button", { name: "Back to data" }));
    expect(await table.findByRole("cell", { name: "7" })).toBeVisible();
    await waitFor(() => expect(resultGrid()).toMatchObject({ scrollLeft: 80, scrollTop: 140 }));
    expect(table.getByRole("button", { name: "Filter" })).toBeVisible();

    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: "public.customers" } });
    fireEvent.click(tree.getByRole("button", { name: /^customers/ }));
    dock = within(screen.getByRole("region", { name: "Quick Query" }));
    expect(dock.getByRole("textbox")).toHaveValue("SELECT *\nFROM `public`.`customers`\nLIMIT 100;");
    expect(screen.queryByRole("cell", { name: "42" })).toBeNull();
    pickOrders();
    dock = within(screen.getByRole("region", { name: "Quick Query" }));
    expect(dock.getByRole("textbox")).toHaveValue(draft);
    await within(screen.getByRole("region", { name: "Table data" })).findByRole("cell", { name: "7" });
  });

  it("shows the correct MySQL column comment and copies the context row or field name", async () => {
    const clipboard = stubClipboard();
    try {
      const platform = await mount();
      vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
        queryId, columns: [{ name: "total", databaseType: "decimal" }, { name: "customer_id", databaseType: "varchar" }],
        rows: [[{ kind: "text", value: "8.50", truncated: false }, { kind: "text", value: 'blue\t"north"\nwest', truncated: false }]],
        rowCount: 1, truncated: false, durationMs: 1, notices: [],
      }));
      fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
      pickOrders();
      fireEvent.click(screen.getByRole("button", { name: "Database" }));
      const workspace = within(await screen.findByRole("region", { name: "Table data" }));
      const header = await workspace.findByRole("button", { name: "total" });
      fireEvent.pointerEnter(header, { pointerType: "mouse" });
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Calculated order total");
      fireEvent.pointerLeave(header, { pointerType: "mouse" });
      expect(screen.queryByRole("tooltip")).toBeNull();

      const cell = workspace.getByRole("cell", { name: "8.50" });
      const row = cell.closest("tr");
      fireEvent.contextMenu(cell, { clientX: 320, clientY: 180 });
      expect(row).toHaveAttribute("aria-selected", "true");
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy Row" }));
        await Promise.resolve();
      });
      expect(clipboard.writeText).toHaveBeenLastCalledWith('8.50\t"blue\t""north""\nwest"');
      expect(workspace.queryByText("Copied to clipboard.")).not.toBeInTheDocument();
      expect(row).toHaveFocus();

      fireEvent.contextMenu(cell);
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy Field Name" }));
      expect(clipboard.writeText).toHaveBeenLastCalledWith("total");
      fireEvent.contextMenu(cell);
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy As" }));
      const submenu = within(screen.getByRole("menu", { name: "Copy As" }));
      fireEvent.click(submenu.getByRole("menuitem", { name: "Tab-separated With Headers" }));
      expect(clipboard.writeText).toHaveBeenLastCalledWith('total\tcustomer_id\n8.50\t"blue\t""north""\nwest"');
    } finally {
      clipboard.restore();
    }
  });
  it("keeps SQLite drafts when viewing table DDL and switching to Quick Query results", async () => {
    const clipboard = stubClipboard();
    try {
      const platform = await mount();
      const ddl = 'CREATE TABLE "orders" ("id" INTEGER PRIMARY KEY, "customer_id" TEXT);';
      const readDdl = vi.spyOn(platform, "readTableDdl").mockResolvedValue(ddl);
      const readQuery = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
        queryId, columns: [{ name: "answer", databaseType: "INTEGER" }], rows: [[{ kind: "number", value: 42 }]],
        rowCount: 1, durationMs: 1, truncated: false, notices: [],
      }));
      vi.spyOn(platform, "loadSqliteTable").mockResolvedValue({
        version: "copy-fixture",
        columns: [
          { name: "id", declaredType: "INTEGER", generated: false, primaryKey: true },
          { name: "customer_id", declaredType: "TEXT", generated: false, primaryKey: false },
        ],
        rows: [{
          cells: [{ kind: "integer", value: "1" }, { kind: "text", value: "original" }],
          identity: { key: [{ kind: "integer", value: "1" }], revision: "original" },
        }],
        nextOffset: null,
      });
      fireEvent.click(screen.getByRole("button", { name: "Load SQLite fixture" }));
      fireEvent.click(screen.getByRole("button", { name: "Database" }));
      const tree = within(screen.getByRole("region", { name: "Database structure" }));
      fireEvent.change(tree.getByRole("searchbox"), { target: { value: "main.orders" } });
      fireEvent.click(tree.getByRole("button", { name: "orders" }));
      const workspace = within(await screen.findByRole("region", { name: "Table data" }));
      const header = await workspace.findByRole("button", { name: "customer_id" });
      expect(header).toHaveAccessibleDescription("TEXT. Customer identifier");
      fireEvent.click(workspace.getByRole("button", { name: "Edit data" }));
      fireEvent.change(workspace.getByRole("textbox", { name: "id" }), { target: { value: "2" } });
      fireEvent.change(workspace.getByRole("textbox", { name: "customer_id" }), { target: { value: "O'Reilly" } });
      const viewDdl = workspace.getByRole("button", { name: "View DDL" });
      expect(readDdl).not.toHaveBeenCalled();
      viewDdl.focus();
      fireEvent.click(viewDdl);
      const modal = within(await screen.findByRole("dialog", { name: "Table DDL" }));
      const reader = await modal.findByRole("textbox", { name: "Read-only object definition" });
      expect(reader).toHaveTextContent(ddl);
      expect(readDdl).toHaveBeenCalledWith({ sourceId: sqliteProfile.id, connectionRevision: sqliteProfile.updatedAt, schema: "main", name: "orders" });
      fireEvent.click(modal.getByRole("button", { name: "Copy DDL" }));
      expect(clipboard.writeText).toHaveBeenLastCalledWith(ddl);
      fireEvent.keyDown(modal.getByRole("button", { name: "Close" }), { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Table DDL" })).not.toBeInTheDocument();
      expect(viewDdl).toHaveFocus();
      expect(workspace.getByText("Pending changes: 1")).toBeVisible();
      expect(workspace.getByRole("textbox", { name: "customer_id" })).toHaveValue("O'Reilly");
      const row = workspace.getByRole("row", { name: "Row 1" });
      row.focus();
      fireEvent.keyDown(row, { key: "F10", shiftKey: true });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy Row" }));
        await Promise.resolve();
      });
      expect(clipboard.writeText).toHaveBeenLastCalledWith("2\tO'Reilly");
      expect(workspace.queryByText("Copied to clipboard.")).not.toBeInTheDocument();
      fireEvent.keyDown(row, { key: "F10", shiftKey: true });
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy As" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Insert Statement" }));
      expect(clipboard.writeText).toHaveBeenLastCalledWith(`INSERT INTO "main"."orders" ("id", "customer_id") VALUES (2, 'O''Reilly');`);
      fireEvent.keyDown(row, { key: "F10", shiftKey: true });
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy As" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Update Statement" }));
      expect(clipboard.writeText).toHaveBeenLastCalledWith(`UPDATE "main"."orders" SET "id" = 2, "customer_id" = 'O''Reilly' WHERE "id" = 1;`);
      expect(workspace.getByText("Pending changes: 1")).toBeVisible();
      const dock = within(screen.getByRole("region", { name: "Quick Query" }));
      fireEvent.change(dock.getByRole("textbox"), { target: { value: "SELECT 42 AS answer;" } });
      fireEvent.click(dock.getByRole("button", { name: "Run" }));
      await screen.findByRole("cell", { name: "42" });
      const results = within(screen.getByRole("region", { name: "Table data" }));
      expect(results.getByRole("cell", { name: "42" })).toBeVisible();
      expect(screen.getAllByRole("table")).toHaveLength(1);
      expect(readQuery).toHaveBeenCalledTimes(1);
      fireEvent.click(results.getByRole("button", { name: "Back to data" }));
      expect(workspace.getByText("Pending changes: 1")).toBeVisible();
      expect(workspace.getByRole("textbox", { name: "customer_id" })).toHaveValue("O'Reilly");
    } finally {
      clipboard.restore();
    }
  });
  it.each([
    { engine: "PostgreSQL", schema: "public", initialCount: "≈1,200" },
    { engine: "SQLite", schema: "main", initialCount: "—" },
  ])("shows $engine table row counts without automatically counting individual tables", async ({ engine, schema, initialCount }) => {
    const platform = await mount();
    const readCounts = vi.spyOn(platform, "readTableRowCounts").mockImplementation(({ target }) => Promise.resolve(target
      ? [{ ...target, count: "924" }]
      : [{ schema, name: "orders", count: "1200" }]));
    fireEvent.click(screen.getByRole("button", { name: `Load ${engine} fixture` }));
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: `${schema}.orders` } });
    const count = await tree.findByRole("button", { name: "Count rows in orders" });
    await waitFor(() => expect(count).toHaveTextContent(initialCount));
    expect(tree.getByRole("button", { name: "orders" })).toHaveTextContent(/^orders$/);
    expect(readCounts.mock.calls.map(([input]) => input.target)).toEqual(engine === "SQLite" ? [] : [undefined]);

    fireEvent.click(count);
    await waitFor(() => expect(count).toHaveTextContent(/^924$/));
    expect(count).toHaveAccessibleDescription("Last counted 924 rows");
    expect(readCounts.mock.calls.at(-1)?.[0].target).toEqual({ schema, name: "orders" });
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: `${schema}.customers` } });
    expect(tree.getByRole("button", { name: "Count rows in customers" })).toHaveTextContent("—");
    expect(readCounts).toHaveBeenCalledTimes(engine === "SQLite" ? 1 : 2);
  });
  it.each([
    { filtered: false, truncated: false, expectedCount: "1" },
    { filtered: true, truncated: false, expectedCount: "—" },
    { filtered: false, truncated: true, expectedCount: "—" },
  ])("uses only complete, unfiltered PostgreSQL previews for sidebar counts ($filtered, $truncated)", async ({ filtered, truncated, expectedCount }) => {
    const platform = await mount();
    const sourceId = "ddl-postgreSql";
    const readCounts = vi.spyOn(platform, "readTableRowCounts").mockResolvedValue([]);
    vi.spyOn(platform, "executeReadonlyQuery").mockResolvedValue({
      queryId: "row-count-preview", columns: [{ name: "id", databaseType: "int8" }],
      rows: [[{ kind: "text", value: "7", truncated: false }]], rowCount: 1, truncated, durationMs: 1, notices: [],
    });
    if (filtered) {
      saveTableFilter(tableFilterKey(sourceId, "public", "orders"), { match: "all", rules: [{ kind: "equals", column: "id", value: "7" }] });
    }
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    pickOrders();
    expect(await screen.findByRole("cell", { name: "7" })).toBeVisible();
    const count = screen.getByRole("button", { name: "Count rows in orders" });
    expect(count.textContent).toBe(expectedCount);
    expect(readCounts.mock.calls.map(([input]) => input.target)).toEqual([undefined]);
  });
  it.each(ddlFixtures)("confirms the exact $engine DDL selection and refreshes the model inside Query", async ({ engine, profile, snapshot }) => {
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
    clearQuerySessions();
    try {
      const platform = await mount();
      const schema = snapshot.schemas[0];
      const capture: CaptureSnapshotResult = {
        snapshot: { ...snapshot, id: "ddl-refreshed", capturedAt: "2099-01-01T00:00:00Z",
          schemas: [{ ...schema, tables: [...schema.tables, { ...schema.tables[0], key: { kind: "table", schema: schema.name, name: "ddl_example" } }] }] },
        stored: true, changeSet: null,
      };
      const ddl = vi.spyOn(platform, "executeSchemaDdl")
        .mockResolvedValueOnce({ kind: "refreshed", capture })
        .mockResolvedValueOnce({ kind: "refreshFailed", message: "Test refresh failure" })
        .mockResolvedValueOnce({ kind: "outcomeUnknown" });
      const query = vi.spyOn(platform, "executeReadonlyQuery").mockRejectedValue("Read-only queries require SELECT.");
      fireEvent.click(screen.getByRole("button", { name: `Load ${engine} fixture` }));
      fireEvent.click(screen.getByRole("button", { name: "Query" }));
      const workspace = await screen.findByRole("region", { name: "Query workspace" });
      expect(within(workspace).getByText(`Write a SELECT query or one ${engine} DDL statement…`)).toBeVisible();
      const editor = EditorView.findFromDOM(workspace.querySelector<HTMLElement>(".cm-editor")!)!;
      const selected = "CREATE TABLE ddl_example (id INTEGER PRIMARY KEY);";
      const documentSql = `SELECT 1;\n${selected}`;
      act(() => editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: documentSql },
        selection: { anchor: documentSql.indexOf("CREATE"), head: documentSql.length },
      }));
      fireEvent.click(within(workspace).getByRole("button", { name: /^Run (?:⌘R|Ctrl\+R)$/ }));
      expect(await screen.findByText(/Read-only queries require SELECT/)).toBeVisible();
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ sql: selected }));
      expect(ddl).not.toHaveBeenCalled();

      const review = () => fireEvent.click(within(workspace).getByRole("button", { name: `Run ${engine} DDL…` }));
      const activeDialog = () => within(screen.getByRole("dialog", { name: `Confirm ${engine} schema change` }));
      review();
      let dialog = activeDialog();
      const target = profile.databaseType === "sqlite" ? { filePath: profile.sqlite!.path }
        : { host: profile.host, port: profile.port, username: profile.username, database: profile.database, profileUpdatedAt: profile.updatedAt };
      expect(dialog.getByText("filePath" in target ? target.filePath! : `${target.username}@${target.host}:${target.port} / ${target.database}`)).toBeVisible();
      expect(dialog.getByLabelText("SQL to execute")).toHaveTextContent(selected);
      expect(ddl).not.toHaveBeenCalled();
      fireEvent.keyDown(dialog.getByRole("button", { name: "Cancel" }), { key: "s", metaKey: usesAppleKeyboard(), ctrlKey: !usesAppleKeyboard() });
      expect(screen.queryByRole("dialog", { name: "Save Query" })).not.toBeInTheDocument();
      fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
      expect(ddl).not.toHaveBeenCalled();

      review();
      dialog = activeDialog();
      fireEvent.click(dialog.getByRole("button", { name: "Apply schema change" }));
      expect(await screen.findByText("Schema change committed. The model has been refreshed.")).toBeVisible();
      expect(ddl).toHaveBeenCalledExactlyOnceWith({ databaseType: profile.databaseType, sourceId: profile.id, ...target, sql: selected });
      expect(screen.getByRole("button", { name: "Query" })).toHaveAttribute("aria-pressed", "true");
      const tree = within(screen.getByRole("region", { name: "Database structure" }));
      fireEvent.change(tree.getByRole("searchbox"), { target: { value: "ddl_example" } });
      expect(tree.getByRole("button", { name: /^ddl_example/ })).toBeVisible();

      const updatedEditor = EditorView.findFromDOM(workspace.querySelector<HTMLElement>(".cm-editor")!)!;
      act(() => updatedEditor.dispatch({ changes: { from: 0, to: updatedEditor.state.doc.length, insert: "CREATE INDEX ddl_idx ON ddl_example(id);" } }));
      review();
      fireEvent.click(activeDialog().getByRole("button", { name: "Apply schema change" }));
      expect(await screen.findByText(/Schema change committed.*Test refresh failure/)).toBeVisible();
      expect(ddl).toHaveBeenCalledTimes(2);
      if (profile.databaseType !== "sqlite") {
        review();
        fireEvent.click(activeDialog().getByRole("button", { name: "Apply schema change" }));
        expect(await screen.findByText(/Could not confirm the schema change/)).toBeVisible();
        expect(ddl).toHaveBeenCalledTimes(3);
      }
    } finally {
      cleanup();
      clearQuerySessions();
      if (showModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModal); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      if (close) Object.defineProperty(HTMLDialogElement.prototype, "close", close); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });
  it("opens SQLite in Database and keeps all drafts until one batch is saved", async () => {
    const platform = await mount();
    const initial: SqliteTableData = {
      version: "table-version",
      statement: 'SELECT "label" FROM main."orders" LIMIT 101',
      columns: [{ name: "label", declaredType: "TEXT", generated: false, primaryKey: false }],
      rows: ["first", "second"].map((value, index) => ({
        cells: [{ kind: "text", value }],
        identity: { key: [{ kind: "integer", value: String(index + 1) }], revision: value },
      })),
      nextOffset: null,
    };
    const load = vi.spyOn(platform, "loadSqliteTable").mockResolvedValue(initial);
    const save = vi.spyOn(platform, "saveSqliteTable")
      .mockRejectedValueOnce(new Error("Constraint failed"))
      .mockResolvedValueOnce(undefined);
    const readOnly = vi.spyOn(platform, "executeReadonlyQuery");
    fireEvent.click(screen.getByRole("button", { name: "Load SQLite fixture" }));
    const navigation = within(screen.getByRole("group", { name: "View mode" }));
    expect(navigation.getAllByRole("button").map((button) => button.textContent)).toEqual(["Model", "Ontology", "Database", "Query"]);
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: "main.orders" } });
    fireEvent.click(tree.getByRole("button", { name: /^orders/ }));
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(navigation.getByRole("button", { name: "Database" }));

    const editor = within(await screen.findByRole("region", { name: "Table data" }));
    expect(navigation.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
    expect(await editor.findByRole("cell", { name: "first" })).toBeVisible();
    const footer = within(editor.getByLabelText("Table data toolbar"));
    fireEvent.click(footer.getByRole("button", { name: "Current SQL" }));
    const sql = screen.getByRole("dialog", { name: "Current SQL" });
    expect(sql).toHaveTextContent(initial.statement!);
    fireEvent.click(within(sql).getByRole("button", { name: "Close" }));
    expect(footer.getByRole("button", { name: "Delete row" })).toBeDisabled();
    expect(editor.queryByRole("region", { name: "Row editor" })).toBeNull();
    expect(editor.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(editor.queryByRole("searchbox", { name: "Filter value" })).not.toBeInTheDocument();
    expect(editor.getAllByRole("columnheader")).toHaveLength(1);
    expect(editor.queryByRole("rowheader")).not.toBeInTheDocument();
    const column = editor.getByRole("button", { name: "label" });
    fireEvent.click(column);
    expect(column).toHaveAttribute("aria-pressed", "true");
    expect(editor.getByRole("cell", { name: "first" })).toHaveAttribute("data-column-selected", "true");
    expect(editor.getByRole("cell", { name: "second" })).toHaveAttribute("data-column-selected", "true");
    const firstRow = editor.getByRole("row", { name: "Row 1" });
    expect(firstRow).toHaveAttribute("aria-selected", "false");
    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: "ArrowDown" });
    const secondRow = editor.getByRole("row", { name: "Row 2" });
    expect(secondRow).toHaveFocus();
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(column).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(secondRow, { key: "ArrowUp" });
    fireEvent.click(editor.getByRole("button", { name: "Row details" }));
    const details = within(editor.getByRole("region", { name: "Row details" }));
    expect(details.getByText("first")).toBeVisible();
    expect(details.queryByRole("textbox")).toBeNull();
    const resize = editor.getByRole("separator", { name: "Resize row panel" });
    expect(resize).toHaveAttribute("aria-valuenow", "336");
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(editor.getByText("Read-only")).toHaveAttribute("data-mode", "read");
    fireEvent.click(editor.getByRole("button", { name: "Edit data" }));
    expect(await editor.findByRole("textbox", { name: "label" })).toHaveValue("first");
    expect(editor.getByText("Editing")).toHaveAttribute("data-mode", "write");
    expect(resize).toHaveAttribute("aria-valuenow", "352");
    expect(editor.getByRole("combobox", { name: "label value type" })).toHaveClass("ds-select");
    fireEvent.change(editor.getByRole("textbox", { name: "label" }), { target: { value: "updated" } });
    fireEvent.click(editor.getByRole("cell", { name: "second" }));
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    fireEvent.click(column);
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(editor.getByRole("textbox", { name: "label" })).toHaveValue("second");
    fireEvent.click(editor.getByRole("button", { name: "Delete row" }));
    fireEvent.click(editor.getByRole("button", { name: "Add row" }));
    fireEvent.change(editor.getByRole("textbox", { name: "label" }), { target: { value: "inserted" } });
    fireEvent.click(editor.getByRole("cell", { name: "updated" }));
    expect(editor.getByRole("textbox", { name: "label" })).toHaveValue("updated");
    expect(editor.getByText("Pending changes: 3")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(readOnly).not.toHaveBeenCalled();

    fireEvent.click(navigation.getByRole("button", { name: "Model" }));
    fireEvent.click(navigation.getByRole("button", { name: "Database" }));
    fireEvent.click(editor.getByRole("button", { name: "Discard changes" }));
    expect(editor.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    const undoDiscard = editor.getByRole("button", { name: "Undo discard" });
    expect(undoDiscard).toHaveFocus();
    fireEvent.click(undoDiscard);
    expect(editor.getByText("Pending changes: 3")).toBeVisible();
    fireEvent.click(editor.getByRole("button", { name: "Save changes" }));
    expect(await editor.findByRole("alert")).toHaveTextContent("Constraint failed");
    expect(editor.getByText("Pending changes: 3")).toBeVisible();
    expect(editor.getByRole("textbox", { name: "label" })).toHaveValue("updated");
    const batch = {
      target: { sourceId: sqliteProfile.id, table: "orders" }, version: initial.version,
      changes: [
        { kind: "update", identity: initial.rows[0].identity, fields: [{ column: 0, value: { kind: "text", value: "updated" } }] },
        { kind: "delete", identity: initial.rows[1].identity },
        { kind: "insert", fields: [{ column: 0, value: { kind: "text", value: "inserted" } }] },
      ],
    };
    expect(save).toHaveBeenCalledExactlyOnceWith(batch);
    fireEvent.click(editor.getByRole("button", { name: "Save changes" }));
    expect(await editor.findByText("Saved 3 row changes.")).toBeVisible();
    expect(editor.queryByText("Pending changes: 0")).not.toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith(batch);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("releases clean SQLite editors when switching tables and keeps editors with drafts", async () => {
    const platform = await mount();
    vi.spyOn(platform, "loadSqliteTable").mockImplementation(({ table }) => Promise.resolve({
      version: "fixture",
      columns: [{ name: "label", declaredType: "TEXT", generated: false, primaryKey: false }],
      rows: [{ cells: [{ kind: "text", value: table }], identity: { revision: table, key: [{ kind: "integer", value: "1" }] } }],
      nextOffset: null,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load SQLite fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    const open = async (name: string) => {
      fireEvent.change(tree.getByRole("searchbox"), { target: { value: `main.${name}` } });
      fireEvent.click(tree.getByRole("button", { name }));
      const workspace = within(screen.getByRole("region", { name: "Table data" }));
      await workspace.findByRole("cell", { name });
      return workspace;
    };
    await open("customers");
    const editor = await open("orders");
    expect(screen.getAllByRole("region", { name: "Table data", hidden: true })).toHaveLength(1);

    fireEvent.click(editor.getByRole("button", { name: "Edit data" }));
    fireEvent.change(editor.getByRole("textbox", { name: "label" }), { target: { value: "draft order" } });
    await open("customers");
    expect(screen.getAllByRole("region", { name: "Table data", hidden: true })).toHaveLength(2);
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: "main.orders" } });
    fireEvent.click(tree.getByRole("button", { name: "orders" }));
    expect(screen.getAllByRole("region", { name: "Table data", hidden: true })).toHaveLength(1);
    expect(editor.getByRole("textbox", { name: "label" })).toHaveValue("draft order");
  });

  it("keeps off-page changes tied to their original rows across sorting and filtering", async () => {
    const platform = await mount();
    const data: SqliteTableData = {
      version: "version",
      columns: [{ name: "label", declaredType: "TEXT", generated: false, primaryKey: false }],
      rows: ["first", "second"].map((value, index) => ({
        cells: [{ kind: "text", value }],
        identity: { key: [{ kind: "integer", value: String(index + 1) }], revision: value },
      })),
      nextOffset: null,
    };
    const load = vi.spyOn(platform, "loadSqliteTable").mockImplementation((_target, options) => {
      if (options.filter) return Promise.resolve({ ...data, rows: [data.rows[1]] });
      if (options.sort) return Promise.resolve({ ...data, rows: [...data.rows].reverse() });
      if (options.offset === 1) return Promise.resolve({ ...data, rows: [data.rows[1]] });
      return Promise.resolve({ ...data, rows: [data.rows[0]], nextOffset: 1,
        nextCursor: { version: data.version, values: [{ kind: "integer", value: "1" }] } });
    });
    const save = vi.spyOn(platform, "saveSqliteTable").mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Load SQLite fixture" }));
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: "main.orders" } });
    fireEvent.contextMenu(tree.getByRole("button", { name: /^orders/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Table" }));
    const editor = within(await screen.findByRole("region", { name: "Table data" }));
    await editor.findByRole("cell", { name: "first" });
    fireEvent.click(editor.getByRole("button", { name: "Edit data" }));
    await editor.findByDisplayValue("first");
    fireEvent.change(editor.getByRole("textbox", { name: "label" }), { target: { value: "edited first" } });
    fireEvent.click(editor.getByRole("button", { name: "Next page" }));
    await editor.findByDisplayValue("second");
    expect(editor.getByText("Page 2")).toBeVisible();
    expect(load).toHaveBeenLastCalledWith({ sourceId: sqliteProfile.id, table: "orders" }, expect.objectContaining({
      offset: 1, cursor: { version: data.version, values: [{ kind: "integer", value: "1" }] },
    }));
    expect(editor.queryByText("edited first")).toBeNull();
    fireEvent.click(editor.getByRole("button", { name: "Delete row" }));
    fireEvent.change(editor.getByRole("combobox", { name: "Rows per page" }), { target: { value: "50" } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      { sourceId: sqliteProfile.id, table: "orders" }, expect.objectContaining({ offset: 0, pageSize: 50 }),
    ));
    expect(editor.getByText("Pending changes: 2")).toBeVisible();
    const columnHandle = editor.getByRole("separator", { name: "Resize label column" });
    fireEvent.keyDown(columnHandle, { key: "ArrowRight" });
    expect(columnHandle).toHaveAttribute("aria-valuenow", "156");
    fireEvent.click(editor.getByRole("button", { name: "Sort by label" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sort ascending" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      { sourceId: sqliteProfile.id, table: "orders" }, expect.objectContaining({ offset: 0, sort: { column: "label", direction: "asc" } }),
    ));
    expect(await editor.findByRole("cell", { name: "edited first" })).toBeVisible();
    expect(editor.getByRole("separator", { name: "Resize label column" })).toHaveAttribute("aria-valuenow", "156");

    fireEvent.click(editor.getByRole("button", { name: "Filter" }));
    fireEvent.change(editor.getByRole("searchbox", { name: "Filter value" }), { target: { value: "second" } });
    fireEvent.click(editor.getByRole("button", { name: "Apply filter" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      { sourceId: sqliteProfile.id, table: "orders" }, expect.objectContaining({
        offset: 0, filter: { match: "all", rules: [{ column: "label", kind: "contains", value: "second" }] },
      }),
    ));
    expect(editor.getByText("Pending changes: 2")).toBeVisible();
    await waitFor(() => expect(editor.queryByRole("cell", { name: "edited first" })).toBeNull());
    fireEvent.click(editor.getByRole("button", { name: "Done editing" }));
    expect(editor.queryByRole("region", { name: "Row editor" })).toBeNull();
    fireEvent.click(editor.getByRole("button", { name: "Pending only" }));
    expect(editor.getByRole("cell", { name: "edited first" })).toBeVisible();
    expect(editor.getByRole("cell", { name: "second" })).toBeVisible();

    fireEvent.click(editor.getByRole("button", { name: "Save changes" }));
    expect(await editor.findByText("Saved 2 row changes.")).toBeVisible();
    expect(editor.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(save).toHaveBeenCalledExactlyOnceWith({
      target: { sourceId: sqliteProfile.id, table: "orders" },
      version: data.version,
      changes: [
        { kind: "update", identity: data.rows[0].identity, fields: [{ column: 0, value: { kind: "text", value: "edited first" } }] },
        { kind: "delete", identity: data.rows[1].identity },
      ],
    });
  });
  it("opens table data in Database, leaves the Query draft intact, and exports the selected objects", async () => {
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
    clearQuerySessions();
    const workspaceKey = queryWorkspaceKey(reportSnapshot.sourceId);
    saveQuerySession(workspaceKey, { ...loadQuerySession(workspaceKey), draft: "SELECT 42;", rowLimit: 500 });
    try {
      const platform = await mount();
      const query = vi.spyOn(platform, "executeReadonlyQuery").mockResolvedValue({
        queryId: "preview", columns: [{ name: "id", databaseType: "int8" }], rows: [[{ kind: "text", value: "5678", truncated: false }]],
        rowCount: 1, truncated: false, durationMs: 1, notices: [],
      });
      const exportFile = vi.spyOn(platform, "exportDatabaseFile").mockImplementation((_input, progress) => {
        progress({ stage: "exporting", bytes: 2048 });
        return Promise.resolve({ path: "/exports/orders.json", bytes: 2048 });
      });
      fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search database objects" }), { target: { value: "public.orders" } });
      const row = screen.getByRole("button", { name: /^orders/ });
      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByRole("menuitem", { name: "Open Table" }));
      const dataWorkspace = await screen.findByRole("region", { name: "Table data" });
      expect(await within(dataWorkspace).findByRole("cell", { name: "5678" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(query).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ sourceId: reportSnapshot.sourceId, rowLimit: 101, tableBrowse: true,
        sql: 'SELECT *, CAST("id" AS TEXT) AS "__nodal_cursor_0"\nFROM "public"."orders"\nORDER BY "id" ASC\nLIMIT 101;' }), expect.any(Function));
      fireEvent.click(screen.getByRole("button", { name: "Query" }));
      const queryWorkspace = await screen.findByRole("region", { name: /Query workspace/i });
      expect(queryWorkspace.querySelector(".cm-content")).toHaveTextContent("SELECT 42;");
      expect(within(queryWorkspace).getByRole("combobox", { name: "Row limit" })).toHaveValue("500");

      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByRole("menuitem", { name: "Export Wizard…" }));
      const wizard = within(screen.getByRole("dialog", { name: "Export Wizard…" }));
      expect(wizard.getByRole("checkbox", { name: /Protect spreadsheet formulas/ })).toBeChecked();
      fireEvent.change(wizard.getByRole("combobox", { name: "File format" }), { target: { value: "json" } });
      fireEvent.click(wizard.getByRole("checkbox", { name: "customer_id" }));
      fireEvent.click(wizard.getByRole("button", { name: "Choose file and export…" }));
      expect(await wizard.findByText(/Saved 2 KiB to/)).toBeVisible();
      expect(exportFile).toHaveBeenCalledWith(expect.objectContaining({ sourceId: reportSnapshot.sourceId, export: {
        kind: "tableData", table: { kind: "table", schema: "public", name: "orders" }, format: "json", protectFormulas: true, columns: ["id", "total"],
      } }), expect.any(Function));
      fireEvent.click(wizard.getByRole("button", { name: "Done" }));
      fireEvent.contextMenu(screen.getByRole("button", { name: /^public\s*\d+$/ }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Dump SQL File" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Structure Only…" }));
      const dump = within(screen.getByRole("dialog", { name: "Dump SQL File" }));
      expect(dump.getByText("Commerce / public")).toBeVisible();
      fireEvent.click(dump.getByRole("button", { name: "Choose file and export…" }));
      await waitFor(() => expect(exportFile).toHaveBeenLastCalledWith(expect.objectContaining({
        sourceId: reportSnapshot.sourceId,
        export: { kind: "sqlDump", schema: "public", mode: "structureOnly" },
      }), expect.any(Function)));
    } finally {
      cleanup();
      clearQuerySessions();
      if (showModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModal); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      if (close) Object.defineProperty(HTMLDialogElement.prototype, "close", close); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });
  it("opens the selected MySQL table and cancels its pending preview when another table is selected", async () => {
    const platform = await mount();
    let registered!: () => void;
    let finishFirst!: () => void;
    const query = vi.spyOn(platform, "executeReadonlyQuery")
      .mockImplementationOnce((_input, onRegistered) => {
        registered = onRegistered!;
        return new Promise((_resolve, reject) => { finishFirst = () => reject(new Error("Cancelled")); });
      })
      .mockRejectedValueOnce({ kind: "connection", message: "Fixture connection interrupted" })
      .mockResolvedValueOnce({
        queryId: "latest-preview", columns: [{ name: "id", databaseType: "bigint" }],
        rows: [[{ kind: "text", value: "5678", truncated: false }]], rowCount: 1, truncated: false, durationMs: 1, notices: [],
      });
    const cancel = vi.spyOn(platform, "cancelQuery").mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    pickOrders();
    expect(query).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const workspace = within(await screen.findByRole("region", { name: "Table data" }));
    expect(workspace.getByRole("heading", { name: "public.orders" })).toBeVisible();
    const loading = workspace.getByText("Loading table data…");
    const loadingBody = loading.closest(".table-data-preview-result");
    expect(loading).toHaveAttribute("role", "status");
    expect(loadingBody?.nextElementSibling).toContainElement(workspace.getByRole("button", { name: "Next page" }));
    expect(workspace.queryByRole("button", { name: "Current SQL" })).toBeNull();
    await waitFor(() => expect(query).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sql: "SELECT *, CONVERT(`id` USING utf8mb4) AS `__nodal_cursor_0`\nFROM `public`.`orders`\nORDER BY `id` ASC\nLIMIT 101;", rowLimit: 101,
    }), expect.any(Function)));

    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.change(tree.getByRole("searchbox"), { target: { value: "public.customers" } });
    fireEvent.click(tree.getByRole("button", { name: /^customers/ }));
    const customers = within(screen.getByRole("region", { name: "Table data" }));
    expect(customers.getByRole("heading", { name: "public.customers" })).toBeVisible();
    const pager = customers.getByRole("button", { name: "Next page" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    registered();
    expect(cancel).toHaveBeenCalledWith(query.mock.calls[0][0].queryId);
    finishFirst();

    expect(await customers.findByRole("alert")).toHaveTextContent("Fixture connection interrupted");
    fireEvent.click(customers.getByRole("button", { name: "Retry" }));
    const cell = await customers.findByRole("cell", { name: "5678" });
    expect(cell).toBeVisible();
    expect(cell.closest(".table-data-preview-result")?.nextElementSibling).toContainElement(pager);
    expect(customers.queryByText("Loading table data…")).toBeNull();
    expect(query.mock.lastCall?.[0].sql).toContain("FROM `public`.`customers`\nORDER BY `id` ASC\nLIMIT 101;");
    expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
  });
  it("fetches another network page by cursor and restarts paging when sorting changes", async () => {
    const platform = await mount();
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ sql, queryId }) => {
      const first = sql.includes("WHERE") ? 101 : 1;
      const rowCount = first === 1 ? 101 : 1;
      return Promise.resolve({ queryId, rowCount, durationMs: 1, truncated: false, notices: [],
        columns: [{ name: "id", databaseType: "uuid" }, { name: "__nodal_cursor_0", databaseType: "text" }],
        rows: Array.from({ length: rowCount }, (_, i) => {
          const value = `00000000-0000-0000-0000-${String(i + first).padStart(12, "0")}`;
          return [
            { kind: "text" as const, value, truncated: false },
            { kind: "text" as const, value, truncated: false },
          ];
        }),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    pickOrders();
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const workspace = within(await screen.findByRole("region", { name: "Table data" }));
    const next = await workspace.findByRole("button", { name: "Next page" });
    expect(workspace.queryByText("__nodal_cursor_0")).toBeNull();
    expect(workspace.queryByTitle(/000000000101$/)).toBeNull();
    fireEvent.click(next);
    expect(await workspace.findByText("Page 2")).toBeVisible();
    expect(await workspace.findByTitle(/000000000101$/)).toBeVisible();
    expect(next).toBeDisabled();
    expect(query.mock.lastCall?.[0].sql).toContain('"id" > CAST($nodal$00000000-0000-0000-0000-000000000100$nodal$');
    fireEvent.click(workspace.getByRole("button", { name: "Previous page" }));
    await workspace.findByText("Page 1");
    const nextAgain = workspace.getByRole("button", { name: "Next page" });
    await waitFor(() => expect(nextAgain).toBeEnabled());
    fireEvent.click(nextAgain);
    await workspace.findByText("Page 2");
    fireEvent.click(workspace.getByRole("button", { name: "Sort by id" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sort descending" }));
    await workspace.findByText("Page 1");
    expect(query.mock.lastCall?.[0].sql).not.toContain("WHERE");
    expect(query.mock.lastCall?.[0].sql).toContain('ORDER BY "id" DESC');
  });

  it("remembers the loaded network page and both scroll axes, and resets them when query settings change", async () => {
    const [otherTable, orders] = reportSnapshot.schemas[0].tables;
    const platform = getPlatform();
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId, rowLimit, sql }) => {
      const cursor = Number(/WHERE .*?\$nodal\$(\d+)\$nodal\$/.exec(sql)?.[1] ?? 0);
      const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? cursor);
      const columns = [{ name: "id", databaseType: "uuid" }];
      if (sql.includes("__nodal_cursor_0")) columns.push({ name: "__nodal_cursor_0", databaseType: "text" });
      const rows = Array.from({ length: Math.max(0, Math.min(rowLimit, 250 - offset)) }, (_, index) =>
        columns.map(() => ({ kind: "text" as const, truncated: false, value: String(offset + index + 1) })));
      return Promise.resolve({ queryId, rowCount: rows.length, rows, durationMs: 1, truncated: false, notices: [], columns });
    });
    const renderTable = (table: typeof orders) => render(<QueryClientProvider client={new QueryClient()}>
      <TableDataPreview platform={platform} snapshot={reportSnapshot} table={table} />
    </QueryClientProvider>);
    const view = renderTable(orders);
    const size = screen.getByRole("combobox", { name: "Rows per page" });
    expect(size).toHaveValue("100");
    await screen.findByTitle("100");
    await waitFor(() => expect(size).toBeEnabled());
    fireEvent.change(size, { target: { value: "50" } });
    await waitFor(() => expect(screen.queryByTitle("51")).toBeNull());
    expect(query.mock.lastCall?.[0].rowLimit).toBe(51);

    const jump = screen.getByRole("spinbutton", { name: "Go to page" });
    const go = screen.getByRole("button", { name: "Go" });
    fireEvent.change(jump, { target: { value: "0" } });
    expect(go).toBeDisabled();
    fireEvent.change(jump, { target: { value: "4" } });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    await screen.findByText("Page 4");
    expect(await screen.findByTitle("151")).toBeVisible();
    expect(query.mock.lastCall?.[0].sql).toContain("LIMIT 51 OFFSET 150");
    const nextAfterJump = screen.getByRole("button", { name: "Next page" });
    await waitFor(() => expect(nextAfterJump).toBeEnabled());
    fireEvent.click(nextAfterJump);
    await screen.findByText("Page 5");
    expect(await screen.findByTitle("201")).toBeVisible();
    expect(query.mock.lastCall?.[0].sql).toContain('WHERE (("id" > CAST($nodal$200$nodal$');
    expect(query.mock.lastCall?.[0].sql).not.toContain("OFFSET");
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    const grid = () => screen.getByRole("region", { name: "Query results" });
    fireEvent.scroll(grid(), { target: { scrollLeft: 240, scrollTop: 680 } });

    fireEvent.change(jump, { target: { value: "99" } });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await screen.findByText("No rows on this page. Enter an earlier page number.")).toBeVisible();
    expect(query.mock.calls.every(([{ sql }]) => !/\bcount\s*\(/i.test(sql))).toBe(true);
    view.unmount();
    const second = renderTable(otherTable);
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toHaveValue("100");
    await screen.findByTitle("1");
    expect(screen.getByText("Page 1")).toBeVisible();
    expect(grid()).toMatchObject({ scrollLeft: 0, scrollTop: 0 });
    second.unmount();
    query.mockClear();
    renderTable(orders);
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toHaveValue("50");
    expect(await screen.findByTitle("201")).toBeVisible();
    expect(screen.getByText("Page 5")).toBeVisible();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.lastCall?.[0].sql).toContain("LIMIT 51 OFFSET 200");
    expect(grid()).toMatchObject({ scrollLeft: 240, scrollTop: 680 });

    const pageKey = tablePageNumberKey(reportSnapshot.sourceId, "public", "orders");
    const jumpToFour = async () => {
      fireEvent.change(screen.getByRole("spinbutton", { name: "Go to page" }), { target: { value: "4" } });
      const jumpButton = screen.getByRole("button", { name: "Go" });
      await waitFor(() => expect(jumpButton).toBeEnabled());
      fireEvent.click(jumpButton);
      expect(await screen.findByTitle("151")).toBeVisible();
      fireEvent.scroll(grid(), { target: { scrollLeft: 150, scrollTop: 310 } });
    };
    const expectReset = async () => {
      expect(localStorage.getItem(pageKey)).toBeNull();
      expect(await screen.findByTitle("1")).toBeVisible();
      expect(screen.getByText("Page 1")).toBeVisible();
      expect(grid()).toMatchObject({ scrollLeft: 0, scrollTop: 0 });
    };
    fireEvent.click(screen.getByRole("button", { name: "Sort by id" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sort descending" }));
    await expectReset();
    await jumpToFour();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter operator" }), { target: { value: "isNotNull" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    await expectReset();
    // Changing the page size must also reset axes while already on page one.
    fireEvent.scroll(grid(), { target: { scrollLeft: 150, scrollTop: 310 } });
    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "100" } });
    await expectReset();
    const next = screen.getByRole("button", { name: "Next page" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    await screen.findByText("Page 2");
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    await screen.findByText("Page 1");
    expect(screen.getByTitle("1")).toBeVisible();
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
    expect(query.mock.lastCall?.[0].sql).not.toContain("OFFSET");
    expect(query.mock.calls.every(([{ sql }]) => !/\bcount\s*\(/i.test(sql))).toBe(true);
  });

  it("restores the SQLite page and scroll position and resets them if that page disappears", async () => {
    const platform = getPlatform();
    let total = 250;
    const load = vi.spyOn(platform, "loadSqliteTable").mockImplementation((_target, { offset, pageSize = 100 }) => {
      const count = Math.max(0, Math.min(pageSize, total - offset));
      return Promise.resolve({
        version: "fixture",
        columns: [{ name: "id", declaredType: "INTEGER", generated: false, primaryKey: true }],
        rows: Array.from({ length: count }, (_, index) => ({
          cells: [{ kind: "integer" as const, value: String(offset + index + 1) }], identity: null,
        })),
        nextOffset: offset + count < total ? offset + count : null,
      });
    });
    const target = { sourceId: sqliteProfile.id, table: "orders" };
    const renderTable = () => render(<QueryClientProvider client={new QueryClient()}>
      <SqliteTableWorkspace platform={platform} target={target} binding="fixture" activeTable panelWidth={330} onPanelWidthChange={() => {}} />
    </QueryClientProvider>);
    const view = renderTable();
    await screen.findByTitle("1");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Go to page" }), { target: { value: "3" } });
    const go = screen.getByRole("button", { name: "Go" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await screen.findByTitle("201")).toBeVisible();
    const grid = () => screen.getByRole("region", { name: "Rows" });
    fireEvent.scroll(grid(), { target: { scrollLeft: 130, scrollTop: 420 } });
    view.unmount();
    load.mockClear();
    const reopened = renderTable();
    expect(await screen.findByTitle("201")).toBeVisible();
    expect(load).toHaveBeenCalledExactlyOnceWith(target, expect.objectContaining({ offset: 200, pageSize: 100 }));
    expect(grid()).toMatchObject({ scrollLeft: 130, scrollTop: 420 });
    reopened.unmount();

    total = 50;
    load.mockClear();
    renderTable();
    expect(await screen.findByTitle("1")).toBeVisible();
    expect(load.mock.calls.map(([, { offset }]) => offset)).toEqual([200, 0]);
    expect(localStorage.getItem(tablePageNumberKey(target.sourceId, "main", target.table))).toBeNull();
    expect(grid()).toMatchObject({ scrollLeft: 0, scrollTop: 0 });
  });

  it.each(ddlFixtures.filter(({ profile }) => profile.databaseType !== "sqlite"))(
    "counts filtered $engine rows only when going to the last page",
    async ({ snapshot }) => {
      const platform = getPlatform();
      const table = snapshot.schemas[0].tables[1];
      const { schema, name } = table.key;
      saveTableFilter(tableFilterKey(snapshot.sourceId, schema, name), { match: "all", rules: [{ kind: "isNotNull", column: "id" }] });
      const value = (id: number) => ({ kind: "text" as const, value: String(id), truncated: false });
      const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ sql, queryId, rowLimit }) => {
        const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
        const count = sql.includes("COUNT(*)");
        const columns = [{ name: "id", databaseType: "text" }];
        if (sql.includes("__nodal_cursor_0")) columns.push({ name: "__nodal_cursor_0", databaseType: "text" });
        const rows = count ? [[value(207)]] : Array.from({ length: Math.min(rowLimit, 207 - offset) }, (_, index) =>
          columns.map(() => value(offset + index + 1)));
        return Promise.resolve({ queryId, columns, rows, rowCount: rows.length, durationMs: 1, truncated: false, notices: [] });
      });
      const countStatements = () => query.mock.calls.map(([input]) => input.sql).filter((sql) => sql.includes("COUNT(*)"));
      render(<QueryClientProvider client={new QueryClient()}>
        <TableDataPreview platform={platform} snapshot={snapshot} table={table} />
      </QueryClientProvider>);
      await screen.findByTitle("1");
      fireEvent.change(screen.getByRole("spinbutton", { name: "Go to page" }), { target: { value: "2" } });
      const go = screen.getByRole("button", { name: "Go" });
      await waitFor(() => expect(go).toBeEnabled());
      fireEvent.click(go);
      await screen.findByTitle("101");
      expect(countStatements()).toHaveLength(0);

      const last = screen.getByRole("button", { name: "Last page" });
      await waitFor(() => expect(last).toBeEnabled());
      fireEvent.click(last);
      await screen.findByText("Page 3");
      expect(await screen.findByTitle("207")).toBeVisible();
      expect(countStatements()).toEqual([
        snapshot.database.databaseType === "mySql"
          ? 'SELECT CAST(COUNT(*) AS CHAR)\nFROM `public`.`orders`\nWHERE (`id` IS NOT NULL);'
          : 'SELECT CAST(COUNT(*) AS TEXT)\nFROM "public"."orders"\nWHERE ("id" IS NOT NULL);',
      ]);
      expect(query.mock.lastCall?.[0].sql).toContain("LIMIT 101 OFFSET 200");
      const previous = screen.getByRole("button", { name: "Previous page" });
      await waitFor(() => expect(previous).toBeEnabled());
      fireEvent.click(previous);
      await screen.findByText("Page 2");
      expect(countStatements()).toHaveLength(1);
    },
  );

  it("keeps SQLite on the current page if the filtered count fails and allows retrying", async () => {
    const platform = getPlatform();
    const target = { sourceId: sqliteProfile.id, table: "orders" };
    const filter = { match: "all" as const, rules: [{ kind: "isNotNull" as const, column: "id" }] };
    saveTableFilter(tableFilterKey(target.sourceId, "main", target.table), filter);
    const count = vi.spyOn(platform, "countSqliteTableRows").mockRejectedValueOnce(new Error("Count timed out")).mockResolvedValue("201");
    const load = vi.spyOn(platform, "loadSqliteTable").mockImplementation((_target, { offset }) => Promise.resolve({
      version: "fixture",
      columns: [{ name: "id", declaredType: "INTEGER", generated: false, primaryKey: true }],
      rows: [{ cells: [{ kind: "integer", value: String(offset + 1) }], identity: null }],
      nextOffset: offset === 0 ? 100 : null,
    }));
    render(<QueryClientProvider client={new QueryClient()}>
      <SqliteTableWorkspace platform={platform} target={target} binding="fixture" activeTable panelWidth={330} onPanelWidthChange={() => {}} />
    </QueryClientProvider>);
    await screen.findByRole("cell", { name: "1" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2");
    expect(count).not.toHaveBeenCalled();

    const last = screen.getByRole("button", { name: "Last page" });
    fireEvent.click(last);
    expect(await screen.findByRole("alert")).toHaveTextContent("Count timed out");
    expect(screen.getByText("Page 2")).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
    fireEvent.click(last);
    await screen.findByText("Page 3");
    expect(count.mock.calls).toEqual([[target, filter], [target, filter]]);
    expect(load).toHaveBeenLastCalledWith(target, expect.objectContaining({ offset: 200, pageSize: 100, filter }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["unique", "offset", "unusable cursor", "inherited rows", "legacy inherited rows"] as const)("paginates a network table using %s", async (mode) => {
    const base = reportSnapshot.schemas[0].tables[1];
    const inherited = mode === "inherited rows" || mode === "legacy inherited rows";
    const useOffset = mode === "offset" || inherited;
    const table = { ...base, primaryKey: inherited ? base.primaryKey : null,
      includesInheritedRows: mode === "legacy inherited rows" ? undefined : inherited };
    const platform = getPlatform();
    const cell = (value: string, truncated = false) => ({ kind: "text" as const, value, truncated });
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ sql, queryId }) => {
      const result = { queryId, durationMs: 1, truncated: false, notices: [] };
      if (sql.includes("pg_catalog.pg_index")) {
        const invalid = [[cell("1"), cell("id"), cell("1")], [cell("1"), cell("customer_id"), cell("0")]];
        const rows = inherited ? [] : useOffset ? invalid : [...invalid, [cell("2"), cell("id"), cell("1")]];
        return Promise.resolve({ ...result, columns: [], rows, rowCount: rows.length });
      }
      const isSecond = / OFFSET 100|\bWHERE\b/.test(sql);
      const projected = sql.includes("__nodal_cursor_0");
      const columns = [{ name: "id", databaseType: "uuid" }];
      if (projected) columns.push({ name: "__nodal_cursor_0", databaseType: "text" });
      const rows = Array.from({ length: isSecond ? 1 : 101 }, (_, i) => {
        const id = String(isSecond ? 101 : i + 1);
        return projected ? [cell(id), cell(id, i === 99 && mode === "unusable cursor")] : [cell(id)];
      });
      return Promise.resolve({ ...result, columns, rows, rowCount: rows.length });
    });
    render(<QueryClientProvider client={new QueryClient()}><TableDataPreview platform={platform} snapshot={reportSnapshot} table={table} /></QueryClientProvider>);
    const workspace = within(await screen.findByRole("region", { name: "Table data" }));
    expect(await workspace.findByText("Page 1")).toBeVisible();
    expect(workspace.queryByRole("cell", { name: "101" })).toBeNull();
    fireEvent.click(workspace.getByRole("button", { name: "Next page" }));
    const page = await workspace.findByText("Page 2");
    expect(workspace.getByRole("cell", { name: "101" })).toBeVisible();
    expect(workspace.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(query.mock.calls.filter(([input]) => input.sql.includes("pg_catalog.pg_index"))).toHaveLength(mode === "inherited rows" ? 0 : 1);
    const sql = query.mock.lastCall?.[0].sql;
    if (mode === "unique") {
      expect(sql).toContain('"id" > CAST($nodal$100$nodal$ AS "pg_catalog"."uuid")');
      expect(sql).not.toContain("OFFSET");
      expect(page).not.toHaveAttribute("title");
    } else {
      expect(sql).toContain("LIMIT 101 OFFSET 100");
      expect(sql).toContain(useOffset ? "ORDER BY tableoid ASC, ctid ASC" : 'ORDER BY "id" ASC');
      expect(page).toHaveAttribute("title", "Offset pagination");
    }
  });

  it("sorts the network table before limiting the preview and preserves column widths", async () => {
    const platform = await mount();
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
      queryId, columns: [{ name: "id", databaseType: "int8" }, { name: "label", databaseType: "text" }],
      rows: [[{ kind: "text", value: "1", truncated: false }, { kind: "text", value: "A", truncated: false }]],
      rowCount: 1, truncated: false, durationMs: 1, notices: [],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    pickOrders();
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const workspace = within(await screen.findByRole("region", { name: "Table data" }));
    await workspace.findByRole("cell", { name: "A" });
    const handle = () => workspace.getByRole("separator", { name: "Resize id column" });
    const header = () => handle().closest("th");
    fireEvent.mouseDown(handle(), { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 150 });
    fireEvent.mouseUp(window, { clientX: 150 });
    expect(handle()).toHaveAttribute("aria-valuenow", "80");
    expect(handle().closest("table")?.querySelectorAll("col")[1]).toHaveStyle({ width: "80px" });

    const openMenu = () => fireEvent.keyDown(workspace.getByRole("button", { name: "Sort by id" }), { key: "ArrowDown" });
    openMenu();
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Sort ascending" })).toHaveFocus();
    expect(within(menu).getByRole("menuitem", { name: "Clear sort" })).toBeDisabled();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitemradio", { name: "Sort descending" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Enter" });
    await waitFor(() => expect(header()).toHaveAttribute("aria-sort", "descending"));
    expect(header()?.querySelector(".data-column-sort-direction")).toHaveTextContent("↓");
    expect(workspace.getByRole("button", { name: "Sort by id" })).not.toHaveTextContent("↓");
    expect(workspace.getByRole("button", { name: "Sort by id" })).toHaveFocus();
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      sql: 'SELECT *, CAST("id" AS TEXT) AS "__nodal_cursor_0"\nFROM "public"."orders"\nORDER BY "id" DESC\nLIMIT 101;', rowLimit: 101,
    }), expect.any(Function));
    expect(handle()).toHaveAttribute("aria-valuenow", "80");

    openMenu();
    expect(screen.getByRole("menuitemradio", { name: "Sort descending" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear sort" }));
    await waitFor(() => expect(header()).not.toHaveAttribute("aria-sort"));
    expect(header()?.querySelector(".data-column-sort-direction")).not.toBeInTheDocument();
    expect(query.mock.lastCall?.[0].sql).toContain('ORDER BY "id" ASC\nLIMIT 101;');

    const titleButton = workspace.getByRole("button", { name: "id" });
    const unsortedQueryCount = query.mock.calls.length;
    titleButton.focus();
    fireEvent.click(titleButton);
    expect(titleButton).toHaveAttribute("aria-pressed", "true");
    expect(workspace.getByRole("cell", { name: "1" })).toHaveAttribute("data-column-selected", "true");
    expect(workspace.getByRole("cell", { name: "A" })).not.toHaveAttribute("data-column-selected");
    expect(titleButton).toHaveFocus();
    fireEvent.click(workspace.getByRole("cell", { name: "A" }));
    expect(titleButton).toHaveAttribute("aria-pressed", "false");
    expect(workspace.getByRole("cell", { name: "A" }).closest("tr")).toHaveAttribute("aria-selected", "true");
    expect(query).toHaveBeenCalledTimes(unsortedQueryCount);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sort ascending" }));
    await waitFor(() => expect(header()).toHaveAttribute("aria-sort", "ascending"));
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sort descending" }));
    await waitFor(() => expect(header()).toHaveAttribute("aria-sort", "descending"));

    const refresh = vi.spyOn(platform, "capturePostgresSnapshot").mockResolvedValue({
      snapshot: { ...ddlFixtures[1].snapshot, id: "updated-postgres-model" }, stored: true, changeSet: null,
    });
    const queryCount = query.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh schema" }));
    await waitFor(() => expect(query).toHaveBeenCalledTimes(queryCount + 1));
    expect(refresh).toHaveBeenCalledWith(ddlFixtures[1].profile.id, "manual");
    expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
    expect(workspace.getByRole("heading", { name: "public.orders" })).toBeVisible();
    expect(header()).toHaveAttribute("aria-sort", "descending");
  });
  it.each([
    { engine: "SQLite", schema: "main", quote: '"' },
    { engine: "PostgreSQL", schema: "public", quote: '"' },
    { engine: "MySQL", schema: "public", quote: "`" },
  ])("restores and clears $engine sort settings independently for each table", async ({ engine, schema, quote }) => {
    const platform = await mount();
    const load = vi.spyOn(platform, "loadSqliteTable").mockResolvedValue({
      version: "sort-fixture",
      columns: [
        { name: "id", declaredType: "INTEGER", generated: false, primaryKey: true },
        { name: "label", declaredType: "TEXT", generated: false, primaryKey: false },
      ],
      rows: [], nextOffset: null,
    });
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
      queryId, columns: [{ name: "id", databaseType: "int8" }, { name: "label", databaseType: "text" }],
      rows: [], rowCount: 0, truncated: false, durationMs: 1, notices: [],
    }));
    function loadSource() {
      fireEvent.click(screen.getByRole("button", { name: `Load ${engine} fixture` }));
      fireEvent.click(screen.getByRole("button", { name: "Database" }));
    }
    async function openTable(name: string) {
      const tree = within(screen.getByRole("region", { name: "Database structure" }));
      fireEvent.change(tree.getByRole("searchbox"), { target: { value: `${schema}.${name}` } });
      fireEvent.click(tree.getByRole("button", { name: new RegExp(`^${name}`) }));
      const table = await screen.findByRole("region", { name: "Table data" });
      await within(table).findByRole("button", { name: "Sort by id" });
      return table;
    }
    const header = (table: HTMLElement, column: string) => within(table).getByRole("button", { name: `Sort by ${column}` }).closest("th");
    function selectSort(table: HTMLElement, column: string, direction: "ascending" | "descending") {
      fireEvent.click(within(table).getByRole("button", { name: `Sort by ${column}` }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: `Sort ${direction}` }));
      return waitFor(() => expect(header(table, column)).toHaveAttribute("aria-sort", direction));
    }

    loadSource();
    const orders = await openTable("orders");
    await selectSort(orders, "id", "descending");
    const customers = await openTable("customers");
    expect(header(customers, "id")).not.toHaveAttribute("aria-sort");
    await selectSort(customers, "label", "ascending");
    expect(header(await openTable("orders"), "id")).toHaveAttribute("aria-sort", "descending");

    cleanup();
    await mount();
    loadSource();
    load.mockClear();
    query.mockClear();
    const restored = await openTable("orders");
    expect(header(restored, "id")).toHaveAttribute("aria-sort", "descending");
    if (engine === "SQLite") {
      expect(load).toHaveBeenCalledExactlyOnceWith({ sourceId: sqliteProfile.id, table: "orders" }, {
        offset: 0, pageSize: 100, sort: { column: "id", direction: "desc" }, filter: undefined,
      });
    } else {
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0].sql).toContain(`ORDER BY ${quote}id${quote} DESC`);
    }
    fireEvent.click(within(restored).getByRole("button", { name: "Sort by id" }));
    expect(screen.getByRole("menuitemradio", { name: "Sort descending" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear sort" }));
    await waitFor(() => expect(header(restored, "id")).not.toHaveAttribute("aria-sort"));

    cleanup();
    await mount();
    loadSource();
    expect(header(await openTable("orders"), "id")).not.toHaveAttribute("aria-sort");
    expect(header(await openTable("customers"), "label")).toHaveAttribute("aria-sort", "ascending");
  });
  it("can clear a restored network sort when its column has been removed", async () => {
    const platform = await mount();
    const key = tableSortKey(ddlFixtures[1].profile.id, "public", "orders");
    saveTableSort(key, { column: "old_id", direction: "asc" });
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockRejectedValueOnce("Column old_id does not exist.")
      .mockImplementation(({ queryId }) => Promise.resolve({
        queryId, columns: [{ name: "id", databaseType: "int8" }],
        rows: [], rowCount: 0, truncated: false, durationMs: 1, notices: [],
      }));
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    pickOrders();
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const workspace = within(await screen.findByRole("region", { name: "Table data" }));
    fireEvent.click(await workspace.findByRole("button", { name: "Clear sort" }));
    await workspace.findByRole("button", { name: "Sort by id" });
    expect(query.mock.calls[1][0].sql).toContain('ORDER BY "id" ASC');
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("applies multiple network filter conditions together and clears them without changing the table", async () => {
    const platform = await mount();
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
      queryId, columns: [{ name: "id", databaseType: "int8" }],
      rows: [[{ kind: "text", value: "5", truncated: false }]],
      rowCount: 1, truncated: false, durationMs: 1, notices: [],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    pickOrders();
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    const workspace = within(await screen.findByRole("region", { name: "Table data" }));
    await workspace.findByRole("cell", { name: "5" });
    fireEvent.click(workspace.getByRole("button", { name: "Filter" }));
    const editor = within(workspace.getByRole("form", { name: "Filter table data" }));
    fireEvent.change(editor.getByRole("combobox", { name: "Match conditions" }), { target: { value: "any" } });
    const first = within(editor.getByRole("group", { name: "Condition 1" }));
    fireEvent.change(first.getByRole("combobox", { name: "Filter column" }), { target: { value: "id" } });
    fireEvent.change(first.getByRole("combobox", { name: "Filter operator" }), { target: { value: "between" } });
    fireEvent.change(first.getByRole("searchbox", { name: "Filter value" }), { target: { value: "1" } });
    expect(editor.getByRole("button", { name: "Apply filter" })).toBeDisabled();
    fireEvent.change(first.getByRole("searchbox", { name: "End value" }), { target: { value: "10" } });
    fireEvent.click(editor.getByRole("button", { name: "+ Add condition" }));
    const second = within(editor.getByRole("group", { name: "Condition 2" }));
    fireEvent.change(second.getByRole("combobox", { name: "Filter column" }), { target: { value: "id" } });
    fireEvent.change(second.getByRole("combobox", { name: "Filter operator" }), { target: { value: "inList" } });
    fireEvent.change(second.getByRole("textbox", { name: "One value per line" }), { target: { value: "42\n70" } });
    expect(query).toHaveBeenCalledTimes(1);
    fireEvent.click(editor.getByRole("button", { name: "Apply filter" }));
    await waitFor(() => expect(query.mock.lastCall?.[0].sql).toContain(
      'WHERE ("id" BETWEEN $nodal$1$nodal$ AND $nodal$10$nodal$) OR ("id" IN ($nodal$42$nodal$, $nodal$70$nodal$))\nORDER BY "id" ASC\nLIMIT 101;',
    ));
    expect(workspace.getByRole("button", { name: "Filter (2)" })).toBeVisible();
    fireEvent.click(editor.getByRole("button", { name: "Clear filter" }));
    await waitFor(() => expect(query.mock.lastCall?.[0].sql).not.toContain("WHERE"));
  });
  it.each([
    { engine: "SQLite", schema: "main" },
    { engine: "PostgreSQL", schema: "public" },
  ])("restores and clears applied $engine filters independently for each table", async ({ engine, schema }) => {
    const platform = await mount();
    const load = vi.spyOn(platform, "loadSqliteTable").mockResolvedValue({
      version: "filter-fixture", columns: [{ name: "id", declaredType: "INTEGER", generated: false, primaryKey: true }],
      rows: [{ cells: [{ kind: "integer", value: "5" }], identity: null }], nextOffset: null,
    });
    const query = vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
      queryId, columns: [{ name: "id", databaseType: "int8" }],
      rows: [[{ kind: "text", value: "5", truncated: false }]],
      rowCount: 1, truncated: false, durationMs: 1, notices: [],
    }));
    function loadSource() {
      fireEvent.click(screen.getByRole("button", { name: `Load ${engine} fixture` }));
      fireEvent.click(screen.getByRole("button", { name: "Database" }));
    }
    async function openTable(name: string) {
      const tree = within(screen.getByRole("region", { name: "Database structure" }));
      fireEvent.change(tree.getByRole("searchbox"), { target: { value: `${schema}.${name}` } });
      fireEvent.click(tree.getByRole("button", { name: new RegExp(`^${name}`) }));
      const table = await screen.findByRole("region", { name: "Table data" });
      await within(table).findByRole("cell", { name: "5" });
      return table;
    }
    function openFilters(tableRegion: HTMLElement, buttonName: string) {
      const table = within(tableRegion);
      const button = table.getByRole("button", { name: buttonName });
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
      return within(table.getByRole("form", { name: "Filter table data" }));
    }

    loadSource();
    const orders = openFilters(await openTable("orders"), "Filter");
    fireEvent.change(orders.getByRole("combobox", { name: "Match conditions" }), { target: { value: "any" } });
    fireEvent.change(orders.getByRole("combobox", { name: "Filter operator" }), { target: { value: "between" } });
    fireEvent.change(orders.getByRole("searchbox", { name: "Filter value" }), { target: { value: "1" } });
    fireEvent.change(orders.getByRole("searchbox", { name: "End value" }), { target: { value: "8" } });
    fireEvent.click(orders.getByRole("button", { name: "+ Add condition" }));
    const second = within(orders.getByRole("group", { name: "Condition 2" }));
    expect(second.getByRole("combobox", { name: "Filter column" })).toHaveFocus();
    fireEvent.change(second.getByRole("combobox", { name: "Filter operator" }), { target: { value: "inList" } });
    fireEvent.change(second.getByRole("textbox"), { target: { value: "12\n25" } });
    expect(second.getByRole("checkbox")).toBeChecked();
    fireEvent.click(second.getByRole("checkbox"));
    expect(second.getByRole("textbox")).toHaveValue("12\n25");
    fireEvent.click(orders.getByRole("button", { name: "Apply filter" }));
    expect(await orders.findByText("Filter applied")).toBeVisible();
    fireEvent.change(orders.getByRole("searchbox", { name: "End value" }), { target: { value: "9" } });
    expect(orders.getByText("Unapplied changes")).toBeVisible();

    const customers = openFilters(await openTable("customers"), "Filter");
    expect(customers.getByRole("searchbox")).toHaveValue("");
    fireEvent.change(customers.getByRole("searchbox"), { target: { value: "5" } });
    fireEvent.click(customers.getByRole("button", { name: "Apply filter" }));
    expect(await customers.findByText("Filter applied")).toBeVisible();
    expect(openFilters(await openTable("orders"), "Filter (1)").getByRole("searchbox", { name: "End value" })).toHaveValue("8");

    cleanup();
    await mount();
    loadSource();
    load.mockClear();
    query.mockClear();
    const restored = openFilters(await openTable("orders"), "Filter (1)");
    expect(restored.getByRole("combobox", { name: "Match conditions" })).toHaveValue("any");
    expect(restored.getByRole("searchbox", { name: "End value" })).toHaveValue("8");
    expect(restored.getByRole("textbox")).toHaveValue("12\n25");
    expect(restored.getByRole("checkbox", { name: "Use condition 1" })).toBeChecked();
    expect(restored.getByRole("checkbox", { name: "Use condition 2" })).not.toBeChecked();
    expect(restored.getByRole("button", { name: "Apply filter" })).toBeDisabled();
    if (engine === "SQLite") {
      expect(load).toHaveBeenCalledExactlyOnceWith({ sourceId: sqliteProfile.id, table: "orders" }, expect.objectContaining({
        filter: { match: "any", rules: [
          { kind: "between", column: "id", value: "1", end: "8" },
        ] },
      }));
    } else {
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0].sql).toContain('WHERE ("id" BETWEEN $nodal$1$nodal$ AND $nodal$8$nodal$)');
      expect(query.mock.calls[0][0].sql).not.toContain(" IN ");
    }
    fireEvent.click(restored.getByRole("checkbox", { name: "Use condition 1" }));
    fireEvent.click(restored.getByRole("button", { name: "Apply filter" }));
    expect(await restored.findByText("All conditions are off")).toBeVisible();
    if (engine === "SQLite") {
      expect(load.mock.lastCall?.[1].filter).toBeUndefined();
    } else {
      expect(query.mock.lastCall?.[0].sql).not.toContain("WHERE");
    }

    const other = openFilters(await openTable("customers"), "Filter (1)");
    expect(other.getByRole("checkbox")).toBeChecked();
    const allOff = openFilters(await openTable("orders"), "Filter");
    expect(allOff.getByRole("searchbox", { name: "End value" })).toHaveValue("8");
    expect(allOff.getByRole("checkbox", { name: "Use condition 1" })).not.toBeChecked();
    fireEvent.click(allOff.getByRole("checkbox", { name: "Use condition 2" }));
    fireEvent.click(allOff.getByRole("button", { name: "Apply filter" }));
    expect(await allOff.findByText("Filter applied")).toBeVisible();
    if (engine === "SQLite") {
      expect(load.mock.lastCall?.[1].filter?.rules).toEqual([{ kind: "inList", column: "id", values: ["12", "25"] }]);
    } else {
      expect(query.mock.lastCall?.[0].sql).toContain('WHERE ("id" IN ($nodal$12$nodal$, $nodal$25$nodal$))');
    }
    fireEvent.click(allOff.getByRole("button", { name: "Clear filter" }));
    expect(allOff.queryByRole("button", { name: "Clear filter" })).toBeNull();

    cleanup();
    await mount();
    loadSource();
    expect(openFilters(await openTable("orders"), "Filter").getByRole("searchbox")).toHaveValue("");
    expect(openFilters(await openTable("customers"), "Filter (1)").getByRole("searchbox")).toHaveValue("5");
  });
  it.each([
    { engine: "SQLite", schema: "main", initialWidth: 140 },
    { engine: "PostgreSQL", schema: "public", initialWidth: 220 },
  ])("restores independent $engine table column widths after switching tables and remounting", async ({ engine, schema, initialWidth }) => {
    const platform = await mount();
    vi.spyOn(platform, "loadSqliteTable").mockResolvedValue({
      version: "width-fixture", columns: [{ name: "label", declaredType: "TEXT", generated: false, primaryKey: false }],
      rows: [], nextOffset: null,
    });
    vi.spyOn(platform, "executeReadonlyQuery").mockImplementation(({ queryId }) => Promise.resolve({
      queryId, columns: [{ name: "label", databaseType: "text" }],
      rows: [], rowCount: 0, truncated: false, durationMs: 1, notices: [],
    }));
    const loadSource = () => {
      fireEvent.click(screen.getByRole("button", { name: `Load ${engine} fixture` }));
      fireEvent.click(screen.getByRole("button", { name: "Database" }));
    };
    const openTable = async (name: string) => {
      const tree = within(screen.getByRole("region", { name: "Database structure" }));
      fireEvent.change(tree.getByRole("searchbox"), { target: { value: `${schema}.${name}` } });
      fireEvent.click(tree.getByRole("button", { name: new RegExp(`^${name}`) }));
      return screen.findByRole("separator", { name: "Resize label column" });
    };

    loadSource();
    const orders = await openTable("orders");
    expect(orders).toHaveAttribute("aria-valuenow", String(initialWidth));
    fireEvent.mouseDown(orders, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 270 });
    fireEvent.mouseUp(window, { clientX: 270 });
    expect(orders).toHaveAttribute("aria-valuenow", String(initialWidth + 70));

    const customers = await openTable("customers");
    expect(customers).toHaveAttribute("aria-valuenow", String(initialWidth));
    fireEvent.keyDown(customers, { key: "ArrowLeft" });
    expect(customers).toHaveAttribute("aria-valuenow", String(initialWidth - 16));
    expect(await openTable("orders")).toHaveAttribute("aria-valuenow", String(initialWidth + 70));

    cleanup();
    await mount();
    loadSource();
    expect(await openTable("customers")).toHaveAttribute("aria-valuenow", String(initialWidth - 16));
    expect(await openTable("orders")).toHaveAttribute("aria-valuenow", String(initialWidth + 70));
  });
  it("opens field details, highlights and locates repeated clicks, and clears stale field selection", async () => {
    const scrolled: HTMLElement[] = [];
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: function (this: HTMLElement) { scrolled.push(this); } });
    try {
      await mount();
      fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
      fireEvent.click(screen.getByRole("button", { name: "Inspect total field" }));
      const inspector = document.querySelector<HTMLElement>(".inspector")!;
      const highlighted = () => inspector.querySelector<HTMLElement>('[data-column-focus="true"]');
      expect(inspector).toBeVisible();
      expect(highlighted()).toHaveTextContent("Calculated order total");
      expect(scrolled.at(-1)).toBe(highlighted());
      expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(screen.getByRole("button", { name: "Semantics" }));
      fireEvent.click(screen.getByRole("button", { name: "Collapse right inspector" }));
      const scrollCount = scrolled.length;
      fireEvent.click(screen.getByRole("button", { name: "Inspect total field" }));
      expect(inspector).toBeVisible();
      expect(highlighted()).toHaveTextContent("Calculated order total");
      expect(scrolled.length).toBeGreaterThan(scrollCount);
      expect(scrolled.at(-1)).toBe(highlighted());

      fireEvent.click(screen.getByRole("button", { name: "Inspect customer field" }));
      expect(inspector.querySelectorAll('[data-column-focus="true"]')).toHaveLength(1);
      expect(highlighted()).toHaveTextContent("Customer identifier");
      expect(scrolled.at(-1)).toBe(highlighted());
      fireEvent.click(screen.getByRole("button", { name: "Inspect archived field" }));
      expect(highlighted()).toHaveTextContent("id");
      expect(inspector).toHaveTextContent("Archived order structure");
      fireEvent.click(screen.getByRole("button", { name: "Clear canvas selection" }));
      expect(highlighted()).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Inspect total field" }));
      pickOrders();
      expect(highlighted()).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Inspect total field" }));
      fireEvent.click(screen.getByRole("button", { name: "Load enum fixture" }));
      expect(highlighted()).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });
  it("opens a central document without remounting the canvas or changing tree search", async () => {
    const platform = await mount();
    const save = vi.spyOn(platform, "saveLayout");
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const canvas = await screen.findByRole("region", { name: "Navigation canvas" });
    const tree = screen.getByRole("region", { name: "Database structure" });
    const search = within(tree).getByRole("searchbox");
    fireEvent.change(search, { target: { value: "order_totals" } });
    fireEvent.click(within(tree).getByRole("button", { name: /^order_totals/ }));
    expect(screen.getByRole("region", { name: "Object document" })).toBeVisible();
    expect(tree.querySelector(".schema-object-preview")).toBeNull();
    expect(canvas.isConnected).toBe(true);
    expect(canvas.closest(".object-canvas-host")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: /Back to diagram/ }));
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBe(canvas);
    expect(canvas).toBeVisible();
    expect(search).toHaveValue("order_totals");
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(tree).getByRole("button", { name: /^order_totals/ }));
    fireEvent.click(screen.getByRole("button", { name: "Load enum fixture" }));
    expect(screen.queryByRole("region", { name: "Object document" })).not.toBeInTheDocument();
  });
  it("locates a cross-schema enum usage from preflight, clears Diagram filters and supports repeated location without closing details", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load enum fixture" }));
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.click(tree.getByRole("button", { name: /^public/ }));
    fireEvent.click(tree.getByRole("button", { name: /^Enums/ }));
    fireEvent.click(tree.getByRole("button", { name: "order_status" }));
    const details = tree.getByRole("region", { name: "Enum details for public.order_status" });
    expect(screen.getByTestId("locate-request")).toHaveTextContent("none");
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "no-matching-tables" } });
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    fireEvent.click(within(details).getByRole("button", { name: "Locate archive.orders in diagram" }));
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Search schema" })).toHaveValue("");
    expect(requested()).toEqual({ sourceId: enumSnapshot.sourceId, snapshotId: enumSnapshot.id, nodeId: "archive.orders", revision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge navigation" }));
    fireEvent.click(within(details).getByRole("button", { name: "Locate archive.orders in diagram" }));
    expect(requested().revision).toBe(2); expect(details).toBeVisible();
    fireEvent.click(within(details).getByRole("button", { name: "Locate public.orders in diagram" }));
    expect(requested().nodeId).toBe("public.orders"); expect(requested().revision).toBe(3);
  });
  it("opens a saved view from the sidebar, leaves preflight, and reuses navigation without writing layouts", async () => {
    const platform = await mount();
    const view = { id: "navigation-view", sourceId: reportSnapshot.sourceId, name: "Order fulfillment", rootTableKeys: [reportSnapshot.schemas[0].tables[0].key], relationshipDepth: 0, updatedAt: "now" };
    vi.spyOn(platform, "getSemantics").mockResolvedValue({ ...reportSemantics, savedViews: [view, { ...view, id: "foreign", sourceId: "another-source", name: "Other database view" }] });
    const save = vi.spyOn(platform, "saveLayout");
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const navigation = await screen.findByRole("navigation", { name: "Model views" });
    await waitFor(() => expect(within(navigation).getByRole("button", { name: "Order fulfillment" })).toBeEnabled());
    expect(within(navigation).queryByRole("button", { name: "Other database view" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Order fulfillment" }));
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    expect(screen.getByTestId("canvas-view")).toHaveTextContent("Order fulfillment");
    expect(screen.getByRole("combobox", { name: "Search schema" })).toHaveValue("");
    expect(localStorage.getItem(`nodalstudio:last-view:${reportSnapshot.sourceId}`)).toBe(view.id);
    fireEvent.click(within(navigation).getByRole("button", { name: "Full model" }));
    expect(screen.getByTestId("canvas-view")).toHaveTextContent("Full model");
    expect(localStorage.getItem(`nodalstudio:last-view:${reportSnapshot.sourceId}`)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps sidebar search independent, reveals filtered tables, and issues a new request for repeated clicks", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const globalSearch = screen.getByRole("combobox", { name: "Search schema" });
    fireEvent.change(globalSearch, { target: { value: "nothing-matches" } });
    pickOrders();
    expect(globalSearch).toHaveValue(""); expect(screen.getByTestId("canvas-query")).toHaveTextContent("");
    expect(screen.getByRole("searchbox", { name: "Search database objects" })).toHaveValue("public.orders");
    expect(requested()).toEqual({ sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, nodeId: "public.orders", revision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge navigation" }));
    expect(screen.getByTestId("locate-request")).toHaveTextContent("none");
    pickOrders();
    expect(requested().revision).toBe(2);
  });
  it("retains the same canvas and preflight filter across round trips", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const canvas = screen.getByRole("region", {name: "Navigation canvas"});
    fireEvent.click(screen.getByRole("button", {name: "Structure preflight"}));
    const search = await screen.findByRole("searchbox", {name: "Search findings"});
    fireEvent.change(search,{target:{value:"orders"}});
    expect(canvas).toBeInTheDocument(); expect(canvas).not.toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Back to diagram"}));
    expect(screen.getByRole("region",{name:"Navigation canvas"})).toBe(canvas);
    fireEvent.click(screen.getByRole("button",{name:"Return to preflight"}));
    expect(screen.getByRole("searchbox",{name:"Search findings"})).toBe(search);
    expect(search).toHaveValue("orders");
  });
  it("switches from change list and preflight back to Diagram without losing the navigation request", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load changed fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(screen.getByRole("button", { name: "History comparison" }));
    expect(screen.queryByRole("region", { name: "Navigation canvas" })).not.toBeInTheDocument();
    pickOrders();
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    expect(screen.getByTestId("locate-request")).toHaveTextContent("public.orders");
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    expect(screen.queryByRole("region", { name: "Navigation canvas" })).not.toBeInTheDocument();
    pickOrders();
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    expect(screen.getByTestId("locate-request")).toHaveTextContent("none");
  });
  it("waits for local semantics/layout loading but permits navigation after a storage error", async () => {
    const platform = await mount(); let fail!: (error: Error) => void;
    vi.spyOn(platform, "getSemantics").mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    pickOrders();
    expect(screen.getByTestId("navigation-ready")).toHaveTextContent("false");
    await act(async () => { fail(new Error("Local storage unavailable")); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByTestId("navigation-ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("locate-request")).toHaveTextContent("public.orders");
  });
});
