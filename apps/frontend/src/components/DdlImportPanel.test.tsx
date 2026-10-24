/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import type { Language } from "../platform/settings-types";
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
const finish = async () => screen.findByRole("region", { name: "Temporary DDL model" });
describe("read-only DDL panel", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
 vi.stubGlobal("crypto", webcrypto); vi.mocked(previewDdlInWorker).mockImplementation((request) => createDdlPreview(request)); localStorage.clear(); });
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
  it("shows partial coverage, isolated identity and exact source navigation, with no persistence", async () => {
    mount(); fireEvent.change(screen.getByLabelText("SQL DDL text"), { target: { value: sql } }); fireEvent.click(screen.getByRole("button", { name: "Preview DDL" })); await finish();
    expect(within(screen.getByRole("region", {name:"Temporary DDL model"})).getByRole("status")).toHaveTextContent("1 tables · 2 findings");
    fireEvent.click(screen.getByText(/Parsing diagnostics/));
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(/Session ID/)).toHaveTextContent("ddl-preview:");
    fireEvent.click(screen.getByRole("button", {name:"Structure preview"}));
    expect(screen.getByRole("region", {name:"Parsed DDL structure"})).toHaveTextContent("public.t");
    fireEvent.click(within(screen.getByText(/Non-CREATE statement omitted/).closest("article")!).getByRole("button", { name: /Show source: line/ }));
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("SQL DDL text").selectionStart).toBe(sql.indexOf("ALTER")));
    const editor = screen.getByLabelText<HTMLTextAreaElement>("SQL DDL text"); expect(sql.slice(editor.selectionStart, editor.selectionEnd)).toContain("ALTER TABLE");
    fireEvent.click(screen.getByRole("button", {name:"Cancel"}));
    fireEvent.click(screen.getByRole("button", {name:"Diagram preview"}));
    expect(screen.getByText(/DDL canvas/)).toHaveTextContent("read only · ddl-preview:");
    expect(localStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", {name:"Edit DDL"}));
    fireEvent.change(editor, { target: { value: "CREATE TABLE newer(id int);" } }); expect(screen.queryByText(/Session ID/)).not.toBeInTheDocument();
  });
  it("reads clipboard only when explicitly requested and supports manual paste after denial", async () => {
    const readText = vi.fn().mockRejectedValueOnce(new Error("Clipboard denied")).mockResolvedValue("CREATE TABLE c(id int);"); vi.stubGlobal("navigator", { clipboard: { readText } });
    mount(); expect(readText).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Read clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard denied"); fireEvent.click(screen.getByRole("button", { name: "Retry input read" }));
    await waitFor(() => expect(screen.getByLabelText("SQL DDL text")).toHaveValue("CREATE TABLE c(id int);")); expect(readText).toHaveBeenCalledTimes(2); expect(screen.getByText(/Source: Clipboard/)).toHaveTextContent("Clipboard/editor");
  });
  it("loads a bounded UTF-8 file buffer and rejects oversized files without parsing", async () => {
    mount(); const file = new File([sql], "schema.sql"); Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(new TextEncoder().encode(sql).buffer) });
    fireEvent.change(screen.getByLabelText(/SQL file/), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText("SQL DDL text")).toHaveValue(sql)); expect(screen.getByText(/Source: schema.sql/)).toHaveTextContent("schema.sql");
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
    fireEvent.click(screen.getByRole("button", {name:"Edit DDL"})); fireEvent.change(screen.getByLabelText("DDL dialect"), { target: { value: "mySql" } }); expect(screen.getByLabelText("Default namespace")).toHaveValue("imported"); expect(screen.queryByText(/Session ID/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview DDL" })); await finish(); expect(screen.getByRole("heading", { name: "imported.t" })).toBeVisible();
  });
  it("retains input, selection and the mounted canvas when returning and reopening", async () => {
    const onReturn = vi.fn(); const onClose = vi.fn();
    const props = {canvasSettings: defaultAppSettings().canvas, runtimeKind: "desktop" as const, onReturn, onClose};
    const view = render(<DdlImportPanel {...props} active />);
    fireEvent.change(screen.getByLabelText("SQL DDL text"), {target: {value: "CREATE TABLE a(id int); CREATE TABLE b(id int);"}});
    fireEvent.click(screen.getByRole("button", {name:"Preview DDL"})); await finish();
    const canvas = screen.getByText(/DDL canvas/);
    fireEvent.click(screen.getByRole("button", {name:"Structure preview"}));
    fireEvent.click(within(screen.getByRole("region", {name:"Parsed DDL structure"})).getByRole("button", {name:/public.b/}));
    fireEvent.click(screen.getByRole("button", {name:/Back to database/})); expect(onReturn).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
    view.rerender(<DdlImportPanel {...props} active={false} />);
    expect(canvas).toBeInTheDocument();
    view.rerender(<DdlImportPanel {...props} active />);
    expect(screen.getByRole("heading", {name:"public.b"})).toBeVisible();
    fireEvent.click(screen.getByRole("button", {name:"Diagram preview"})); expect(screen.getByText(/DDL canvas/)).toBe(canvas);
    fireEvent.click(screen.getByRole("button", {name:"Close temporary model"}));
    expect(screen.getByRole("dialog", {name:"Discard this temporary model?"})).toBeVisible();
    fireEvent.click(screen.getByRole("button", {name:"Keep editing"})); expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name:"Edit DDL"})); expect(screen.getByLabelText("SQL DDL text")).toHaveValue("CREATE TABLE a(id int); CREATE TABLE b(id int);");
    fireEvent.click(screen.getByRole("button", {name:"Cancel"}));
    fireEvent.click(screen.getByRole("button", {name:"Close temporary model"}));
    fireEvent.click(screen.getByRole("button", {name:"Discard and close"})); expect(onClose).toHaveBeenCalledOnce();
  });
  it("retranslates a retained preview and shows an actionable empty result", async () => {
    function Scope({language}: {language: Language}) {return <I18nProvider value={useI18n(language)}><DdlImportPanel canvasSettings={defaultAppSettings().canvas} onClose={vi.fn()} /></I18nProvider>;}
    const view = render(<Scope language="en" />);
    fireEvent.change(screen.getByLabelText("SQL DDL text"), {target:{value:"ALTER TABLE a ADD id int;"}});
    fireEvent.click(screen.getByRole("button", {name:"Preview DDL"})); await finish();
    expect(screen.getByText("No tables to preview")).toBeVisible();
    expect(screen.getByRole("button", {name:"Diagram preview"})).toBeDisabled();
    expect(screen.getByRole("button", {name:"Structure preview"})).toHaveAttribute("aria-pressed", "true");
    view.rerender(<Scope language="zhCn" />);
    expect(screen.getByRole("region", {name:"DDL 临时模型"})).toBeVisible();
    expect(screen.getByText("此语句不在支持范围内，已跳过；未执行任何 SQL。")).toBeVisible();
    expect(screen.getByText("没有可预览的表")).toBeVisible();
  });

});
