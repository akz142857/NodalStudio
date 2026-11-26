import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CaptureSnapshotResult,
  ConnectionTestResult,
  ConnectionTestOptions,
  DataSourceProfile,
  NodalStudioPlatform,
} from "../platform";
import { ConnectionPanel } from "./ConnectionPanel";
import { SchemaTree } from "./SchemaTree";
import { reportSnapshot } from "../test/schema-report-fixture";
import { lastServerDatabase, rememberServerDatabase } from "../platform/database-server";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const profile: DataSourceProfile = {
  id: "source-1",
  displayName: "Flow",
  host: "127.0.0.1",
  port: 3306,
  database: "flow",
  username: "root",
  databaseType: "mySql",
  sslMode: "prefer",
  createdAt: "2026-07-18T00:00:00Z",
  updatedAt: "2026-07-18T00:00:00Z",
};

const connectionResult: ConnectionTestResult = {
  database: { name: "flow", databaseType: "mySql", version: "8.0.40" },
  sslActive: true,
  serverReadOnly: false,
};

const captureResult = {
  snapshot: { sourceId: profile.id },
  stored: true,
  changeSet: null,
} as CaptureSnapshotResult;

function platformMock(overrides: Partial<NodalStudioPlatform> = {}): NodalStudioPlatform {
  return {
    listDataSources: vi.fn().mockResolvedValue([profile]),
    listRecentSnapshotIds: vi.fn().mockResolvedValue(["snapshot-1"]),
    getSnapshot: vi.fn().mockResolvedValue(captureResult.snapshot),
    testPostgresConnection: vi.fn().mockResolvedValue(connectionResult),
    saveDataSource: vi.fn().mockResolvedValue(profile),
    saveAndMapDataSource: vi.fn().mockResolvedValue({ profile, capture: captureResult }),
    capturePostgresSnapshot: vi.fn().mockResolvedValue(captureResult),
    verifyAndRefreshDataSource: vi.fn().mockResolvedValue({
      profile,
      connection: connectionResult,
      capture: captureResult,
    }),
    clearCredentials: vi.fn().mockResolvedValue(undefined),
    deleteSourceData: vi.fn().mockResolvedValue(4),
    ...overrides,
  } as unknown as NodalStudioPlatform;
}

function renderPanel(platform = platformMock(), activeSourceId: string | null = profile.id) {
  const onSnapshot = vi.fn();
  const onSourceDeleted = vi.fn();
  render(
    <ConnectionPanel
      enabled
      activeSourceId={activeSourceId ?? undefined}
      platform={platform}
      onSnapshot={onSnapshot}
      onSourceDeleted={onSourceDeleted}
      defaultDatabaseType="mySql"
      defaultSslMode="prefer"
    />,
  );
  return { onSnapshot, onSourceDeleted };
}

async function editCurrentConnection(name = "Flow") {
  fireEvent.click(await screen.findByRole("button", { name: `Connection: ${name}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit current connection…" }));
}

function confirmSourceDeletion(name: string) {
  const confirmation = screen.getByRole("dialog", { name: `Delete “${name}”?` });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
}

function enterServerAccount(password = "fixture-only") {
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: profile.host } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: profile.username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

function enterDatabaseName(database: string) {
  fireEvent.change(screen.getByLabelText("Database", { selector: "select" }), { target: { value: "named" } });
  fireEvent.change(screen.getByLabelText("Database name"), { target: { value: database } });
}


it("keeps the PostgreSQL source menu focused on connection actions", async () => {
  const postgres: DataSourceProfile = { ...profile, databaseType: "postgreSql" };
  const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([postgres]) });
  render(<ConnectionPanel enabled activeSourceId={postgres.id} platform={platform} onSnapshot={vi.fn()} onRefresh={vi.fn()}
    defaultDatabaseType="postgreSql" defaultSslMode="prefer" />);
  const database = await screen.findByRole("button", { name: "Connection: Flow" });
  expect(screen.queryByRole("button", { name: "Connection actions" })).not.toBeInTheDocument();
  fireEvent.click(database);
  const switcher = screen.getByRole("menu", { name: "Switch connection" });
  expect(within(switcher).queryByRole("menuitem", { name: "Dump SQL File" })).not.toBeInTheDocument();

  fireEvent.contextMenu(database);
  const actions = screen.getByRole("menu", { name: "Actions for Flow" });
  expect(screen.queryByRole("menu", { name: "Switch connection" })).not.toBeInTheDocument();
  expect(within(actions).getByRole("menuitem", { name: "New connection…" })).toBeEnabled();
  expect(within(actions).getByRole("menuitem", { name: "Manage connections…" })).toBeEnabled();
  expect(within(actions).getByRole("menuitem", { name: "Refresh schema" })).toBeEnabled();
  expect(within(actions).queryByRole("menuitem", { name: /Dump SQL File/ })).not.toBeInTheDocument();
  fireEvent.keyDown(actions, { key: "Escape" });
  expect(database).toHaveFocus();

  fireEvent.keyDown(database, { key: "F10", shiftKey: true });
  const keyboardMenu = screen.getByRole("menu", { name: "Actions for Flow" });
  fireEvent.keyDown(keyboardMenu, { key: "End" });
  expect(within(keyboardMenu).getByRole("menuitem", { name: "Refresh schema" })).toHaveFocus();
  fireEvent.keyDown(keyboardMenu, { key: "Escape" });
  expect(database).toHaveFocus();
});

it("disables schema SQL dump on SSH while keeping table export available", async () => {
  const postgres: DataSourceProfile = {
    ...profile, databaseType: "postgreSql",
    security: { tls: {}, ssh: { host: "jump.test", port: 22, username: "fixture", authentication: "agent" } },
  };
  const model = { ...reportSnapshot, sourceId: postgres.id };
  const onDump = vi.fn();
  const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([postgres]) });
  render(<ConnectionPanel enabled activeSourceId={postgres.id} platform={platform} onSnapshot={vi.fn()}
    defaultDatabaseType="postgreSql" defaultSslMode="prefer">
    <SchemaTree snapshot={model} onSelectTable={vi.fn()} onExportTable={vi.fn()} onDumpSchema={onDump} />
  </ConnectionPanel>);
  const schema = await screen.findByRole("button", { name: /^public\s*\d+$/ });
  fireEvent.contextMenu(schema);
  expect(screen.getByRole("menuitem", { name: "Dump SQL File (direct connections only)" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search database objects" }), { target: { value: "public.orders" } });
  fireEvent.contextMenu(screen.getByRole("button", { name: /^orders/ }));
  expect(screen.queryByRole("menuitem", { name: /Dump SQL File/ })).not.toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Export Wizard…" })).toBeEnabled();
  expect(onDump).not.toHaveBeenCalled();
});

function renderWorkspace(platform: NodalStudioPlatform, initialSourceId = profile.id) {
  const onSnapshot = vi.fn(), onSourceDeleted = vi.fn();
  function Workspace() {
    const [sourceId, setSourceId] = useState<string | undefined>(initialSourceId);
    return <ConnectionPanel enabled platform={platform} activeSourceId={sourceId}
      defaultDatabaseType="mySql" defaultSslMode="prefer"
      onDatabaseCleared={() => setSourceId(undefined)}
      onSnapshot={(result) => { onSnapshot(result); setSourceId(result.snapshot.sourceId); }}
      onSourceDeleted={(id) => { onSourceDeleted(id); setSourceId((current) => current === id ? undefined : current); }}>
      <p>Model for {sourceId}</p>
    </ConnectionPanel>;
  }
  render(<Workspace />);
  return { onSnapshot, onSourceDeleted };
}

describe("ConnectionPanel", () => {
  it("cancels the actual test and ignores a late successful response", async () => {
    let options: ConnectionTestOptions | undefined;
    let finish!: (value: ConnectionTestResult) => void;
    const testPostgresConnection = vi.fn((_input: unknown, next?: ConnectionTestOptions) => {
      options = next;
      return new Promise<ConnectionTestResult>((resolve) => { finish = resolve; });
    });
    const saveAndMapDataSource = vi.fn();
    renderPanel(platformMock({ testPostgresConnection, saveAndMapDataSource }));
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    enterServerAccount();
    enterDatabaseName(profile.database);
    fireEvent.click(screen.getByRole("button", { name: "Connect and open" }));
    act(() => options?.onProgress?.({ phase: "handshake", sshConnected: false }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Connecting to the database and negotiating TLS…");
    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection test" }));
    expect(options?.signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel connection test" })).toBeDisabled();
    await act(async () => { finish(connectionResult); await Promise.resolve(); });
    expect(screen.getByText("Connection test cancelled")).toBeVisible();
    expect(screen.queryByText("Connection successful")).not.toBeInTheDocument();
    expect(saveAndMapDataSource).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect and open" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("tests without saving and invalidates the result after edits", async () => {
    const saveAndMapDataSource = vi.fn().mockResolvedValue({ profile, capture: captureResult });
    const testPostgresConnection = vi.fn().mockResolvedValue(connectionResult);
    const platform = platformMock({ saveAndMapDataSource, testPostgresConnection });
    renderPanel(platform);
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    enterServerAccount();
    enterDatabaseName(profile.database);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection successful")).toBeVisible();
    expect(saveAndMapDataSource).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "different.example" } });
    expect(screen.queryByText("Connection successful")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect and open" }));
    await waitFor(() => expect(saveAndMapDataSource).toHaveBeenCalledOnce());
    expect(testPostgresConnection).toHaveBeenCalledTimes(2);
    expect(testPostgresConnection).toHaveBeenLastCalledWith(expect.objectContaining({ host: "different.example", database: profile.database }), expect.anything());
  });

  it("clears a typed SSH password when the jump host changes", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "first.example" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("SSH password"), { target: { value: "first-password" } });
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "second.example" } });
    expect(screen.getByLabelText("SSH password")).toHaveValue("");
  });

  it("prompts for connection details and opens the chosen PostgreSQL database from a single catalog request", async () => {
    const server = { ...profile, id: "postgres-server", displayName: profile.host, database: "", databaseType: "postgreSql" as const, port: 5432 };
    const database = { ...server, id: "postgres-child", database: "reporting", serverSourceId: server.id };
    const listServerDatabases = vi.fn().mockResolvedValue(["inventory", database.database]);
    const saveDataSource = vi.fn().mockResolvedValue(server);
    const openServerDatabase = vi.fn().mockResolvedValue({ profile: database, capture: captureResult });
    const testPostgresConnection = vi.fn().mockResolvedValue(connectionResult);
    const onSnapshot = vi.fn();
    const platform = platformMock({ testPostgresConnection, saveDataSource, listServerDatabases, openServerDatabase });
    render(<StrictMode><ConnectionPanel enabled platform={platform} onSnapshot={onSnapshot}
      defaultDatabaseType="postgreSql" defaultSslMode="require" /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    expect(screen.getByLabelText("Host")).toHaveValue("");
    expect(screen.getByLabelText("Database", { selector: "select" })).toHaveValue("browse");
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the database server’s hostname or IP address.");
    expect(testPostgresConnection).not.toHaveBeenCalled();
    enterServerAccount();
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    const chooser = within(await screen.findByRole("dialog", { name: "Open a database" }));
    fireEvent.change(chooser.getByRole("searchbox", { name: "Search databases" }), { target: { value: "report" } });
    fireEvent.click(await chooser.findByRole("option", { name: database.database }));
    expect(chooser.queryByRole("option", { name: "inventory" })).not.toBeInTheDocument();
    fireEvent.click(chooser.getByRole("button", { name: "Open database" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(captureResult));
    expect(testPostgresConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ database: "", port: 5432 }), expect.anything());
    expect(saveDataSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ database: "", displayName: profile.host }));
    expect(listServerDatabases).toHaveBeenCalledExactlyOnceWith(server.id);
    expect(openServerDatabase).toHaveBeenCalledExactlyOnceWith(server.id, database.database, server.updatedAt);
  });

  it("returns to the connection form when PostgreSQL requires a specific database name", async () => {
    const testPostgresConnection = vi.fn().mockRejectedValueOnce({
      stage: "database", code: "postgresMaintenanceUnavailable", message: "Maintenance databases unavailable",
    }).mockResolvedValueOnce(connectionResult);
    const saveAndMapDataSource = vi.fn().mockResolvedValue({ profile, capture: captureResult });
    const { onSnapshot } = renderPanel(platformMock({ testPostgresConnection, saveAndMapDataSource }));
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    fireEvent.change(screen.getByLabelText("Database engine"), { target: { value: "postgreSql" } });
    enterServerAccount();
    fireEvent.click(screen.getByRole("tab", { name: "TLS" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an accessible database name");
    expect(screen.getByLabelText("Host")).toBeVisible();
    expect(saveAndMapDataSource).not.toHaveBeenCalled();
    enterDatabaseName(profile.database);
    fireEvent.click(screen.getByRole("button", { name: "Connect and open" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(captureResult));
    expect(testPostgresConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      databaseType: "postgreSql", database: profile.database, username: profile.username,
    }), expect.anything());
  });

  it.each([
    ["MySQL", "mySql", 3306, "information_schema"],
    ["PostgreSQL", "postgreSql", 5432, "postgres"],
  ] as const)("saves a blank %s SSH connection and retries opening without creating the database twice", async (engine, databaseType, port, maintenanceDatabase) => {
    const server = { ...profile, id: "server-1", displayName: "Fixture server", database: "", databaseType, port,
      security: { tls: {}, ssh: { host: "jump.example", port: 22, username: "tester", authentication: "agent" as const } } };
    const database = { ...server, id: "database-1", database: "first_business", serverSourceId: server.id };
    const capture = { ...captureResult, snapshot: { ...captureResult.snapshot, sourceId: database.id } };
    const saveDataSource = vi.fn().mockResolvedValue(server);
    const listServerDatabases = vi.fn().mockResolvedValue([maintenanceDatabase]);
    const createServerDatabase = vi.fn().mockResolvedValue(database.database);
    const openServerDatabase = vi.fn()
      .mockRejectedValueOnce({ stage: "database", message: "Schema connection interrupted", sshConnected: true })
      .mockResolvedValueOnce({ profile: database, capture });
    const capturePostgresSnapshot = vi.fn();
    const testPostgresConnection = vi.fn().mockResolvedValue({ ...connectionResult, database: { name: "", databaseType, version: "fixture" } });
    const { onSnapshot } = renderPanel(platformMock({
      saveDataSource, listServerDatabases, createServerDatabase, openServerDatabase, capturePostgresSnapshot, testPostgresConnection,
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    fireEvent.change(screen.getByLabelText("Database engine"), { target: { value: databaseType } });
    expect(screen.getByLabelText("Database", { selector: "select" })).toHaveValue("browse");
    enterServerAccount("fixture password");
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "jump.example" } });
    fireEvent.change(screen.getByLabelText("SSH username"), { target: { value: "tester" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Server connected")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "TLS" }));
    expect(screen.getByRole("group", { name: "Server status" })).toHaveTextContent("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    const chooser = within(await screen.findByRole("dialog", { name: "Open a database" }));
    expect(await chooser.findByRole("option", { name: maintenanceDatabase })).toBeVisible();
    expect(testPostgresConnection).toHaveBeenCalledOnce();
    expect(listServerDatabases).toHaveBeenCalledOnce();
    fireEvent.click(chooser.getByRole("button", { name: "New database…" }));
    const browser = within(await screen.findByRole("dialog", { name: "New database" }));
    expect(browser.getByText(server.displayName)).toBeVisible();
    expect(browser.getByText(`${engine} · ${server.host}:${port} · SSH`)).toBeVisible();
    expect(saveDataSource).toHaveBeenCalledWith(expect.objectContaining({ databaseType, database: "", security: server.security }));
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(browser.getByLabelText("Database name")).toHaveFocus();
    expect(browser.getByText(databaseType === "postgreSql"
      ? "The new database uses the default PostgreSQL template."
      : "The new database uses the server’s default character set and collation.")).toBeVisible();
    expect(createServerDatabase).not.toHaveBeenCalled();
    fireEvent.change(browser.getByLabelText("Database name"), { target: { value: database.database } });
    fireEvent.click(browser.getByRole("button", { name: "Create and open" }));
    expect(await browser.findByRole("alert")).toHaveTextContent("Schema connection interrupted");
    expect(createServerDatabase).toHaveBeenCalledWith(server.id, database.database, server.updatedAt);
    expect(browser.getByRole("option", { name: database.database })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(browser.getByRole("button", { name: "Open database" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(capture));
    expect(openServerDatabase).toHaveBeenCalledWith(server.id, database.database, server.updatedAt);
    expect(createServerDatabase).toHaveBeenCalledOnce();
  });

  it("filters a saved server's databases and restores the selection and scroll position after creation is cancelled", async () => {
    const server = { ...profile, database: "", displayName: "Fixture server" };
    const database = { ...profile, database: "reporting_archive" };
    const openServerDatabase = vi.fn().mockResolvedValue({ profile: database, capture: captureResult });
    const listServerDatabases = vi.fn().mockResolvedValue(["inventory", "reporting", database.database]);
    const { onSnapshot } = renderPanel(platformMock({
      listDataSources: vi.fn().mockResolvedValue([server]),
      listServerDatabases,
      openServerDatabase,
    }), null);

    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fixture server/ }));
    fireEvent.click(screen.getByRole("button", { name: "New database…" }));
    expect(listServerDatabases).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", { name: "New database" })).getByRole("button", { name: "Back" }));
    const browser = within(await screen.findByRole("dialog", { name: "Open a database" }));
    await browser.findByRole("option", { name: "inventory" });
    expect(browser.getByRole("button", { name: "Open" })).toBeDisabled();
    const search = browser.getByRole("searchbox", { name: "Search databases" });
    fireEvent.change(search, { target: { value: "absent" } });
    expect(browser.getByRole("status")).toHaveTextContent("No databases match your search.");
    fireEvent.change(search, { target: { value: "REPORTING" } });
    expect(browser.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const reporting = browser.getByRole("option", { name: "reporting" });
    expect(reporting).toHaveFocus();
    fireEvent.keyDown(reporting, { key: "End" });
    const archive = browser.getByRole("option", { name: database.database });
    expect(archive).toHaveFocus();
    expect(archive).toHaveAttribute("aria-selected", "true");
    expect(openServerDatabase).not.toHaveBeenCalled();

    browser.getByRole("listbox").parentElement!.scrollTop = 28;
    fireEvent.click(browser.getByRole("button", { name: "New database…" }));
    fireEvent.click(browser.getByRole("button", { name: "Back" }));
    const restoredSearch = browser.getByRole("searchbox", { name: "Search databases" });
    expect(restoredSearch).toHaveValue("REPORTING");
    expect(restoredSearch).toHaveFocus();
    expect(browser.getByRole("option", { name: database.database })).toHaveAttribute("aria-selected", "true");
    expect(browser.getByRole("listbox").parentElement?.scrollTop).toBe(28);
    fireEvent.keyDown(restoredSearch, { key: "ArrowDown" });
    fireEvent.keyDown(browser.getByRole("option", { name: database.database }), { key: "Enter" });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(captureResult));
    expect(openServerDatabase).toHaveBeenCalledExactlyOnceWith(server.id, database.database, server.updatedAt);
    expect(listServerDatabases).toHaveBeenCalledOnce();
  });

  it("lists databases on demand and restores the last database without refreshing the server catalog", async () => {
    const server = { ...profile, id: "browse-server", database: "", displayName: "Shared server" };
    const archive = { ...server, id: "archive-source", database: "reporting_archive", displayName: "Linked archive", serverSourceId: server.id };
    const fixedSnapshot = { ...captureResult.snapshot, sourceId: profile.id };
    const archiveSnapshot = { ...captureResult.snapshot, sourceId: archive.id };
    const listServerDatabases = vi.fn().mockResolvedValueOnce(["inventory", archive.database]).mockResolvedValueOnce(["inventory"]);
    const opened = { profile: archive, capture: { ...captureResult, snapshot: archiveSnapshot } };
    const openServerDatabase = vi.fn().mockResolvedValueOnce(opened).mockResolvedValueOnce(opened)
      .mockRejectedValueOnce({ stage: "database", code: "databaseMissing", message: "Database gone" });
    renderWorkspace(platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, server, archive]), listServerDatabases,
      openServerDatabase, getSnapshot: vi.fn().mockResolvedValue(fixedSnapshot) }));
    const switchConnection = async (current: string, next: RegExp) => {
      fireEvent.click(await screen.findByRole("button", { name: `Connection: ${current}` }));
      expect(screen.queryByRole("menuitemradio", { name: /Linked archive/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitemradio", { name: next }));
    };
    expect(await screen.findByText("flow")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Database" })).not.toBeInTheDocument();
    await switchConnection("Flow", /^Shared server/);
    const databasePicker = screen.getByRole("combobox", { name: "Database" });
    expect(screen.queryByText("Model for source-1")).not.toBeInTheDocument();
    expect(listServerDatabases).not.toHaveBeenCalled();
    fireEvent.click(databasePicker);
    fireEvent.change(databasePicker, { target: { value: "arch" } });
    expect(await screen.findByRole("option", { name: archive.database })).toBeVisible();
    expect(screen.queryByRole("option", { name: "inventory" })).not.toBeInTheDocument();
    fireEvent.keyDown(databasePicker, { key: "Enter" });
    expect(await screen.findByText("Model for archive-source")).toBeVisible();
    expect(openServerDatabase).toHaveBeenCalledExactlyOnceWith(server.id, archive.database, server.updatedAt);
    expect(lastServerDatabase(server.id)).toBe(archive.database);

    await switchConnection("Shared server", /^Flow/);
    expect(await screen.findByText("Model for source-1")).toBeVisible();
    await switchConnection("Flow", /^Shared server/);
    expect(await screen.findByText("Model for archive-source")).toBeVisible();
    expect(openServerDatabase).toHaveBeenCalledTimes(2);

    await switchConnection("Shared server", /^Flow/);
    expect(await screen.findByText("Model for source-1")).toBeVisible();
    await switchConnection("Flow", /^Shared server/);
    expect(await screen.findByRole("alert")).toHaveTextContent("The database does not exist.");
    expect(openServerDatabase).toHaveBeenCalledTimes(3);
    expect(listServerDatabases).toHaveBeenCalledOnce();
    expect(screen.getByText("Model for source-1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose a database…" }));
    expect(await within(screen.getByRole("dialog", { name: "Open a database" })).findByRole("option", { name: "inventory" })).toBeVisible();
    expect(listServerDatabases).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Model for archive-source")).not.toBeInTheDocument();
  });

  it("keeps the database list selectable during refresh and retains the current workspace until a switch succeeds", async () => {
    const server = { ...profile, id: "progress-server", displayName: "Shared server", database: "" };
    const current = { ...profile, id: "progress-current", serverSourceId: server.id };
    const target = { ...current, id: "progress-target", database: "reporting" };
    const capture = { ...captureResult, snapshot: { ...captureResult.snapshot, sourceId: target.id } };
    let finishCatalog!: (databases: string[]) => void;
    let finishCatalogRefresh!: (databases: string[]) => void;
    let failOpen!: (reason: Error) => void;
    const databases = [target.database, ...Array.from({ length: 42 }, (_, index) => `archive_${index}`), current.database];
    const listServerDatabases = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => { finishCatalog = resolve; }))
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => { finishCatalogRefresh = resolve; }));
    const openServerDatabase = vi.fn<NodalStudioPlatform["openServerDatabase"]>()
      .mockImplementationOnce(() => new Promise((_, reject) => { failOpen = reject; }))
      .mockResolvedValue({ profile: target, capture });
    renderWorkspace(platformMock({ listDataSources: vi.fn().mockResolvedValue([server, current, target]), listServerDatabases, openServerDatabase }), current.id);

    const picker = await screen.findByRole("combobox", { name: "Database" });
    fireEvent.click(picker);
    expect(screen.getByText("Loading databases…")).toBeVisible();
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    await act(async () => { finishCatalog(databases); await Promise.resolve(); });
    const selected = screen.getByRole("option", { name: current.database, selected: true });
    expect(picker).toHaveAttribute("aria-activedescendant", selected.id);
    expect(screen.getAllByRole("option")).toHaveLength(40);

    fireEvent.click(screen.getByRole("option", { name: target.database }));
    expect(picker).toHaveAttribute("aria-busy", "true");
    expect(picker).toHaveValue(current.database);
    expect(screen.getByText("Opening reporting…")).toBeVisible();
    expect(screen.getByText(`Model for ${current.id}`)).toBeVisible();
    await act(async () => { failOpen(new Error("Database unavailable")); await Promise.resolve(); });
    expect(picker).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t Open “reporting”");
    expect(screen.getByText(`Model for ${current.id}`)).toBeVisible();

    fireEvent.keyDown(picker, { key: "Enter" });
    expect(listServerDatabases).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: target.database })).toBeVisible();
    expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-busy");
    await act(async () => { finishCatalogRefresh(["recent_database", ...databases]); await Promise.resolve(); });
    expect(screen.getByRole("option", { name: "recent_database" })).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: target.database }));
    expect(await screen.findByText(`Model for ${target.id}`)).toBeVisible();
    expect(picker).toHaveValue(target.database);
    expect(screen.queryByText("Opening reporting…")).not.toBeInTheDocument();
  });

  it("keeps the current workspace when a remembered database fails to open", async () => {
    const server = { ...profile, id: "restore-failure", displayName: "Reporting server", database: "" };
    rememberServerDatabase(server.id, "reporting");
    let fail!: (reason: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    const listServerDatabases = vi.fn().mockRejectedValue(new Error("Catalog unavailable"));
    const openServerDatabase = vi.fn().mockReturnValue(failure);
    const { onSnapshot } = renderWorkspace(platformMock({
      listDataSources: vi.fn().mockResolvedValue([profile, server]), listServerDatabases, openServerDatabase,
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Connection: Flow" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Reporting server/ }));
    expect(screen.getByText("Opening reporting on Reporting server…")).toBeVisible();
    expect(screen.getByText(`Model for ${profile.id}`)).toBeVisible();
    await waitFor(() => expect(openServerDatabase).toHaveBeenCalledOnce());
    expect(listServerDatabases).not.toHaveBeenCalled();
    await act(async () => { fail(new Error("Server unavailable")); await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("Server unavailable");
    expect(screen.queryByText("Opening reporting on Reporting server…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connection: Flow" })).toBeEnabled();
    expect(screen.getByText(`Model for ${profile.id}`)).toBeVisible();
    expect(onSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose a database…" }));
    const chooser = within(screen.getByRole("dialog", { name: "Open a database" }));
    expect(await chooser.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    expect(chooser.getByRole("button", { name: "Refresh databases" })).toBeEnabled();
  });

  it("reopens a linked database through the updated server after editing its host", async () => {
    const server = { ...profile, id: "edit-server", displayName: "Shared server", database: "" };
    const database = { ...profile, id: "edit-database", displayName: "Linked Flow", serverSourceId: server.id };
    const updatedServer = { ...server, host: "new.example.test", updatedAt: "2026-07-19T00:00:00Z" };
    const capture = { ...captureResult, snapshot: { ...captureResult.snapshot, sourceId: database.id } };
    const listRecentSnapshotIds = vi.fn();
    const listServerDatabases = vi.fn().mockResolvedValue([database.database]);
    const openServerDatabase = vi.fn().mockResolvedValue({ profile: { ...database, host: updatedServer.host }, capture });
    const { onSnapshot } = renderWorkspace(platformMock({
      listDataSources: vi.fn().mockResolvedValue([server, database]), listRecentSnapshotIds, listServerDatabases, openServerDatabase,
      testPostgresConnection: vi.fn().mockResolvedValue({ ...connectionResult, database: { ...connectionResult.database, name: "" } }),
      saveDataSource: vi.fn().mockResolvedValue(updatedServer),
    }), database.id);

    expect(await screen.findByText(`Model for ${database.id}`)).toBeVisible();
    await editCurrentConnection(server.displayName);
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: updatedServer.host } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Server connected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByText(`Model for ${database.id}`)).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Database" })).toHaveValue("");

    fireEvent.click(screen.getByRole("combobox", { name: "Database" }));
    fireEvent.click(await screen.findByRole("option", { name: database.database }));
    expect(await screen.findByText(`Model for ${database.id}`)).toBeVisible();
    expect(listServerDatabases).toHaveBeenCalledWith(server.id);
    expect(openServerDatabase).toHaveBeenCalledExactlyOnceWith(server.id, database.database, updatedServer.updatedAt);
    expect(listRecentSnapshotIds).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledWith(capture);
  });

  it("guides missing database passwords to Connection and tests with a separate private key passphrase", async () => {
    const testPostgresConnection = vi.fn().mockResolvedValueOnce(connectionResult);
    const saveDataSource = vi.fn();
    renderPanel(platformMock({ testPostgresConnection, saveDataSource }));
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    enterServerAccount("");
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "privateKey" } });
    fireEvent.change(screen.getByLabelText("SSH private key"), { target: { value: "/fixture/client" } });
    fireEvent.change(screen.getByLabelText("Key passphrase"), { target: { value: "fixture passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the password for this database account.");
    expect(testPostgresConnection).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Host")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fixture database password" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Server version 8.0.40")).toBeVisible();
    expect(testPostgresConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      password: "fixture database password", sshKeyPassphrase: "fixture passphrase",
    }), expect.anything());
    expect(saveDataSource).not.toHaveBeenCalled();
  });

  it("shows the failed stage and lets the user retry without writing a source", async () => {
    const saveAndMapDataSource = vi.fn();
    renderPanel(platformMock({ saveAndMapDataSource, testPostgresConnection: vi.fn().mockRejectedValue({ stage: "tls", message: "Check the CA certificate.", sshConnected: true }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    enterServerAccount();
    enterDatabaseName(profile.database);
    fireEvent.click(screen.getByRole("button", { name: "Connect and open" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("TLS verification failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Check the CA certificate.");
    expect(saveAndMapDataSource).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect and open" })).toBeEnabled();
  });

  it("keeps edits across security tabs and clears passwords when closing", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    expect(screen.getByLabelText("Host")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    expect(screen.queryByRole("tabpanel", { name: "Connection" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Host").closest("[role=tabpanel]")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("SSH password"), { target: { value: "test-only" } });
    fireEvent.click(screen.getByRole("tab", { name: "TLS" }));
    expect(screen.queryByRole("tabpanel", { name: "SSH" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("SSH password").closest("[role=tabpanel]")).toHaveAttribute("inert");
    expect(screen.getByLabelText("SSL mode")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /SSH/ }));
    expect(screen.getByLabelText("SSH password")).toHaveValue("test-only");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    expect(screen.getByLabelText("Host")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    expect(screen.getByRole("checkbox", { name: /Connect through SSH/ })).not.toBeChecked();
  });

  it("keeps object search and group state across same-source snapshot refresh without reopening it", async () => {
    const listRecentSnapshotIds = vi.fn(), getSnapshot = vi.fn(), capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listRecentSnapshotIds, getSnapshot, capturePostgresSnapshot }), onSnapshot = vi.fn();
    const model = { ...reportSnapshot, sourceId: profile.id, schemas: [reportSnapshot.schemas[0]] };
    const panel = (snapshot = model) => <ConnectionPanel enabled activeSourceId={profile.id} platform={platform}
      onSnapshot={onSnapshot} defaultDatabaseType="mySql" defaultSslMode="prefer">
      <SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />
    </ConnectionPanel>;
    const { rerender } = render(panel());
    await screen.findByRole("button", { name: "Connection: Flow" });
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    const search = screen.getByRole("searchbox", { name: "Search database objects" });
    fireEvent.change(search, { target: { value: "orders" } });
    // A fresh snapshot for the same source preserves the current object navigation.
    rerender(panel({ ...model, id: "refreshed" }));
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toBeVisible(); expect(search).toHaveValue("orders");
    fireEvent.click(screen.getByRole("button", { name: "Clear object search" }));
    expect(screen.getByRole("button", { name: /Tables/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^customers/ })).toBeVisible();
    expect(listRecentSnapshotIds).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("opens a newly selected source and keeps its content visible independently of editing", async () => {
    const other = { ...profile, id: "source-2", displayName: "Other" };
    const listRecentSnapshotIds = vi.fn().mockResolvedValue(["other-snapshot"]);
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listRecentSnapshotIds,
      getSnapshot: vi.fn().mockResolvedValue({ ...captureResult.snapshot, sourceId: other.id }) });
    const onSnapshot = vi.fn();
    const panel = (id: string) => <ConnectionPanel enabled activeSourceId={id} platform={platform}
      onSnapshot={onSnapshot} defaultDatabaseType="mySql" defaultSslMode="prefer"><input aria-label="Source content" /></ConnectionPanel>;
    const { rerender } = render(panel(profile.id));
    await editCurrentConnection();
    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connection: Flow" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Other/ }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(listRecentSnapshotIds).toHaveBeenCalledWith(other.id);
    rerender(panel(other.id));
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Connection: Other" })).toHaveTextContent("MySQL · 127.0.0.1:3306");
    rerender(panel(profile.id));
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
  });

  it("keeps connection fields in a create dialog", async () => {
    renderPanel();

    expect(await screen.findByRole("button", { name: "Connection: Flow" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add database" }));

    expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeInTheDocument();
    expect(screen.getByLabelText("Database engine")).toHaveValue("mySql");
    expect(screen.getByLabelText("Port")).toHaveValue(3306);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["before", "after"])("discards an open failure arriving %s a successful workspace change", async (timing) => {
    let reject!: (reason: Error) => void;
    const getSnapshot = vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const platform = platformMock({ getSnapshot });
    const panel = (id?: string) => <ConnectionPanel enabled activeSourceId={id} platform={platform}
      onSnapshot={vi.fn()} defaultDatabaseType="mySql" defaultSslMode="prefer" />;
    const { rerender } = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    fireEvent.click(screen.getByRole("menuitemradio"));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    if (timing === "after") rerender(panel(profile.id));
    await act(async () => { reject(new Error("Fixture local read timed out")); await Promise.resolve(); });
    if (timing === "before") {
      expect(screen.getByRole("alert")).toHaveTextContent("Fixture local read timed out");
      expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
      rerender(panel(profile.id));
    }
    expect(screen.queryByText(/Fixture local read timed out/)).not.toBeInTheDocument();
    rerender(panel());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries a failed local open without connecting to the server", async () => {
    const capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ capturePostgresSnapshot, getSnapshot: vi.fn().mockRejectedValueOnce(new Error("Fixture local read timed out")).mockResolvedValue(captureResult.snapshot) });
    const { onSnapshot } = renderPanel(platform, null);
    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    fireEvent.click(screen.getByRole("menuitemradio"));
    fireEvent.click(await screen.findByRole("button", { name: "Try Again" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
  });

  it("opens the connection editor to create a missing schema snapshot", async () => {
    const verifyAndRefreshDataSource = vi.fn().mockResolvedValue({ profile, connection: connectionResult, capture: captureResult });
    const platform = platformMock({ listRecentSnapshotIds: vi.fn().mockResolvedValue([]), verifyAndRefreshDataSource });
    const { onSnapshot } = renderPanel(platform, null);
    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    fireEvent.click(screen.getByRole("menuitemradio"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t Open “flow”");
    expect(alert).toHaveTextContent("Use Verify & refresh in the connection editor to save the first schema snapshot.");
    expect(screen.queryByRole("button", { name: "Try Again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Connection…" }));
    const editor = screen.getByRole("dialog", { name: "Edit Flow" });
    fireEvent.click(within(editor).getByRole("button", { name: "Verify & refresh" }));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(captureResult));
    expect(verifyAndRefreshDataSource).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the saved snapshot without reconnecting to the database", async () => {
    const listRecentSnapshotIds = vi.fn().mockResolvedValue(["snapshot-1"]);
    const getSnapshot = vi.fn().mockResolvedValue(captureResult.snapshot);
    const capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listRecentSnapshotIds, getSnapshot, capturePostgresSnapshot });
    const { onSnapshot } = renderPanel(platform, null);

    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    expect(screen.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Flow/ }));

    await waitFor(() => expect(listRecentSnapshotIds).toHaveBeenCalledWith(profile.id));
    expect(getSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledWith({ snapshot: captureResult.snapshot, stored: false, changeSet: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens an explicit edit form for an existing source", async () => {
    renderPanel();

    await editCurrentConnection();

    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeInTheDocument();
    expect(screen.getByLabelText("Database")).toHaveValue("flow");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Leave blank to keep the saved password.");
    expect(screen.getByText("Use TLS when available; this mode can fall back to an unencrypted connection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify & refresh" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete data source" })).toBeInTheDocument();
  });

  it("saves profile edits locally without reconnecting or replacing the saved password", async () => {
    const updatedProfile = { ...profile, displayName: "Flow local" };
    const saveDataSource = vi.fn().mockResolvedValue(updatedProfile);
    const testPostgresConnection = vi.fn();
    const capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ saveDataSource, testPostgresConnection, capturePostgresSnapshot });
    renderPanel(platform);

    await editCurrentConnection();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Flow local" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(saveDataSource).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
      displayName: "Flow local",
      password: "",
    })));
    expect(testPostgresConnection).not.toHaveBeenCalled();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connection: Flow local" })).toHaveTextContent("MySQL · 127.0.0.1:3306");
  });

  it("requires verification for connection detail changes and reuses the system credential store password", async () => {
    const verifyAndRefreshDataSource = vi.fn().mockResolvedValue({
      profile,
      connection: connectionResult,
      capture: captureResult,
    });
    const platform = platformMock({ verifyAndRefreshDataSource });
    const { onSnapshot } = renderPanel(platform);

    await editCurrentConnection();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.internal" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText(/Connection details changed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(verifyAndRefreshDataSource).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
      host: "db.internal",
      password: "",
    })));
    expect(onSnapshot).toHaveBeenCalledWith(captureResult);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the original profile active when atomic verification fails", async () => {
    const saveDataSource = vi.fn();
    const capturePostgresSnapshot = vi.fn();
    const verifyAndRefreshDataSource = vi.fn().mockRejectedValue(new Error("Metadata refresh failed"));
    const platform = platformMock({
      saveDataSource,
      capturePostgresSnapshot,
      verifyAndRefreshDataSource,
    });
    renderPanel(platform);

    await editCurrentConnection();
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Metadata refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeInTheDocument();
    expect(saveDataSource).not.toHaveBeenCalled();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connection: Flow" })).toHaveTextContent("MySQL · 127.0.0.1:3306");
  });

  it("deletes a source and its local data after confirmation", async () => {
    const clearCredentials = vi.fn().mockResolvedValue(undefined);
    const deleteSourceData = vi.fn().mockResolvedValue(4);
    const listRecentSnapshotIds = vi.fn();
    const platform = platformMock({ clearCredentials, deleteSourceData, listRecentSnapshotIds });
    const { onSnapshot, onSourceDeleted } = renderWorkspace(platform);
    await editCurrentConnection();
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
    expect(deleteSourceData).not.toHaveBeenCalled();
    confirmSourceDeletion("Flow");

    await waitFor(() => expect(deleteSourceData).toHaveBeenCalledWith(profile.id, {
      deleteConnection: true,
      deleteHistory: true,
      deleteSemantics: true,
      removeDatabaseCredential: false,
    }));
    expect(clearCredentials).toHaveBeenCalledWith(profile.id, { database: true, ai: true, cloud: true });
    expect(onSourceDeleted).toHaveBeenCalledWith(profile.id);
    expect(screen.queryByRole("button", { name: "Connection: Flow" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /No database connected/ })).toBeVisible();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(listRecentSnapshotIds).not.toHaveBeenCalled();
  });

  it("opens the remaining saved model after deleting the current source", async () => {
    const remaining = { ...profile, id: "source-2", database: "warehouse", displayName: "Flow" };
    const snapshot = { ...captureResult.snapshot, sourceId: remaining.id };
    const listRecentSnapshotIds = vi.fn().mockResolvedValue(["remaining-snapshot"]), capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, remaining]), getSnapshot: vi.fn().mockResolvedValue(snapshot), listRecentSnapshotIds, capturePostgresSnapshot });
    const { onSnapshot, onSourceDeleted } = renderWorkspace(platform);
    await editCurrentConnection();
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
    confirmSourceDeletion("Flow");
    expect(await screen.findByRole("button", { name: "Connection: Flow" })).toBeVisible();
    expect(screen.getByText("Model for source-2")).toBeVisible();
    expect(onSourceDeleted).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({ snapshot, stored: false, changeSet: null });
    expect(listRecentSnapshotIds).toHaveBeenCalledExactlyOnceWith(remaining.id);
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connection: Flow" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the picker and management available if the remaining snapshot fails to open, then allows retry", async () => {
    const remaining = { ...profile, id: "source-2", database: "warehouse" };
    const platform = platformMock({
      listDataSources: vi.fn().mockResolvedValue([profile, remaining]),
      listRecentSnapshotIds: vi.fn().mockRejectedValueOnce(new Error("Local snapshot unavailable")).mockResolvedValue(["remaining-snapshot"]),
      getSnapshot: vi.fn().mockResolvedValue({ ...captureResult.snapshot, sourceId: remaining.id }),
    });
    renderWorkspace(platform);
    await editCurrentConnection();
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
    confirmSourceDeletion("Flow");
    expect(await screen.findByText("Local snapshot unavailable")).toBeVisible();
    expect(screen.queryByText("Model for source-1")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Select connection" });
    expect(trigger).toHaveTextContent("1 saved connection");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Manage connections…" })).toBeEnabled();
    expect(screen.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio"));
    expect(await screen.findByRole("button", { name: "Connection: Flow" })).toBeVisible();
    expect(screen.queryByText("Local snapshot unavailable")).not.toBeInTheDocument();
  });

  it("preserves the current model when deleting another source from connection management", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    try {
      const other = { ...profile, id: "other", database: "warehouse", displayName: "Other" };
      const listRecentSnapshotIds = vi.fn();
      const clearCredentials = vi.fn().mockResolvedValue(undefined);
      const deleteSourceData = vi.fn().mockRejectedValueOnce(new Error("Local storage unavailable")).mockResolvedValue(1);
      const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listRecentSnapshotIds, clearCredentials, deleteSourceData });
      const { onSnapshot, onSourceDeleted } = renderWorkspace(platform);
      await screen.findByRole("button", { name: "Connection: Flow" });
      fireEvent.contextMenu(screen.getByRole("region", { name: "Data sources" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
      const manager = screen.getByRole("dialog", { name: "Manage connections" });
      const search = within(manager).getByRole("searchbox");
      fireEvent.change(search, { target: { value: "other" } });
      const remove = within(manager).getByRole("button", { name: "Delete Other…" });
      fireEvent.click(remove);
      const confirmation = screen.getByRole("dialog", { name: "Delete “Other”?" });
      const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
      expect(cancel).toHaveFocus();
      expect(clearCredentials).not.toHaveBeenCalled();
      expect(deleteSourceData).not.toHaveBeenCalled();
      fireEvent.click(cancel);
      expect(confirmation).not.toBeInTheDocument();
      expect(remove).toBeEnabled();

      fireEvent.click(remove);
      confirmSourceDeletion("Other");
      expect(await within(manager).findByRole("alert")).toHaveTextContent("Local storage unavailable");
      expect(onSourceDeleted).not.toHaveBeenCalled();
      expect(remove).toBeEnabled();

      fireEvent.click(remove);
      confirmSourceDeletion("Other");
      await waitFor(() => expect(onSourceDeleted).toHaveBeenCalledExactlyOnceWith(other.id));
      expect(within(manager).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(manager).queryByRole("button", { name: "Delete Other…" })).not.toBeInTheDocument();
      expect(search).toHaveValue("other");
      expect(search).toHaveFocus();
      fireEvent.click(within(manager).getByRole("button", { name: "Close" }));
      expect(screen.getByRole("button", { name: "Connection: Flow" })).toBeVisible();
      expect(screen.getByText("Model for source-1")).toBeVisible();
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(listRecentSnapshotIds).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });

  it("retries a failed initial mapping with the same source ID and no extra connection test", async () => {
    const saveDataSource = vi.fn();
    const testPostgresConnection = vi.fn().mockResolvedValue(connectionResult);
    const saveAndMapDataSource = vi.fn()
      .mockRejectedValueOnce("Structure read timed out")
      .mockResolvedValueOnce({ profile, capture: captureResult });
    const { onSnapshot } = renderPanel(platformMock({
      listDataSources: vi.fn().mockResolvedValue([]), saveDataSource, saveAndMapDataSource, testPostgresConnection,
    }));

    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    enterServerAccount();
    enterDatabaseName(profile.database);
    const map = screen.getByRole("button", { name: "Connect and open" });
    fireEvent.click(map);
    expect(await screen.findByText("Structure read timed out")).toBeVisible();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(map).toBeEnabled();

    fireEvent.click(map);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onSnapshot).toHaveBeenCalledWith(captureResult);
    expect(saveDataSource).not.toHaveBeenCalled();
    expect(testPostgresConnection).toHaveBeenCalledOnce();
    expect(saveAndMapDataSource).toHaveBeenCalledTimes(2);
    expect(saveAndMapDataSource.mock.calls[0][0]).toEqual(expect.objectContaining({ database: profile.database, displayName: profile.database }));
    expect(saveAndMapDataSource.mock.calls[1][1]).toEqual(saveAndMapDataSource.mock.calls[0][1]);
  });

});

describe("database navigation actions", () => {
  it("opens a keyboard-accessible blank-space menu without taking over object or input context menus", async () => {
    const capturePostgresSnapshot = vi.fn();
    const onRefresh = vi.fn(), platform = platformMock({ capturePostgresSnapshot });
    const panel = (refreshDisabled = false) => <ConnectionPanel enabled activeSourceId={profile.id} platform={platform} onSnapshot={vi.fn()}
      onRefresh={onRefresh} refreshDisabled={refreshDisabled} defaultDatabaseType="mySql" defaultSslMode="prefer">
      <input aria-label="Object search" /><button>Table object</button>
    </ConnectionPanel>;
    const { rerender } = render(panel());
    await screen.findByRole("button", { name: "Connection: Flow" });
    const region = screen.getByRole("region", { name: "Data sources" });
    fireEvent.contextMenu(screen.getByRole("textbox", { name: "Object search" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Table object" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(region, { clientX: 40, clientY: 300 });
    expect(screen.getByRole("menuitem", { name: "New connection…" })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh schema" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(region).toHaveFocus();
    rerender(panel(true));
    fireEvent.keyDown(region, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Refresh schema" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Manage connections…" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(region).toHaveFocus();
    fireEvent.contextMenu(region);
    fireEvent.click(screen.getByRole("menuitem", { name: "New connection…" }));
    expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeVisible();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
  });

  it("disables refresh without an active snapshot or permitted refresh callback", async () => {
    renderPanel(platformMock(), null);
    await screen.findByRole("button", { name: "Select connection" });
    fireEvent.contextMenu(screen.getByRole("region", { name: "Data sources" }));
    expect(screen.getByRole("menuitem", { name: "Refresh schema" })).toBeDisabled();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows the same connection list in the switcher and manager while a linked database is active", async () => {
    const server = { ...profile, id: "manager-server", displayName: "Shared server", database: "" };
    const linked = { ...profile, id: "manager-link", displayName: "Shared server · flow", serverSourceId: server.id };
    const orphan = { ...profile, id: "manager-legacy", displayName: "Legacy workspace", serverSourceId: "removed-server" };
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    try {
      renderWorkspace(platformMock({ listDataSources: vi.fn().mockResolvedValue([linked, profile, server, orphan]) }), linked.id);
      fireEvent.click(await screen.findByRole("button", { name: "Connection: Shared server" }));
      const switcher = within(screen.getByRole("menu", { name: "Switch connection" }));
      const switcherNames = switcher.getAllByRole("menuitemradio").map((item) => item.querySelector("strong")?.textContent);
      expect(switcherNames).toEqual([profile.displayName, server.displayName]);
      fireEvent.click(switcher.getByRole("menuitem", { name: "Manage connections…" }));
      const manager = screen.getByRole("dialog", { name: "Manage connections" });
      const rows = Array.from(manager.querySelectorAll(".connection-manager-row"));
      expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(switcherNames);
      expect(rows[1]).toHaveTextContent("Current");
      expect(rows[0]).not.toHaveTextContent("Current");
      const search = within(manager).getByRole("searchbox", { name: "Find database connections" });
      fireEvent.change(search, { target: { value: linked.displayName } });
      expect(within(manager).getByText("No matching connections.")).toBeVisible();
    } finally {
      cleanup();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });

  it("closes the active database when removing its server and leaves the database workspace intact", async () => {
    const server = { ...profile, id: "server-to-delete", displayName: "Shared server", database: "" };
    const linked = { ...profile, id: "active-database", displayName: "Shared server · flow", serverSourceId: server.id };
    const deleteSourceData = vi.fn().mockResolvedValue(1);
    const listRecentSnapshotIds = vi.fn();
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([linked, server, profile]), deleteSourceData, listRecentSnapshotIds });
    const { onSourceDeleted } = renderWorkspace(platform, linked.id);
    await editCurrentConnection(server.displayName);
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
    expect(screen.getByText(/Snapshots and semantics for its databases are kept/)).toBeVisible();
    confirmSourceDeletion(server.displayName);

    const picker = await screen.findByRole("button", { name: "Select connection" });
    expect(onSourceDeleted).toHaveBeenCalledWith(server.id);
    expect(deleteSourceData).toHaveBeenCalledExactlyOnceWith(server.id, expect.anything());
    expect(listRecentSnapshotIds).not.toHaveBeenCalled();
    fireEvent.click(picker);
    const switcher = within(screen.getByRole("menu", { name: "Switch connection" }));
    expect(switcher.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(switcher.getByRole("menuitemradio")).toHaveTextContent(profile.displayName);
  });

  it("tests and saves an imported server in place before browsing its databases", async () => {
    const server = { ...profile, id: "imported-server", displayName: "Imported server", database: "", connectionSync: { originId: "remote-server", pending: true } };
    const saved = { ...server, connectionSync: { ...server.connectionSync, pending: false } };
    const saveDataSource = vi.fn().mockRejectedValueOnce(new Error("Server verification failed")).mockResolvedValue(saved);
    const listServerDatabases = vi.fn().mockResolvedValue(["flow"]);
    const verifyAndRefreshDataSource = vi.fn();
    const saveAndMapDataSource = vi.fn();
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([server]), saveDataSource, listServerDatabases, verifyAndRefreshDataSource, saveAndMapDataSource });
    renderPanel(platform, null);
    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Imported server/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit Imported server" });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "fixture-password" } });
    const save = within(dialog).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    expect(await within(dialog).findByText("Server verification failed")).toBeVisible();
    expect(within(dialog).queryByText("Server connected")).not.toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    expect(await screen.findByRole("button", { name: "Connection: Imported server" })).toBeVisible();
    expect(saveDataSource).toHaveBeenCalledWith(expect.objectContaining({ id: server.id, database: "", password: "fixture-password" }));
    expect(verifyAndRefreshDataSource).not.toHaveBeenCalled();
    expect(saveAndMapDataSource).not.toHaveBeenCalled();
  });

  it("manages every saved connection and reuses existing open and edit flows", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    try {
      const other = { ...profile, id: "other", displayName: "Warehouse", database: "warehouse" };
      const listRecentSnapshotIds = vi.fn().mockResolvedValue(["snapshot-1"]), saveDataSource = vi.fn(), capturePostgresSnapshot = vi.fn();
      const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listRecentSnapshotIds, saveDataSource, capturePostgresSnapshot });
      const { onSnapshot } = renderPanel(platform, null);
      await screen.findByRole("button", { name: "Select connection" });
      const region = screen.getByRole("region", { name: "Data sources" });
      const manage = () => {
        fireEvent.contextMenu(region);
        fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
      };
      fireEvent.click(screen.getByRole("button", { name: "Select connection" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
      const manager = screen.getByRole("dialog", { name: "Manage connections" });
      const search = screen.getByRole("searchbox", { name: "Find database connections" });
      expect(search).toHaveFocus();
      fireEvent.change(search, { target: { value: "warehouse" } });
      expect(manager.querySelectorAll('.connection-manager-row')).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Open Warehouse" }));
      await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
      expect(listRecentSnapshotIds).toHaveBeenCalledWith(other.id);
      manage();
      fireEvent.click(within(screen.getByRole("dialog", { name: "Manage connections" })).getByRole("button", { name: "Edit Warehouse" }));
      expect(screen.getByRole("dialog", { name: "Edit Warehouse" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      manage();
      fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find database connections" }), { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(region).toHaveFocus();
      manage();
      fireEvent(screen.getByRole("dialog", { name: "Manage connections" }), new Event("cancel", { bubbles: false, cancelable: true }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(region).toHaveFocus();
      manage();
      const actions = within(screen.getByRole("dialog", { name: "Manage connections" }));
      expect(actions.getByRole("button", { name: "Close" }).closest("footer")?.querySelectorAll("button")).toHaveLength(1);
      fireEvent.click(actions.getByRole("button", { name: "Add connection…" }));
      expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeVisible();
      expect(saveDataSource).not.toHaveBeenCalled();
      expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });
});

it("opens SQLite through a file picker without network or credential fields", async () => {
  const pickWorkspacePath = vi.fn().mockResolvedValue("/tmp/local.sqlite");
  const testPostgresConnection = vi.fn().mockResolvedValue({ database: { name: "local.sqlite", databaseType: "sqlite", version: "3.51" }, sslActive: null, serverReadOnly: true });
  renderPanel(platformMock({ pickWorkspacePath, testPostgresConnection }));
  fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Database engine" }), { target: { value: "sqlite" } });
  expect(screen.queryByRole("textbox", { name: "Host" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "TLS" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "SSH" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Choose database file" }));
  await waitFor(() => expect(screen.getByDisplayValue("/tmp/local.sqlite")).toBeInTheDocument());
  expect(pickWorkspacePath).toHaveBeenCalledWith("openSqlite");
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("SQLite passed the read-only connection test.");
  expect(testPostgresConnection).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "sqlite", sqlite: { path: "/tmp/local.sqlite" }, password: "" }), expect.anything());
  expect(screen.queryByRole("group", { name: "TLS status" })).not.toBeInTheDocument();
});


it("omits network tabs for SQLite and supports keyboard navigation across connection settings", async () => {
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Database engine" }), { target: { value: "sqlite" } });
  expect(screen.queryByRole("tablist", { name: "Connection settings" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose database file" })).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "SSL mode" })).not.toBeInTheDocument();
  expect(screen.getByText("File access").closest("details")).not.toHaveAttribute("open");
  fireEvent.change(screen.getByRole("combobox", { name: "Database engine" }), { target: { value: "postgreSql" } });
  expect(screen.getByLabelText("Host")).toBeVisible();
  const tabs = screen.getByRole("tablist", { name: "Connection settings" });
  expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Connection", "TLS", "SSH"]);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Connection" }), { key: "ArrowRight" });
  expect(screen.getByRole("combobox", { name: "SSL mode" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("tab", { name: "TLS" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "SSH" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
  expect(screen.getByLabelText("Host")).toBeVisible();
  expect(screen.getByRole("tabpanel", { name: "Connection" })).toBeVisible();
});

it("preserves network TLS and credentials when switching between PostgreSQL and MySQL", async () => {
  const testPostgresConnection = vi.fn().mockResolvedValue(connectionResult);
  renderPanel(platformMock({ testPostgresConnection }));
  fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
  enterServerAccount("entered-password");
  fireEvent.click(screen.getByRole("tab", { name: "TLS" }));
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "verifyFull" } });
  fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Database engine" }), { target: { value: "postgreSql" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(testPostgresConnection).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "postgreSql", sslMode: "verifyFull", password: "entered-password" }), expect.anything()));
});

it.each(["mySql", "postgreSql"] as const)("offers TLS guidance for a private %s hostname without testing or saving", async (engine) => {
  const testPostgresConnection = vi.fn();
  const saveDataSource = vi.fn();
  renderPanel(platformMock({ testPostgresConnection, saveDataSource }));
  fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
  fireEvent.change(screen.getByLabelText("Database engine"), { target: { value: engine } });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "office-db.example" } });
  fireEvent.click(screen.getByRole("tab", { name: "TLS" }));
  expect(screen.getByText("Use the TLS mode specified by your database provider.")).toBeVisible();
  fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "require" } });
  expect(screen.getByLabelText("SSL mode")).toHaveValue("require");
  expect(testPostgresConnection).not.toHaveBeenCalled();
  expect(saveDataSource).not.toHaveBeenCalled();
});

it("retries an explicitly rejected unencrypted connection using the same draft and Require", async () => {
  const testPostgresConnection = vi.fn()
    .mockRejectedValueOnce({ stage: "tls", code: "unencryptedConnectionRejected", message: "Native fallback", sshConnected: true })
    .mockResolvedValueOnce(connectionResult);
  const saveDataSource = vi.fn();
  renderPanel(platformMock({ testPostgresConnection, saveDataSource }));
  fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
  enterServerAccount("fixture-password");
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "office-db.example" } });
  fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
  fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "jump.example" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  fireEvent.click(await screen.findByRole("button", { name: "Require TLS and retest" }));
  expect(await screen.findByText("Server connected")).toBeVisible();
  expect(testPostgresConnection).toHaveBeenCalledTimes(2);
  expect(testPostgresConnection).toHaveBeenLastCalledWith(
    { ...testPostgresConnection.mock.calls[0][0], sslMode: "require" }, expect.anything(),
  );
  expect(saveDataSource).not.toHaveBeenCalled();
});

it("blocks saving or changing the connection while a SQLite file picker is pending", async () => {
  let choose!: (path: string) => void;
  const pickWorkspacePath = vi.fn().mockImplementationOnce(() => Promise.resolve("/tmp/first.db"))
    .mockImplementationOnce(() => new Promise<string>((resolve) => { choose = resolve; }));
  const testPostgresConnection = vi.fn().mockResolvedValue(connectionResult);
  const saveAndMapDataSource = vi.fn().mockResolvedValue({ profile, capture: captureResult });
  const api = platformMock({ pickWorkspacePath, saveAndMapDataSource, testPostgresConnection });
  renderPanel(api);
  fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Database engine" }), { target: { value: "sqlite" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose database file" }));
  await screen.findByDisplayValue("/tmp/first.db");
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Open SQLite file" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Choose database file" }));
  expect(screen.getByRole("combobox", { name: "Database engine" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  expect(saveAndMapDataSource).not.toHaveBeenCalled();
  await act(() => Promise.resolve(choose("/tmp/second.db")));
  expect(screen.getByDisplayValue("/tmp/second.db")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open SQLite file" }));
  await waitFor(() => expect(saveAndMapDataSource).toHaveBeenCalledOnce());
  expect(testPostgresConnection).toHaveBeenCalledTimes(2);
  expect(testPostgresConnection).toHaveBeenLastCalledWith(expect.objectContaining({ sqlite: { path: "/tmp/second.db" } }), expect.anything());
});


it("deletes a SQLite source without requesting a database credential operation", async () => {
  const clearCredentials = vi.fn().mockResolvedValue(undefined);
  const sqliteProfile = { ...profile, databaseType: "sqlite" as const, sqlite: { path: "/tmp/source.db" } };
  renderPanel(platformMock({ listDataSources: vi.fn().mockResolvedValue([sqliteProfile]), clearCredentials }));
  await editCurrentConnection();
  expect(screen.getByText("Open the saved SQLite file read-only and refresh its schema snapshot.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
  confirmSourceDeletion("Flow");
  await waitFor(() => expect(clearCredentials).toHaveBeenCalledWith(profile.id, { database: false, ai: true, cloud: true }));
});


it("reloads the picker and editor when a backup import removes the SQLite binding", async () => {
  const bound: DataSourceProfile = { ...profile, databaseType: "sqlite", sqlite: { path: "/synthetic/original.sqlite" } };
  const listDataSources = vi.fn().mockResolvedValueOnce([bound]).mockResolvedValue([{ ...bound, displayName: "Imported model", sqlite: undefined }]);
  const api = platformMock({ listDataSources });
  const props = { enabled: true, activeSourceId: profile.id, platform: api, onSnapshot: vi.fn(), defaultDatabaseType: "sqlite" as const, defaultSslMode: "disable" as const };
  const view = render(<ConnectionPanel {...props} sourcesRevision={0} />);
  expect(await screen.findByRole("button", { name: "Connection: Flow" })).toHaveAttribute("title", expect.stringContaining("/synthetic/original.sqlite"));
  view.rerender(<ConnectionPanel {...props} sourcesRevision={1} />);
  const imported = await screen.findByRole("button", { name: "Connection: Imported model" });
  expect(imported).not.toHaveAttribute("title", expect.stringContaining("/synthetic/original.sqlite"));
  await editCurrentConnection("Imported model");
  expect(screen.getByRole("textbox", { name: "Database file" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Imported model");
});

describe("manual connection sync", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  it("previews and confirms a conflict without opening the new connection", async () => {
    const file = "/tmp/nodal-connections.nodalconnections";
    const passphrase = "example sync passphrase";
    const incoming = { ...profile, host: "remote.example", ssh: null };
    const added = { ...incoming, id: "separate-local-id", connectionSync: { originId: profile.id, pending: true } };
    const pickWorkspacePath = vi.fn().mockResolvedValue(file);
    const previewConnectionSync = vi.fn().mockResolvedValue({
      token: "preview-token",
      rows: [{ connection: incoming, action: "conflict", existing: { ...profile, ssh: null } }],
    });
    const importConnectionSync = vi.fn().mockResolvedValue([added]);
    const listRecentSnapshotIds = vi.fn();
    const testPostgresConnection = vi.fn();
    const platform = platformMock({ pickWorkspacePath, previewConnectionSync, importConnectionSync, listRecentSnapshotIds, testPostgresConnection });
    renderPanel(platform, null);
    fireEvent.click(await screen.findByRole("button", { name: "Select connection" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
    fireEvent.click(screen.getByRole("button", { name: "Connection sync…" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("button", { name: "Preview Merge" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose Encrypted File…" }));
    await screen.findByText("nodal-connections.nodalconnections");
    expect(pickWorkspacePath).toHaveBeenCalledWith("openConnectionSync");
    fireEvent.change(screen.getByLabelText("File passphrase"), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Merge" }));
    const preview = await screen.findByRole("dialog", { name: "Preview Connection Merge" });
    expect(within(preview).getByText("Keep both versions")).toBeVisible();
    expect(within(preview).getByText("root@127.0.0.1:3306")).toBeVisible();
    expect(within(preview).getByText("root@remote.example:3306")).toBeVisible();
    expect(previewConnectionSync).toHaveBeenCalledWith(file, passphrase);
    expect(importConnectionSync).not.toHaveBeenCalled();

    fireEvent.click(within(preview).getByRole("button", { name: "Import Connections" }));
    const result = await screen.findByRole("dialog", { name: "Connection sync" });
    expect(within(result).getByRole("status")).toHaveTextContent("Added 1 connection.");
    expect(screen.getByLabelText("File passphrase")).toHaveValue("");
    expect(importConnectionSync).toHaveBeenCalledWith(file, passphrase, "preview-token");
    expect(listRecentSnapshotIds).not.toHaveBeenCalled();
    expect(testPostgresConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const manager = screen.getByRole("dialog", { name: "Manage connections" });
    const row = within(manager).getByText("Local setup required").closest(".connection-manager-row");
    expect(within(manager).getAllByText("Flow", { exact: true })).toHaveLength(2);
    expect(row).toBeInTheDocument();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Edit Flow" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByText("Enter the database password and any SSH credentials or local files this connection requires, then test the connection.")).toBeVisible();
  });

  it("offers import when no connections are saved", async () => {
    renderPanel(platformMock({ listDataSources: vi.fn().mockResolvedValue([]) }), null);
    fireEvent.click(await screen.findByRole("button", { name: "Connection sync…" }));
    const dialog = screen.getByRole("dialog", { name: "Connection sync" });
    expect(within(dialog).getByRole("button", { name: "Import" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeDisabled();
  });
});
