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
    expect(screen.getByRole("group", { name: "Workspace navigation" })).toHaveTextContent("Open Query");
    fireEvent.change(screen.getByRole("textbox", { name: "Refresh Schema" }), { target: { value: "Mod+4" } });
    expect(screen.getByText(/already assigned to Open Query/)).toBeVisible();
    expect(onUpdateApp).not.toHaveBeenCalled();
  });

  it("shows a saved custom refresh interval and commits only valid numeric edits", async () => {
    const settings = defaultEffectiveSettings("source");
    if (!settings.source) throw new Error("Expected a source fixture");
    settings.source.refresh.intervalSeconds = 75;
    const onUpdateSource = vi.fn<(value: DataSourceSettings) => Promise<void>>().mockResolvedValue(undefined);
    render(<SettingsPage {...baseProps} settings={settings} initialCategory="data-sources" onUpdateSource={onUpdateSource} />);
    expect(screen.getByRole("option", { name: "Custom interval", selected: true })).toBeVisible();
    const field = screen.getByRole("spinbutton", { name: "Custom refresh interval" });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(field).toHaveValue(75);
    expect(onUpdateSource).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "120" } });
    expect(onUpdateSource).not.toHaveBeenCalled();
    fireEvent.blur(field);
    await waitFor(() => expect(onUpdateSource).toHaveBeenCalledOnce());
    expect(onUpdateSource.mock.calls[0][0].refresh.intervalSeconds).toBe(120);
  });
});

describe("Mac App Store submission boundaries", () => {
  const runtime = { ...baseProps.runtime, distribution: "macAppStore" } as const;
  it("shows personal folder sync and keeps team projects limited to community builds", () => {
    const props = { ...baseProps, settings: defaultEffectiveSettings("source"), initialCategory: "cloud" as const };
    const { rerender } = render(<SettingsPage {...props} runtime={runtime} />);
    expect(screen.getByRole("button", { name: "Cloud Sync" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Personal Connection Sync" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Team Projects" })).not.toBeInTheDocument();
    expect(screen.queryByText("Create cloud account and team")).not.toBeInTheDocument();
    rerender(<SettingsPage {...props} />);
    expect(screen.getByRole("heading", { name: "Team Projects" })).toBeVisible();
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

describe("personal connection sync", () => {
  const folder = "/sync/fixtures";
  const library = "1f470925-a398-43aa-87c8-b8cb03bfdd40";
  const passphrase = "a disposable test passphrase";
  const status = {
    folder, library, provider: "googleDrive", paused: false, queued: 0, pending: 0,
    lastWrite: null, lastCheck: null, pendingId: null, problem: null,
  } as const;

  it.each([0, 2])("previews a fresh library with %i local connections before enabling it", async (outgoing) => {
    const pickWorkspacePath = vi.fn().mockResolvedValue(folder);
    const inspectConnectionFolder = vi.fn().mockResolvedValue({ libraries: [] });
    const previewConnectionFolderSetup = vi.fn().mockResolvedValue({ token: "ready", rows: [], outgoing, createsLibrary: true });
    const enableConnectionFolder = vi.fn().mockResolvedValue(status);
    const onDataSourcesChanged = vi.fn().mockResolvedValue(undefined);
    const platform = { pickWorkspacePath, inspectConnectionFolder, previewConnectionFolderSetup, enableConnectionFolder } as unknown as NodalStudioPlatform;
    render(<SettingsPage {...baseProps} settings={defaultEffectiveSettings()} initialCategory="cloud"
      activeSourceId={undefined} platform={platform} onDataSourcesChanged={onDataSourcesChanged} />);

    fireEvent.change(screen.getByRole("combobox", { name: "File provider" }), { target: { value: "googleDrive" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose Sync Folder…" }));
    await screen.findByText("Create an encrypted library in this folder. Existing connections on this device are included.");
    expect(pickWorkspacePath).toHaveBeenCalledTimes(1);
    expect(inspectConnectionFolder).toHaveBeenCalledWith(folder);
    const previewButton = screen.getByRole("button", { name: "Preview Setup" });
    fireEvent.change(screen.getByLabelText("File passphrase"), { target: { value: passphrase } });
    expect(previewButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm file passphrase"), { target: { value: passphrase } });
    fireEvent.click(previewButton);
    await screen.findByText("Updates to review 0 · Connections to write " + outgoing);
    expect(enableConnectionFolder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable Sync" }));
    await screen.findByText("Personal connection sync is enabled.");
    expect(enableConnectionFolder).toHaveBeenCalledWith({ folder, library: null, provider: "googleDrive", passphrase }, "ready");
    expect(onDataSourcesChanged).toHaveBeenCalledOnce();
    expect(pickWorkspacePath).toHaveBeenCalledTimes(1);
  });

  const connection = {
    host: "device-a.example", displayName: "Warehouse", databaseType: "postgreSql", database: "dw",
    port: 5432, username: "reader", sslMode: "verifyFull", ssh: null,
  };
  const review = {
    token: "reviewed", outgoing: 0, createsLibrary: false,
    rows: [{ action: "conflict", connection, existing: { ...connection, host: "device-b.example" } }],
  };

  it("rechecks the same folder when another device creates its library during setup", async () => {
    const pickWorkspacePath = vi.fn().mockResolvedValue(folder);
    const inspectConnectionFolder = vi.fn().mockResolvedValueOnce({ libraries: [] })
      .mockResolvedValueOnce({ libraries: [library] });
    const previewConnectionFolderSetup = vi.fn().mockRejectedValueOnce("chooseLibrary").mockResolvedValueOnce(review);
    const platform = { pickWorkspacePath, inspectConnectionFolder, previewConnectionFolderSetup } as unknown as NodalStudioPlatform;
    render(<SettingsPage {...baseProps} platform={platform} settings={defaultEffectiveSettings()} initialCategory="cloud" />);

    fireEvent.click(screen.getByRole("button", { name: "Choose Sync Folder…" }));
    fireEvent.change(await screen.findByLabelText("File passphrase"), { target: { value: passphrase } });
    fireEvent.change(screen.getByLabelText("Confirm file passphrase"), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check Folder Again" }));
    const field = await screen.findByLabelText("File passphrase");
    expect(field).toHaveValue("");
    expect(screen.queryByLabelText("Confirm file passphrase")).not.toBeInTheDocument();
    expect(pickWorkspacePath).toHaveBeenCalledTimes(1);
    expect(inspectConnectionFolder.mock.calls).toEqual([[folder], [folder]]);
    fireEvent.change(field, { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Setup" }));
    expect(await screen.findByText("Keep both versions")).toBeVisible();
    expect(previewConnectionFolderSetup).toHaveBeenLastCalledWith({ folder, library, provider: "iCloud", passphrase });
  });

  it("unlocks an existing library and keeps both versions in the setup preview", async () => {
    const enableConnectionFolder = vi.fn().mockResolvedValue(status);
    const platform = {
      pickWorkspacePath: vi.fn().mockResolvedValue(folder),
      inspectConnectionFolder: vi.fn().mockResolvedValue({ libraries: [library] }),
      previewConnectionFolderSetup: vi.fn().mockResolvedValue(review),
      enableConnectionFolder,
    } as unknown as NodalStudioPlatform;
    render(<SettingsPage {...baseProps} platform={platform} settings={defaultEffectiveSettings()} initialCategory="cloud" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Sync Folder…" }));
    await screen.findByText("This folder has an encrypted connection library. Enter its passphrase to preview the merge.");
    expect(screen.queryByLabelText("Confirm file passphrase")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("File passphrase"), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Setup" }));
    await screen.findByText("Keep both versions");
    expect(screen.getByText("reader@device-a.example:5432")).toBeVisible();
    expect(screen.getByText("reader@device-b.example:5432")).toBeVisible();
    expect(enableConnectionFolder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable Sync" }));
    await waitFor(() => expect(enableConnectionFolder).toHaveBeenCalledWith({ folder, library, provider: "iCloud", passphrase }, "reviewed"));
  });

  it("requires confirmation for incoming updates after setup", async () => {
    const previewConnectionFolderUpdates = vi.fn().mockResolvedValue(review);
    const applyConnectionFolderUpdates = vi.fn().mockResolvedValue(status);
    const onDataSourcesChanged = vi.fn().mockResolvedValue(undefined);
    const platform = { previewConnectionFolderUpdates, applyConnectionFolderUpdates } as unknown as NodalStudioPlatform;
    render(<SettingsPage {...baseProps} platform={platform} settings={defaultEffectiveSettings()} initialCategory="cloud"
      connectionFolderStatus={{ ...status, pending: 1, pendingId: "pending" }} onDataSourcesChanged={onDataSourcesChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Updates" }));
    await screen.findByText("Keep both versions");
    expect(applyConnectionFolderUpdates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge" }));
    await screen.findByText("Reviewed connection updates were merged.");
    expect(applyConnectionFolderUpdates).toHaveBeenCalledWith("reviewed");
    expect(onDataSourcesChanged).toHaveBeenCalledOnce();
  });
});
