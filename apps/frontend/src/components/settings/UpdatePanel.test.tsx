import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePanel } from "./UpdatePanel";
import { defaultAppSettings, type NodalStudioPlatform, type UpdateStatus } from "../../platform";
import { useUpdateBlocker } from "../../platform/update-guard";
let status: UpdateStatus;
const platform = { getUpdateStatus: vi.fn(() => Promise.resolve({ ...status })), openUpdateReleases: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), cancelUpdateDownload: vi.fn(), installUpdate: vi.fn() };
function renderPanel(options: { offline?: boolean; web?: boolean; managed?: boolean } = {}) {
  const app = defaultAppSettings(); app.privacy.offlineMode = Boolean(options.offline);
  return render(<div className="ds-surface"><UpdatePanel platform={platform as unknown as NodalStudioPlatform} runtime={{ kind: options.web ? "web" : "desktop", version: "0.1.0", label: "Test" }} app={app} managed={options.managed ? { source: "Organization", reason: "Updates are blocked" } : undefined} onSave={vi.fn()} /></div>);
}
beforeEach(() => {
  vi.clearAllMocks();
  status = { phase: "idle", currentVersion: "0.1.0", availableVersion: null, notes: null, downloadUrl: null, downloadedBytes: 0, totalBytes: null, checkedAt: null, error: null, configured: true, canCheck: true, manualOnly: false, source: "GitHub Releases", configurationMessage: null, canDownload: false, canInstall: false };
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
describe("software update flow", () => {
  it("offers manual GitHub installation without enabling unsigned downloads", async () => {
    status = { ...status, phase: "available", availableVersion: "0.2.0", configured: false, manualOnly: true, configurationMessage: "Install releases manually." };
    renderPanel();
    expect(await screen.findByText("Installed version 0.1.0 · Available 0.2.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Download update" })).not.toBeInTheDocument();
    expect(screen.queryByText("Signature verified")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get update on GitHub" }));
    await waitFor(() => expect(platform.openUpdateReleases).toHaveBeenCalledOnce());
    expect(platform.downloadUpdate).not.toHaveBeenCalled();
    expect(platform.installUpdate).not.toHaveBeenCalled();
  });
  it("disables a broken custom feed and explains how to recover", async () => {
    status = { ...status, configured: false, canCheck: false, source: null, configurationMessage: "Clear the custom feed to check GitHub Releases." };
    renderPanel();
    expect(await screen.findByText("Clear the custom feed to check GitHub Releases.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  });
  it.each([{ offline: true }, { managed: true }])("blocks manual release navigation under restrictions %j", async (options) => {
    status = { ...status, configured: false, manualOnly: true };
    renderPanel(options);
    expect(await screen.findByRole("button", { name: "View GitHub releases" })).toBeDisabled();
  });
  it("ignores a delayed poll that predates a completed update check", async () => {
    const previous = { ...status };
    let finishPoll!: (value: UpdateStatus) => void;
    platform.getUpdateStatus.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
    platform.checkForUpdates.mockImplementation(() => { status = { ...status, phase: "available", availableVersion: "0.1.1", canDownload: true }; return Promise.resolve(status); });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("button", { name: "Download update" })).toBeEnabled();
    await act(() => { finishPoll(previous); return Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Download update" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "An update is available" })).toBeVisible();
  });
  it("ignores errors from a poll belonging to an earlier effect lifecycle", async () => {
    let failOldPoll!: (error: Error) => void;
    platform.getUpdateStatus.mockImplementationOnce(() => new Promise((_, reject) => { failOldPoll = reject; }));
    status = { ...status, phase: "ready", availableVersion: "0.1.1", canInstall: true };
    render(<StrictMode><UpdatePanel platform={platform as unknown as NodalStudioPlatform} runtime={{ kind: "desktop", version: "0.1.0", label: "Test" }} app={defaultAppSettings()} onSave={vi.fn()} /></StrictMode>);
    expect(await screen.findByRole("button", { name: "Install and Restart…" })).toBeEnabled();
    await act(() => { failOldPoll(new Error("Obsolete poll failed")); return Promise.resolve(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("checks, downloads, confirms explicitly and retries an installation failure", async () => {
    platform.checkForUpdates.mockImplementation(() => { status = { ...status, phase: "available", availableVersion: "0.1.1", notes: "Model relationship improvements", canDownload: true }; return Promise.resolve(status); });
    platform.downloadUpdate.mockImplementation(() => { status = { ...status, phase: "ready", canDownload: false, canInstall: true }; return Promise.resolve(); });
    platform.installUpdate.mockRejectedValue(new Error("Wait for active queries"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install and Restart…" }));
    expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus();
    expect(platform.installUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install and Restart…" }));
    fireEvent.click(screen.getByRole("button", { name: "Install and Restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait for active queries");
    expect(screen.getByRole("button", { name: "Install and Restart" })).toBeEnabled();
  });
  it("does not offer installation after signature rejection and allows a retry", async () => {
    status = { ...status, phase: "available", availableVersion: "0.1.1", canDownload: true };
    platform.downloadUpdate.mockRejectedValue(new Error("Signature could not be verified"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Signature");
    expect(screen.queryByRole("button", { name: "Install and Restart…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download update" })).toBeEnabled();
  });
  it("shows real progress and cancels without enabling install", async () => {
    status = { ...status, phase: "downloading", downloadedBytes: 5242880, totalBytes: 10485760 };
    platform.cancelUpdateDownload.mockResolvedValue(undefined);
    renderPanel();
    expect(await screen.findByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "50");
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(platform.cancelUpdateDownload).toHaveBeenCalledOnce();
  });
  it.each([{ offline: true }, { web: true }, { managed: true }])("honors runtime and policy restrictions %j", async (options) => {
    renderPanel(options);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(platform.checkForUpdates).not.toHaveBeenCalled();
  });
  it("blocks restart until unsaved work is handled", async () => {
    function Draft() { useUpdateBlocker("save table knowledge", true); return null; }
    status = { ...status, phase: "ready", availableVersion: "0.1.1", canInstall: true };
    const draft = render(<Draft />); renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Install and Restart…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("save table knowledge");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    draft.unmount();
    fireEvent.click(screen.getByRole("button", { name: "Install and Restart…" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
  });
  it("allows a verified package to install offline even when automatic checks are managed", async () => {
    status = { ...status, phase: "ready", availableVersion: "0.1.1", canInstall: true };
    renderPanel({ offline: true, managed: true });
    expect(await screen.findByRole("button", { name: "Install and Restart…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Install and Restart…" }));
    expect(screen.getByRole("dialog")).toBeVisible();
  });
  it("blocks installation when native configuration or policy no longer permits updates", async () => {
    status = { ...status, phase: "ready", availableVersion: "0.1.1", canInstall: true, configured: false };
    renderPanel({ managed: true });
    expect(await screen.findByRole("button", { name: "Install and Restart…" })).toBeDisabled();
  });
});
