import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlEditor } from "./SqlEditor";
import type { DatabaseSnapshot } from "../../platform";

const writeText = vi.fn<(text: string) => Promise<void>>();
const readText = vi.fn<() => Promise<string>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function setup(initial = "select 1;\nselect 2;", dialect: "postgreSql" | "mySql" = "postgreSql") {
  const onRun = vi.fn();
  const snapshot = { id: "snapshot", database: { databaseType: dialect }, schemas: [] } as unknown as DatabaseSnapshot;
  function Harness() {
    const [value, onChange] = useState(initial);
    return <SqlEditor value={value} onChange={onChange} onRun={onRun} snapshot={snapshot} executing={false} disabled={false} onStop={vi.fn()} />;
  }
  const { container, unmount } = render(<Harness />);
  const editor = container.querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(editor)!;
  const choose = (name: string) => { fireEvent.contextMenu(editor); fireEvent.click(screen.getByRole("menuitem", { name })); };
  const select = (anchor: number, head = anchor) => act(() => view.dispatch({ selection: { anchor, head } }));
  return { view, choose, select, onRun, unmount };
}
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});
afterAll(() => {
  if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects); else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (originalBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds); else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  readText.mockReset().mockResolvedValue("pasted");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText, readText } });
});
afterEach(() => { if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard); else Reflect.deleteProperty(navigator, "clipboard"); vi.restoreAllMocks(); });

describe("SQL editor editing menu", () => {
  it("copies the exact selection without changing SQL or executing it", async () => {
    const { view, choose, select, onRun } = setup();
    select(10, 19); choose("Copy");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("select 2;"));
    expect(view.state.doc.toString()).toBe("select 1;\nselect 2;");
    expect(onRun).not.toHaveBeenCalled();
  });
  it("cuts only after clipboard success and supports one-step undo", async () => {
    const { view, choose, select } = setup();
    select(10, 19); choose("Cut");
    await waitFor(() => expect(view.state.doc.toString()).toBe("select 1;\n"));
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("select 1;\nselect 2;");
  });
  it("preserves SQL on clipboard failures", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { view, choose, select } = setup();
    select(0, 9); choose("Cut");
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard access failed");
    expect(view.state.doc.toString()).toBe("select 1;\nselect 2;");
    readText.mockRejectedValue(new Error("denied")); choose("Paste");
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard access failed");
    expect(view.state.doc.toString()).toBe("select 1;\nselect 2;");
  });
  it("replaces a selection on paste and retains it for an empty clipboard", async () => {
    const { view, choose, select } = setup();
    select(10, 19); choose("Paste");
    await waitFor(() => expect(view.state.doc.toString()).toBe("select 1;\npasted"));
    act(() => { undo(view); });
    readText.mockResolvedValue(""); select(10, 19); choose("Paste");
    await waitFor(() => expect(readText).toHaveBeenCalledTimes(2));
    expect(view.state.doc.toString()).toBe("select 1;\nselect 2;");
  });
  it.each(["Cut", "Paste"])("does not apply delayed %s over subsequent edits, including ABA", async action => {
    let finish!: () => void;
    if (action === "Cut") writeText.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    else readText.mockImplementation(() => new Promise<string>(resolve => { finish = () => resolve("late"); }));
    const { view, choose, select } = setup();
    select(0, 9); choose(action);
    select(10); select(0, 9);
    await act(async () => { finish(); await Promise.resolve(); });
    expect(view.state.doc.toString()).toBe("select 1;\nselect 2;");
    expect(screen.getByRole("alert")).toHaveTextContent("editor changed");
  });
  it("selects all without changing SQL", () => {
    const { view, choose } = setup(); choose("Select all");
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });
  it.each(["postgreSql", "mySql"] as const)("formats %s SQL preserving literals and undo", async dialect => {
    const text = dialect === "mySql" ? "select `a;b`, 'literal  text' from `orders` where id = ?;" : "select \"a;b\", $$literal  text$$ from orders where id = $1;";
    const { view, choose, onRun } = setup(text, dialect);
    choose("Format SQL");
    await waitFor(() => expect(view.state.doc.toString()).toContain("\n"));
    expect(view.state.doc.toString()).toContain("literal  text");
    expect(view.state.doc.toString()).toContain(dialect === "mySql" ? "`a;b`" : '"a;b"');
    expect(view.state.doc.toString()).toContain(dialect === "mySql" ? "?" : "$1");
    act(() => { undo(view); }); expect(view.state.doc.toString()).toBe(text);
    expect(onRun).not.toHaveBeenCalled();
  });
  it("formats only a selection and keeps neighboring SQL", async () => {
    const text = "select 1;\nselect a,b from orders;\nselect 3;";
    const { view, choose, select } = setup(text);
    select(10, text.lastIndexOf("\n")); choose("Format selected SQL");
    await waitFor(() => expect(view.state.doc.lines).toBeGreaterThan(3));
    expect(view.state.doc.toString()).toMatch(/^select 1;\n/);
    expect(view.state.doc.toString()).toMatch(/\nselect 3;$/);
    act(() => { undo(view); }); expect(view.state.doc.toString()).toBe(text);
  });
  it("keeps invalid SQL unchanged on formatting failure", async () => {
    const { view, choose } = setup("select 'unterminated"); choose("Format SQL");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to format");
    expect(view.state.doc.toString()).toBe("select 'unterminated");
  });
});
