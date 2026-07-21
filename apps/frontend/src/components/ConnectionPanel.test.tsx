import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CaptureSnapshotResult,
  ConnectionTestResult,
  DataSourceProfile,
  NodalStudioPlatform,
} from "../platform";
import { ConnectionPanel } from "./ConnectionPanel";

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
  it("keeps connection fields in a create dialog", async () => {
    renderPanel();

    expect(await screen.findByText("Flow")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "Open Flow" }));

    await waitFor(() => expect(listSnapshots).toHaveBeenCalledWith(profile.id));
    expect(getSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(capturePostgresSnapshot).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledWith({ snapshot: captureResult.snapshot, stored: false, changeSet: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens an explicit edit form for an existing source", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Flow" }));

    expect(screen.getByRole("dialog", { name: "Edit database connection" })).toBeInTheDocument();
    expect(screen.getByLabelText("Database")).toHaveValue("flow");
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Required to save changes");
    expect(screen.getByRole("button", { name: "Delete data source" })).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and map" }));

    await waitFor(() => expect(saveDataSource).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(/Connected to flow/)).toBeInTheDocument();
  });
});
