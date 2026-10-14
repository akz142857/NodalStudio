import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEffectiveSettings, type AppSettings, type NodalStudioPlatform } from "../platform";
import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

const baseProps = {
  platform: {} as NodalStudioPlatform,
  runtime: { kind: "desktop", label: "Tauri desktop runtime", version: "0.1.0" } as const,
  dataSources: [],
  activeSourceId: "source",
  onClose: vi.fn(),
  onUpdateApp: vi.fn(() => Promise.resolve()),
  onUpdateSource: vi.fn(() => Promise.resolve()),
  onResetApp: vi.fn(() => Promise.resolve()),
  onResetSource: vi.fn(() => Promise.resolve()),
  onReload: vi.fn(() => Promise.resolve()),
  onDataSourcesChanged: vi.fn(() => Promise.resolve()),
  onFactoryReset: vi.fn(() => Promise.resolve()),
};

describe("SettingsPage", () => {
  it("finds the capability matrix in Settings search and renders scope without platform requests", () => {
    render(<SettingsPage {...baseProps} settings={defaultEffectiveSettings()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "capabilities" } });
    fireEvent.click(screen.getByRole("button", { name: "Capabilities" }));
    expect(screen.getByRole("region", { name: "Product capabilities" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible(); expect(screen.getByText(/No loaded database/)).toBeVisible();
  });
  it("supports the capabilities category deep link with a loaded MySQL context", () => {
    render(<SettingsPage {...baseProps} settings={defaultEffectiveSettings()} initialCategory="capabilities" activeDatabase={{ name: "fixture", databaseType: "mySql", version: "8.4" }} />);
    expect(screen.getByRole("columnheader", { name: "Desktop · MySQL Current" })).toHaveAttribute("data-current", "true");
    expect(screen.getByText(/MySQL metadata capture is supported/)).toBeVisible();
  });
  it("searches settings and saves a Canvas preference", async () => {
    const onUpdateApp = vi.fn<(settings: AppSettings) => Promise<void>>(() => Promise.resolve());
    render(
      <SettingsPage
        {...baseProps}
        settings={defaultEffectiveSettings("source")}
        onUpdateApp={onUpdateApp}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
      target: { value: "foreign key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Canvas & ER" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Inferred relationships/ }));

    await waitFor(() => expect(onUpdateApp).toHaveBeenCalledOnce());
    const saved = onUpdateApp.mock.calls.at(0)?.at(0);
    expect(saved?.canvas.showInferredRelationships).toBe(true);
  });

  it("renders organization-managed settings as locked with their source", () => {
    const settings = defaultEffectiveSettings("source");
    settings.managed = [
      {
        path: "privacy.offlineMode",
        source: "Security team",
        reason: "Required for this environment",
      },
    ];
    render(
      <SettingsPage
        {...baseProps}
        settings={settings}
        initialCategory="privacy"
      />,
    );

    expect(screen.getByRole("checkbox", { name: /Completely offline/ })).toBeDisabled();
    expect(screen.getByText("Managed · Security team")).toBeVisible();
  });

  it("rejects conflicting custom shortcuts before saving", () => {
    const onUpdateApp = vi.fn<(settings: AppSettings) => Promise<void>>(() => Promise.resolve());
    render(
      <SettingsPage
        {...baseProps}
        settings={defaultEffectiveSettings("source")}
        initialCategory="shortcuts"
        onUpdateApp={onUpdateApp}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Refresh Schema" }), {
      target: { value: "Mod+," },
    });

    expect(screen.getByText(/already assigned to Open Settings/)).toBeVisible();
    expect(onUpdateApp).not.toHaveBeenCalled();
  });
});
