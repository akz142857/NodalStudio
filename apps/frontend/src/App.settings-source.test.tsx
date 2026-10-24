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

async function loadSource(name: "A" | "B") {
  fireEvent.click(screen.getByRole("button", { name: `Load source ${name}` }));
  fireEvent.click(await screen.findByRole("button", { name: "Select current table" }));
  const expand = screen.queryByRole("button", { name: "Expand right inspector" });
  if (expand) fireEvent.click(expand);
  fireEvent.click(screen.getByRole("button", { name: "AI" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toBeEnabled());
}

async function finishSave(save: PendingSave) {
  // The desktop update_app_settings command returns only the application layer.
  await act(async () => {
    save.resolve({ app: save.app, source: null, project: null, managed: [] });
    await Promise.resolve();
  });
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
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].app.general.lastSourceId).toBe("source-a");
    await finishSave(pending[0]);

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
    await waitFor(() => expect(pending).toHaveLength(1));
    await loadSource("B");
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].app.general.lastSourceId).toBe("source-b");
    await finishSave(pending[1]);
    await finishSave(pending[0]);

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
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].reject(new Error("Fixture disk write failed"));
      await Promise.resolve();
    });

    expect(screen.getByRole("textbox", { name: "Question" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Open notifications/ }));
    expect(await screen.findByText("Recent workspace could not be saved")).toBeVisible();
    expect(screen.getByText("Fixture disk write failed")).toBeVisible();
  });
});
