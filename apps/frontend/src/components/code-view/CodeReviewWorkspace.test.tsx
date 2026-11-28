import { EditorView } from "@codemirror/view";
import { highlightingFor } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { webcrypto } from "node:crypto";
import { lint } from "markdownlint/sync";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { codeShortcutEvent, type CodeShortcut } from "../command-shortcuts";
import type { CodeDefinitionRequest, CodeDefinitionResult, CodeDocumentHighlightRange, CodeDocumentOutlineRequest, CodeReviewCompactFolders,
  CodeChangeComparison, CodeDocumentOutlineResult, CodeLanguageStatus, CodeReviewChange, CodeReviewDirectory, CodeReviewPlatform, CodeReviewProject,
  CodeSavedProject, CodeSavedProjectGroup } from "../../platform/code-review";
import { CodeReviewWorkspace } from "./CodeReviewWorkspace";
import { reviewHistory, saveReviewNote } from "./code-review-notes";

vi.mock("./code-review-checks", async (original) => {
  const module = await original<typeof import("./code-review-checks")>();
  return { ...module, checkMarkdown: vi.fn<typeof module.checkMarkdown>(({ text, config, limit }) => {
    const findings = lint({ strings: { markdown: text }, config }).markdown;
    return Promise.resolve({ version: "0.42.2", findings: findings.slice(0, limit), total: findings.length });
  }) };
});

function renderWorkspace(api: CodeReviewPlatform, client = new QueryClient(), extensionsMode?: Parameters<typeof CodeReviewWorkspace>[0]["extensionsMode"], extensionsOffline = false, allowFinderReveal = false) {
  function Workspace({ outlineOpen }: { outlineOpen: boolean }) {
    const [sidebarOpen, setSidebarOpen] = useState(true);
    return <QueryClientProvider client={client}>
      <CodeReviewWorkspace api={api} sidebarId="project-sidebar" sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
        outlineId="code-outline" outlineOpen={outlineOpen} extensionsMode={extensionsMode} extensionsOffline={extensionsOffline}
        allowFinderReveal={allowFinderReveal}
        eslintAvailability={api.eslint ? "enabled" : "eslintUnavailable"} />
    </QueryClientProvider>;
  }
  const result = render(<Workspace outlineOpen={false} />);
  return { ...result, openOutline: (open: boolean) => result.rerender(<Workspace outlineOpen={open} />) };
}

const projectNavigator = () => within(screen.getByRole("navigation", { name: "Project navigator" }));

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});

afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

it("recommends and enables only bundled syntax while offline in the App Store edition", async () => {
  const install = vi.fn().mockResolvedValue(null);
  const syntax = { id: "tamasfe.even-better-toml", name: "TOML", version: "0.21.2", extensions: [".toml"] };
  const enable = vi.fn().mockResolvedValue({
    ...syntax, description: "", publisher: "tamasfe", fileName: "toml.tmLanguage.json",
    sha256: "fixture", engine: "*", capability: "syntax", enabled: true, source: "bundledSyntax", languages: [],
  });
  const search = vi.fn();
  const debug = vi.fn();
  const choose = vi.fn().mockResolvedValue(null);
  const changes = vi.fn().mockResolvedValue({ files: [], limited: false });
  const installed = vi.fn().mockResolvedValue([]);
  const listSyntax = vi.fn().mockResolvedValue([syntax]);
  renderWorkspace({
    current: () => Promise.resolve({ id: "store-project", key: "store-project", name: "Store project", git: "folder", baseline: null }),
    choose, changes,
    directory: () => Promise.resolve({ entries: [], limited: false }),
    paths: () => Promise.resolve({ paths: ["docs.toml", "app.py", "main.js"], limited: false }),
    file: vi.fn(),
    extensions: {
      list: installed, install, change: vi.fn(), prepare: vi.fn(),
      syntaxCatalog: { list: listSyntax, enable },
      openVsx: { search, detail: vi.fn(), updates: vi.fn(), install: vi.fn() },
    },
    pythonDebug: { prepare: debug, start: vi.fn(), control: vi.fn(), stop: vi.fn() },
  }, new QueryClient(), "syntax", true);

  fireEvent.click(await screen.findByRole("button", { name: "Extensions" }));
  expect(screen.queryByRole("searchbox", { name: "Search Open VSX" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Python Debugger" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Extension actions" })).toBeNull();
  await screen.findByRole("button", { name: "Enable TOML syntax" });
  const toolbar = within(screen.getByRole("group", { name: "Extensions actions" }));
  const refresh = toolbar.getByRole("button", { name: "Refresh extensions" });
  await waitFor(() => expect(refresh).toBeEnabled());
  fireEvent.click(refresh);
  await waitFor(() => expect(installed).toHaveBeenCalledTimes(2));
  expect(listSyntax).toHaveBeenCalledTimes(2);
  expect(changes).toHaveBeenCalledOnce();
  const installSyntax = toolbar.getByRole("button", { name: "Enable bundled syntax…" });
  await waitFor(() => expect(installSyntax).toBeEnabled());
  fireEvent.click(installSyntax);
  fireEvent.click(screen.getByRole("menuitem", { name: "Enable TOML syntax" }));
  expect(await screen.findByRole("button", { name: "Manage TOML" })).toBeVisible();
  expect(installSyntax).toBeDisabled();
  expect(enable).toHaveBeenCalledExactlyOnceWith("store-project", syntax.id);
  expect(install).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
});

it("routes each sidebar toolbar to the active Files, Search, or Changes panel", { timeout: 15_000 }, async () => {
  const project = { id: "toolbars", key: "toolbars", name: "Toolbar project", git: "ready", baseline: "abc123" } as const;
  const choose = vi.fn().mockResolvedValue(null);
  const changes = vi.fn().mockResolvedValue({ files: [], limited: false });
  const directory = vi.fn().mockResolvedValue({ entries: [{ name: "report.py", path: "report.py", directory: false }], limited: false });
  const searchContent = vi.fn().mockResolvedValue({ files: [], limited: false });
  const createEntry = vi.fn().mockResolvedValue("new.py");
  renderWorkspace({ current: () => Promise.resolve(project), choose, changes, directory, searchContent, createEntry, file: vi.fn() });

  const changeActions = within(await screen.findByRole("group", { name: "Changes actions" }));
  const refreshChanges = changeActions.getByRole("button", { name: "Refresh changes" });
  await waitFor(() => expect(refreshChanges).toBeEnabled());
  fireEvent.click(refreshChanges);
  await waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
  expect(directory).not.toHaveBeenCalled();

  fireEvent.click(projectNavigator().getByRole("button", { name: "Files" }));
  await screen.findByRole("button", { name: "report.py" });
  const fileActions = within(screen.getByRole("group", { name: "Files actions" }));
  fireEvent.click(fileActions.getByRole("button", { name: "Refresh files" }));
  await waitFor(() => expect(directory).toHaveBeenCalledTimes(2));
  expect(changes).toHaveBeenCalledTimes(3);
  const newFile = fileActions.getByRole("button", { name: "New File…" });
  newFile.focus();
  fireEvent.click(newFile);
  const dialog = screen.getByRole("dialog", { name: "New File…" });
  expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(newFile).toHaveFocus();
  expect(createEntry).not.toHaveBeenCalled();

  fireEvent.click(projectNavigator().getByRole("button", { name: "Search" }));
  const searchActions = within(screen.getByRole("group", { name: "Search actions" }));
  const refreshSearch = searchActions.getByRole("button", { name: "Refresh search results" });
  expect(refreshSearch).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Project Content" }), { target: { value: "total" } });
  await waitFor(() => expect(searchContent).toHaveBeenCalledOnce());
  await waitFor(() => expect(refreshSearch).toBeEnabled());
  fireEvent.click(refreshSearch);
  await waitFor(() => expect(searchContent).toHaveBeenCalledTimes(2));
  expect(searchContent).toHaveBeenLastCalledWith(project.id, "total");
  expect(changes).toHaveBeenCalledTimes(3);
  expect(directory).toHaveBeenCalledTimes(2);
  expect(choose).not.toHaveBeenCalled();
});

it.each([
  { path: "analysis.rs", before: 'fn title() -> \'static str { "before" }', after: 'fn title() -> \'static str { "after" }' },
  { path: "main.go", before: 'func title() string { return "before" }', after: 'func title() string { return "after" }' },
])("syntax-highlights deleted lines in the offline $path Diff", async ({ path, before, after }) => {
  const project = { id: path, key: path, name: "Offline project", git: "ready", baseline: "abc" } as const;
  const change: CodeReviewChange = { path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "evidence" };
  const { container } = renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(),
    changes: () => Promise.resolve({ files: [change], limited: false }),
    file: () => Promise.resolve({ before: { state: "text", text: before }, after: { state: "text", text: after },
      evidence: change.evidence, indexOnly: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
  }, new QueryClient(), undefined, true);
  await waitFor(() => {
    const editor = container.querySelector<HTMLElement>(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    const stringClass = view && highlightingFor(view.state, [tags.string])?.split(" ")[0];
    expect(stringClass).toBeTruthy();
    const deleted = editor?.querySelector(".cm-deletedChunk .cm-deletedLine");
    const strings = Array.from(deleted?.querySelectorAll(`.${stringClass}`) ?? [], (part) => part.textContent).join("");
    expect(strings).toBe('"before"');
  });
});

it("keeps the expanded Code sidebar at least 280 pixels wide", async () => {
  const project = { id: "sidebar-width", key: "sidebar-width", name: "Sidebar width", git: "ready", baseline: "abc" } as const;
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(),
    changes: () => Promise.resolve({ files: [], limited: false }), file: vi.fn(),
    directory: () => Promise.resolve({ entries: [], limited: false }),
  });
  const divider = await screen.findByRole("separator", { name: "Resize left sidebar" });
  expect(divider).toHaveAttribute("aria-valuenow", "280");
  fireEvent.keyDown(divider, { key: "ArrowLeft" });
  expect(divider).toHaveAttribute("aria-valuenow", "280");
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  expect(Number(divider.getAttribute("aria-valuenow"))).toBeGreaterThan(280);
  fireEvent.keyDown(divider, { key: "Home" });
  expect(divider).toHaveAttribute("aria-valuenow", "280");
});

it("creates entries through the Files toolbar and file or folder context menus", async () => {
  const project = { id: "create", key: "create", name: "Create project", git: "folder", baseline: null } as const;
  const createEntry = vi.fn<NonNullable<CodeReviewPlatform["createEntry"]>>()
    .mockRejectedValueOnce("codeReviewEntryExists").mockResolvedValueOnce("new.txt")
    .mockResolvedValueOnce("src/folder").mockResolvedValueOnce("src/nested.txt");
  const file = vi.fn<CodeReviewPlatform["file"]>().mockResolvedValue({
    before: null, after: { state: "text", text: "" }, evidence: null, indexOnly: false,
  });
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(), changes: vi.fn(), createEntry, file,
    directory: (_, path) => Promise.resolve({ entries: path
      ? [{ name: "main.py", path: "src/main.py", directory: false }]
      : [{ name: "src", path: "src", directory: true }], limited: false }),
  });

  const create = (title: string, name: string) => {
    const dialog = within(screen.getByRole("dialog", { name: title }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: name } });
    fireEvent.submit(dialog.getByRole("button", { name: "Create" }).closest("form")!);
  };
  fireEvent.click(await screen.findByRole("button", { name: "New File…" }));
  create("New File…", "taken.txt");
  expect(await screen.findByText("A file or folder with this name already exists.")).toBeVisible();
  create("New File…", "new.txt");
  await waitFor(() => expect(file).toHaveBeenCalledWith(project.id, "new.txt", false));
  expect(createEntry).toHaveBeenNthCalledWith(2, project.id, "", "new.txt", "file");

  fireEvent.contextMenu(screen.getByRole("button", { name: "src" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Folder…" }));
  create("New Folder…", "folder");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(createEntry).toHaveBeenNthCalledWith(3, project.id, "src", "folder", "folder");

  fireEvent.contextMenu(await screen.findByRole("button", { name: "main.py" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New File…" }));
  create("New File…", "nested.txt");
  await waitFor(() => expect(file).toHaveBeenCalledWith(project.id, "src/nested.txt", false));
  expect(createEntry).toHaveBeenNthCalledWith(4, project.id, "src", "nested.txt", "file");
});

it("shows one file with both Git comparisons, tracks each review, and guards staging by revision", async () => {
  const project = { id: "git-review", key: "git-review", name: "Git review project", git: "ready", baseline: "abc123" } as const;
  const git = { branch: "ai/orders", baseline: "abc123", baselineChanged: false, indexRevision: "index-a" };
  const file = (path: string, comparison: CodeChangeComparison, evidence: string): CodeReviewChange => ({
    path, previousPath: null, kind: "modified", evidence, comparison, staged: comparison === "staged", indexOnly: comparison === "staged",
  });
  const staged = file("orders.sql", "staged", "reviewed-index");
  const unstaged = file("orders.sql", "unstaged", "working-file");
  const other = file("readme.md", "unstaged", "other");
  saveReviewNote(project.key, staged.path, { evidence: staged.evidence!, comparison: "staged", status: "reviewed", note: "checked the index", at: "2026-11-28" });
  const original = { files: [staged, other], git, staged: [staged], unstaged: [unstaged, other], limited: false };
  const changes = vi.fn().mockResolvedValue(original);
  const changeIndex = vi.fn().mockRejectedValue("codeReviewStale");
  const updateBaseline = vi.fn().mockResolvedValue({ ...original, git: { ...git, baseline: "def456" } });
  const readFile = vi.fn<CodeReviewPlatform["file"]>().mockImplementation((_, path, compare, scope) => {
    const entry = path === "readme.md" ? other : scope === "staged" ? staged : unstaged;
    return Promise.resolve({ before: compare ? { state: "text", text: "base\n" } : null, after: { state: "text", text: entry.evidence! },
      evidence: compare ? entry.evidence : null, indexOnly: scope === "staged" });
  });
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(), changes, changeIndex, updateBaseline, file: readFile,
    directory: () => Promise.resolve({ entries: [], limited: false }),
  });
  expect(await screen.findByText("ai/orders")).toBeVisible();
  const scope = within(screen.getByRole("group", { name: "Git change scope" }));
  expect(screen.getAllByLabelText("Staged and unstaged")).toHaveLength(1);
  const editorScope = within(await screen.findByRole("group", { name: "File comparison" }));
  fireEvent.click(editorScope.getByRole("button", { name: "Staged" }));
  await waitFor(() => expect(readFile).toHaveBeenLastCalledWith(project.id, "orders.sql", true, "staged"));
  fireEvent.click(scope.getByRole("button", { name: "Staged" }));
  expect(screen.getByText("1 of 1 files reviewed")).toBeVisible();
  fireEvent.click(scope.getByRole("button", { name: "Unstaged" }));
  fireEvent.click(await screen.findByRole("button", { name: "Stage file" }));
  await waitFor(() => expect(changeIndex).toHaveBeenCalledWith(project.id, {
    path: unstaged.path, comparison: "unstaged", evidence: unstaged.evidence, indexRevision: git.indexRevision,
  }));
  expect(await screen.findByText(/Git or the file changed/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next to review" }));
  await waitFor(() => expect(readFile).toHaveBeenCalledWith(project.id, other.path, true, "unstaged"));

  changes.mockResolvedValue({ ...original, git: { ...git, baselineChanged: true } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
  expect(await screen.findByText(/still reviewing the previous base/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Use current HEAD" }));
  await waitFor(() => expect(updateBaseline).toHaveBeenCalledExactlyOnceWith(project.id));
  await waitFor(() => expect(screen.queryByText(/still reviewing the previous base/)).toBeNull());
});

it("switches the viewed worktree, preserves local review and staging, and shows committed diffs separately", async () => {
  const task = { id: "task-view", key: "task-review", name: "order-import", git: "ready", baseline: "task-head" } as const;
  const main = { id: "main-view", key: "main-review", name: "demo", git: "ready", baseline: "main-head" } as const;
  const worktrees = [
    { name: main.name, path: "/demo", branch: "main", head: main.baseline, primary: true },
    { name: task.name, path: "/order-import", branch: "codex/order-import", head: task.baseline, primary: false },
  ];
  const staged: CodeReviewChange = { path: "staged.sql", previousPath: null, kind: "modified", staged: true, indexOnly: true,
    comparison: "staged", evidence: "staged-reviewed" };
  const unstaged: CodeReviewChange = { ...staged, path: "working.sql", staged: false, indexOnly: false,
    comparison: "unstaged", evidence: "working-edit" };
  const committed: CodeReviewChange = { ...unstaged, path: "committed.sql", comparison: undefined, evidence: "committed-version" };
  saveReviewNote(task.key, staged.path, { evidence: staged.evidence!, comparison: "staged", note: "Checked", status: "reviewed", at: "2026-11-28" });
  const changes: CodeReviewPlatform["changes"] = (id) => {
    const project = id === task.id ? task : main;
    return Promise.resolve({
      git: { branch: id === task.id ? "codex/order-import" : "main", baseline: project.baseline, head: project.baseline,
        indexRevision: project.id, baselineChanged: false, worktrees: worktrees.map((worktree) => ({ ...worktree, current: worktree.name === project.name })) },
      limited: false, files: id === task.id ? [staged, unstaged] : [], staged: id === task.id ? [staged] : [], unstaged: id === task.id ? [unstaged] : [],
      branchChanges: { target: "origin/main", base: main.baseline, head: project.baseline, files: id === task.id ? [committed] : [], limited: false },
    });
  };
  const diff = (entry: CodeReviewChange) => ({ before: { state: "text", text: "base" } as const,
    after: { state: "text", text: entry.path } as const, evidence: entry.evidence, indexOnly: entry.indexOnly });
  const file = vi.fn<CodeReviewPlatform["file"]>().mockImplementation((_, path) => Promise.resolve(diff(path === staged.path ? staged : unstaged)));
  const branchFile = vi.fn().mockResolvedValue(diff(committed));
  const switchWorktree = vi.fn().mockImplementation((_, path) => Promise.resolve(path === "/demo" ? main : task));
  const changeIndex = vi.fn().mockResolvedValue(undefined);
  renderWorkspace({ current: () => Promise.resolve(task), choose: vi.fn(), changes, file, branchFile, switchWorktree, changeIndex,
    directory: () => Promise.resolve({ entries: [], limited: false }) });

  expect(await screen.findByText("1 of 2 files reviewed")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Changes" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /working\.sql/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stage file" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Stage file" }));
  await waitFor(() => expect(changeIndex).toHaveBeenCalledWith(task.id, { path: unstaged.path,
    comparison: "unstaged", evidence: unstaged.evidence, indexRevision: task.id }));

  fireEvent.change(screen.getByRole("combobox", { name: "Review status" }), { target: { value: "reviewed" } });
  expect(screen.queryByRole("button", { name: /working\.sql.*Pending review/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Against origin\/main/ }));
  await waitFor(() => expect(branchFile).toHaveBeenCalledWith(task.id, committed.path));
  expect(screen.getByRole("button", { name: /committed\.sql.*Pending review/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Stage file" })).toBeNull();
  const pick = (label: RegExp, path: RegExp) => {
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole("button", { name: path }));
  };
  pick(/Switch worktree · order-import/, /Main worktree.*\/demo/);
  expect(await screen.findAllByText("No committed changes against the main branch.")).not.toHaveLength(0);
  expect(screen.getByRole("button", { name: /Against origin\/main/ })).toHaveAttribute("aria-pressed", "true");
  pick(/Switch worktree · demo/, /order-import.*\/order-import/);
  await screen.findByLabelText(/Switch worktree · order-import/);
  fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));
  expect(await screen.findByText("1 of 2 files reviewed")).toBeVisible();
  expect(switchWorktree.mock.calls).toEqual([[task.id, "/demo"], [main.id, "/order-import"]]);
  expect(changeIndex).toHaveBeenCalledTimes(1);
});

it("checks the full local diff of a partially staged file in the worktree view", async () => {
  const project = { id: "full-check", key: "full-check", name: "Partial staging", git: "ready", baseline: "old-head" } as const;
  const path = "README.md";
  const combined: CodeReviewChange = { path, previousPath: null, kind: "modified", staged: true, indexOnly: false, evidence: "full-diff" };
  const staged: CodeReviewChange = { ...combined, comparison: "staged", indexOnly: true, evidence: "index-diff" };
  const unstaged: CodeReviewChange = { ...combined, comparison: "unstaged", staged: false, evidence: "working-diff" };
  const file = vi.fn<CodeReviewPlatform["file"]>().mockImplementation((_, requested, _compare, scope) => Promise.resolve(requested !== path
    ? { before: null, after: { state: "missing" }, evidence: null, indexOnly: false }
    : { before: { state: "text", text: "# Base\n" }, after: { state: "text", text: "# Base\n\nChanges.\n" },
      evidence: scope === "unstaged" ? unstaged.evidence : combined.evidence, indexOnly: false }));
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(), file, directory: () => Promise.resolve({ entries: [], limited: false }),
    changes: () => Promise.resolve({
      files: [combined], staged: [staged], unstaged: [unstaged], limited: false,
      git: { branch: "main", head: "current-head", baseline: project.baseline, indexRevision: "index", baselineChanged: true, worktrees: [] },
    }),
  });
  await screen.findByRole("button", { name: /Local Changes/ });
  fireEvent.click(screen.getByRole("button", { name: /^Show Checks/ }));
  file.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Check Changed Files" }));
  await waitFor(() => expect(file).toHaveBeenCalledWith(project.id, path, true));
  await screen.findByText(/markdownlint 0.42.2/);
});

it("rejects a changed Diff response and runs batch Checks on the selected Git scope", async () => {
  const project = { id: "scoped-checks", key: "scoped-checks", name: "Scoped checks", git: "ready", baseline: "abc" } as const;
  const git = { branch: "main", baseline: "abc", baselineChanged: false, indexRevision: "index-a" };
  const staged: CodeReviewChange = {
    path: "README.md", kind: "modified", previousPath: null, evidence: "readme-stage", comparison: "staged", indexOnly: true, staged: true,
  };
  const other: CodeReviewChange = {
    ...staged, path: "z-other.md", evidence: "other-worktree", comparison: "unstaged", indexOnly: false, staged: false,
  };
  const versions = { files: [staged, other], staged: [staged], unstaged: [other], limited: false, git };
  const document = { before: { state: "text", text: "# Base\n" }, after: { state: "text", text: "# Staged\n\nChanged.\n" },
    evidence: staged.evidence, indexOnly: true, executableChangedTo: true } as const;
  const readFile = vi.fn<CodeReviewPlatform["file"]>().mockResolvedValueOnce({ ...document, evidence: "readme-newer" })
    .mockImplementation((_, path) => Promise.resolve(path === ".markdownlint.json"
      ? { before: null, after: { state: "missing" }, evidence: null, indexOnly: false } : document));
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(), changes: () => Promise.resolve(versions), file: readFile,
    directory: () => Promise.resolve({ entries: [], limited: false }),
  });
  expect(await screen.findByText("This file changed. Refresh to review the latest version.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
  expect(await screen.findByText("File mode changed to executable (100755).")).toBeVisible();
  const scope = within(screen.getByRole("group", { name: "Git change scope" }));
  fireEvent.click(scope.getByRole("button", { name: "Staged" }));
  fireEvent.click(screen.getByRole("button", { name: /^Show Checks/ }));
  readFile.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Check Changed Files" }));
  await waitFor(() => expect(readFile).toHaveBeenCalledWith(project.id, "README.md", true, "staged"));
  await screen.findByText(/markdownlint 0.42.2/);
  expect(readFile.mock.calls.some(([, path]) => path === "z-other.md")).toBe(false);
});

it("remembers when an identical reviewed version moves to the index", async () => {
  const project = { id: "staging-review", key: "staging-review", name: "Staging review", git: "ready", baseline: "abc" } as const;
  const git = { branch: "main", baseline: "abc", baselineChanged: false, indexRevision: "original-index" };
  const working: CodeReviewChange = { path: "orders.sql", kind: "modified", previousPath: null, evidence: "verified-version",
    comparison: "unstaged", indexOnly: false, staged: false };
  const staged: CodeReviewChange = { ...working, comparison: "staged", indexOnly: true, staged: true };
  saveReviewNote(project.key, working.path, { evidence: working.evidence!, comparison: "unstaged", status: "reviewed", note: "Approved",
    at: "2026-11-28T00:00:00Z" });
  const changes = vi.fn().mockResolvedValue({ files: [working], staged: [], unstaged: [working], limited: false, git });
  const changeIndex = vi.fn().mockImplementation(() => {
    changes.mockResolvedValue({ files: [staged], staged: [staged], unstaged: [], limited: false, git: { ...git, indexRevision: "updated-index" } });
    return Promise.resolve();
  });
  const readFile = vi.fn<CodeReviewPlatform["file"]>().mockImplementation((_, __, ___, comparison) => Promise.resolve({
    before: { state: "text", text: "original" }, after: { state: "text", text: "approved" },
    evidence: working.evidence, indexOnly: comparison === "staged",
  }));
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(), changes, changeIndex, file: readFile,
    directory: () => Promise.resolve({ entries: [], limited: false }),
  });

  fireEvent.click(await screen.findByRole("button", { name: "Stage file" }));
  await waitFor(() => expect(reviewHistory(project.key, working.path)[0]).toMatchObject({
    note: "Approved", comparisons: ["unstaged", "staged"],
  }));
  const externallyChanged = { ...staged, evidence: "another-index-version" };
  changes.mockResolvedValue({ files: [externallyChanged], staged: [externallyChanged], unstaged: [], limited: false, git: { ...git, indexRevision: "external" } });
  readFile.mockResolvedValue({ before: { state: "text", text: "original" }, after: { state: "text", text: "new index" },
    evidence: externallyChanged.evidence, indexOnly: true });
  fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
  expect(await screen.findByRole("button", { name: /orders.sql.*Review again/ })).toBeVisible();
});

it("uses Code shortcuts for navigation and keeps untitled text out of project file reads", async () => {
  const project = { id: "shortcuts", key: "shortcuts", name: "Keyboard project", git: "folder", baseline: null } as const;
  const file = vi.fn<CodeReviewPlatform["file"]>().mockResolvedValue({
    before: null, after: { state: "text", text: "line 1\nline 2\n" }, evidence: null, indexOnly: false,
  });
  renderWorkspace({
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: () => Promise.resolve({ entries: [{ name: "main.py", path: "main.py", directory: false }], limited: false }),
    searchContent: () => Promise.resolve({ files: [], limited: false }),
    file,
  });
  const shortcut = (name: CodeShortcut) => {
    const event = new Event(codeShortcutEvent(name), { cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  };
  fireEvent.click(await screen.findByRole("button", { name: "main.py" }));
  const source = await screen.findByRole("textbox", { name: "main.py" });
  expect(source).toHaveAttribute("aria-readonly", "true");
  shortcut("go-to-line");
  const line = screen.getByRole("textbox", { name: /Go to line/ });
  await waitFor(() => expect(line).toHaveFocus());
  fireEvent.keyDown(line, { key: "Escape" });

  shortcut("project-search");
  const search = await screen.findByRole("combobox", { name: "Project Content" });
  await waitFor(() => expect(search).toHaveFocus());
  shortcut("files");
  const files = within(screen.getByRole("complementary", { name: "Project files" }));
  expect(await files.findByRole("button", { name: "main.py" })).toBeVisible();
  shortcut("checks");
  expect(screen.getByRole("searchbox", { name: "Filter findings" })).toHaveFocus();

  shortcut("new-draft");
  const draft = screen.getByRole("textbox", { name: "Untitled-1" });
  expect(draft).toHaveFocus();
  const editor = EditorView.findFromDOM(draft)!;
  act(() => editor.dispatch({ changes: { from: 0, insert: "import pathlib" } }));
  const tabs = within(screen.getByRole("navigation", { name: "Open files" }));
  shortcut("previous-tab");
  expect(tabs.getByRole("button", { name: "main.py" })).toHaveAttribute("aria-current", "true");
  shortcut("next-tab");
  expect(tabs.getByRole("button", { name: "Untitled-1" })).toHaveAttribute("aria-current", "true");
  fireEvent.click(tabs.getByRole("button", { name: "main.py" }));
  await screen.findByRole("textbox", { name: "main.py" });
  fireEvent.click(tabs.getByRole("button", { name: "Untitled-1" }));
  expect(screen.getByRole("textbox", { name: "Untitled-1" })).toHaveTextContent("import pathlib");
  expect(file.mock.calls.every(([, path]) => path === "main.py")).toBe(true);

  shortcut("close-tab");
  const confirm = screen.getByRole("dialog", { name: "Discard unsaved drafts?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("textbox", { name: "Untitled-1" })).toHaveTextContent("import pathlib");
  fireEvent.click(tabs.getByRole("button", { name: "Close Untitled-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
  expect(tabs.queryByRole("button", { name: "Untitled-1" })).toBeNull();
  shortcut("close-tab");
  expect(tabs.queryByRole("button", { name: "main.py" })).toBeNull();
  shortcut("reopen-tab");
  expect(tabs.getByRole("button", { name: "main.py" })).toHaveAttribute("aria-current", "true");
});

it("opens group colors on hover or by keyboard and supports search before opening a file", async () => {
  const saved = { id: "flow", name: "flow-erp", path: "/workspace/flow-erp", pinned: false, groupId: "erp" };
  let group: CodeSavedProjectGroup = { id: "erp", name: "ERP", collapsed: false, color: "orange" };
  const editGroups = vi.fn<NonNullable<CodeReviewPlatform["projects"]>["editGroups"]>((update) => {
    if (update.kind === "color") group = { ...group, color: update.color };
    return Promise.resolve();
  });
  const choose = vi.fn().mockResolvedValue(null);
  renderWorkspace({
    current: () => Promise.resolve(null),
    choose,
    projects: {
      list: () => Promise.resolve({ projects: [saved], groups: [group] }),
      editGroups,
      open: () => Promise.resolve({ id: "session", key: "flow", savedProjectId: "flow", name: saved.name, git: "folder", baseline: null }),
      pin: () => Promise.resolve(),
      remove: () => Promise.resolve(null),
      relocate: () => Promise.resolve(null),
    },
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: () => Promise.resolve({ before: null, after: { state: "missing" }, evidence: null, indexOnly: false }),
    searchContent: () => Promise.resolve({ files: [], limited: false }),
  });
  const more = await screen.findByRole("button", { name: "Manage group ERP" });
  act(() => { window.dispatchEvent(new Event("nodalstudio:code-quick-open")); });
  await waitFor(() => expect(screen.getByRole("searchbox", { name: "Filter projects" })).toHaveFocus());
  expect(choose).not.toHaveBeenCalled();
  fireEvent.click(more);
  const parent = screen.getByRole("menu", { name: "Actions for ERP" });
  const groupColor = within(parent).getByRole("menuitem", { name: "Group Color" });
  fireEvent.pointerEnter(groupColor);
  const colors = screen.getByRole("menu", { name: "Group Color" });
  expect(groupColor).toHaveAttribute("aria-expanded", "true");
  expect(parent).toBeVisible();
  expect(within(colors).getByRole("menuitemradio", { name: "Orange", checked: true })).toBeVisible();
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(within(parent).getByRole("menuitem", { name: "Remove Group" }));
    fireEvent.pointerEnter(colors);
    act(() => { vi.advanceTimersByTime(250); });
    expect(colors).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
  fireEvent.click(within(colors).getByRole("menuitemradio", { name: "No Color" }));
  await waitFor(() => expect(editGroups).toHaveBeenCalledWith({ kind: "color", id: "erp", color: null }));
  await waitFor(() => expect(screen.getByRole("button", { name: "ERP" })).not.toHaveAttribute("aria-description"));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  fireEvent.click(more);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename Group…" }), { key: "ArrowDown" });
  const trigger = screen.getByRole("menuitem", { name: "Group Color" });
  expect(trigger).toHaveFocus();
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  const palette = within(screen.getByRole("menu", { name: "Group Color" }));
  const selected = palette.getByRole("menuitemradio", { name: "No Color", checked: true });
  expect(selected).toHaveFocus();
  fireEvent.keyDown(selected, { key: "ArrowDown" });
  const next = palette.getByRole("menuitemradio", { name: "Red" });
  expect(next).toHaveFocus();
  fireEvent.keyDown(next, { key: "Enter" });
  await waitFor(() => expect(editGroups).toHaveBeenCalledWith({ kind: "color", id: "erp", color: "red" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(more).toHaveFocus();
  fireEvent.click(await screen.findByRole("button", { name: "flow-erp" }));
  await screen.findByRole("button", { name: "Search" });
  act(() => { window.dispatchEvent(new Event("nodalstudio:code-find")); });
  const input = await screen.findByRole("combobox", { name: "Project Content" });
  await waitFor(() => expect(input).toHaveFocus());
});

it("switches saved projects with independent tabs, positions, modes and content searches", { timeout: 15_000 }, async () => {
  const first = { id: "alpha", name: "Alpha repo", path: "/workspace/Alpha", pinned: false };
  const second = { id: "beta", name: "Beta repo", path: "/workspace/Beta", pinned: false };
  let saved: CodeSavedProject[] = [];
  let session = 0;
  const open = ({ id, name }: CodeSavedProject): CodeReviewProject => ({
    id: `${id}-${++session}`, savedProjectId: id, key: id, name, git: "ready", baseline: "abc123",
  });
  const path = "README.md";
  const evidence = "review-file-change";
  const source = (id: string) => id.startsWith("alpha") ? "# Alpha\nkept anchor\n" : "# Beta\nseparate context\n";
  const searchContent = vi.fn<NonNullable<CodeReviewPlatform["searchContent"]>>((id, query) => {
    const text = source(id).split("\n")[0];
    return Promise.resolve({ files: [{ path, matches: [
      { line: 0, character: 2, before: "# ", matched: query, after: text.slice(2 + query.length) },
    ] }], limited: false });
  });
  const pin = vi.fn((id: string, pinned: boolean) => {
    saved = saved.map((project) => project.id === id ? { ...project, pinned } : project);
    return Promise.resolve();
  });
  renderWorkspace({
    current: () => Promise.resolve(null),
    choose: () => {
      const project = saved.length ? second : first;
      saved = [project, ...saved];
      return Promise.resolve(open(project));
    },
    projects: {
      list: () => Promise.resolve({ projects: saved, groups: [] }),
      editGroups: () => Promise.resolve(),
      open: (id) => Promise.resolve(open(saved.find((project) => project.id === id)!)),
      pin,
      relocate: () => Promise.resolve(null),
      remove: () => Promise.resolve(null),
    },
    changes: () => Promise.resolve({ files: [{ path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence }], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: (id, _, compare) => Promise.resolve({ before: compare ? { state: "text", text: "# Previous\n" } : null,
      after: { state: "text", text: source(id) }, evidence: compare ? evidence : null, indexOnly: false }),
    searchContent,
  });
  const selectProjectPanel = () => fireEvent.click(projectNavigator().getByRole("button", { name: "Projects" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add Project…" }));
  expect(await screen.findByRole("button", { name: first.name })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Manage project Alpha repo" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Pin Project" }));
  expect(await screen.findByRole("region", { name: "Pinned" })).toContainElement(screen.getByRole("button", { name: first.name }));
  expect(pin).toHaveBeenCalledWith(first.id, true);
  fireEvent.click(await screen.findByRole("button", { name: "Source" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true"));
  const editor = EditorView.findFromDOM(await screen.findByRole("textbox", { name: path }))!;
  const anchor = editor.state.doc.line(2).from + 2;
  act(() => editor.dispatch({ selection: { anchor } }));
  fireEvent.click(projectNavigator().getByRole("button", { name: "Search" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Project Content" }), { target: { value: "Alpha" } });
  expect(await screen.findByText("1 matching line · 1 file")).toBeVisible();
  expect(searchContent).toHaveBeenCalledWith("alpha-1", "Alpha");
  selectProjectPanel();
  fireEvent.click(screen.getByRole("button", { name: "Add Project…" }));
  await waitFor(() => expect(screen.getByRole("button", { name: second.name })).toHaveAttribute("aria-current", "true"));
  fireEvent.click(projectNavigator().getByRole("button", { name: "Search" }));
  const betaSearch = await screen.findByRole("combobox", { name: "Project Content" });
  expect(betaSearch).toHaveValue("");
  fireEvent.change(betaSearch, { target: { value: "Beta" } });
  await waitFor(() => expect(searchContent).toHaveBeenCalledWith("beta-2", "Beta"));
  selectProjectPanel();
  fireEvent.click(screen.getByRole("button", { name: first.name }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: path })).toHaveTextContent("kept anchor"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true"));
  expect(EditorView.findFromDOM(screen.getByRole("textbox", { name: path }))?.state.selection.main.anchor).toBe(anchor);
  fireEvent.click(projectNavigator().getByRole("button", { name: "Search" }));
  expect(await screen.findByRole("combobox", { name: "Project Content" })).toHaveValue("Alpha");
  await waitFor(() => expect(searchContent).toHaveBeenCalledWith("alpha-3", "Alpha"));

  fireEvent.click(projectNavigator().getByRole("button", { name: "Files" }));
  const switcher = screen.getByRole("button", { name: /Switch project .* Alpha repo/ });
  fireEvent.keyDown(switcher, { key: "ArrowDown" });
  const menu = within(screen.getByRole("menu"));
  expect(menu.getAllByRole("menuitemradio")[0]).toHaveTextContent(first.name);
  expect(menu.getByRole("menuitemradio", { name: first.name, checked: true })).toBeVisible();
  fireEvent.click(menu.getByRole("menuitemradio", { name: second.name }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Switch project .* Beta repo/ })).toHaveFocus());
  expect(projectNavigator().getByRole("button", { name: "Files" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("complementary", { name: "Projects" })).not.toBeInTheDocument();
});

it("keeps the project list in name order after an MRU reorder and restores its filter and scroll", async () => {
  const first = { id: "first", name: "Alpha", path: "/workspace/Alpha", pinned: true };
  const second = { id: "second", name: "Beta", path: "/workspace/Beta", pinned: true };
  let saved = [first, second];
  renderWorkspace({
    current: () => Promise.resolve(null),
    choose: () => Promise.resolve(null),
    projects: {
      list: () => Promise.resolve({ projects: saved, groups: [] }),
      editGroups: () => Promise.resolve(),
      open: (id) => {
        const selected = saved.find((entry) => entry.id === id)!;
        saved = [selected, ...saved.filter((entry) => entry.id !== id)];
        return Promise.resolve({ id, savedProjectId: id, key: id, name: selected.name, git: "folder", baseline: null });
      },
      pin: () => Promise.resolve(),
      relocate: () => Promise.resolve(null),
      remove: () => Promise.resolve(null),
    },
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: () => Promise.resolve({ before: null, after: { state: "missing" }, evidence: null, indexOnly: false }),
  });
  fireEvent.change(await screen.findByRole("searchbox", { name: "Filter projects" }), { target: { value: "a" } });
  fireEvent.scroll(screen.getByRole("region", { name: "Pinned" }).parentElement!, { target: { scrollTop: 96 } });
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-current", "true"));
  expect(saved[0]).toBe(second);
  expect(screen.getByRole("searchbox", { name: "Filter projects" })).toHaveValue("a");
  const pinned = screen.getByRole("region", { name: "Pinned" });
  expect(pinned.parentElement?.scrollTop).toBe(96);
  expect(within(pinned).getAllByRole("button", { name: /^(Alpha|Beta)$/ }).map((button) => button.textContent)).toEqual(["Alpha", "Beta"]);
});

it("keeps Source intact while marking and navigating the same changes as Diff", async () => {
  const project = { id: "source-changes", key: "source-changes", name: "Review", git: "ready", baseline: "abc" } as const;
  const path = "source.txt";
  const before = "head\nold\nkeep\nstable\ntail\n";
  const after = "head\nnew\nkeep\nstable\ntail\nadded\n";
  renderWorkspace({
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [{ path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "first" }], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: (_id, _path, compare) => Promise.resolve({ before: compare ? { state: "text", text: before } : null,
      after: { state: "text", text: after }, evidence: compare ? "first" : null, indexOnly: false }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Source" }));
  const overview = within(await screen.findByRole("group", { name: "Source changes" }));
  const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: path }))!;
  expect(view.state.doc.toString()).toBe(after);
  expect(view.dom.querySelector(".cm-source-modified")).toBeInTheDocument();
  fireEvent.click(overview.getByRole("button", { name: "Go to added lines 6" }));
  expect(view.state.selection.main.head).toBe(view.state.doc.line(6).from);
  fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
  expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
  fireEvent.click(screen.getByRole("button", { name: "Diff" }));
  expect(screen.queryByRole("group", { name: "Source changes" })).not.toBeInTheDocument();
});

it("shows native language progress in the bottom dock and keeps Checks accessible", async () => {
  const id = "language-progress";
  let status: CodeLanguageStatus = { state: "disabled" };
  const enable = vi.fn(() => {
    status = { state: "workspaces", workspaces: [{
      language: "Java", root: "services/os-server", command: "jdtls", state: "connected", lastTask: null,
      progress: { title: "Importing Gradle project", message: "Resolving dependencies", percentage: 0 },
    }] };
    return Promise.resolve();
  });
  renderWorkspace({
    current: () => Promise.resolve({ id, key: id, name: "Review", git: "folder", baseline: null }),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: () => Promise.resolve({ before: null, after: { state: "missing" }, evidence: null, indexOnly: false }),
    languageServices: { status: () => Promise.resolve(status), enable },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Language services" }));
  const dock = screen.getByRole("complementary", { name: "Language services" });
  expect(dock.previousElementSibling).toHaveAttribute("aria-orientation", "horizontal");
  expect(enable).not.toHaveBeenCalled();
  fireEvent.click(await within(dock).findByRole("button", { name: "Enable for this project" }));
  expect(await within(dock).findByRole("progressbar", { name: "Java · Importing Gradle project" })).toHaveAttribute("value", "0");
  expect(dock.nextElementSibling).toContainElement(screen.getByRole("button", { name: /^Language services\s*0%$/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Show Checks/ }));
  expect(screen.getByRole("complementary", { name: "Checks" })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Language services" })).not.toBeInTheDocument();
});

it("checks the displayed index diff, expands a folded result and rejects a stale jump", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  const config = '{"default":false,"MD009":"warning"}';
  let trackVerification = false;
  let verificationDigest: Promise<ArrayBuffer> | undefined;
  const trackDigest = vi.spyOn(webcrypto.subtle, "digest").mockImplementation((...args) => {
    const result = digest(...args);
    if (trackVerification && new TextDecoder().decode(args[1]) === config) verificationDigest = result;
    return result;
  });
  try {
    const project = { id: "markdown", key: "markdown", name: "Markdown review", git: "ready", baseline: "test" } as const;
    const path = "docs/guide.md";
    const before = ["# Guide", "", "Legacy line   ", "", ...Array.from({ length: 24 }, (_, i) => `Step ${i}\n`), "End", ""].join("\n");
    const after = before.replace("End", "Changed line   ");
    const change: CodeReviewChange = { path, previousPath: null, kind: "modified", staged: true, indexOnly: true, evidence: "index-1" };
    let evidence = "index-1";
    let deferCompare = false;
    let finishVerification: (() => void) | undefined;
    const file: CodeReviewPlatform["file"] = async (_, name, compare) => {
      if (compare && deferCompare) {
        deferCompare = false;
        await new Promise<void>((resolve) => { finishVerification = resolve; });
      }
      return name === ".markdownlint.json"
        ? { before: null, after: { state: "text", text: config }, evidence: null, indexOnly: false }
        : compare ? { before: { state: "text", text: before }, after: { state: "text", text: after }, evidence, indexOnly: true }
          : { before: null, after: { state: "text", text: "# Working tree\n" }, evidence: null, indexOnly: false };
    };
    const api: CodeReviewPlatform = {
      current: () => Promise.resolve(project),
      choose: () => Promise.resolve(null),
      changes: () => Promise.resolve({ files: [change], limited: false }),
      directory: () => Promise.resolve({ entries: [], limited: false }),
      file,
    };
    const workspace = renderWorkspace(api);
    await screen.findByRole("textbox", { name: path });
    const checksToggle = screen.getByRole("button", { name: /^Show Checks/ });
    fireEvent.click(checksToggle);
    const dock = screen.getByRole("complementary", { name: "Checks" });
    expect(dock.previousElementSibling).toHaveAttribute("aria-orientation", "horizontal");
    expect(dock.nextElementSibling).toContainElement(checksToggle);
    const panel = within(dock);
    fireEvent.click(panel.getByRole("button", { name: "Check Current File" }));
    await panel.findByText("2 findings");
    expect(panel.getAllByRole("button", { name: /MD009/ })).toHaveLength(1);
    fireEvent.click(panel.getByRole("button", { name: "All Findings" }));
    expect(panel.getAllByRole("button", { name: /MD009/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByText("# Working tree")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /MD009.*Line 3/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute("aria-pressed", "true"));
    const editor = EditorView.findFromDOM(screen.getByRole("textbox", { name: path }));
    expect(editor?.state.doc.lineAt(editor.state.selection.main.from).number).toBe(3);
    expect(workspace.container).toHaveTextContent("Legacy line");
    await waitFor(() => expect(workspace.container.querySelector(".cm-lintRange-warning")).toBeTruthy());

    deferCompare = true;
    fireEvent.click(screen.getByRole("button", { name: /MD009.*Line 3/ }));
    await waitFor(() => expect(finishVerification).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    trackVerification = true;
    act(() => { finishVerification?.(); });
    await waitFor(() => expect(verificationDigest).toBeDefined());
    await act(async () => { await verificationDigest; });
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");

    evidence = "index-2";
    fireEvent.click(screen.getByRole("button", { name: /MD009.*Line 3/ }));
    await screen.findByText("The file or rules changed. Refresh and run the check again.");
    expect(screen.getByRole("button", { name: /MD009.*Line 3/ })).toBeDisabled();
    expect(workspace.container.querySelector(".cm-lintRange-warning")).toBeNull();
  } finally {
    trackDigest.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("checks frozen Markdown changes and reports unsupported and newly stale files separately", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const project = { id: "batch", key: "batch", name: "Batch review", git: "ready", baseline: "test" } as const;
    const paths = ["docs/guide.md", "docs/replaced.markdown", "src/run.ts", "db/report.sql"];
    const changes = paths.map((path): CodeReviewChange => ({
      path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: `listed-${path}`,
    }));
    const readFile = vi.fn<CodeReviewPlatform["file"]>((_, path) => Promise.resolve(path === ".markdownlint.json"
      ? { before: null, after: { state: "missing" }, evidence: null, indexOnly: false }
      : { before: { state: "text", text: "# Guide\n" }, after: { state: "text", text: "#Guide\n" },
        evidence: path === paths[1] ? "newer-than-frozen-list" : `listed-${path}`, indexOnly: false }));
    const api: CodeReviewPlatform = {
      current: () => Promise.resolve(project),
      choose: () => Promise.resolve(null),
      changes: () => Promise.resolve({ files: changes, limited: true }),
      directory: () => Promise.resolve({ entries: [], limited: false }),
      file: readFile,
    };
    renderWorkspace(api);
    await screen.findByRole("textbox", { name: paths[0] });
    fireEvent.click(screen.getByRole("button", { name: /^Show Checks/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check Changed Files" }));
    await screen.findByText("1 checked · 2 skipped · 1 failed or stale · 0 unprocessed");
    const finding = await screen.findByRole("button", { name: /MD018.*Line 1/ });
    await waitFor(() => expect(finding).toBeEnabled());
    const file = within(screen.getByRole("complementary", { name: "Checks" })).getByRole("button", { name: /guide\.md.*docs/ });
    fireEvent.click(file);
    expect(file).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /MD018.*Line 1/ })).not.toBeInTheDocument();
    fireEvent.click(file);
    const filter = screen.getByRole("searchbox", { name: "Filter findings" });
    fireEvent.change(filter, { target: { value: "no matching rule" } });
    expect(screen.getByText("No findings match these filters.")).toBeVisible();
    fireEvent.change(filter, { target: { value: "MD018" } });
    expect(screen.getByRole("button", { name: /MD018.*Line 1/ })).toBeVisible();
    expect(screen.getByText("The Changes list is incomplete.")).toBeVisible();
    fireEvent.click(screen.getByText("Skipped and failed files"));
    expect(screen.getByText("The file or rules changed. Refresh and run the check again.")).toBeVisible();
    expect(screen.getAllByText("Checks currently support Markdown (.md and .markdown).")).toHaveLength(2);
    expect(readFile).not.toHaveBeenCalledWith(project.id, paths[2], true);
    expect(readFile).not.toHaveBeenCalledWith(project.id, paths[3], true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reviews Go and SQL diffs and preserves earlier notes after the target changes", async () => {
  localStorage.clear();
  sessionStorage.clear();
  const project = { id: "current", key: "orders", name: "orders", git: "ready", baseline: "1234567890abcdef" } as const;
  const modelPath = "models/orders.sql";
  const sourcePath = "src/orders.go";
  let evidence = "sql-v1";
  let field = "paid_at";
  const sqlChange: CodeReviewChange = { path: modelPath, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence };
  const api: CodeReviewPlatform = {
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [{ ...sqlChange, evidence }, { ...sqlChange, path: sourcePath, evidence: "go-v1" }], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: vi.fn((_, path: string) => Promise.resolve(path === modelPath
      ? { before: { state: "text" as const, text: "SELECT ordered_at FROM orders;" }, after: { state: "text" as const, text: `SELECT ${field} FROM orders;` }, evidence, indexOnly: false }
      : { before: { state: "text" as const, text: "package old" }, after: { state: "text" as const, text: "package orders" }, evidence: "go-v1", indexOnly: false })),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWorkspace(api, queryClient);

  const sidebar = within(await screen.findByRole("complementary", { name: "Changes" }));
  expect(await screen.findByRole("textbox", { name: modelPath })).toHaveAttribute("aria-readonly", "true");
  expect(screen.getByRole("textbox", { name: modelPath })).toHaveTextContent("SELECT ordered_at FROM orders");
  fireEvent.click(sidebar.getByRole("button", { name: /orders\.go/ }));
  expect(await screen.findByRole("textbox", { name: sourcePath })).toHaveTextContent("package orders");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Open files" })).getByRole("button", { name: "orders.sql" }));

  await screen.findByRole("textbox", { name: modelPath });
  const noteToggle = screen.getByRole("button", { name: /Review note.*Pending review/ });
  fireEvent.click(noteToggle);
  const notePanel = within(screen.getByRole("complementary", { name: "Review note" }));
  const note = await notePanel.findByRole("textbox", { name: "Note" });
  expect(note).toHaveFocus();
  expect(notePanel.getByRole("status")).toHaveTextContent("Pending review");
  expect(note).toHaveAccessibleDescription(`${project.baseline?.slice(0, 10)} → Working tree`);
  fireEvent.change(note, { target: { value: "Check how missing payments are handled." } });
  fireEvent.click(notePanel.getByRole("button", { name: "Close panel" }));
  expect(noteToggle).toHaveFocus();
  const tabs = within(screen.getByRole("navigation", { name: "Open files" }));
  fireEvent.click(tabs.getByRole("button", { name: "orders.go" }));
  fireEvent.click(tabs.getByRole("button", { name: "orders.sql" }));
  await screen.findByRole("textbox", { name: modelPath });
  fireEvent.click(screen.getByRole("button", { name: /Review note.*Pending review/ }));
  expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("Check how missing payments are handled.");
  fireEvent.click(screen.getByRole("button", { name: "Needs changes" }));
  await waitFor(() => expect(sidebar.getByRole("button", { name: /orders\.sql.*Needs changes/i })).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /Review note.*Needs changes/ })).toBeVisible();

  evidence = "sql-v2";
  field = "settled_at";
  fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This file changed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: modelPath })).toHaveTextContent("SELECT settled_at FROM orders;"));
  expect(sidebar.getByRole("button", { name: /orders\.sql.*Review again/i })).toBeVisible();
  fireEvent.click(screen.getByText("Notes on earlier versions"));
  expect(screen.getByText("Check how missing payments are handled.")).toBeVisible();
});

it("provides a clear clean-tree action and accessible folder navigation", async () => {
  const project = { id: "clean", key: "clean", name: "clean project", git: "ready", baseline: "abc123" } as const;
  const api: CodeReviewPlatform = {
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: vi.fn((_, path: string) => Promise.resolve({ limited: false, entries: path ? [
      { name: "example.go", path: "src/example.go", directory: false },
    ] : [
      { name: ".gitignore", path: ".gitignore", directory: false },
      { name: "src", path: "src", directory: true },
      { name: "README.md", path: "README.md", directory: false },
    ] })),
    file: vi.fn(() => Promise.resolve({ before: null, after: { state: "text" as const, text: "package main" }, evidence: null, indexOnly: false })),
  };
  renderWorkspace(api);
  expect(await screen.findByText("No changes to review.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Browse Files" }));
  const folder = await screen.findByRole("button", { name: "src" });
  expect(screen.queryByRole("button", { name: ".gitignore" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View options" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show hidden files", checked: false }));
  expect(screen.getByRole("button", { name: ".gitignore" })).toBeVisible();
  folder.focus();
  fireEvent.keyDown(folder, { key: "ArrowRight" });
  const source = await screen.findByRole("button", { name: "example.go" });
  fireEvent.keyDown(folder, { key: "ArrowRight" });
  expect(source).toHaveFocus();
  fireEvent.click(source);
  expect(await screen.findByRole("textbox", { name: "src/example.go" })).toHaveTextContent("package main");
});

it("reveals Code files and folders in Finder, including compact folders, search results and Quick Open", async () => {
  const project = { id: "finder-review", key: "finder-review", name: "Finder project", git: "folder", baseline: null } as const;
  const path = "src/reports/total.go";
  const reveal = vi.fn().mockResolvedValue({ added: 0, skipped: 0 });
  renderWorkspace({
    current: () => Promise.resolve(project), choose: vi.fn(), changes: vi.fn(),
    directory: (_, folder) => Promise.resolve({ limited: false, entries: folder
      ? [{ name: "total.go", path, directory: false }]
      : [{ name: "src", path: "src", directory: true, compactSegments: ["reports"] }] }),
    file: () => Promise.resolve({ before: null, after: { state: "text", text: "package total\n" }, evidence: null, indexOnly: false }),
    finder: { act: reveal, addProjects: vi.fn() },
    paths: () => Promise.resolve({ limited: false, paths: [path] }),
    searchContent: () => Promise.resolve({ limited: false, files: [{ path, matches: [{ line: 0, character: 8, matched: "total", before: "package ", after: "" }] }] }),
  }, new QueryClient(), undefined, false, true);
  const pick = (element: HTMLElement, target: string) => {
    fireEvent.contextMenu(element);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(reveal).toHaveBeenLastCalledWith({ kind: "entry", projectId: project.id, path: target }, "reveal");
  };
  const compacted = await screen.findByRole("button", { name: "src / reports" });
  pick(within(compacted).getByText("src"), "src");
  pick(within(compacted).getByText("reports"), "src/reports");
  fireEvent.click(compacted);
  const file = await screen.findByRole("button", { name: "total.go" });
  pick(file, path);
  fireEvent.click(file);
  pick(await screen.findByRole("textbox", { name: path }), path);

  fireEvent.click(projectNavigator().getByRole("button", { name: "Search" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Project Content" }), { target: { value: "total" } });
  pick(await screen.findByRole("option", { name: /package total/ }), path);

  act(() => { window.dispatchEvent(new Event("nodalstudio:code-quick-open")); });
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.contextMenu(await dialog.findByRole("option", { name: /total\.go/ }));
  fireEvent.click(dialog.getByRole("menuitem", { name: "Reveal in Finder" }));
  expect(reveal).toHaveBeenLastCalledWith({ kind: "entry", projectId: project.id, path }, "reveal");
});

it("opens source from Files and Quick Open while Changes opens a diff", async () => {
  const project = { id: "ide", key: "ide", name: "IDE project", git: "ready", baseline: "abc123" } as const;
  const path = "src/services/OrderReport.go";
  const other = "models/paid_orders.sql";
  const api: CodeReviewPlatform = {
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ limited: false, files: [
      { path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "go-1" },
    ] }),
    paths: () => Promise.resolve({ limited: false, paths: [path, other] }),
    directory: () => Promise.resolve({ limited: false, entries: [{ name: "OrderReport.go", path, directory: false }] }),
    file: (_, filePath, compare) => Promise.resolve({
      before: compare ? { state: "text", text: 'package reports\n\nconst timestamp = "ordered_at"' } : null,
      after: { state: "text", text: filePath === path ? 'package reports\n\nconst timestamp = "paid_at"' : "select paid_at from orders" },
      evidence: compare ? "go-1" : null, indexOnly: false,
    }),
  };
  renderWorkspace(api);
  const sidebar = within(await screen.findByRole("complementary", { name: "Changes" }));
  expect(await screen.findByRole("textbox", { name: path })).toHaveTextContent("ordered_at");
  const viewSwitcher = screen.getByRole("group", { name: "File view" });
  const breadcrumbs = screen.getByRole("navigation", { name: "File path" });
  const actions = screen.getByRole("group", { name: "Source actions" });
  expect(viewSwitcher.compareDocumentPosition(breadcrumbs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(breadcrumbs.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(viewSwitcher).getByRole("button", { name: "Diff", pressed: true })).toBeVisible();
  const crumbs = within(breadcrumbs).getAllByRole("listitem");
  expect(crumbs.map((item) => item.textContent)).toEqual(["src", "services", "OrderReport.go"]);
  expect(crumbs[2]).toHaveAttribute("aria-current", "page");
  fireEvent.click(projectNavigator().getByRole("button", { name: "Files" }));
  fireEvent.click(await sidebar.findByRole("button", { name: "OrderReport.go" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: path })).not.toHaveTextContent("ordered_at"));
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  const find = within(screen.getByRole("search", { name: "Find in file" }));
  const findField = find.getByRole("searchbox", { name: "Find in file" });
  const nextMatch = find.getByRole("button", { name: "Next match" });
  expect(findField).toHaveFocus();
  expect(nextMatch).toBeDisabled();
  fireEvent.input(findField, { target: { value: "paid_at" } });
  expect(find.getByRole("status")).toHaveTextContent("1 match");
  fireEvent.keyDown(findField, { key: "Enter" });
  expect(find.getByRole("status")).toHaveTextContent("Match 1 of 1");
  fireEvent.click(find.getByRole("button", { name: "Use regular expression" }));
  fireEvent.input(findField, { target: { value: "[" } });
  expect(findField).toHaveAttribute("aria-invalid", "true");
  expect(find.getByRole("status")).toHaveTextContent("Invalid regular expression");
  fireEvent.keyDown(findField, { key: "Escape" });
  expect(screen.queryByRole("search", { name: "Find in file" })).not.toBeInTheDocument();
  const goToLine = screen.getByRole("button", { name: "Go to line" });
  const source = EditorView.findFromDOM(screen.getByRole("textbox", { name: path }));
  expect(source).not.toBeNull();
  act(() => {
    if (source) source.dispatch({ selection: { anchor: source.state.doc.line(3).from + 4 } });
  });
  expect(goToLine).toHaveTextContent("Ln 3, Col 5");

  act(() => { window.dispatchEvent(new Event("nodalstudio:code-quick-open")); });
  fireEvent.click(await screen.findByRole("button", { name: "Find in File" }));
  const quickFind = await screen.findByRole("searchbox", { name: "Find in file" });
  expect(quickFind).toHaveFocus();
  fireEvent.keyDown(quickFind, { key: "Escape" });
  act(() => { window.dispatchEvent(new Event("nodalstudio:code-quick-open")); });
  const input = await screen.findByRole("combobox", { name: "Open File Quickly" });
  fireEvent.change(input, { target: { value: "paid_sql:1:8" } });
  expect(await screen.findByRole("option", { name: /paid_orders\.sql/ })).toBeVisible();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("textbox", { name: other })).toHaveTextContent("select paid_at");
  expect(screen.getByRole("button", { name: "Go to line" })).toHaveTextContent("Ln 1, Col 8");
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  expect(await screen.findByRole("textbox", { name: path })).not.toHaveTextContent("ordered_at");
  expect(screen.getByRole("button", { name: "Go to line" })).toHaveTextContent("Ln 3, Col 5");
  fireEvent.click(projectNavigator().getByRole("button", { name: "Changes (1)" }));
  fireEvent.click(await sidebar.findByRole("button", { name: /OrderReport\.go.*Modified/ }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: path })).toHaveTextContent("ordered_at"));
});

it("targets individual files in the tree, tabs and reader without changing the repository", async () => {
  const project = { id: "menu", key: "menu", name: "Context menus", git: "ready", baseline: "abc123" } as const;
  const path = "src/reports/summary.ts";
  const other = "README.md";
  const api: CodeReviewPlatform = {
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ limited: false, files: [
      { path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "edit-1" },
    ] }),
    directory: (_, folder) => Promise.resolve({ limited: false, entries: folder === "" ? [
      { name: "src", path: "src", directory: true, compactSegments: ["reports"] },
      { name: other, path: other, directory: false },
    ] : [{ name: "summary.ts", path, directory: false }] }),
    file: (_, name, compare) => Promise.resolve({
      before: compare ? { state: "text", text: "export const oldName = 1;" } : null,
      after: { state: "text", text: name === path ? "export const report = 1;" : "# Reports" },
      evidence: compare ? "edit-1" : null, indexOnly: false,
    }),
  };
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  try {
    renderWorkspace(api);
    const sidebar = within(await screen.findByRole("complementary", { name: "Changes" }));
    const tabs = within(screen.getByRole("navigation", { name: "Open files" }));
    await screen.findByRole("textbox", { name: path });

    fireEvent.contextMenu(tabs.getByRole("button", { name: "summary.ts" }), { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Files" }));
    const row = await sidebar.findByRole("button", { name: "summary.ts" });
    expect(sidebar.getByRole("button", { name: "src / reports" })).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveFocus();

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Review Note" }));
    expect(screen.getByRole("complementary", { name: "Review note" })).toBeVisible();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Source" }));
    const reader = await screen.findByRole("textbox", { name: path });
    expect(reader).not.toHaveTextContent("oldName");

    fireEvent.contextMenu(reader);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path and Line" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${path}:1`));

    const sibling = sidebar.getByRole("button", { name: other });
    fireEvent.contextMenu(sibling);
    expect(screen.queryByRole("menuitem", { name: "Open Diff" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(other));
    expect(reader).toBeVisible();
    fireEvent.click(sibling);
    await screen.findByRole("textbox", { name: other });
    fireEvent.contextMenu(tabs.getByRole("button", { name: "summary.ts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Other Tabs" }));
    expect(tabs.queryByRole("button", { name: other })).not.toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: path })).toBeVisible();
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("groups project content hits and opens the exact working-tree match even when the diff is stale", async () => {
  const project = { id: "content", key: "content", name: "Project search", git: "ready", baseline: "abc123" } as const;
  const first = "lib/alpha.ts";
  const second = "jobs/beta.py";
  let secondText = "# total\r\n# 😀 total\r\n";
  const searchContent = vi.fn<NonNullable<CodeReviewPlatform["searchContent"]>>().mockResolvedValue({ limited: false, files: [
    { path: first, matches: [{ line: 0, character: 6, before: "const ", matched: "total", after: " = 1" }] },
    { path: second, matches: [
      { line: 0, character: 2, before: "# ", matched: "total", after: "" },
      { line: 1, character: 5, before: "# 😀 ", matched: "total", after: "" },
    ] },
  ] });
  const api: CodeReviewPlatform = {
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ limited: false, files: [
      { path: second, previousPath: null, kind: "modified", staged: true, indexOnly: true, evidence: "old-diff" },
    ] }),
    directory: () => Promise.resolve({ limited: false, entries: [] }),
    paths: () => Promise.resolve({ limited: false, paths: [first, second] }),
    searchContent,
    file: (_, path, compare) => compare ? Promise.reject(new Error("codeReviewStale"))
      : Promise.resolve({ after: { state: "text", text: path === first ? "const total = 1" : secondText }, before: null, evidence: null, indexOnly: false }),
  };
  renderWorkspace(api);
  await screen.findByRole("button", { name: "Changes (1)" });

  act(() => { window.dispatchEvent(new Event("nodalstudio:code-quick-open")); });
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Project Content" }));
  const input = within(dialog).getByRole("combobox", { name: "Project Content" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "total" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const group = await within(dialog).findByRole("group", { name: second });
  fireEvent.click(within(group).getAllByRole("option")[1]);
  const reader = await screen.findByRole("textbox", { name: second });
  const editor = EditorView.findFromDOM(reader);
  expect(editor?.state.selection.main.from).toBe((editor?.state.doc.line(2).from ?? 0) + 5);
  expect(editor?.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe("total");
  expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const sidebar = within(screen.getByRole("complementary", { name: "Search" }));
  expect(sidebar.getByRole("combobox", { name: "Project Content" })).toHaveValue("total");
  expect(sidebar.getByText("3 matching lines · 2 files")).toBeVisible();
  fireEvent.click(within(sidebar.getByRole("group", { name: first })).getByRole("option"));
  expect(await screen.findByRole("textbox", { name: first })).toBeVisible();
  const activityBar = projectNavigator();
  const files = activityBar.getByRole("button", { name: "Files" });
  fireEvent.click(files);
  files.focus();
  const search = activityBar.getByRole("button", { name: "Search", pressed: false });
  fireEvent.keyDown(files, { key: "ArrowDown" });
  expect(search).toHaveFocus();
  expect(files).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(search);
  expect(search).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(search);
  expect(screen.queryByRole("complementary", { name: "Search" })).toBeNull();
  expect(search).toBeVisible();
  fireEvent.click(search);
  expect(sidebar.getByRole("combobox", { name: "Project Content" })).toHaveValue("total");
  secondText = "# shifted\n# no longer matches";
  fireEvent.click(within(sidebar.getByRole("group", { name: second })).getAllByRole("option")[1]);
  expect(await screen.findByText("The file changed. Search again to find the current line.")).toBeVisible();
  expect(searchContent).toHaveBeenCalledExactlyOnceWith(project.id, "total");
});

it("marks collapsed ancestors from Changes and keeps deleted files reachable after their directory disappears", async () => {
  const project = { id: "marked", key: "marked", name: "Marked project", git: "ready", baseline: "abc123" } as const;
  const source = "services/reporting/summary.go";
  const moved = "services/reporting/report.py";
  const removed = "legacy/archive/old.sql";
  const added = "tools/check.ts";
  let changes: CodeReviewChange[] = [
    { path: source, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "go" },
    { path: moved, previousPath: "legacy/report.py", kind: "renamed", staged: true, indexOnly: false, evidence: "py" },
    { path: removed, previousPath: null, kind: "deleted", staged: false, indexOnly: false, evidence: "sql" },
    { path: added, previousPath: null, kind: "added", staged: false, indexOnly: false, evidence: "ts" },
  ];
  const folders: Record<string, Array<{ path: string; name: string; directory: boolean }>> = {
    "": [
      { path: "services", name: "services", directory: true },
      { path: "services-backup", name: "services-backup", directory: true },
    ],
    services: [{ path: "services/reporting", name: "reporting", directory: true }],
    "services/reporting": [
      { path: source, name: "summary.go", directory: false },
      { path: moved, name: "report.py", directory: false },
    ],
  };
  const directory = vi.fn((_: string, path: string) => Promise.resolve({ entries: folders[path] ?? [], limited: false }));
  const api: CodeReviewPlatform = {
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: changes, limited: false }),
    directory,
    file: (_, path, compare) => Promise.resolve({
      before: compare ? { state: "text", text: path === removed ? "select 1;" : "original" } : null,
      after: path === removed ? { state: "missing" } : { state: "text", text: "revised" },
      evidence: changes.find((entry) => entry.path === path)?.evidence ?? null,
      indexOnly: false,
    }),
  };
  renderWorkspace(api);
  const sidebar = within(await screen.findByRole("complementary", { name: "Changes" }));
  expect(await sidebar.findByRole("button", { name: /summary\.go.*Modified/ })).toBeVisible();
  expect(sidebar.getByRole("button", { name: /report\.py.*Renamed/ })).toBeVisible();
  expect(sidebar.getByRole("button", { name: /old\.sql.*Deleted/ })).toBeVisible();
  fireEvent.click(projectNavigator().getByRole("button", { name: "Files" }));
  const services = await sidebar.findByRole("button", { name: "services", expanded: false });
  expect(services).toHaveAccessibleDescription("Contains changed files");
  expect(services).toHaveAttribute("data-folder-change", "modified");
  expect(sidebar.getByRole("button", { name: "services-backup" })).not.toHaveAttribute("aria-description");
  const tools = sidebar.getByRole("button", { name: "tools" });
  expect(tools).toHaveAccessibleDescription("Contains added files");
  expect(tools).toHaveAttribute("data-folder-change", "added");
  expect(directory.mock.calls.map(([, path]) => path)).not.toContain("services");
  fireEvent.click(services);
  const reporting = await sidebar.findByRole("button", { name: "reporting", expanded: false });
  expect(reporting).toHaveAccessibleDescription("Contains changed files");
  fireEvent.click(reporting);
  expect(await sidebar.findByRole("button", { name: "summary.go" })).toHaveAccessibleDescription("Modified");
  expect(sidebar.getByRole("button", { name: "report.py" })).toHaveAccessibleDescription("Renamed");
  fireEvent.click(services);
  expect(services).toHaveAccessibleDescription("Contains changed files");

  const legacy = sidebar.getByRole("button", { name: "legacy", expanded: false });
  expect(legacy).toHaveAccessibleDescription("Contains deleted files");
  expect(legacy).toHaveAttribute("data-folder-change", "deleted");
  fireEvent.click(legacy);
  const archive = await sidebar.findByRole("button", { name: "archive", expanded: false });
  expect(archive).toHaveAccessibleDescription("Contains deleted files");
  fireEvent.click(archive);
  const deleted = await sidebar.findByRole("button", { name: "old.sql" });
  expect(deleted).toHaveAccessibleDescription("Deleted");
  expect(directory.mock.calls.map(([, path]) => path)).not.toContain("legacy");
  fireEvent.click(deleted);
  expect(await screen.findByRole("textbox", { name: removed })).toHaveTextContent("select 1;");
  expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute("aria-pressed", "true");

  changes = [...changes,
    { path: "tools/old.ts", kind: "deleted", previousPath: null, staged: false, indexOnly: false, evidence: null },
    { path: "services/reporting/conflict.go", kind: "conflict", previousPath: null, staged: false, indexOnly: false, evidence: null },
  ];
  fireEvent.click(sidebar.getByRole("button", { name: "Refresh files" }));
  await waitFor(() => expect(services).toHaveAccessibleDescription("Contains files with conflicts"));
  expect(services).toHaveAttribute("data-folder-change", "conflict");
  expect(tools).toHaveAccessibleDescription("Contains changed files");
  expect(tools).toHaveAttribute("data-folder-change", "modified");

  changes = [];
  fireEvent.click(sidebar.getByRole("button", { name: "Refresh files" }));
  expect(await projectNavigator().findByRole("button", { name: "Changes (0)" })).toBeVisible();
  expect(services).not.toHaveAttribute("aria-description");
  expect(sidebar.queryByRole("button", { name: "legacy" })).not.toBeInTheDocument();
});

it("compacts single-folder paths while keeping real file paths, visible siblings and change badges", { timeout: 15_000 }, async () => {
  const project = { id: "compact", key: "compact", name: "Java project", git: "ready", baseline: "abc123" } as const;
  const java = "src/test/java";
  const chain = ["com", "wahool", "erp", "web"];
  const leaf = `${java}/${chain.join("/")}`;
  const source = `${leaf}/ReviewTest.java`;
  const deleted = `${java}/com/Removed.java`;
  const folder = (path: string, name: string, compactSegments?: string[]) => ({ path: path ? `${path}/${name}` : name, name, directory: true, compactSegments });
  const file = (path: string, name: string) => ({ path: `${path}/${name}`, name, directory: false });
  const folders: Record<string, CodeReviewDirectory["entries"]> = {
    "": [folder("", "src")],
    src: [folder("src", "main"), folder("src", "test")],
    "src/test": [folder("src/test", "java", chain), folder("src/test", "resources")],
    [java]: [folder(java, "com", chain.slice(1)), file(java, ".keep")],
    [leaf]: [file(leaf, "ReviewTest.java")],
  };
  let parent = java;
  for (const [i, segment] of chain.entries()) {
    const path = `${parent}/${segment}`;
    if (i < chain.length - 1) folders[path] = [folder(path, chain[i + 1], chain.slice(i + 2))];
    parent = path;
  }
  const document = vi.fn((_: string, path: string) => Promise.resolve({
    before: { state: "text" as const, text: "class Previous {}" },
    after: path === deleted ? { state: "missing" as const } : { state: "text" as const, text: "class ReviewTest {}" },
    evidence: null, indexOnly: false,
  }));
  const directory = vi.fn((_: string, path: string, compact?: CodeReviewCompactFolders) => Promise.resolve({ limited: false,
    entries: path === "src/test" && compact === "all" ? [folder(path, "java"), folder(path, "resources")] : folders[path] ?? [],
  }));
  let changes: CodeReviewChange[] = [{ path: source, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: null }];
  renderWorkspace({
    current: () => Promise.resolve(project), choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: changes, limited: false }), directory, file: document,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Files" }));
  const sidebar = within(await screen.findByRole("complementary", { name: "Project files" }));
  fireEvent.click(await sidebar.findByRole("button", { name: "src" }));
  fireEvent.click(await sidebar.findByRole("button", { name: "test" }));
  const row = await sidebar.findByRole("button", { name: "java / com / wahool / erp / web", expanded: false });
  expect(row).toHaveAccessibleDescription("Contains changed files");
  expect(row).toHaveAttribute("data-folder-change", "modified");
  expect(row).toHaveAttribute("title", `${leaf} · Contains changed files`);
  const resources = sidebar.getByRole("button", { name: "resources" });
  fireEvent.click(resources);
  await waitFor(() => expect(directory).toHaveBeenCalledWith(project.id, "src/test/resources", "visible"));
  await waitFor(() => expect(resources.parentElement).toHaveTextContent(/^resources$/));
  expect(sidebar.queryByText("No files to show.")).not.toBeInTheDocument();
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowRight" });
  const target = await sidebar.findByRole("button", { name: "ReviewTest.java" });
  expect(target).toHaveAccessibleDescription("Modified");
  fireEvent.keyDown(row, { key: "ArrowRight" });
  expect(target).toHaveFocus();
  fireEvent.keyDown(target, { key: "ArrowLeft" });
  expect(row).toHaveFocus();
  const accessed = directory.mock.calls.map(([, path]) => path);
  expect(accessed).toContain(leaf);
  expect(accessed).not.toContain(java);
  fireEvent.click(target);
  expect(await screen.findByRole("textbox", { name: source })).toHaveTextContent("class ReviewTest");
  expect(document).toHaveBeenCalledWith(project.id, source, true);

  const options = sidebar.getByRole("button", { name: "View options" });
  fireEvent.keyDown(options, { key: "ArrowDown" });
  expect(options).toHaveAttribute("aria-expanded", "true");
  const menu = () => within(screen.getByRole("menu", { name: /View options/ }));
  const compact = menu().getByRole("menuitemcheckbox", { name: "Compact folders", checked: true });
  expect(compact).toHaveFocus();
  fireEvent.keyDown(compact, { key: "Enter" });
  expect(options).toHaveFocus();
  expect(options).toHaveAttribute("aria-expanded", "false");
  expect(await sidebar.findByRole("button", { name: "web", expanded: true })).toBeVisible();
  expect(await sidebar.findByRole("button", { name: "ReviewTest.java" })).toHaveAttribute("aria-current", "true");
  expect(sidebar.queryByRole("button", { name: /java \/ com/ })).not.toBeInTheDocument();
  fireEvent.click(options);
  fireEvent.click(menu().getByRole("menuitemcheckbox", { name: "Compact folders", checked: false }));
  await sidebar.findByRole("button", { name: "java / com / wahool / erp / web" });

  fireEvent.click(options);
  fireEvent.keyDown(menu().getByRole("menuitemcheckbox", { name: "Compact folders", checked: true }), { key: "ArrowDown" });
  const hidden = menu().getByRole("menuitemcheckbox", { name: "Show hidden files", checked: false });
  expect(hidden).toHaveFocus();
  fireEvent.keyDown(hidden, { key: " " });
  expect(await sidebar.findByRole("button", { name: ".keep" })).toBeVisible();
  expect(sidebar.getByRole("button", { name: "java", expanded: true })).toBeVisible();
  fireEvent.click(options);
  fireEvent.click(menu().getByRole("menuitemcheckbox", { name: "Show hidden files", checked: true }));
  await sidebar.findByRole("button", { name: "java / com / wahool / erp / web" });

  changes = [...changes, { path: deleted, previousPath: null, kind: "deleted", staged: false, indexOnly: false, evidence: null }];
  fireEvent.click(sidebar.getByRole("button", { name: "Refresh files" }));
  expect(await sidebar.findByRole("button", { name: "java / com", expanded: true })).toHaveAccessibleDescription("Contains changed files");
  expect(await sidebar.findByRole("button", { name: "Removed.java" })).toHaveAccessibleDescription("Deleted");
});

it("opens definitions from a modifier-click, displays dependency source and restores each caller on Back", async () => {
  const project = { id: "definitions", key: "definitions", name: "Definitions", git: "folder", baseline: null } as const;
  const main = "\n\nconst value = helper();\n";
  const helper = "function helper() {\n  return remote();\n}";
  const dependency = "export function remote() { return 1; }";
  let enabled = false;
  const definition = vi.fn((_: string, input: CodeDefinitionRequest): Promise<CodeDefinitionResult> => {
    enabled ||= input.enable;
    if (!enabled) return Promise.resolve({ state: "disabled" });
    return Promise.resolve({ state: "resolved", targets: [input.origin.kind === "workspace" && input.origin.path === "main.ts"
      ? { path: "helper.ts", position: { line: 1, character: 9 } }
      : { path: "/dependencies/remote.ts", sourceId: "remote-id", position: { line: 0, character: 16 } },
    ] });
  });
  const definitionSource = vi.fn(() => Promise.resolve(dependency));
  renderWorkspace({
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: () => Promise.resolve({ entries: [{ name: "main.ts", path: "main.ts", directory: false }], limited: false }),
    file: (_, path) => Promise.resolve({ before: null, after: { state: "text", text: path === "main.ts" ? main : helper }, evidence: null, indexOnly: false }),
    definition,
    definitionSource,
  });
  fireEvent.click(await screen.findByRole("button", { name: "main.ts" }));
  const caller = await screen.findByRole("textbox", { name: "main.ts" });
  const position = vi.spyOn(EditorView.prototype, "posAndSideAtCoords").mockReturnValue({ pos: main.indexOf("helper"), assoc: 1 });
  const isMac = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  const line = caller.querySelectorAll(".cm-line")[2];
  try {
    fireEvent.mouseMove(line, { clientX: 1, clientY: 1 });
    expect(caller.querySelector(".cm-definition-link")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(caller.querySelector(".cm-definition-link")).toHaveTextContent("helper");
    expect(definition).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { key: "Meta" });
    expect(caller.querySelector(".cm-definition-link")).not.toBeInTheDocument();
    fireEvent.mouseMove(line, { metaKey: true, clientX: 1, clientY: 1 });
    expect(caller.querySelector(".cm-definition-link")).toHaveTextContent("helper");
    fireEvent.mouseLeave(caller);
    expect(caller.querySelector(".cm-definition-link")).not.toBeInTheDocument();
    fireEvent.mouseDown(line, { metaKey: true, button: 0, clientX: 1, clientY: 1 });
  } finally {
    position.mockRestore();
    isMac.mockRestore();
  }
  const trust = within(await screen.findByRole("dialog", { name: "Go to definition" }));
  expect(definition).toHaveBeenLastCalledWith(project.id, expect.objectContaining({
    origin: { kind: "workspace", path: "main.ts" }, position: { line: 2, character: 14 }, enable: false,
  }));
  fireEvent.click(trust.getByRole("button", { name: "Enable definition navigation" }));
  const helperSource = await screen.findByRole("textbox", { name: "helper.ts" });
  expect(screen.getByRole("button", { name: "Go to line" })).toHaveTextContent("Ln 2, Col 10");
  fireEvent.keyDown(helperSource, { key: "F12" });
  expect(await screen.findByRole("textbox", { name: "/dependencies/remote.ts" })).toHaveTextContent(dependency);
  expect(definitionSource).toHaveBeenCalledWith(project.id, "remote-id");
  expect(screen.getByText("Dependency source · Read only")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Back to previous location" }));
  await screen.findByRole("textbox", { name: "helper.ts" });
  expect(screen.getByRole("button", { name: "Go to line" })).toHaveTextContent("Ln 2, Col 10");
  fireEvent.click(screen.getByRole("button", { name: "Back to previous location" }));
  await screen.findByRole("textbox", { name: "main.ts" });
  expect(screen.getByRole("button", { name: "Go to line" })).toHaveTextContent("Ln 3, Col 15");
  expect(screen.queryByRole("button", { name: "Back to previous location" })).not.toBeInTheDocument();
});

it("highlights only the current file's resolved symbol and clears marks while finding text", async () => {
  const project = { id: "references", key: "references", name: "References", git: "folder", baseline: null } as const;
  const path = "main.go";
  const text = "package main\nfunc sum(value int) int { return value + value }\nfunc other(value int) int { return value }";
  const ranges = [9, 33, 41].map((character) => ({
    start: { line: 1, character }, end: { line: 1, character: character + 5 },
  }));
  let finish: ((ranges: CodeDocumentHighlightRange[]) => void) | undefined;
  const documentHighlights = vi.fn()
    .mockResolvedValueOnce(ranges)
    .mockImplementationOnce(() => new Promise<CodeDocumentHighlightRange[]>((resolve) => { finish = resolve; }));
  renderWorkspace({
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [], limited: false }),
    directory: () => Promise.resolve({ entries: [{ name: path, path, directory: false }], limited: false }),
    file: () => Promise.resolve({ before: null, after: { state: "text", text }, evidence: null, indexOnly: false }),
    documentHighlights,
  });
  fireEvent.click(await screen.findByRole("button", { name: path }));
  const source = await screen.findByRole("textbox", { name: path });
  const editor = EditorView.findFromDOM(source)!;
  const select = (line: number, value: string) => {
    const row = editor.state.doc.line(line);
    const anchor = row.from + row.text.indexOf(value);
    act(() => editor.dispatch({ selection: { anchor, head: anchor + value.length } }));
  };
  const marks = () => Array.from(source.querySelectorAll(".cm-code-reference"));
  select(2, "value");
  await waitFor(() => expect(marks().map((mark) => mark.textContent)).toEqual(["value", "value", "value"]));
  expect(source.querySelectorAll(".cm-line")[2].querySelector(".cm-code-reference")).toBeNull();
  expect(documentHighlights).toHaveBeenCalledWith(project.id, {
    origin: { kind: "workspace", path }, position: { line: 1, character: 9 }, text,
  });

  select(3, "value");
  expect(marks()).toHaveLength(0);
  await waitFor(() => expect(documentHighlights).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await act(() => {
    finish?.(ranges);
    return Promise.resolve();
  });
  expect(marks()).toHaveLength(0);
});

it("uses the controlled outline panel to locate a nested symbol in Source", async () => {
  const project = { id: "outline", key: "outline", name: "Review project", git: "ready", baseline: "abc123" } as const;
  const path = "report.go";
  const text = "package main\ntype Report struct{}\nfunc (Report) summarize() {}";
  let enabled = false;
  const documentOutline = vi.fn((_: string, input: CodeDocumentOutlineRequest): Promise<CodeDocumentOutlineResult> => {
    if (input.enable) {
      enabled = true;
      return Promise.resolve({ state: "serverFailed", command: "gopls" });
    }
    if (!enabled) return Promise.resolve({ state: "disabled" });
    return Promise.resolve({ state: "ready", symbols: [{ name: "Report", kind: 23, position: { line: 1, character: 5 },
      children: [{ name: "summarize", kind: 6, position: { line: 2, character: 14 }, children: [] }] }] });
  });
  const layout = renderWorkspace({
    current: () => Promise.resolve(project),
    choose: () => Promise.resolve(null),
    changes: () => Promise.resolve({ files: [{ path, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "first" }], limited: false }),
    directory: () => Promise.resolve({ entries: [], limited: false }),
    file: () => Promise.resolve({ before: { state: "text", text: "package main" }, after: { state: "text", text }, evidence: "first", indexOnly: false }),
    documentOutline,
  });

  const source = await screen.findByRole("textbox", { name: path });
  expect(getComputedStyle(source.closest(".cm-scroller")!).cursor).toBe("text");
  expect(screen.queryByRole("complementary", { name: "Outline" })).not.toBeInTheDocument();
  expect(documentOutline).not.toHaveBeenCalled();
  layout.openOutline(true);
  const panel = within(await screen.findByRole("complementary", { name: "Outline" }));
  fireEvent.click(await panel.findByRole("button", { name: "Enable language services" }));
  await waitFor(() => expect(documentOutline).toHaveBeenCalledWith(project.id, { origin: { kind: "workspace", path }, text, enable: true }));
  expect(await panel.findByText(/Check that gopls can run/)).toBeVisible();
  fireEvent.click(panel.getByRole("button", { name: "Retry outline" }));
  fireEvent.click(await panel.findByRole("button", { name: "Collapse Report" }));
  expect(panel.queryByRole("button", { name: "summarize" })).not.toBeInTheDocument();
  fireEvent.click(panel.getByRole("button", { name: "Expand Report" }));
  fireEvent.click(panel.getByRole("button", { name: "summarize" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Go to line" })).toHaveTextContent("Ln 3, Col 15"));
  expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
  layout.openOutline(false);
  expect(screen.queryByRole("complementary", { name: "Outline" })).not.toBeInTheDocument();
});
