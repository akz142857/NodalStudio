import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEffectiveSettings, type AppSettings, type DataSourceSettings, type NodalStudioPlatform } from "../platform";
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
  it("shows an empty state instead of stale preferences when search has no results", () => {
    render(<SettingsPage {...baseProps} settings={defaultEffectiveSettings()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "no-such-preference" } });
    expect(screen.getByRole("heading", { name: "No settings found" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Theme" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeVisible();
  });

  it("supports keyboard navigation and resets content scroll when changing categories", () => {
    render(<SettingsPage {...baseProps} settings={defaultEffectiveSettings("source")} />);
    const general = screen.getByRole("button", { name: "General" });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowDown" });
    const appearance = screen.getByRole("button", { name: "Appearance" });
    expect(appearance).toHaveFocus();
    const content = screen.getByRole("main");
    content.scrollTop = 200;
    fireEvent.click(appearance);
    expect(appearance).toHaveAttribute("aria-current", "page");
    expect(general).not.toHaveAttribute("aria-current");
    expect(content.scrollTop).toBe(0);
    fireEvent.keyDown(appearance, { key: "End" });
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveFocus();
  });

  it("keeps AI drafts local until explicitly saved", async () => {
    const onUpdateSource = vi.fn<(settings: DataSourceSettings) => Promise<void>>(() => Promise.resolve());
    render(<SettingsPage {...baseProps} settings={defaultEffectiveSettings("source")} initialCategory="ai" onUpdateSource={onUpdateSource} />);
    // Let the existing source synchronization effect settle before editing.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openAiCompatible" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "review-model" } });
    expect(onUpdateSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save AI configuration" }));
    await waitFor(() => expect(onUpdateSource).toHaveBeenCalledOnce());
    expect(onUpdateSource.mock.calls[0][0].ai.model).toBe("review-model");
    expect(onUpdateSource.mock.calls[0][0].ai.enabled).toBe(false);
  });

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
    expect(screen.getByText(/Desktop MySQL: one read-only SELECT or WITH query/)).toBeVisible();
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
    expect(screen.getByRole("checkbox", { name: /Inferred relationships/ })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Inferred relationships/ }));

    await waitFor(() => expect(onUpdateApp).toHaveBeenCalledOnce());
    const saved = onUpdateApp.mock.calls.at(0)?.at(0);
    expect(saved?.canvas.showInferredRelationships).toBe(false);
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

    expect(screen.getByRole("checkbox", { name: /Restrict app external requests/ })).toBeDisabled();
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

describe("Mac App Store submission boundaries", () => {
  const runtime = { ...baseProps.runtime, distribution: "macAppStore" } as const;
  it("removes cloud navigation and deep links while retaining community cloud", () => {
    const props = { ...baseProps, settings: defaultEffectiveSettings("source"), initialCategory: "cloud" as const };
    const { rerender } = render(<SettingsPage {...props} runtime={runtime} />);
    expect(screen.queryByRole("button", { name: "Cloud Sync" })).not.toBeInTheDocument();
    expect(screen.queryByText("Create cloud account and team")).not.toBeInTheDocument();
    rerender(<SettingsPage {...props} />);
    expect(screen.getByRole("button", { name: "Cloud Sync" })).toBeVisible();
  });
  it("offers a readable offline policy and accurate App Store update status", () => {
    render(<SettingsPage {...baseProps} runtime={runtime} settings={defaultEffectiveSettings()} initialCategory="privacy" />);
    fireEvent.click(screen.getByRole("button", { name: "Privacy policy" }));
    expect(screen.getByRole("region", { name: "Privacy policy" })).toHaveTextContent("Retention and deletion");
    expect(screen.getByText("App Store", { exact: true })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /Anonymous diagnostics/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Crash reports/ })).not.toBeInTheDocument();
  });
  it("uses the native backup picker, preserves the previous path on cancel, and displays failures", async () => {
    const picker = vi.fn().mockResolvedValueOnce("/chosen/model.nodalmodel").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Permission unavailable"));
    render(<SettingsPage {...baseProps} runtime={runtime} settings={defaultEffectiveSettings("source")} initialCategory="history" platform={{ pickWorkspacePath: picker } as unknown as NodalStudioPlatform} />);
    const path = screen.getByPlaceholderText("/absolute/path/model.nodalmodel");
    expect(path).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Choose export location…" }));
    await waitFor(() => expect(path).toHaveValue("/chosen/model.nodalmodel"));
    expect(picker).toHaveBeenCalledWith("saveBackup");
    fireEvent.click(screen.getByRole("button", { name: "Choose import file…" }));
    await waitFor(() => expect(picker).toHaveBeenCalledTimes(2));
    expect(path).toHaveValue("/chosen/model.nodalmodel");
    fireEvent.click(screen.getByRole("button", { name: "Choose import file…" }));
    await waitFor(() => expect(screen.getByText("Permission unavailable")).toBeVisible());
  });
});

it("checks MAS model files without offering an external merge driver installer", async () => {
  const settings=defaultEffectiveSettings("source");
  settings.source!.git.repositoryPath="/chosen/repository";
  const checkMergeDriver=vi.fn().mockResolvedValue({repositoryIsGit:true,manifestPresent:true,driverVersion:null,expectedVersion:"0.2.4",driverConfigured:false,attributesConfigured:true,installCommand:"",conflictReports:[],fingerprintMatches:true});
  render(<SettingsPage {...baseProps} settings={settings} runtime={{...baseProps.runtime,distribution:"macAppStore"}} initialCategory="git" platform={{checkMergeDriver} as unknown as NodalStudioPlatform} />);
  fireEvent.click(screen.getByRole("button",{name:"Check repository"}));
  await waitFor(()=>expect(screen.getByText(/This edition exchanges model files/)).toBeVisible());
  expect(screen.queryByRole("button",{name:"Copy install command"})).not.toBeInTheDocument();
  expect(screen.queryByText("Not installed")).not.toBeInTheDocument();
});
