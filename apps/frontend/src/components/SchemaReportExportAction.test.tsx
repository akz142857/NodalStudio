/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileExportReceipt, NodalStudioPlatform, SchemaReportExportInput } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { SchemaReportExportAction } from "./SchemaReportExportAction";

describe("SchemaReportExportAction", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("saves the loaded snapshot and semantics and reports the actual destination and counts", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const saveSchemaReport = vi.fn().mockResolvedValue({ path: "/Downloads/report-1.html" });
    render(<SchemaReportExportAction snapshot={reportSnapshot} semantics={reportSemantics} platform={{ saveSchemaReport } as unknown as NodalStudioPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: "Export structure document" }));
    await waitFor(() => expect(saveSchemaReport).toHaveBeenCalledOnce());
    const input = saveSchemaReport.mock.calls[0][0] as SchemaReportExportInput;
    expect(input.fileName).toBe("Commerce-schema-report-schema-repor.html");
    expect(input.html).toContain("订单：记录已确认的购买意图");
    expect(input.html).toContain('id="table-1-0"');
    expect(await screen.findByRole("status")).toHaveTextContent("Saved to /Downloads/report-1.html · 3 tables · 6 columns");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss report export result" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("disables export until current semantics are loaded and prevents duplicate requests while saving", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    let finish!: (receipt: FileExportReceipt) => void;
    const saveSchemaReport = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const platform = { saveSchemaReport } as unknown as NodalStudioPlatform;
    const { rerender } = render(<SchemaReportExportAction snapshot={reportSnapshot} platform={platform} />);
    expect(screen.getByRole("button", { name: "Export structure document" })).toBeDisabled();
    rerender(<SchemaReportExportAction snapshot={reportSnapshot} semantics={reportSemantics} platform={platform} />);
    const button = screen.getByRole("button", { name: "Export structure document" });
    fireEvent.click(button); fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Exporting structure document…" })).toBeDisabled();
    await waitFor(() => expect(saveSchemaReport).toHaveBeenCalledOnce());
    await act(() => Promise.resolve(finish({ path: null })));
    expect(screen.getByRole("status")).toHaveTextContent("Download started: Commerce-schema-report");
  });

  it("shows save failures without a success message and permits retry", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const saveSchemaReport = vi.fn().mockRejectedValueOnce(new Error("Downloads unavailable")).mockResolvedValue({ path: null });
    render(<SchemaReportExportAction snapshot={reportSnapshot} semantics={reportSemantics} platform={{ saveSchemaReport } as unknown as NodalStudioPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: "Export structure document" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Downloads unavailable");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry report export" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Download started"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides an old receipt when a new snapshot is loaded while export is pending", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    let finish!: (receipt: FileExportReceipt) => void;
    const saveSchemaReport = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const platform = { saveSchemaReport } as unknown as NodalStudioPlatform;
    const { rerender } = render(<SchemaReportExportAction snapshot={reportSnapshot} semantics={reportSemantics} platform={platform} />);
    fireEvent.click(screen.getByRole("button", { name: "Export structure document" }));
    expect(screen.getByRole("status")).toHaveTextContent("Running");
    await waitFor(() => expect(saveSchemaReport).toHaveBeenCalledOnce());
    rerender(<SchemaReportExportAction snapshot={{ ...reportSnapshot, id: "new" }} semantics={reportSemantics} platform={platform} />);
    await act(() => Promise.resolve(finish({ path: "/Downloads/old.html" })));
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Export structure document" })).toBeEnabled();
  });

  it("exports an interactive whole-snapshot file through the existing HTML save path with its own name and retry", async () => {
    vi.stubGlobal("crypto", webcrypto); vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const saveSchemaReport = vi.fn().mockRejectedValueOnce(new Error("Downloads unavailable")).mockResolvedValue({ path: null });
    render(<SchemaReportExportAction snapshot={reportSnapshot} semantics={reportSemantics} platform={{ saveSchemaReport } as unknown as NodalStudioPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: "Export interactive viewer" }));
    expect(screen.getByRole("button", { name: "Exporting interactive viewer…" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Export structure document" })).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to export interactive viewer");
    fireEvent.click(screen.getByRole("button", { name: "Retry Viewer export" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Download started: Commerce-offline-viewer-schema-repor.html · 3 tables · 6 columns"));
    const input = saveSchemaReport.mock.calls[1][0] as SchemaReportExportInput;
    expect(input.html).toContain('id="offline-model"'); expect(input.html).toContain('id="table-1-0"'); expect(input.html).not.toContain(reportSnapshot.sourceId);
  });

  it("prevents duplicate or mixed exports and ignores a late Viewer receipt after source changes", async () => {
    vi.stubGlobal("crypto", webcrypto); vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    let finish!: (receipt: FileExportReceipt) => void;
    const saveSchemaReport = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const platform = { saveSchemaReport } as unknown as NodalStudioPlatform;
    const { rerender } = render(<SchemaReportExportAction snapshot={reportSnapshot} semantics={reportSemantics} platform={platform} />);
    const button = screen.getByRole("button", { name: "Export interactive viewer" }); fireEvent.click(button); fireEvent.click(button); fireEvent.click(screen.getByRole("button", { name: "Export structure document" }));
    await waitFor(() => expect(saveSchemaReport).toHaveBeenCalledOnce());
    rerender(<SchemaReportExportAction snapshot={{ ...reportSnapshot, id: "new" }} semantics={reportSemantics} platform={platform} />);
    await act(() => Promise.resolve(finish({ path: "/Downloads/old-viewer.html" })));
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Export interactive viewer" })).toBeEnabled();
  });

  it("rejects temporary DDL and generation errors before saving, and waits for current semantics", async () => {
    vi.stubGlobal("crypto", webcrypto); vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const saveSchemaReport = vi.fn(); const platform = { saveSchemaReport } as unknown as NodalStudioPlatform;
    const snapshot = { ...reportSnapshot, sourceId: "ddl-preview:test" };
    const { rerender } = render(<SchemaReportExportAction snapshot={snapshot} platform={platform} />);
    expect(screen.getByRole("button", { name: "Export interactive viewer" })).toBeDisabled();
    rerender(<SchemaReportExportAction snapshot={snapshot} semantics={reportSemantics} platform={platform} />);
    fireEvent.click(screen.getByRole("button", { name: "Export interactive viewer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary DDL previews"); expect(saveSchemaReport).not.toHaveBeenCalled();
  });
});
