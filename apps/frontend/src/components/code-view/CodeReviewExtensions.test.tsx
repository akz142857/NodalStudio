import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CodeExtension, CodeExtensionPlatform, CodeOpenVsxDetail, CodeOpenVsxPlatform } from "../../platform/code-review";
import { CodeOpenVsxDetails } from "./CodeOpenVsxExtensions";
import { CodeReviewExtensions } from "./CodeReviewExtensions";

it("opens a package from its row and runs management actions from the focused menu", async () => {
  const item: CodeExtension = {
    id: "example.syntax", name: "Example Syntax", publisher: "example", version: "1.0.0", description: "Highlights source code",
    fileName: "example.syntax-1.0.0.vsix", sha256: "test", source: "local", engine: "^1.90.0", capability: "syntax",
    enabled: true, languages: [],
  };
  const disabled = { ...item, enabled: false };
  const change = vi.fn<CodeExtensionPlatform["change"]>().mockResolvedValue(disabled);
  const onUpdate = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><CodeReviewExtensions
    api={{ list: vi.fn(), install: vi.fn(), prepare: vi.fn(), change }} projectId="project"
    items={[item]} loading={false} loadError={false} retry={vi.fn()} activities={[]} onUpdate={onUpdate} offline={false}
  /></QueryClientProvider>);

  const row = screen.getByRole("button", { name: item.name });
  row.focus();
  fireEvent.click(row);
  const details = screen.getByRole("dialog", { name: "Package details" });
  expect(within(details).getByText(item.fileName)).toBeVisible();
  fireEvent.click(within(details).getByRole("button", { name: "Close" }));
  expect(row).toHaveFocus();

  const manage = screen.getByRole("button", { name: `Manage ${item.name}` });
  fireEvent.click(manage);
  expect(manage).toHaveAttribute("aria-expanded", "true");
  const disable = screen.getByRole("menuitem", { name: "Disable" });
  expect(disable).toHaveFocus();
  fireEvent.keyDown(disable, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(manage).toHaveFocus();

  fireEvent.click(manage);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Disable" }), { key: "Enter" });
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(item.id, disabled));
  expect(change).toHaveBeenCalledExactlyOnceWith("project", item.id, "disable");
});

it("loads the Open VSX featured list by default and restores it when search is cleared", async () => {
  const featured = { id: "example.featured", name: "Featured extension", description: "Example", publisher: "example",
    version: "1.0.0", verified: true, deprecated: false };
  const matched = { ...featured, id: "example.linter", name: "Example Linter" };
  const search = vi.fn<CodeOpenVsxPlatform["search"]>((_, query, offset) => Promise.resolve(
    query && offset === 0 ? { items: [], nextOffset: 20 } : { items: [query ? matched : featured], nextOffset: null },
  ));
  const install = vi.fn<CodeExtensionPlatform["install"]>().mockResolvedValue(null);
  const detail = vi.fn<CodeOpenVsxPlatform["detail"]>().mockResolvedValue({
    ...matched, versions: [matched.version], capability: "syntax", downloadable: true, canUpdate: false,
    license: null, engine: null, incompatibility: null,
  });
  const api: CodeExtensionPlatform = {
    list: vi.fn(), install, prepare: vi.fn(), change: vi.fn(),
    openVsx: { search, detail, install: vi.fn(), updates: vi.fn() },
  };
  const client = new QueryClient();
  const renderPanel = (offline: boolean) => <QueryClientProvider client={client}><CodeReviewExtensions
    api={api} projectId="project" items={[]} loading={false} loadError={false} retry={vi.fn()}
    activities={[]} onUpdate={vi.fn()} offline={offline} /></QueryClientProvider>;
  const { rerender } = render(renderPanel(true));
  expect(screen.getByText("Open VSX is unavailable in offline mode.")).toBeVisible();
  expect(search).not.toHaveBeenCalled();

  rerender(renderPanel(false));
  const featuredGroup = screen.getByRole("region", { name: "Recommended from Open VSX" });
  expect(await within(featuredGroup).findByRole("button", { name: featured.name })).toBeVisible();
  expect(search).toHaveBeenCalledExactlyOnceWith("project", "", 0);
  const installed = screen.getByRole("region", { name: "Installed" });
  expect(within(installed).getByText("No extensions installed.")).toBeVisible();
  expect(within(installed).queryByRole("button", { name: "Install from VSIX…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Extension actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Install from VSIX…" }));
  await waitFor(() => expect(install).toHaveBeenCalledExactlyOnceWith("project"));

  const disclosure = within(installed).getByRole("button", { name: "Installed (0)" });
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");

  const input = screen.getByRole("searchbox", { name: "Search Open VSX" });
  fireEvent.change(input, { target: { value: "linter" } });
  const results = screen.getByRole("region", { name: "Open VSX results" });
  const more = await within(results).findByRole("button", { name: "Load more" });
  expect(search).toHaveBeenLastCalledWith("project", "linter", 0);
  expect(within(results).getByText("No compatible extensions found so far.")).toBeVisible();
  fireEvent.click(more);
  fireEvent.click(await within(results).findByRole("button", { name: matched.name }));
  expect(search).toHaveBeenLastCalledWith("project", "linter", 20);
  const dialog = within(screen.getByRole("dialog", { name: "Extension details" }));
  expect(await dialog.findByRole("button", { name: "Install 1.0.0" })).toBeEnabled();
  expect(detail).toHaveBeenCalledExactlyOnceWith("project", matched.id, matched.version);
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear extension search" }));
  expect(input).toHaveFocus();
  expect(screen.getByRole("button", { name: featured.name })).toBeVisible();
  expect(screen.getByRole("button", { name: "Installed (0)" })).toHaveAttribute("aria-expanded", "false");
  expect(search).toHaveBeenCalledTimes(3);
});

it("explains why a downloadable debugger cannot be installed in Code", async () => {
  const release: CodeOpenVsxDetail = {
    id: "ms-python.debugpy", name: "Python Debugger", description: "", publisher: "ms-python",
    version: "2026.6.0", versions: ["2026.6.0"], engine: "^1.92.0", license: "MIT",
    verified: true, deprecated: false, downloadable: true, canUpdate: false,
    capability: "unsupported", incompatibility: "debugger",
  };
  const install = vi.fn<CodeOpenVsxPlatform["install"]>();
  const market: CodeOpenVsxPlatform = {
    search: vi.fn(), detail: vi.fn().mockResolvedValue(release), install, updates: vi.fn(),
  };
  render(<QueryClientProvider client={new QueryClient()}><CodeOpenVsxDetails
    market={market} projectId="project" id={release.id} offline={false} dismiss={vi.fn()} onInstall={vi.fn()}
  /></QueryClientProvider>);
  const dialog = within(screen.getByRole("dialog", { name: "Extension details" }));
  expect(await dialog.findByText(/needs a VS Code debugger host/)).toBeVisible();
  const installButton = dialog.getByRole("button", { name: "Install 2026.6.0" });
  expect(installButton).toBeDisabled();
  fireEvent.click(installButton);
  expect(install).not.toHaveBeenCalled();
});
