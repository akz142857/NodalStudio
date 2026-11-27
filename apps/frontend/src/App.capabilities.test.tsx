import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult } from "./platform";
import type { ConnectionFolderStatus, RuntimeInfo } from "./platform/types";
import { reportSnapshot } from "./test/schema-report-fixture";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button type="button" onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load PostgreSQL fixture</button>
  <button type="button" onClick={() => onSnapshot({ snapshot: { ...reportSnapshot, id: "mysql", sourceId: "mysql", database: { ...reportSnapshot.database, databaseType: "mySql", version: "8.4" } }, stored: true, changeSet: null })}>Load MySQL fixture</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot, onOpenQuery }: SchemaCanvasProps) => <button type="button" disabled={!onOpenQuery} onClick={() => onOpenQuery?.(snapshot.schemas[0].tables[0])}>Canvas query shortcut</button> }));
async function mount(kind: "desktop" | "web", distribution?: RuntimeInfo["distribution"]) {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind, distribution, label: `${kind} capability test`, version: "test" });
  vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findByText(`${kind} capability test`);
  return client;
}

const folderStatus: ConnectionFolderStatus = {
  folder: "/sync/fixture", library: "test-library", provider: "iCloud", paused: false,
  queued: 0, pending: 0, pendingId: null, lastCheck: null, lastWrite: null, problem: null,
};

describe("App capability integration", () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });
  afterEach(() => vi.restoreAllMocks());
  it("starts in Model with no Changes segment before a source is selected", async () => {
    await mount("desktop");
    const navigation = within(screen.getByRole("group", { name: "View mode" }));
    expect(navigation.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    expect(navigation.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
  });
  it("opens Code from the desktop navigation without a database and selects a project", async () => {
    const platform = getPlatform();
    const current = vi.fn().mockResolvedValue(null);
    const project = { id: "project", key: "project-key", name: "review-fixture", baseline: null, git: "folder" };
    const choose = vi.fn().mockResolvedValue(project);
    const changes = vi.fn().mockResolvedValue({ files: [], limited: false });
    const directory = vi.fn().mockResolvedValue({ entries: [], limited: false });
    const paths = vi.fn().mockResolvedValue({ paths: [], limited: false });
    const searchContent = vi.fn();
    const documentOutline = vi.fn();
    Object.defineProperty(platform, "codeReview", { configurable: true, value: { current, choose, changes, directory, paths, searchContent, documentOutline } });
    try {
      await mount("desktop");
      const navigation = within(screen.getByRole("group", { name: "View mode" }));
      const code = navigation.getByRole("button", { name: "Code" });
      fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
      const palette = within(screen.getByRole("dialog", { name: "Command palette" }));
      expect(palette.getByRole("option", { name: "Code Review" })).toBeVisible();
      fireEvent.keyDown(palette.getByRole("combobox"), { key: "Escape" });
      const headerToggle = screen.getByRole("button", { name: /collapse left sidebar/i });
      fireEvent.click(code);
      expect(code).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("combobox", { name: "Search schema" })).not.toBeInTheDocument();
      const review = await screen.findByRole("region", { name: "Code Review" });
      expect(await within(review).findByText("Code Review")).toBeVisible();
      await screen.findByRole("button", { name: "Open Folder…" });
      const search = screen.getByRole("button", { name: "Search project files and content…" });
      expect(search.closest("header.topbar")).toBeTruthy();
      search.focus();
      fireEvent.click(search);
      const quickOpen = await screen.findByRole("combobox", { name: "Open File Quickly" });
      expect(quickOpen).toHaveFocus();
      expect(screen.getByRole("button", { name: "Project Content" })).toBeVisible();
      expect(paths).toHaveBeenCalledWith(project.id);
      fireEvent.keyDown(quickOpen, { key: "Escape" });
      expect(search).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Open File Quickly" })).not.toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "review-fixture" })).toBeVisible();
      expect(current).toHaveBeenCalledOnce();
      expect(choose).toHaveBeenCalledOnce();
      expect(directory).toHaveBeenCalledWith(project.id, "", "visible");
      const sidebar = screen.getByRole("complementary", { name: "Project files" });
      expect(screen.getByRole("button", { name: "Hide project sidebar" })).toBe(headerToggle);
      expect(headerToggle).toHaveAttribute("aria-controls", sidebar.id);
      fireEvent.click(headerToggle);
      expect(screen.getByRole("button", { name: "Show project sidebar" })).toHaveAttribute("aria-expanded", "false");
      expect(sidebar).not.toBeVisible();
      fireEvent.click(headerToggle);
      expect(sidebar).toBeVisible();
      const outline = screen.getByRole("button", { name: "Show Code sidebar" });
      expect(outline).toBe(outline.closest("header.topbar")?.lastElementChild);
      fireEvent.click(outline);
      const panel = screen.getByRole("complementary", { name: "Outline" });
      expect(outline).toHaveAttribute("aria-controls", panel.id);
      expect(outline).toHaveAttribute("aria-expanded", "true");
      expect(outline).toHaveAccessibleName("Hide Code sidebar");
      expect(documentOutline).not.toHaveBeenCalled();
      fireEvent.click(outline);
      expect(panel).not.toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(platform, "codeReview");
    }
  });
  it("opens Cloud Sync directly from the desktop toolbar without a data source", async () => {
    await mount("desktop");
    const tools = within(screen.getByRole("group", { name: "Application tools" }));
    expect(tools.queryByRole("button", { name: "Open command palette" })).not.toBeInTheDocument();
    fireEvent.click(tools.getByRole("button", { name: "Open Cloud Sync" }));
    const settings = within(await screen.findByRole("dialog", { name: "Settings" }));
    expect(settings.getByRole("button", { name: "Cloud Sync" })).toHaveAttribute("aria-current", "page");
    expect(settings.getByRole("heading", { name: "Personal Connection Sync" })).toBeVisible();
    expect(window.location.hash).toBe("#/settings/cloud");
  });
  it("routes the native Close shortcut to the active Code file and otherwise closes the window", async () => {
    const platform = getPlatform();
    let nativeClose: ((close: () => void) => void) | undefined;
    const closeWindow = vi.fn();
    const project = { id: "close-file", key: "close-file", name: "Keyboard project", baseline: null, git: "folder" };
    Object.defineProperty(platform, "codeReview", { configurable: true, value: {
      current: () => Promise.resolve(project),
      changes: () => Promise.resolve({ files: [], limited: false }),
      directory: () => Promise.resolve({ entries: [{ name: "main.py", path: "main.py", directory: false }], limited: false }),
      file: () => Promise.resolve({ before: null, after: { state: "text", text: "pass" }, evidence: null, indexOnly: false }),
    } });
    Object.defineProperty(platform, "onNativeCloseShortcut", { configurable: true, value: (listener: typeof nativeClose) => {
      nativeClose = listener;
      return Promise.resolve(() => { nativeClose = undefined; });
    } });
    try {
      await mount("desktop");
      fireEvent.click(screen.getByRole("button", { name: "Code" }));
      fireEvent.click(await screen.findByRole("button", { name: "main.py" }));
      const files = await screen.findByRole("navigation", { name: "Open files" });
      expect(within(files).getByRole("button", { name: "main.py" })).toBeVisible();
      act(() => nativeClose?.(closeWindow));
      expect(within(files).queryByRole("button", { name: "main.py" })).not.toBeInTheDocument();
      act(() => nativeClose?.(closeWindow));
      expect(closeWindow).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      act(() => nativeClose?.(closeWindow));
      expect(closeWindow).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(platform, "onNativeCloseShortcut");
      Reflect.deleteProperty(platform, "codeReview");
    }
  });
  it("offers bottom Code Checks independently of the Mac App Store outline capability", async () => {
    const platform = getPlatform();
    const documentOutline = vi.fn();
    Object.defineProperty(platform, "codeReview", { configurable: true, value: {
      current: () => Promise.resolve({ id: "project", key: "folder", name: "Local folder", baseline: null, git: "folder" }),
      changes: () => Promise.resolve({ files: [], limited: false }),
      directory: () => Promise.resolve({ entries: [], limited: false }),
      documentOutline,
    } });
    try {
      await mount("desktop", "macAppStore");
      fireEvent.click(screen.getByRole("button", { name: "Code" }));
      await screen.findByRole("heading", { name: "Local folder" });
      expect(screen.queryByRole("button", { name: "Show Code sidebar" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Show Checks/ }));
      const panel = within(screen.getByRole("complementary", { name: "Checks" }));
      expect(panel.getByRole("button", { name: "Check Current File" })).toBeDisabled();
      expect(documentOutline).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(platform, "codeReview");
    }
  });
  it("updates the Cloud Sync badge as the folder status changes and removes it when healthy", async () => {
    vi.spyOn(getPlatform(), "getConnectionFolderStatus").mockResolvedValue({ ...folderStatus, folder: null, library: null, provider: null });
    const client = await mount("desktop");
    const button = screen.getByRole("button", { name: "Open Cloud Sync" });
    await waitFor(() => expect(button).toHaveAccessibleDescription("Sync is off"));
    expect(button.querySelector(".connection-folder-badge")).toHaveTextContent("−");

    const states = [
      { details: { problem: "cannotWrite", pending: 1 }, description: "Sync failed", tone: "danger" },
      { details: { problem: "folderWaiting" }, description: "Waiting for the sync files to become available on this device.", tone: "neutral" },
      { details: { paused: true }, description: "Paused", tone: "neutral" },
      { details: { pending: 1 }, description: "Connection updates available", tone: "accent" },
    ];
    for (const { details, description, tone } of states) {
      act(() => { client.setQueryData(["connection-folder-status"], { ...folderStatus, ...details }); });
      await waitFor(() => expect(button).toHaveAccessibleDescription(description));
      expect(button.querySelector(".connection-folder-badge")).toHaveAttribute("data-tone", tone);
    }
    act(() => { client.setQueryData(["connection-folder-status"], folderStatus); });
    await waitFor(() => expect(button.querySelector(".connection-folder-badge")).not.toBeInTheDocument());
  });
  it("surfaces a connection merge failure after leaving Settings and clears it on retry", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getConnectionFolderStatus").mockResolvedValue({ ...folderStatus, pending: 1, pendingId: "pending" });
    vi.spyOn(platform, "previewConnectionFolderUpdates").mockResolvedValue({
      token: "reviewed", outgoing: 0, createsLibrary: false, deferredIncoming: false,
      rows: [{ action: "add", existing: null, connection: {
        displayName: "Fixture", databaseType: "postgreSql", host: "local.example", port: 5432,
        database: "fixture", username: "reader", sslMode: "verifyFull", ssh: null,
      } }],
    });
    vi.spyOn(platform, "applyConnectionFolderUpdates").mockRejectedValueOnce("stalePreview").mockResolvedValueOnce(folderStatus);
    await mount("desktop");

    const button = screen.getByRole("button", { name: "Open Cloud Sync" });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Merge" }));
    const changed = "The file or saved connections changed. Preview the merge again.";
    expect(await screen.findByRole("alert")).toHaveTextContent(changed);
    const settings = within(screen.getByRole("dialog", { name: "Settings" }));
    fireEvent.click(settings.getByRole("button", { name: "← Back" }));
    expect(button).toHaveAttribute("aria-description", "Merge failed");
    expect(button.querySelector(".connection-folder-badge")).toHaveAttribute("data-tone", "danger");

    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(changed);
    fireEvent.click(screen.getByRole("button", { name: "Preview Updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Merge" }));
    expect(await screen.findByText("Reviewed connection updates were merged.")).toBeVisible();
    expect(button.querySelector(".connection-folder-badge")).not.toBeInTheDocument();
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
    fireEvent.keyDown(document.body, { key: "P", [modifier]: true, shiftKey: true });
    const option = screen.getByRole("option", { name: "Open Ontology" });
    expect(option).toHaveTextContent(hint);
    fireEvent.click(option);
    expect(ontology).toHaveAttribute("aria-pressed", "true");
  });
  it("leaves the browser’s numbered tab shortcut available in the web viewer", async () => {
    await mount("web");
    expect(screen.queryByRole("button", { name: "Open Cloud Sync" })).not.toBeInTheDocument();
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
    vi.spyOn(getPlatform(), "listRecentSnapshotIds").mockResolvedValue(Array.from({ length: count }, (_, i) => `snapshot-${i}`));
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
    fireEvent.keyDown(document.body, { key: "P", ctrlKey: true, shiftKey: true });
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
