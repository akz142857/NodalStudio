import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CodeExtension, CodeExtensionPlatform, CodeOpenVsxDetail, CodeOpenVsxPlatform, CodeSyntaxSource } from "../../platform/code-review";
import { CodeOpenVsxDetails } from "./CodeOpenVsxExtensions";
import { CodeReviewExtensions } from "./CodeReviewExtensions";
import { recommendCodeExtensions } from "./code-extension-recommendations";
import { findExtensionSyntax } from "./code-extension-runtime";

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

it("recommends compatible extensions locally and preserves Open VSX search", async () => {
  const matched = { id: "example.linter", name: "Example Linter", description: "Example", publisher: "example",
    version: "1.0.0", verified: true, deprecated: false };
  const loadPaths = vi.fn().mockResolvedValue({ paths: ["src/main.py", "src/second.PY"], limited: false });
  const search = vi.fn<CodeOpenVsxPlatform["search"]>((_, query, offset) => Promise.resolve(
    offset === 0 ? { items: [], nextOffset: 20 } : { items: query ? [matched] : [], nextOffset: null },
  ));
  const install = vi.fn<CodeExtensionPlatform["install"]>().mockResolvedValue(null);
  const refreshInstalled = vi.fn();
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
    api={api} projectId="project" items={[]} loading={false} loadError={false} retry={refreshInstalled}
    activities={[]} loadPaths={loadPaths} onUpdate={vi.fn()} offline={offline} /></QueryClientProvider>;
  const { rerender } = render(renderPanel(true));
  expect(screen.getByText("Open VSX is unavailable in offline mode.")).toBeVisible();
  expect(search).not.toHaveBeenCalled();

  rerender(renderPanel(false));
  const recommended = screen.getByRole("region", { name: "Recommended for This Project" });
  expect(await within(recommended).findByRole("button", { name: "View Python Debugger details" })).toBeEnabled();
  expect(within(recommended).getByText("Matches 2 project files")).toBeVisible();
  expect(within(recommended).queryByText("ESLint")).toBeNull();
  expect(search).not.toHaveBeenCalled();
  const installed = screen.getByRole("region", { name: "Installed" });
  expect(within(installed).getByText("No extensions installed.")).toBeVisible();
  expect(within(installed).queryByRole("button", { name: "Install from VSIX…" })).toBeNull();
  const actions = within(screen.getByRole("group", { name: "Extensions actions" }));
  fireEvent.click(actions.getByRole("button", { name: "Refresh extensions" }));
  await waitFor(() => expect(loadPaths).toHaveBeenCalledTimes(2));
  expect(search).not.toHaveBeenCalled();
  expect(refreshInstalled).toHaveBeenCalledOnce();
  fireEvent.click(actions.getByRole("button", { name: "Install from VSIX…" }));
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
  expect(await screen.findByRole("button", { name: "View Python Debugger details" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Installed (0)" })).toHaveAttribute("aria-expanded", "false");
  expect(search).toHaveBeenCalledTimes(2);
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

it("recommends and applies offline syntax by extension, exact filename, or filename prefix", () => {
  const docker: CodeSyntaxSource = {
    id: "vscode.docker", name: "Dockerfile", version: "1.95.3",
    extensions: [".dockerfile"], filenames: ["Dockerfile"], filenamePatterns: ["Dockerfile.*"],
  };
  const kotlin: CodeSyntaxSource = {
    id: "fwcd.kotlin", name: "Kotlin", version: "0.2.36", extensions: [".kt", ".kts"],
  };
  const paths = ["docker/Dockerfile", "docker/Dockerfile.dev.dockerfile", "android/build.gradle.kts", "DockerfileNotes"];
  const languages = [{
    id: "dockerfile", aliases: ["Dockerfile"], extensions: [".dockerfile"],
    filenames: ["Dockerfile"], filenamePatterns: ["Dockerfile.*"],
  }];
  const active: CodeExtension = {
    ...docker, source: "bundledSyntax", publisher: "vscode", description: "", fileName: "grammar.json",
    sha256: "fixture", engine: "*", capability: "syntax", enabled: true, languages,
  };

  expect(recommendCodeExtensions(paths, [docker, kotlin], [], false)).toMatchObject([
    { id: docker.id, count: 2 }, { id: kotlin.id, count: 1 },
  ]);
  expect(findExtensionSyntax([active], paths[0])?.language.id).toBe("dockerfile");
  expect(findExtensionSyntax([active], paths[1])?.language.id).toBe("dockerfile");
  expect(findExtensionSyntax([active], paths[3])).toBeUndefined();
  // The same language may already be covered by a different installed package.
  expect(recommendCodeExtensions(paths, [docker, kotlin], [{ ...active, id: "other.docker" }], false))
    .toMatchObject([{ id: kotlin.id, count: 1 }]);
});
