import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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

async function editCurrentConnection() {
  fireEvent.click(await screen.findByRole("button", { name: "Data source: flow" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit current connection…" }));
}

function renderWorkspace(platform: NodalStudioPlatform) {
  const onSnapshot = vi.fn(), onSourceDeleted = vi.fn();
  function Workspace() {
    const [sourceId, setSourceId] = useState<string | undefined>(profile.id);
    return <ConnectionPanel enabled platform={platform} activeSourceId={sourceId}
      defaultDatabaseType="mySql" defaultSslMode="prefer"
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

  it("keeps object search and group state across same-source snapshot refresh without reopening it", async () => {
    const listSnapshots = vi.fn(), getSnapshot = vi.fn(), capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listSnapshots, getSnapshot, capturePostgresSnapshot }), onSnapshot = vi.fn();
    const model = { ...reportSnapshot, sourceId: profile.id, schemas: [reportSnapshot.schemas[0]] };
    const panel = (snapshot = model) => <ConnectionPanel enabled activeSourceId={profile.id} platform={platform}
      onSnapshot={onSnapshot} defaultDatabaseType="mySql" defaultSslMode="prefer">
      <SchemaTree snapshot={snapshot} onSelectTable={vi.fn()} />
    </ConnectionPanel>;
    const { rerender } = render(panel());
    await screen.findByRole("button", { name: "Data source: flow" });
    fireEvent.click(screen.getByRole("button", { name: /Tables/ }));
    const search = screen.getByRole("searchbox", { name: "Search tables and views" });
    fireEvent.change(search, { target: { value: "orders" } });
    // A fresh snapshot for the same source preserves the current object navigation.
    rerender(panel({ ...model, id: "refreshed" }));
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

  it("opens a newly selected source and keeps its content visible independently of editing", async () => {
    const other = { ...profile, id: "source-2", displayName: "Other" };
    const listSnapshots = vi.fn().mockResolvedValue([{ id: "other-snapshot", sourceId: other.id }]);
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listSnapshots,
      getSnapshot: vi.fn().mockResolvedValue({ ...captureResult.snapshot, sourceId: other.id }) });
    const onSnapshot = vi.fn();
    const panel = (id: string) => <ConnectionPanel enabled activeSourceId={id} platform={platform}
      onSnapshot={onSnapshot} defaultDatabaseType="mySql" defaultSslMode="prefer"><input aria-label="Source content" /></ConnectionPanel>;
    const { rerender } = render(panel(profile.id));
    await editCurrentConnection();
    expect(screen.getByRole("dialog", { name: "Edit Flow" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Data source: flow" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /MySQL · Other/ }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(listSnapshots).toHaveBeenCalledWith(other.id);
    rerender(panel(other.id));
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add database" }));
    expect(screen.getByRole("dialog", { name: "Create database connection" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Data source: flow" })).toHaveTextContent("MySQL · Other");
    rerender(panel(profile.id));
    expect(screen.getByRole("textbox", { name: "Source content" })).toBeVisible();
  });

  it("keeps connection fields in a create dialog", async () => {
    renderPanel();

    expect(await screen.findByRole("button", { name: "Data source: flow" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Select database" }));
    fireEvent.click(screen.getByRole("menuitemradio"));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    if (timing === "after") rerender(panel(profile.id));
    await act(async () => { reject(new Error("Fixture local read timed out")); await Promise.resolve(); });
    if (timing === "before") {
      expect(screen.getByRole("alert")).toHaveTextContent("Fixture local read timed out");
      expect(screen.getByRole("button", { name: "Retry opening database" })).toBeEnabled();
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
    fireEvent.click(await screen.findByRole("button", { name: "Select database" }));
    fireEvent.click(screen.getByRole("menuitemradio"));
    fireEvent.click(await screen.findByRole("button", { name: "Retry opening database" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
  });

  it("opens the saved snapshot without reconnecting to the database", async () => {
    const listSnapshots = vi.fn().mockResolvedValue([{ id: "snapshot-1", sourceId: profile.id }]);
    const getSnapshot = vi.fn().mockResolvedValue(captureResult.snapshot);
    const capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listSnapshots, getSnapshot, capturePostgresSnapshot });
    const { onSnapshot } = renderPanel(platform, null);

    fireEvent.click(await screen.findByRole("button", { name: "Select database" }));
    expect(screen.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /MySQL · Flow/ }));

    await waitFor(() => expect(listSnapshots).toHaveBeenCalledWith(profile.id));
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
    expect(screen.getByRole("button", { name: "Data source: flow" })).toHaveTextContent("MySQL · Flow local");
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
    expect(screen.getByRole("button", { name: "Data source: flow" })).toHaveTextContent("MySQL · Flow");
  });

  it("deletes a source and its local data after confirmation", async () => {
    const clearCredentials = vi.fn().mockResolvedValue(undefined);
    const deleteSourceData = vi.fn().mockResolvedValue(4);
    const listSnapshots = vi.fn();
    const platform = platformMock({ clearCredentials, deleteSourceData, listSnapshots });
    const { onSnapshot, onSourceDeleted } = renderWorkspace(platform);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await editCurrentConnection();
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));

    await waitFor(() => expect(deleteSourceData).toHaveBeenCalledWith(profile.id, {
      deleteConnection: true,
      deleteHistory: true,
      deleteSemantics: true,
      removeDatabaseCredential: false,
    }));
    expect(clearCredentials).toHaveBeenCalledWith(profile.id, { database: true, ai: true, cloud: true });
    expect(onSourceDeleted).toHaveBeenCalledWith(profile.id);
    expect(screen.queryByRole("button", { name: "Data source: flow" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /No database connected/ })).toBeVisible();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(listSnapshots).not.toHaveBeenCalled();
  });

  it("opens the remaining saved model after deleting the current source", async () => {
    const remaining = { ...profile, id: "source-2", database: "warehouse", displayName: "Flow" };
    const snapshot = { ...captureResult.snapshot, sourceId: remaining.id };
    const listSnapshots = vi.fn().mockResolvedValue([{ id: "remaining-snapshot" }]), capturePostgresSnapshot = vi.fn();
    const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, remaining]), getSnapshot: vi.fn().mockResolvedValue(snapshot), listSnapshots, capturePostgresSnapshot });
    const { onSnapshot, onSourceDeleted } = renderWorkspace(platform);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await editCurrentConnection();
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
    expect(await screen.findByRole("button", { name: "Data source: warehouse" })).toBeVisible();
    expect(screen.getByText("Model for source-2")).toBeVisible();
    expect(onSourceDeleted).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({ snapshot, stored: false, changeSet: null });
    expect(listSnapshots).toHaveBeenCalledExactlyOnceWith(remaining.id);
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Data source: warehouse" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the picker and management available if the remaining snapshot fails to open, then allows retry", async () => {
    const remaining = { ...profile, id: "source-2", database: "warehouse" };
    const platform = platformMock({
      listDataSources: vi.fn().mockResolvedValue([profile, remaining]),
      listSnapshots: vi.fn().mockRejectedValueOnce(new Error("Local snapshot unavailable")).mockResolvedValue([{ id: "remaining-snapshot" }]),
      getSnapshot: vi.fn().mockResolvedValue({ ...captureResult.snapshot, sourceId: remaining.id }),
    });
    renderWorkspace(platform);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await editCurrentConnection();
    fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
    expect(await screen.findByText("Local snapshot unavailable")).toBeVisible();
    expect(screen.queryByText("Model for source-1")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Select database" });
    expect(trigger).toHaveTextContent("1 saved connection");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Manage connections…" })).toBeEnabled();
    expect(screen.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio"));
    expect(await screen.findByRole("button", { name: "Data source: warehouse" })).toBeVisible();
    expect(screen.queryByText("Local snapshot unavailable")).not.toBeInTheDocument();
  });

  it("preserves the current model when deleting another source from connection management", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    try {
      const other = { ...profile, id: "other", database: "warehouse", displayName: "Other" };
      const listSnapshots = vi.fn();
      const platform = platformMock({ listDataSources: vi.fn().mockResolvedValue([profile, other]), listSnapshots });
      const { onSnapshot, onSourceDeleted } = renderWorkspace(platform);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await screen.findByRole("button", { name: "Data source: flow" });
      fireEvent.contextMenu(screen.getByRole("region", { name: "Data sources" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit Other" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete data source" }));
      await waitFor(() => expect(onSourceDeleted).toHaveBeenCalledExactlyOnceWith(other.id));
      expect(screen.getByRole("button", { name: "Data source: flow" })).toBeVisible();
      expect(screen.getByText("Model for source-1")).toBeVisible();
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(listSnapshots).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
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
    await screen.findByRole("button", { name: "Data source: flow" });
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
    await screen.findByRole("button", { name: "Select database" });
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
      const { onSnapshot } = renderPanel(platform, null);
      await screen.findByRole("button", { name: "Select database" });
      const region = screen.getByRole("region", { name: "Data sources" });
      const manage = () => {
        fireEvent.contextMenu(region);
        fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
      };
      fireEvent.click(screen.getByRole("button", { name: "Select database" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Manage connections…" }));
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
      fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find database connections" }), { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(region).toHaveFocus();
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
