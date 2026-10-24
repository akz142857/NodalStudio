import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { defaultEffectiveSettings, getPlatform, type CaptureSnapshotResult, type UpdateStatus } from "./platform";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";

vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: () => <p>Restored model</p> }));
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (value: CaptureSnapshotResult) => void }) =>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: false, changeSet: null })}>Restore model</button> }));

const available: UpdateStatus = { phase: "available", currentVersion: "0.2.0", availableVersion: "0.2.1", notes: "Update notice improvements",
  downloadUrl: null, downloadedBytes: 0, totalBytes: null, checkedAt: null, error: null,
  configured: true, canCheck: true, manualOnly: false, source: "GitHub Releases", configurationMessage: null, canDownload: true, canInstall: false };

function setup(options: { automatic?: boolean; offline?: boolean; web?: boolean; notifications?: boolean; quiet?: boolean } = {}) {
  const platform = getPlatform();
  const settings = (sourceId?: string) => {
    const value = defaultEffectiveSettings(sourceId);
    value.app.legacyStorageMigrationVersion = 3;
    value.app.updates.automaticChecks = options.automatic ?? value.app.updates.automaticChecks;
    value.app.privacy.offlineMode = options.offline ?? false;
    value.app.notifications.updateAvailable = options.notifications ?? true;
    value.app.notifications.quietHoursEnabled = options.quiet ?? false;
    value.app.notifications.quietHoursStart = "00:00";
    value.app.notifications.quietHoursEnd = "23:59";
    if (value.source) { value.source.legacyStorageMigrationVersion = 3; value.source.refresh.intervalSeconds = 0; }
    return value;
  };
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: options.web ? "web" : "desktop", label: "Update test runtime", version: "0.2.0" });
  vi.spyOn(platform, "listDataSources").mockResolvedValue([]);
  const getSettings = vi.spyOn(platform, "getSettings").mockImplementation((id) => Promise.resolve(settings(id)));
  vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics);
  vi.spyOn(platform, "listSnapshots").mockResolvedValue([]);
  const check = vi.spyOn(platform, "checkForUpdates").mockResolvedValue(available);
  vi.spyOn(platform, "getUpdateStatus").mockResolvedValue(available);
  const download = vi.spyOn(platform, "downloadUpdate").mockResolvedValue();
  const install = vi.spyOn(platform, "installUpdate").mockResolvedValue();
  const mount = () => render(<StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider></StrictMode>);
  return { check, download, install, getSettings, settings, mount };
}

beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });
afterEach(() => vi.restoreAllMocks());

describe("startup update notifications", () => {
  it("checks by default, shows a banner, and opens the update page without downloading or installing", async () => {
    const { check, download, install, mount } = setup();
    mount();
    const banner = await screen.findByRole("status", { name: "Application update" });
    expect(banner).toHaveTextContent("Nodal Studio 0.2.1 is available");
    expect(check).toHaveBeenCalledOnce();
    fireEvent.click(within(banner).getByRole("button", { name: "View update" }));
    await vi.dynamicImportSettled();
    expect(await screen.findByRole("heading", { name: "An update is available" })).toBeVisible();
    expect(window.location.hash).toBe("#/settings/updates");
    expect(screen.getByRole("button", { name: "Download update" })).toBeEnabled();
    expect(download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("lets Later dismiss the banner while keeping an actionable notification", async () => {
    const { check, download, install, mount } = setup();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status", { name: "Application update" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open notifications" }));
    const notifications = screen.getByRole("region", { name: "Notifications" });
    expect(notifications).toHaveTextContent("Application update available");
    fireEvent.click(within(notifications).getByRole("button", { name: "View update" }));
    await vi.dynamicImportSettled();
    expect(await screen.findByRole("heading", { name: "An update is available" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument();
    expect(check).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("retains a late startup update result while restoring the workspace", async () => {
    const { check, mount } = setup();
    let finish!: (value: UpdateStatus) => void;
    check.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Restore model" }));
    expect(await screen.findByText("Restored model")).toBeVisible();
    await act(() => { finish(available); return Promise.resolve(); });
    expect(await screen.findByRole("status", { name: "Application update" })).toBeVisible();
    expect(check).toHaveBeenCalledOnce();
  });

  it.each([{ automatic: false }, { offline: true }, { web: true }])("does not automatically check under restrictions %j", async (options) => {
    const { check, mount } = setup(options);
    mount();
    await act(async () => {});
    expect(check).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: "Application update" })).not.toBeInTheDocument();
  });

  it.each([{ notifications: false }, { quiet: true }])("honors notification preferences %j", async (options) => {
    const { check, mount } = setup(options);
    mount();
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole("status", { name: "Application update" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open notifications" }));
    expect(screen.queryByText("Application update available")).not.toBeInTheDocument();
  });

  it("does not use enabled defaults to send a request when stored settings fail to load", async () => {
    const { check, getSettings, mount } = setup();
    getSettings.mockRejectedValue(new Error("Fixture storage unavailable"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open notifications" }));
    expect(await screen.findByText("Stored settings could not be loaded")).toBeVisible();
    expect(check).not.toHaveBeenCalled();
  });

  it.each(["upToDate", "error"] as const)("does not advertise an update for %s", async (phase) => {
    const { check, mount } = setup();
    if (phase === "error") check.mockRejectedValue(new Error("Fixture network unavailable"));
    else check.mockResolvedValue({ ...available, availableVersion: null });
    mount();
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole("status", { name: "Application update" })).not.toBeInTheDocument();
  });
});
