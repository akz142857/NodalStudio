import { findDocumentObject } from "./object-document-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { ObjectDocument } from "./ObjectDocument";
import { reportSnapshot } from "../test/schema-report-fixture";
import type { ProgramDefinition } from "../platform/types";

const program: ProgramDefinition = { key: { kind: "function", schema: "public", name: "long_function(integer)" }, arguments: "value_in integer", language: "sql", owner: "fixture", resultType: "integer", table: null, enabled: null, definition: `${"-- metadata only\n".repeat(800)}RETURN value_in;` };
describe("Object documents", () => {
  it("keeps the entire long definition read-only and searches beyond the visible viewport", () => {
    render(<ObjectDocument snapshot={reportSnapshot} object={program} onClose={vi.fn()} onSelect={vi.fn()} onSelectTable={vi.fn()} />);
    const content = screen.getByRole("textbox", { name: "Read-only object definition" });
    const editor = EditorView.findFromDOM(content)!;
    expect(editor.state.readOnly).toBe(true);
    expect(editor.state.doc.lines).toBe(801);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "RETURN value_in" } });
    fireEvent.click(screen.getByRole("button", { name: "Find next" }));
    expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe("RETURN value_in");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Find next" }));
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
  });
  it("does not invent a definition when permissions hide it and resolves identities by kind and schema", () => {
    const close = vi.fn();
    render(<ObjectDocument snapshot={reportSnapshot} object={{ ...program, definition: null }} onClose={close} onSelect={vi.fn()} onSelectTable={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Copy definition" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    expect(screen.getByText("value_in integer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Back to diagram/ }));
    expect(close).toHaveBeenCalledOnce();
    const key = reportSnapshot.schemas[0].views[0].key;
    expect(findDocumentObject(reportSnapshot, key)).toBe(reportSnapshot.schemas[0].views[0]);
    expect(findDocumentObject(reportSnapshot, { ...key, kind: "function" })).toBeUndefined();
  });
});
