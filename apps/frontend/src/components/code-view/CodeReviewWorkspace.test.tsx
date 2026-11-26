import { EditorView } from "@codemirror/view";
import { webcrypto } from "node:crypto";
import { lint } from "markdownlint/sync";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CodeDefinitionRequest, CodeDefinitionResult, CodeDocumentHighlightRange, CodeDocumentOutlineRequest, CodeReviewCompactFolders,
  CodeDocumentOutlineResult, CodeReviewChange, CodeReviewDirectory, CodeReviewPlatform } from "../../platform/code-review";
import { CodeReviewWorkspace } from "./CodeReviewWorkspace";

vi.mock("./code-review-checks", async (original) => {
  const module = await original<typeof import("./code-review-checks")>();
  return { ...module, checkMarkdown: vi.fn<typeof module.checkMarkdown>(({ text, config, limit }) => {
    const findings = lint({ strings: { markdown: text }, config }).markdown;
    return Promise.resolve({ version: "0.42.2", findings: findings.slice(0, limit), total: findings.length });
  }) };
});

function renderWorkspace(api: CodeReviewPlatform, client = new QueryClient()) {
  const setSidebarOpen = vi.fn();
  const workspace = (outlineOpen: boolean) => <QueryClientProvider client={client}>
    <CodeReviewWorkspace api={api} sidebarId="project-sidebar" sidebarOpen setSidebarOpen={setSidebarOpen}
      outlineId="code-outline" outlineOpen={outlineOpen} eslintAvailability={api.eslint ? "enabled" : "eslintUnavailable"} />
  </QueryClientProvider>;
  const result = render(workspace(false));
  return { ...result, openOutline: (open: boolean) => result.rerender(workspace(open)) };
}

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});

afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

it("checks the displayed index diff, expands a folded result and rejects a stale jump", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const project = { id: "markdown", key: "markdown", name: "Markdown review", git: "ready", baseline: "test" } as const;
    const path = "docs/guide.md";
    const before = ["# Guide", "", "Legacy line   ", "", ...Array.from({ length: 24 }, (_, i) => `Step ${i}\n`), "End", ""].join("\n");
    const after = before.replace("End", "Changed line   ");
    const change: CodeReviewChange = { path, previousPath: null, kind: "modified", staged: true, indexOnly: true, evidence: "index-1" };
    let evidence = "index-1";
    const api: CodeReviewPlatform = {
      current: () => Promise.resolve(project),
      choose: () => Promise.resolve(null),
      changes: () => Promise.resolve({ files: [change], limited: false }),
      directory: () => Promise.resolve({ entries: [], limited: false }),
      file: (_, file, compare) => Promise.resolve(file === ".markdownlint.json"
        ? { before: null, after: { state: "text", text: '{"default":false,"MD009":"warning"}' }, evidence: null, indexOnly: false }
        : compare ? { before: { state: "text", text: before }, after: { state: "text", text: after }, evidence, indexOnly: true }
          : { before: null, after: { state: "text", text: "# Working tree\n" }, evidence: null, indexOnly: false }),
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

    evidence = "index-2";
    fireEvent.click(screen.getByRole("button", { name: /MD009.*Line 3/ }));
    await screen.findByText("The file or rules changed. Refresh and run the check again.");
    expect(screen.getByRole("button", { name: /MD009.*Line 3/ })).toBeDisabled();
    expect(workspace.container.querySelector(".cm-lintRange-warning")).toBeNull();
  } finally {
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

  const sidebar = within(await screen.findByRole("complementary", { name: "Project files" }));
  expect(await screen.findByRole("textbox", { name: modelPath })).toHaveAttribute("aria-readonly", "true");
  expect(screen.getByRole("textbox", { name: modelPath })).toHaveTextContent("SELECT ordered_at FROM orders");
  fireEvent.click(sidebar.getByRole("button", { name: /orders\.go/ }));
  expect(await screen.findByRole("textbox", { name: sourcePath })).toHaveTextContent("package orders");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Open files" })).getByRole("button", { name: "orders.sql" }));

  await screen.findByRole("textbox", { name: modelPath });
  fireEvent.click(screen.getByRole("button", { name: /Review note.*Pending review/ }));
  const note = await screen.findByRole("textbox", { name: "Review note" });
  fireEvent.change(note, { target: { value: "Check how missing payments are handled." } });
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  const tabs = within(screen.getByRole("navigation", { name: "Open files" }));
  fireEvent.click(tabs.getByRole("button", { name: "orders.go" }));
  fireEvent.click(tabs.getByRole("button", { name: "orders.sql" }));
  await screen.findByRole("textbox", { name: modelPath });
  fireEvent.click(screen.getByRole("button", { name: /Review note.*Pending review/ }));
  expect(screen.getByRole("textbox", { name: "Review note" })).toHaveValue("Check how missing payments are handled.");
  fireEvent.click(screen.getByRole("button", { name: "Needs changes" }));
  await waitFor(() => expect(sidebar.getByRole("button", { name: /orders\.sql.*Needs changes/i })).toBeInTheDocument());

  evidence = "sql-v2";
  field = "settled_at";
  fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This file changed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh project" }));
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
  fireEvent.click(screen.getByRole("checkbox", { name: "Show hidden files" }));
  expect(screen.getByRole("button", { name: ".gitignore" })).toBeVisible();
  folder.focus();
  fireEvent.keyDown(folder, { key: "ArrowRight" });
  const source = await screen.findByRole("button", { name: "example.go" });
  fireEvent.keyDown(folder, { key: "ArrowRight" });
  expect(source).toHaveFocus();
  fireEvent.click(source);
  expect(await screen.findByRole("textbox", { name: "src/example.go" })).toHaveTextContent("package main");
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
  const sidebar = within(await screen.findByRole("complementary", { name: "Project files" }));
  expect(await screen.findByRole("textbox", { name: path })).toHaveTextContent("ordered_at");
  const crumbs = within(screen.getByRole("navigation", { name: "File path" })).getAllByRole("listitem");
  expect(crumbs.map((item) => item.textContent)).toEqual(["src", "services", "OrderReport.go"]);
  expect(crumbs[2]).toHaveAttribute("aria-current", "page");
  fireEvent.click(sidebar.getByRole("button", { name: "Files" }));
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
  fireEvent.click(sidebar.getByRole("button", { name: "Changes (1)" }));
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
    const sidebar = within(await screen.findByRole("complementary", { name: "Project files" }));
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
  const sidebar = within(screen.getByRole("complementary", { name: "Project files" }));
  expect(sidebar.getByRole("combobox", { name: "Project Content" })).toHaveValue("total");
  expect(sidebar.getByText("3 matching lines · 2 files")).toBeVisible();
  fireEvent.click(within(sidebar.getByRole("group", { name: first })).getByRole("option"));
  expect(await screen.findByRole("textbox", { name: first })).toBeVisible();
  fireEvent.click(sidebar.getByRole("button", { name: "Files" }));
  fireEvent.click(sidebar.getByRole("button", { name: "Search" }));
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
  let changes: CodeReviewChange[] = [
    { path: source, previousPath: null, kind: "modified", staged: false, indexOnly: false, evidence: "go" },
    { path: moved, previousPath: "legacy/report.py", kind: "renamed", staged: true, indexOnly: false, evidence: "py" },
    { path: removed, previousPath: null, kind: "deleted", staged: false, indexOnly: false, evidence: "sql" },
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
  const sidebar = within(await screen.findByRole("complementary", { name: "Project files" }));
  expect(await sidebar.findByRole("button", { name: /summary\.go.*Modified/ })).toBeVisible();
  expect(sidebar.getByRole("button", { name: /report\.py.*Renamed/ })).toBeVisible();
  expect(sidebar.getByRole("button", { name: /old\.sql.*Deleted/ })).toBeVisible();
  fireEvent.click(sidebar.getByRole("button", { name: "Files" }));
  const services = await sidebar.findByRole("button", { name: "services", expanded: false });
  expect(services).toHaveAccessibleDescription("Contains changed files");
  expect(sidebar.getByRole("button", { name: "services-backup" })).not.toHaveAttribute("aria-description");
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
  expect(legacy).toHaveAccessibleDescription("Contains changed files");
  fireEvent.click(legacy);
  const archive = await sidebar.findByRole("button", { name: "archive", expanded: false });
  expect(archive).toHaveAccessibleDescription("Contains changed files");
  fireEvent.click(archive);
  const deleted = await sidebar.findByRole("button", { name: "old.sql" });
  expect(deleted).toHaveAccessibleDescription("Deleted");
  expect(directory.mock.calls.map(([, path]) => path)).not.toContain("legacy");
  fireEvent.click(deleted);
  expect(await screen.findByRole("textbox", { name: removed })).toHaveTextContent("select 1;");
  expect(screen.getByRole("button", { name: "Diff" })).toHaveAttribute("aria-pressed", "true");

  changes = [];
  fireEvent.click(sidebar.getByRole("button", { name: "Refresh project" }));
  expect(await sidebar.findByRole("button", { name: "Changes (0)" })).toBeVisible();
  expect(services).not.toHaveAttribute("aria-description");
  expect(sidebar.queryByRole("button", { name: "legacy" })).not.toBeInTheDocument();
});

it("compacts single-folder paths while keeping real file paths, visible siblings and change badges", async () => {
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
  const sidebar = within(await screen.findByRole("complementary", { name: "Project files" }));
  fireEvent.click(sidebar.getByRole("button", { name: "Files" }));
  fireEvent.click(await sidebar.findByRole("button", { name: "src" }));
  fireEvent.click(await sidebar.findByRole("button", { name: "test" }));
  const row = await sidebar.findByRole("button", { name: "java / com / wahool / erp / web", expanded: false });
  expect(row).toHaveAccessibleDescription("Contains changed files");
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

  const compact = sidebar.getByRole("checkbox", { name: "Compact folders" });
  fireEvent.click(compact);
  expect(await sidebar.findByRole("button", { name: "web", expanded: true })).toBeVisible();
  expect(await sidebar.findByRole("button", { name: "ReviewTest.java" })).toHaveAttribute("aria-current", "true");
  expect(sidebar.queryByRole("button", { name: /java \/ com/ })).not.toBeInTheDocument();
  fireEvent.click(compact);
  await sidebar.findByRole("button", { name: "java / com / wahool / erp / web" });

  const hidden = sidebar.getByRole("checkbox", { name: "Show hidden files" });
  fireEvent.click(hidden);
  expect(await sidebar.findByRole("button", { name: ".keep" })).toBeVisible();
  expect(sidebar.getByRole("button", { name: "java", expanded: true })).toBeVisible();
  fireEvent.click(hidden);
  await sidebar.findByRole("button", { name: "java / com / wahool / erp / web" });

  changes = [...changes, { path: deleted, previousPath: null, kind: "deleted", staged: false, indexOnly: false, evidence: null }];
  fireEvent.click(sidebar.getByRole("button", { name: "Refresh project" }));
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
