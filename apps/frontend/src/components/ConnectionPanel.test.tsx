import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    listSnapshots: vi.fn().mockResolvedValue([{ id: "snapshot-1", sourceId: profile.id }]),
    getSnapshot: vi.fn().mockResolvedValue(captureResult.snapshot),
    testPostgresConnection: vi.fn().mockResolvedValue(connectionResult),
    saveDataSource: vi.fn().mockResolvedValue(profile),
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

function renderPanel(platform = platformMock()) {
  const onSnapshot = vi.fn();
  const onSourceDeleted = vi.fn();
  render(
    <ConnectionPanel
      enabled
      platform={platform}
      onSnapshot={onSnapshot}
      onSourceDeleted={onSourceDeleted}
      defaultDatabaseType="mySql"
      defaultSslMode="prefer"
    />,
  );
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
    renderPanel(platformMock({ testPostgresConnection }));
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    act(() => options?.onProgress?.({ phase: "handshake", sshConnected: false }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Connecting to the database and negotiating TLS…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection test" }));
    expect(options?.signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel connection test" })).toBeDisabled();
    await act(async () => { finish(connectionResult); await Promise.resolve(); });
    expect(screen.getByText("Connection test cancelled")).toBeVisible();
    expect(screen.queryByText("Connection successful")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and map" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("tests without saving and invalidates the result after edits", async () => {
    const saveDataSource = vi.fn(), capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ saveDataSource, capturePostgresSnapshot });
    renderPanel(platform);
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection successful")).toBeVisible();
    expect(saveDataSource).not.toHaveBeenCalled();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save and map" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "different.example" } });
    expect(screen.queryByText("Connection successful")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and map" })).toBeDisabled();
  });

  it("shows the failed stage and keeps saving disabled", async () => {
    renderPanel(platformMock({ testPostgresConnection: vi.fn().mockRejectedValue({ stage: "tls", message: "Check the CA certificate.", sshConnected: true }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("TLS verification failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Check the CA certificate.");
    expect(screen.getByRole("button", { name: "Save and map" })).toBeDisabled();
  });

  it("keeps edits across security tabs and clears passwords when closing", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    expect(screen.getByRole("tab", { name: "Connection" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    expect(screen.getByLabelText("Database")).not.toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Connect through SSH/ }));
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("SSH password"), { target: { value: "test-only" } });
    fireEvent.click(screen.getByRole("tab", { name: "TLS" }));
    expect(screen.getByLabelText("SSH password")).not.toBeVisible();
    expect(screen.getByLabelText("SSL mode")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /SSH/ }));
    expect(screen.getByLabelText("SSH password")).toHaveValue("test-only");
    fireEvent.click(screen.getByRole("button", { name: "Close connection dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    expect(screen.getByRole("tab", { name: "Connection" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
    expect(screen.getByRole("checkbox", { name: /Connect through SSH/ })).not.toBeChecked();
  });

  it("collapses the active source locally and restores the same search and group state without reopening its snapshot", async () => {
    const listSnapshots = vi.fn(), getSnapshot = vi.fn(), capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listSnapshots, getSnapshot, capturePostgresSnapshot }), onSnapshot = vi.fn();
    const model = { ...reportSnapshot, sourceId: profile.id, schemas: [reportSnapshot.schemas[0]] };
    const panel = (snapshot = model) => <ConnectionPanel enabled activeSourceId={profile.id} platform={platform}
      onSnapshot={onSnapshot} defaultDatabaseType="mySql" defaultSslMode="prefer">
      <SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />
    </ConnectionPanel>;
    const { rerender } = render(panel());
    await screen.findByRole("button", { name: "Collapse Flow" });
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    const search = screen.getByRole("searchbox", { name: "Search tables and views" });
    fireEvent.change(search, { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Flow" }));
    expect(screen.getByRole("button", { name: "Expand Flow" })).toHaveAttribute("aria-expanded", "false");
    expect(search).not.toBeVisible();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    // A fresh snapshot for the same source must not reopen the directory.
    rerender(panel({ ...model, id: "refreshed" }));
    expect(screen.getByRole("button", { name: "Expand Flow" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand Flow" }));
    expect(screen.getByRole("button", { name: "Collapse Flow" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toBeVisible(); expect(search).toHaveValue("orders");
    fireEvent.click(screen.getByRole("button", { name: "Clear object search" }));
    expect(screen.getByRole("button", { name: /Tables/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^customers/ })).toBeVisible();
    expect(listSnapshots).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("opens a newly selected source after collapsing the previous source and leaves editing independent", async () => {
    const other = { ...profile, id: "source-2", displayName: "Other" };
    const listSnapshots = vi.fn().mockResolvedValue([{ id: "other-snapshot", sourceId: other.id }]);
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listSnapshots,
      getSnapshot: vi.fn().mockResolvedValue({ ...captureResult.snapshot, sourceId: other.id }) });
    const onSnapshot = vi.fn();
    const panel = (id: string) => <ConnectionPanel enabled activeSourceId={id} platform={platform}
      onSnapshot={onSnapshot} defaultDatabaseType="mySql" defaultSslMode="prefer"><input aria-label="Source content" /></ConnectionPanel>;
    const { rerender } = render(panel(profile.id));
    fireEvent.click(await screen.findByRole("button", { name: "Collapse Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Flow" }));
    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand Flow" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Data source" }), { target: { value: other.id } });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(listSnapshots).toHaveBeenCalledWith(other.id);
    rerender(panel(other.id));
    expect(screen.getByRole("button", { name: "Collapse Other" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("combobox", { name: "Data source" })).toHaveValue(other.id);
    // Returning to a source is a new selection, so a stale collapsed state must not leak.
    rerender(panel(profile.id));
    expect(screen.getByRole("button", { name: "Collapse Flow" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps connection fields in a create dialog", async () => {
    renderPanel();

    expect(await screen.findByText("Flow")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add database" }));

    expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeInTheDocument();
    expect(screen.getByLabelText("Database engine")).toHaveValue("mySql");
    expect(screen.getByLabelText("Port")).toHaveValue(3306);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the saved snapshot without reconnecting to the database", async () => {
    const listSnapshots = vi.fn().mockResolvedValue([{ id: "snapshot-1", sourceId: profile.id }]);
    const getSnapshot = vi.fn().mockResolvedValue(captureResult.snapshot);
    const capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listSnapshots, getSnapshot, capturePostgresSnapshot });
    const { onSnapshot } = renderPanel(platform);

    fireEvent.click(await screen.findByRole("button", { name: "Open local snapshot for Flow" }));

    await waitFor(() => expect(listSnapshots).toHaveBeenCalledWith(profile.id));
    expect(getSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledWith({ snapshot: captureResult.snapshot, stored: false, changeSet: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens an explicit edit form for an existing source", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Flow" }));

    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeInTheDocument();
    expect(screen.getByLabelText("Database")).toHaveValue("flow");
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Optional — keep current password");
    expect(screen.getByText("System credential storage")).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Edit Flow" }));
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
    expect(screen.getByText("Flow local")).toBeInTheDocument();
  });

  it("requires verification for connection detail changes and reuses the system credential store password", async () => {
    const verifyAndRefreshDataSource = vi.fn().mockResolvedValue({
      profile,
      connection: connectionResult,
      capture: captureResult,
    });
    const platform = platformMock({ verifyAndRefreshDataSource });
    const { onSnapshot } = renderPanel(platform);

    fireEvent.click(await screen.findByRole("button", { name: "Edit Flow" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Edit Flow" }));
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Metadata refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeInTheDocument();
    expect(saveDataSource).not.toHaveBeenCalled();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(screen.getByText("Flow")).toBeInTheDocument();
  });

  it("deletes a source and its local data after confirmation", async () => {
    const clearCredentials = vi.fn().mockResolvedValue(undefined);
    const deleteSourceData = vi.fn().mockResolvedValue(4);
    const platform = platformMock({ clearCredentials, deleteSourceData });
    const { onSourceDeleted } = renderPanel(platform);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(await screen.findByRole("button", { name: "Edit Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));

    await waitFor(() => expect(deleteSourceData).toHaveBeenCalledWith(profile.id, {
      deleteConnection: true,
      deleteHistory: true,
      deleteSemantics: true,
      removeDatabaseCredential: false,
    }));
    expect(clearCredentials).toHaveBeenCalledWith(profile.id, { database: true, ai: true, cloud: true });
    expect(onSourceDeleted).toHaveBeenCalledWith(profile.id);
    expect(screen.queryByText("Flow")).not.toBeInTheDocument();
  });

  it("closes the dialog only after a new source is mapped", async () => {
    const saveDataSource = vi.fn().mockResolvedValue(profile);
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([]), saveDataSource });
    renderPanel(platform);

    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    expect(screen.getByRole("button", { name: "Save and map" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save and map" })).toBeEnabled());
    expect(saveDataSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save and map" }));

    await waitFor(() => expect(saveDataSource).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(/Connected to flow/)).toBeInTheDocument();
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
    await screen.findByRole("button", { name: "Edit Flow" });
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
    renderPanel();
    await screen.findByRole("button", { name: "Edit Flow" });
    fireEvent.contextMenu(screen.getByRole("region", { name: "Data sources" }));
    expect(screen.getByRole("menuitem", { name: "Refresh schema" })).toBeDisabled();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("manages every saved connection and reuses existing open and edit flows", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    try {
      const other = { ...profile, id: "other", displayName: "Warehouse", database: "warehouse" };
      const listSnapshots = vi.fn().mockResolvedValue([{ id: "snapshot-1" }]), saveDataSource = vi.fn(), capturePostgresSnapshot = vi.fn();
      const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listSnapshots, saveDataSource, capturePostgresSnapshot });
      const { onSnapshot } = renderPanel(platform);
      await screen.findByRole("button", { name: "Edit Flow" });
      const region = screen.getByRole("region", { name: "Data sources" });
      const manage = () => {
        fireEvent.contextMenu(region);
        fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
      };
      manage();
      const manager = screen.getByRole("dialog", { name: "Manage connections" });
      const search = screen.getByRole("searchbox", { name: "Find database connections" });
      expect(search).toHaveFocus();
      fireEvent.change(search, { target: { value: "warehouse" } });
      expect(manager.querySelectorAll('.connection-manager-row')).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Open Warehouse" }));
      await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
      expect(listSnapshots).toHaveBeenCalledWith(other.id);
      manage();
      fireEvent.click(within(screen.getByRole("dialog", { name: "Manage connections" })).getByRole("button", { name: "Edit Warehouse" }));
      expect(screen.getByRole("dialog", { name: "Edit Warehouse" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      manage();
      fireEvent(screen.getByRole("dialog", { name: "Manage connections" }), new Event("cancel", { bubbles: false, cancelable: true }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(region).toHaveFocus();
      expect(saveDataSource).not.toHaveBeenCalled();
      expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });
});
