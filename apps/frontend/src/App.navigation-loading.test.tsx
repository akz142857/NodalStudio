import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { defaultEffectiveSettings, getPlatform } from "./platform";

const gates = vi.hoisted(() => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  return { query: gate(), settings: gate(), ddl: gate() };
});
vi.mock("./components/query/QueryPage", async () => { await gates.query.promise; return { QueryPage: () => <div>Query loaded</div> }; });
vi.mock("./components/SettingsPage", async () => { await gates.settings.promise; return { SettingsPage: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close loaded settings</button> }; });
vi.mock("./components/DdlImportPanel", async () => { await gates.ddl.promise; return { DdlImportPanel: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close loaded DDL</button> }; });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState(null, "", "/"); });

it("keeps the shell mounted and selection visible while each first-use page loads", async () => {
  const platform = getPlatform();
  const settings = defaultEffectiveSettings();
  settings.app.general.language = "en";
  settings.app.general.reopenLastWorkspace = false;
  settings.app.legacyStorageMigrationVersion = 3;
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Navigation test", version: "test" });
  vi.spyOn(platform, "getSettings").mockResolvedValue(settings);
  vi.spyOn(platform, "listDataSources").mockResolvedValue([]);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  const modes = await screen.findByRole("group", { name: "View mode" });
  const query = within(modes).getByRole("button", { name: "Query" });
  await vi.waitFor(() => expect(query).toBeEnabled());
  const shell = modes.closest("main")!;
  fireEvent.click(query);
  expect(modes).toBeVisible();
  expect(query).toHaveAttribute("aria-pressed", "true");
  expect(query).toHaveClass("active");
  expect(within(shell).getByRole("status")).toHaveTextContent("Loading");
  await act(async () => { gates.query.resolve(); await gates.query.promise; });
  expect(await screen.findByText("Query loaded")).toBeVisible();
  expect(modes.closest("main")).toBe(shell);
  for (const label of ["Changes", "Database"]) {
    fireEvent.click(within(modes).getByRole("button", { name: label }));
    expect(within(modes).getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(within(modes).getByRole("button", { name: label })).toHaveClass("active");
  }
  fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
  expect(shell).toBeVisible();
  await act(async () => { gates.settings.resolve(); await gates.settings.promise; });
  fireEvent.click(await screen.findByRole("button", { name: "Close loaded settings" }));
  expect(modes.closest("main")).toBe(shell);
  fireEvent.click(screen.getByRole("button", { name: "Import DDL" }));
  expect(shell).toBeInTheDocument();
  expect(shell).toHaveAttribute("inert");
  await act(async () => { gates.ddl.resolve(); await gates.ddl.promise; });
  fireEvent.click(await screen.findByRole("button", { name: "Close loaded DDL" }));
  expect(shell).not.toHaveAttribute("inert");
  expect(modes).toBeVisible();
});
