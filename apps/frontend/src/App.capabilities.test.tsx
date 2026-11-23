import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult } from "./platform";
import { reportSnapshot } from "./test/schema-report-fixture";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button type="button" onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load PostgreSQL fixture</button>
  <button type="button" onClick={() => onSnapshot({ snapshot: { ...reportSnapshot, id: "mysql", sourceId: "mysql", database: { ...reportSnapshot.database, databaseType: "mySql", version: "8.4" } }, stored: true, changeSet: null })}>Load MySQL fixture</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot, onOpenQuery }: SchemaCanvasProps) => <button type="button" disabled={!onOpenQuery} onClick={() => onOpenQuery?.(snapshot.schemas[0].tables[0])}>Canvas query shortcut</button> }));
async function mount(kind: "desktop" | "web") {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind, label: `${kind} capability test`, version: "test" });
  vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText(`${kind} capability test`);
}
describe("App capability integration", () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });
  afterEach(() => vi.restoreAllMocks());
  it("starts in Model with no Changes segment before a source is selected", async () => {
    await mount("desktop");
    const navigation = within(screen.getByRole("group", { name: "View mode" }));
    expect(navigation.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    expect(navigation.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
  });
  it.each([
    { platform: "MacIntel", modifier: "metaKey", shortcut: "Meta", hint: "⌘2" },
    { platform: "Win32", modifier: "ctrlKey", shortcut: "Control", hint: "Ctrl+2" },
  ])("switches workspaces from the SQL editor on $platform", async ({ platform, modifier, shortcut, hint }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await mount("desktop");
    const navigation = within(screen.getByRole("group", { name: "View mode" }));
    expect(fireEvent.keyDown(document.body, { key: "2", [modifier]: true })).toBe(true);
    expect(navigation.queryByRole("button", { name: "Ontology" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    const model = navigation.getByRole("button", { name: "Model" });
    const ontology = navigation.getByRole("button", { name: "Ontology" });
    const database = navigation.getByRole("button", { name: "Database" });
    const query = navigation.getByRole("button", { name: "Query" });
    expect(model).toHaveAttribute("aria-keyshortcuts", `${shortcut}+1`);
    expect(ontology).toHaveAttribute("aria-keyshortcuts", `${shortcut}+2`);
    expect(database).toHaveAttribute("aria-keyshortcuts", `${shortcut}+3`);
    expect(query).toHaveAttribute("aria-keyshortcuts", `${shortcut}+4`);
    expect(fireEvent.keyDown(document.body, { key: "3", [modifier]: true })).toBe(false);
    expect(database).toHaveAttribute("aria-pressed", "true");
    expect(fireEvent.keyDown(document.body, { key: "4", [modifier]: true })).toBe(false);
    expect(query).toHaveAttribute("aria-pressed", "true");
    const editor = await screen.findByRole("textbox", { name: "SQL editor" });
    expect(fireEvent.keyDown(editor, { key: "2", [modifier === "metaKey" ? "ctrlKey" : "metaKey"]: true })).toBe(true);
    expect(fireEvent.keyDown(editor, { key: "2", [modifier]: true })).toBe(false);
    expect(ontology).toHaveAttribute("aria-pressed", "true");
    expect(fireEvent.keyDown(document.body, { key: "1", [modifier]: true })).toBe(false);
    expect(model).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const option = screen.getByRole("option", { name: "Open Ontology" });
    expect(option).toHaveTextContent(hint);
    fireEvent.click(option);
    expect(ontology).toHaveAttribute("aria-pressed", "true");
  });
  it("leaves the browser’s numbered tab shortcut available in the web viewer", async () => {
    await mount("web");
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    const navigation = within(screen.getByRole("group", { name: "View mode" }));
    const database = navigation.getByRole("button", { name: "Database" });
    fireEvent.click(database);
    expect(fireEvent.keyDown(document.body, { key: "1", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "1", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "4", ctrlKey: true })).toBe(true);
    expect(database).toHaveAttribute("aria-pressed", "true");
  });
  it.each([1, 2])("shows the MySQL history comparison empty state with %s saved versions", async (count) => {
    vi.spyOn(getPlatform(), "listSnapshots").mockResolvedValue(Array.from({ length: count }, (_, i) => ({
      id: `snapshot-${i}`, sourceId: "mysql", capturedAt: reportSnapshot.capturedAt,
      fingerprint: `${i}`, databaseName: reportSnapshot.database.name, schemaCount: 1, tableCount: 3,
    })));
    await mount("desktop");
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(screen.getByRole("button", { name: "History comparison" }));
    expect(await screen.findByText(count === 1 ? "Your first snapshot is the starting point." : "Choose two snapshots to compare.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open history" }));
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
  });
  it.each(["desktop", "web"] as const)("uses the matrix to restrict query entry points in %s", async (kind) => {
    await mount(kind);
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    expect(screen.getByRole("button", { name: "Query" })).toHaveProperty("disabled", kind === "web");
    expect(screen.getByRole("button", { name: "Canvas query shortcut" })).toHaveProperty("disabled", kind === "web");
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    expect(screen.getByRole("button", { name: "Query" })).toHaveProperty("disabled", kind === "web");
    expect(screen.getByRole("button", { name: "Canvas query shortcut" })).toHaveProperty("disabled", kind === "web");
    if (kind === "web") expect(screen.getByRole("button", { name: "Query" })).toHaveAttribute("title", expect.stringContaining("Web Viewer never connects"));
  });
  it("opens the matrix from the command palette and supplies the loaded MySQL context", async () => {
    await mount("desktop"); fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    fireEvent.click(screen.getByRole("option", { name: /Open capability matrix/ }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("columnheader", { name: "Desktop · MySQL Current" })).toHaveAttribute("data-current", "true");
    expect(window.location.hash).toBe("#/settings/capabilities");
  });
  it("shares current workspace availability and configured bindings with the command palette", async () => {
    const platform = getPlatform();
    const settings = await platform.getSettings();
    settings.app.shortcuts.bindings.openSettings = "Mod+Y";
    vi.spyOn(platform, "getSettings").mockResolvedValue(settings);
    const capture = vi.spyOn(platform, "capturePostgresSnapshot");
    await mount("desktop");
    const openPalette = () => fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
    openPalette();
    const options = () => within(screen.getByRole("dialog", { name: "Command palette" }));
    expect(options().queryByRole("option", { name: "Refresh schema" })).not.toBeInTheDocument();
    expect(options().queryByRole("option", { name: /fit.*canvas/i })).not.toBeInTheDocument();
    await waitFor(() => expect(options().getByRole("option", { name: "Open Settings" })).toHaveTextContent(/(?:⌘|Ctrl\+)Y/));
    fireEvent.keyDown(options().getByRole("combobox"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Ontology" }));
    openPalette();
    expect(options().getByRole("option", { name: "Refresh schema" })).toHaveTextContent(/(?:⌘|Ctrl\+)R/);
    expect(options().queryByRole("option", { name: /fit.*canvas/i })).not.toBeInTheDocument();
    expect(options().queryByRole("option", { name: "Toggle right inspector" })).not.toBeInTheDocument();
    fireEvent.keyDown(options().getByRole("combobox"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Query" }));
    openPalette();
    expect(options().getByRole("option", { name: "Refresh schema" })).toHaveTextContent(/^Refresh schema$/);
    fireEvent.keyDown(options().getByRole("combobox"), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "y", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
  });
});
