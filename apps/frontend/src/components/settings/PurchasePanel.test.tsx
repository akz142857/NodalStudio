import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PurchasePanel } from "./PurchasePanel";
import { UpdatePanel } from "./UpdatePanel";
import { defaultAppSettings, type NodalStudioPlatform } from "../../platform";
import type { PurchaseStatus } from "../../platform/purchase-types";

const missing: PurchaseStatus = { distribution: "macAppStore", state: "needsRecovery", reason: null, environment: null, checkedAt: null, canUsePaidFeatures: false, busy: false };
const verified: PurchaseStatus = { ...missing, state: "verified", environment: "Production", canUsePaidFeatures: true };
function fixture(initial = missing) {
  const api = { openAppStore: vi.fn().mockResolvedValue(undefined), getPurchaseStatus: vi.fn().mockResolvedValue(initial), restoreAppPurchase: vi.fn().mockResolvedValue(verified), getUpdateStatus: vi.fn(), checkForUpdates: vi.fn() };
  return { api, platform: api as unknown as NodalStudioPlatform };
}
describe("Mac App Store purchase panel", () => {
  it("never restores automatically or reads GitHub status in MAS", async () => {
    const { api, platform } = fixture();
    render(<UpdatePanel platform={platform} runtime={{ kind: "desktop", distribution: "macAppStore", label: "Desktop", version: "1.0.0" }} app={defaultAppSettings()} onSave={vi.fn()} />);
    expect(await screen.findByText("Purchase verification needed")).toBeInTheDocument();
    expect(screen.getByText(/Mac App Store · 1\.0\.0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open App Store" }));
    expect(api.openAppStore).toHaveBeenCalledOnce();
    expect(api.restoreAppPurchase).not.toHaveBeenCalled(); expect(api.getUpdateStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
    expect(screen.queryByText("Advanced update settings")).not.toBeInTheDocument();
    expect(screen.getByText(/Updates are managed by the Mac App Store/)).toBeInTheDocument();
  });
  it("waits for the channel before mounting updater controls", () => {
    const { api, platform } = fixture();
    render(<UpdatePanel platform={platform} app={defaultAppSettings()} onSave={vi.fn()} />);
    expect(api.getUpdateStatus).not.toHaveBeenCalled();
  });
  it("restores on explicit click and shows verified offline use", async () => {
    const { api, platform } = fixture();
    render(<PurchasePanel platform={platform} version="1.0.0" />);
    await screen.findByText("Purchase verification needed");
    fireEvent.click(screen.getByRole("button", { name: "Reverify App Store purchase" }));
    expect(await screen.findByText("Pro · Purchase verified")).toBeInTheDocument();
    expect(api.restoreAppPurchase).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/No periodic activation/)).toBeInTheDocument();
  });
  it("does not let an old status poll undo a completed recovery", async () => {
    const { api, platform } = fixture();
    let finish!: (value: PurchaseStatus) => void;
    api.getPurchaseStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<PurchasePanel platform={platform} version="1.0.0" />);
    fireEvent.click(screen.getByRole("button", { name: "Reverify App Store purchase" }));
    await screen.findByText("Pro · Purchase verified");
    await act(async () => { finish(missing); await Promise.resolve(); });
    expect(screen.getByText("Pro · Purchase verified")).toBeInTheDocument();
  });
  it("keeps cancellation actionable and does not retry or grant access", async () => {
    const { api, platform } = fixture();
    api.restoreAppPurchase.mockResolvedValue({ ...missing, reason: "cancelled" });
    render(<PurchasePanel platform={platform} version="1.0.0" />);
    await screen.findByText("Purchase verification needed");
    fireEvent.click(screen.getByRole("button", { name: "Reverify App Store purchase" }));
    expect(await screen.findByText(/Verification was cancelled/)).toBeInTheDocument();
    expect(screen.queryByText("Pro · Purchase verified")).not.toBeInTheDocument();
    expect(api.restoreAppPurchase).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reverify App Store purchase" })).toBeEnabled();
  });
  it("deduplicates restore clicks and survives unmount during recovery", async () => {
    const { api, platform } = fixture();
    let finish!: (value: PurchaseStatus) => void;
    api.restoreAppPurchase.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<PurchasePanel platform={platform} version="1.0.0" />);
    await screen.findByText("Purchase verification needed");
    const button = screen.getByRole("button", { name: "Reverify App Store purchase" });
    fireEvent.click(button); fireEvent.click(button);
    expect(api.restoreAppPurchase).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled(); view.unmount();
    await act(async () => { finish(verified); await Promise.resolve(); });
  });
  it("labels Apple sandbox proof as testing only", async () => {
    const { platform } = fixture({ ...verified, environment: "Sandbox" });
    render(<PurchasePanel platform={platform} version="1.0.0" />);
    expect(await screen.findByText("Apple sandbox purchase · Testing only")).toBeInTheDocument();
  });
  it("handles unavailable IPC without exposing raw native details", async () => {
    const { api, platform } = fixture(); api.getPurchaseStatus.mockRejectedValue(new Error("private details"));
    render(<PurchasePanel platform={platform} version="1.0.0" />);
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument());
    expect(screen.queryByText("private details")).not.toBeInTheDocument();
  });
});
