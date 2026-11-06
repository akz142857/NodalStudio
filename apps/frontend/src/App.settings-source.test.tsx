import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import {
  defaultEffectiveSettings,
  defaultProjectSettings,
  getPlatform,
  type AppSettings,
  type CaptureSnapshotResult,
  type EffectiveSettings,
  type SnapshotSummary,
} from "./platform";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";

const snapshotA = { ...reportSnapshot, id: "snapshot-a", sourceId: "source-a" };
const snapshotB = { ...reportSnapshot, id: "snapshot-b", sourceId: "source-b" };

vi.mock("./components/ConnectionPanel", () => ({
  ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
    <button onClick={() => onSnapshot({ snapshot: snapshotA, stored: true, changeSet: null })}>Load source A</button>
    <button onClick={() => onSnapshot({ snapshot: snapshotB, stored: true, changeSet: null })}>Load source B</button>
  </>,
}));
vi.mock("./components/SchemaCanvas", () => ({
  SchemaCanvas: (props: SchemaCanvasProps) => <button onClick={() => props.onSelectTable(props.snapshot.schemas[0].tables[1])}>Select current table</button>,
}));

function effectiveSettings(sourceId?: string): EffectiveSettings {
  const settings = defaultEffectiveSettings(sourceId);
  // Keep this fixture focused on workspace saves, without a sidebar preference save.
  settings.app.appearance.rightSidebarExpanded = true;
  settings.app.legacyStorageMigrationVersion = 3;
  settings.app.general.theme = sourceId === "source-a" ? "dark" : "light";
  if (settings.source) {
    settings.source.legacyStorageMigrationVersion = 3;
    settings.source.refresh.intervalSeconds = 0;
    settings.source.ai = { ...settings.source.ai, enabled: true, provider: "openAiCompatible", model: `${sourceId}-model` };
    settings.source.cloud.projectId = `${sourceId}-project`;
    settings.project = { ...defaultProjectSettings(settings.source.cloud.projectId), allowSharedLayouts: false };
    settings.managed = [{ path: "ai.enabled", source: "Test policy", reason: "Managed for this fixture" }];
  }
  return settings;
}

type PendingSave = {
  app: AppSettings;
  resolve: (value: EffectiveSettings) => void;
  reject: (reason: Error) => void;
};

function mount() {
  const platform = getPlatform();
  const pending: PendingSave[] = [];
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Settings test runtime", version: "test" });
  vi.spyOn(platform, "getSettings").mockImplementation((sourceId) => Promise.resolve(effectiveSettings(sourceId)));
  vi.spyOn(platform, "listDataSources").mockResolvedValue([]);
  vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics);
  vi.spyOn(platform, "listSnapshots").mockImplementation((sourceId) => Promise.resolve([{ id: sourceId === "source-b" ? snapshotB.id : snapshotA.id } as SnapshotSummary]));
  vi.spyOn(platform, "updateAppSettings").mockImplementation((app) => new Promise<EffectiveSettings>((resolve, reject) => pending.push({ app, resolve, reject })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  return pending;
}

async function loadSource(name: "A" | "B", settingsReady = true) {
  fireEvent.click(screen.getByRole("button", { name: `Load source ${name}` }));
  fireEvent.click(await screen.findByRole("button", { name: "Select current table" }));
  const expand = screen.queryByRole("button", { name: "Expand right inspector" });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole("button", { name: "AI" }));
  if (settingsReady) await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toBeEnabled());
}

async function finishSave(save: PendingSave) {
  // The desktop update_app_settings command returns only the application layer.
  await act(async () => {
    save.resolve({ app: save.app, source: null, project: null, managed: [] });
    await Promise.resolve();
  });
}

async function sourceSave(pending: PendingSave[], source: "a" | "b") {
  const theme = source === "a" ? "dark" : "light";
  // Loading source settings may finish after the workspace debounce on a slow
  // runner. Wait for the save containing the loaded settings, not a call count.
  await waitFor(() => expect(pending.some(({ app }) =>
    app.general.lastSourceId === `source-${source}` && app.general.theme === theme,
  )).toBe(true));
  return [...pending].reverse().find(({ app }) =>
    app.general.lastSourceId === `source-${source}` && app.general.theme === theme,
  )!;
}

async function openAiSettings() {
  fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
  const settings = within(await screen.findByRole("region", { name: "Settings" }));
  fireEvent.click(settings.getByRole("button", { name: "AI" }));
  return settings;
}

describe("source settings during recent workspace persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps source AI configuration and project/managed policy after an app-only save", async () => {
    const pending = mount();
    await screen.findByText("Settings test runtime");
    await loadSource("A");
    await finishSave(await sourceSave(pending, "a"));

    expect(screen.getByRole("textbox", { name: "Question" })).toBeEnabled();
    const settings = await openAiSettings();
    expect(settings.getByLabelText("Model")).toHaveValue("source-a-model");
    expect(settings.getByRole("checkbox", { name: /Enable AI explanations/ })).toBeChecked();
    expect(settings.getByRole("checkbox", { name: /Enable AI explanations/ })).toBeDisabled();
    fireEvent.click(settings.getByRole("button", { name: "Cloud Sync" }));
    expect(settings.getByRole("checkbox", { name: "Allow shared layouts" })).not.toBeChecked();
  });

  it("ignores a previous source's save response after the new source is loaded", async () => {
    const pending = mount();
    await screen.findByText("Settings test runtime");
    await loadSource("A");
    await sourceSave(pending, "a");
    let resolveSourceB!: (settings: EffectiveSettings) => void;
    const sourceBSettings = new Promise<EffectiveSettings>((resolve) => { resolveSourceB = resolve; });
    vi.spyOn(getPlatform(), "getSettings").mockImplementation((sourceId) =>
      sourceId === "source-b" ? sourceBSettings : Promise.resolve(effectiveSettings(sourceId)),
    );
    await loadSource("B", false);
    // Exercise the slow-settings path explicitly instead of depending on runner speed.
    await waitFor(() => expect(pending.some(({ app }) =>
      app.general.lastSourceId === "source-b" && app.general.theme === "dark",
    )).toBe(true));
    await act(async () => {
      resolveSourceB(effectiveSettings("source-b"));
      await sourceBSettings;
    });
    const current = await sourceSave(pending, "b");
    await finishSave(current);
    // Resolve every older response last, including a possible intermediate B
    // save, and retain the assertions that the current source wins.
    for (const stale of pending.filter((save) => save !== current).reverse()) {
      await finishSave(stale);
    }

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByRole("textbox", { name: "Question" })).toBeEnabled();
    const settings = await openAiSettings();
    expect(settings.getByLabelText("Model")).toHaveValue("source-b-model");
    expect(settings.getByRole("checkbox", { name: /Enable AI explanations/ })).toBeDisabled();
  });

  it("reports a failed workspace save without discarding usable AI settings", async () => {
    const pending = mount();
    await screen.findByText("Settings test runtime");
    await loadSource("A");
    const current = await sourceSave(pending, "a");
    await act(async () => {
      current.reject(new Error("Fixture disk write failed"));
      await Promise.resolve();
    });

    expect(screen.getByRole("textbox", { name: "Question" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Open notifications/ }));
    expect(await screen.findByText("Recent workspace could not be saved")).toBeVisible();
    expect(screen.getByText("Fixture disk write failed")).toBeVisible();
  });
});
