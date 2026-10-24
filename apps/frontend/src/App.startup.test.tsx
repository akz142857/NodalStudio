import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { defaultEffectiveSettings, getPlatform, type CaptureSnapshotResult, type DatabaseSnapshot, type DataSourceProfile } from "./platform";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";

const saved = { ...reportSnapshot, sourceId: "startup-source" };
const manual = { ...reportSnapshot, sourceId: "manual-source" };
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot }: { snapshot: DatabaseSnapshot }) => <output data-testid="loaded-source">{snapshot.sourceId}</output> }));
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot, onSourceOpenStart }: { onSnapshot: (result: CaptureSnapshotResult) => void; onSourceOpenStart: () => void }) => <>
  <button onClick={onSourceOpenStart}>Choose manual source</button>
  <button onClick={() => onSnapshot({ snapshot: manual, stored: false, changeSet: null })}>Finish manual open</button>
</> }));

function setup(autoConnect = false) {
  const platform = getPlatform();
  const settings = (id?: string) => {
    const value = defaultEffectiveSettings(id);
    value.app.legacyStorageMigrationVersion = 3;
    value.app.general.lastSourceId = saved.sourceId;
    value.app.general.startPage = "lastDataSource";
    value.app.general.reopenLastWorkspace = true;
    if (value.source) {
      value.source.legacyStorageMigrationVersion = 3;
      value.source.refresh.autoConnect = autoConnect;
      value.source.refresh.intervalSeconds = 0;
    }
    return value;
  };
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Startup runtime", version: "test" });
  vi.spyOn(platform, "listDataSources").mockResolvedValue([{ id: saved.sourceId } as DataSourceProfile]);
  vi.spyOn(platform, "getSettings").mockImplementation((id) => Promise.resolve(settings(id)));
  vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics);
  vi.spyOn(platform, "listSnapshots").mockResolvedValue([{ id: saved.id, sourceId: saved.sourceId, capturedAt: saved.capturedAt, fingerprint: saved.fingerprint, databaseName: saved.database.name, schemaCount: saved.schemas.length, tableCount: 3 }]);
  const read = vi.spyOn(platform, "getSnapshot").mockResolvedValue(saved);
  const capture = vi.spyOn(platform, "capturePostgresSnapshot").mockResolvedValue({ snapshot: saved, stored: false, changeSet: null });
  const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return { read, capture, mount };
}

describe("startup workspace restoration", () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });
  afterEach(() => vi.restoreAllMocks());

  it("reopens the saved local model without a live connection when auto-connect is off", async () => {
    const { read, capture, mount } = setup();
    mount();
    expect(await screen.findByTestId("loaded-source")).toHaveTextContent(saved.sourceId);
    expect(read).toHaveBeenCalledWith(saved.id);
    expect(capture).not.toHaveBeenCalled();
  });

  it("retains live auto-connect when explicitly enabled", async () => {
    const { capture, mount } = setup(true);
    mount();
    expect(await screen.findByTestId("loaded-source")).toHaveTextContent(saved.sourceId);
    expect(capture).toHaveBeenCalledWith(saved.sourceId, "background");
  });

  it.each([false, true])("does not overwrite a manual selection with a late startup result (auto-connect: %s)", async (autoConnect) => {
    const { read, capture, mount } = setup(autoConnect);
    let finish!: () => void;
    if (autoConnect) capture.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ snapshot: saved, stored: false, changeSet: null }); }));
    else read.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(saved); }));
    mount();
    await waitFor(() => expect(autoConnect ? capture : read).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Choose manual source" }));
    await act(async () => { finish(); await Promise.resolve(); });
    expect(screen.queryByTestId("loaded-source")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish manual open" }));
    expect(await screen.findByTestId("loaded-source")).toHaveTextContent(manual.sourceId);
  });

  it("reports an unsuccessful local restore without silently reconnecting", async () => {
    const { read, capture, mount } = setup();
    read.mockRejectedValue(new Error("Fixture storage-pool-timeout"));
    mount();
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: /Open notifications/ }));
    expect(await screen.findByText("Workspace could not be opened")).toBeVisible();
    expect(screen.getByText(/Fixture storage-pool-timeout/)).toBeVisible();
    expect(capture).not.toHaveBeenCalled();
  });
});
