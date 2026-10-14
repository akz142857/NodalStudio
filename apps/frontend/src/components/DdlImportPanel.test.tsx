/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DdlImportPanel } from "./DdlImportPanel";
import { createDdlPreview } from "../ddl/ddl-preview";
import { previewDdlInWorker } from "../ddl/ddl-worker-client";
import { defaultAppSettings } from "../platform";
import type { DdlPreview } from "../ddl/ddl-types";
import type { SchemaCanvasProps } from "./SchemaCanvas";
vi.mock("../ddl/ddl-worker-client", () => ({ previewDdlInWorker: vi.fn() }));
vi.mock("./SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => <p>DDL canvas: {props.readOnlyPreview ? "read only" : "editable"} · {props.snapshot.sourceId}</p> }));
const sql = "CREATE TABLE t(id integer PRIMARY KEY); ALTER TABLE t ADD extra int;";
const mount = () => render(<DdlImportPanel canvasSettings={defaultAppSettings().canvas} runtimeKind="desktop" onClose={vi.fn()} />);
const finish = async () => waitFor(() => expect(within(screen.getByRole("group", { name: "DDL parsing" })).getByRole("status")).toHaveTextContent("Completed"));
describe("read-only DDL panel", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.mocked(previewDdlInWorker).mockImplementation((request) => createDdlPreview(request)); localStorage.clear(); });
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
  it("shows partial coverage, isolated identity and exact source navigation, with no persistence", async () => {
    mount(); fireEvent.change(screen.getByLabelText("SQL DDL text"), { target: { value: sql } }); fireEvent.click(screen.getByRole("button", { name: "Preview DDL" })); await finish();
    expect(screen.getByRole("status")).toHaveTextContent("1 tables · 1 accepted statements · 1 skipped");
    expect(screen.getByText(/Session ID/)).toHaveTextContent("ddl-preview:"); expect(screen.getByText(/Session ID/)).toHaveTextContent("sha256:");
    expect(screen.getByRole("region", { name: "Parsed DDL structure" })).toHaveTextContent("public.t");
    fireEvent.click(within(screen.getByText(/Non-CREATE statement omitted/).closest("article")!).getByRole("button", { name: /Show source: line/ }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>("SQL DDL text"); expect(sql.slice(editor.selectionStart, editor.selectionEnd)).toContain("ALTER TABLE");
    fireEvent.click(screen.getByRole("button", { name: "Diagram preview" })); expect(screen.getByText(/DDL canvas/)).toHaveTextContent("read only · ddl-preview:");
    expect(localStorage.length).toBe(0);
    fireEvent.change(editor, { target: { value: "CREATE TABLE newer(id int);" } }); expect(screen.queryByText(/Session ID/)).not.toBeInTheDocument();
  });
  it("reads clipboard only when explicitly requested and supports manual paste after denial", async () => {
    const readText = vi.fn().mockRejectedValueOnce(new Error("Clipboard denied")).mockResolvedValue("CREATE TABLE c(id int);"); vi.stubGlobal("navigator", { clipboard: { readText } });
    mount(); expect(readText).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Read clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard denied"); fireEvent.click(screen.getByRole("button", { name: "Retry input read" }));
    await waitFor(() => expect(screen.getByLabelText("SQL DDL text")).toHaveValue("CREATE TABLE c(id int);")); expect(readText).toHaveBeenCalledTimes(2); expect(screen.getByText(/Source: Clipboard/)).toHaveTextContent("Clipboard SQL");
  });
  it("loads a bounded UTF-8 file buffer and rejects oversized files without parsing", async () => {
    mount(); const file = new File([sql], "schema.sql"); Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(new TextEncoder().encode(sql).buffer) });
    fireEvent.change(screen.getByLabelText(/SQL file/), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("SQL DDL text")).toHaveValue(sql)); expect(screen.getByText(/Source: File/)).toHaveTextContent("schema.sql");
    const huge = new File(["x"], "large.sql"); Object.defineProperty(huge, "size", { value: 1_048_577 });
    fireEvent.change(screen.getByLabelText(/SQL file/), { target: { files: [huge] } }); expect(await screen.findByRole("alert")).toHaveTextContent("1 MiB"); expect(previewDdlInWorker).not.toHaveBeenCalled();
  });
  it("rejects invalid UTF-8 files without treating replacement characters as valid SQL", async () => {
    mount(); const file = new File(["x"], "bad.sql"); Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(new Uint8Array([255, 254]).buffer) });
    fireEvent.change(screen.getByLabelText(/SQL file/), { target: { files: [file] } }); expect(await screen.findByRole("alert")).toHaveTextContent("not valid UTF-8");
  });
  it("reports parse failure and retries the current input", async () => {
    vi.mocked(previewDdlInWorker).mockRejectedValueOnce(new Error("Worker failed")); mount(); fireEvent.change(screen.getByLabelText("SQL DDL text"), { target: { value: sql } }); fireEvent.click(screen.getByRole("button", { name: "Preview DDL" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker failed"); fireEvent.click(screen.getByRole("button", { name: "Retry DDL preview" })); await finish(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("cancels pending parsing and discards a late result, retaining the buffer", async () => {
    let resolve!: (preview: DdlPreview) => void; let signal!: AbortSignal;
    vi.mocked(previewDdlInWorker).mockImplementationOnce((_, abort) => { signal = abort; return new Promise((done) => { resolve = done; }); });
    mount(); fireEvent.change(screen.getByLabelText("SQL DDL text"), { target: { value: sql } }); fireEvent.click(screen.getByRole("button", { name: "Preview DDL" })); expect(screen.getByRole("status")).toHaveTextContent("Running");
    fireEvent.click(screen.getByRole("button", { name: "Cancel preview" })); expect(signal.aborted).toBe(true);
    await act(async () => { resolve(await createDdlPreview({ text: sql, dialect: "postgreSql", defaultSchema: "public", source: { kind: "ddl-clipboard", name: "Old", id: "old" } })); });
    expect(screen.queryByText(/Session ID/)).not.toBeInTheDocument(); expect(screen.getByLabelText("SQL DDL text")).toHaveValue(sql); expect(screen.getByRole("status")).toHaveTextContent("cancelled");
  });
  it("switches the explicit dialect/default namespace and invalidates old previews", async () => {
    mount(); fireEvent.change(screen.getByLabelText("SQL DDL text"), { target: { value: "CREATE TABLE t(id int);" } }); fireEvent.click(screen.getByRole("button", { name: "Preview DDL" })); await finish();
    fireEvent.change(screen.getByLabelText("DDL dialect"), { target: { value: "mySql" } }); expect(screen.getByLabelText("Default namespace")).toHaveValue("imported"); expect(screen.queryByText(/Session ID/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview DDL" })); await finish(); expect(screen.getByRole("region", { name: "Parsed DDL structure" })).toHaveTextContent("imported.t");
  });
});
