import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform } from "../platform";
import { DiagramExportActions } from "./DiagramExportActions";
import * as exportGraph from "../graph/diagram-export";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>模型</text></svg>';
const diagram = { svg, byteLength: new TextEncoder().encode(svg).length, width: 1000, height: 800 };

describe("DiagramExportActions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves generated SVG bytes through the platform and reports the actual destination", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const saveDiagramExport = vi.fn().mockResolvedValue({ path: "/Downloads/model-1.svg" });
    const capture = vi.fn().mockReturnValue(diagram);
    const blob = vi.spyOn(globalThis, "Blob");
    render(<DiagramExportActions capture={capture} platform={{ saveDiagramExport } as unknown as NodalStudioPlatform} fileName={(format) => `model.${format}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
    await waitFor(() => expect(saveDiagramExport).toHaveBeenCalledOnce());
    const input = saveDiagramExport.mock.calls[0][0] as { fileName: string; format: string; data: Uint8Array };
    expect(input.data).toBeInstanceOf(Uint8Array);
    expect(input.data.buffer.byteLength).toBe(diagram.byteLength);
    expect(blob).not.toHaveBeenCalled();
    expect(input.fileName).toBe("model.svg");
    expect(input.format).toBe("svg");
    expect(new TextDecoder().decode(new Uint8Array(input.data))).toBe(diagram.svg);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved to /Downloads/model-1.svg");
  });

  it("shows failures without claiming success and can retry", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const saveDiagramExport = vi.fn().mockRejectedValueOnce(new Error("Downloads is unavailable")).mockResolvedValue({ path: null });
    render(<DiagramExportActions capture={() => diagram} platform={{ saveDiagramExport } as unknown as NodalStudioPlatform} fileName={(format) => `model.${format}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Downloads is unavailable");
    expect(screen.queryByText(/Download started/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Download started: model.svg"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables export while the diagram is empty or still being laid out", () => {
    const capture = vi.fn();
    render(<DiagramExportActions disabled capture={capture} platform={{} as NodalStudioPlatform} fileName={(format) => `model.${format}`} />);
    expect(screen.getByRole("button", { name: "Export SVG" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
    expect(capture).not.toHaveBeenCalled();
  });

  it("retries the failed PNG format with the current diagram and reports raster dimensions", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const png = vi.spyOn(exportGraph, "diagramPng").mockResolvedValue({ blob: new Blob(["png"]), width: 2000, height: 1600 });
    const saveDiagramExport = vi.fn().mockRejectedValueOnce(new Error("Downloads unavailable")).mockResolvedValue({ path: "/Downloads/current.png" });
    const platform = { saveDiagramExport } as unknown as NodalStudioPlatform;
    const { rerender } = render(<DiagramExportActions scope="a" capture={() => diagram} platform={platform} fileName={(format) => `model.${format}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to export PNG diagram");
    const current = { ...diagram, svg: "<svg>Current view</svg>" };
    rerender(<DiagramExportActions scope="a" capture={() => current} platform={platform} fileName={(format) => `current.${format}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry diagram export" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved to /Downloads/current.png · 2000 × 1600"));
    expect(png).toHaveBeenLastCalledWith(current);
    expect(saveDiagramExport).toHaveBeenLastCalledWith(expect.objectContaining({ format: "png", fileName: "current.png" }));
  });

  it("does not show a completed export after the diagram scope changes", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    let finish!: (receipt: { path: string }) => void;
    const saveDiagramExport = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const platform = { saveDiagramExport } as unknown as NodalStudioPlatform;
    const { rerender } = render(<DiagramExportActions scope="a" capture={() => diagram} platform={platform} fileName={(format) => `model.${format}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
    expect(screen.getByRole("status")).toHaveTextContent("Running");
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
    await waitFor(() => expect(saveDiagramExport).toHaveBeenCalledOnce());
    rerender(<DiagramExportActions scope="b" capture={() => diagram} platform={platform} fileName={(format) => `model.${format}`} />);
    await act(() => Promise.resolve(finish({ path: "/Downloads/old.svg" })));
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); expect(screen.queryByText(/old.svg/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled();
  });
});

it("waits for asynchronous full-detail capture before saving and retries capture failures", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
  let complete!: (result: typeof diagram) => void;
  const capture = vi.fn().mockRejectedValueOnce(new Error("View changed during preparation"))
    .mockImplementationOnce(() => new Promise<typeof diagram>((resolve) => { complete = resolve; }));
  const saveDiagramExport = vi.fn().mockResolvedValue({ path: "/Downloads/full.svg" });
  render(<DiagramExportActions capture={capture} platform={{ saveDiagramExport } as unknown as NodalStudioPlatform} fileName={() => "full.svg"} />);
  fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("View changed during preparation");
  fireEvent.click(screen.getByRole("button", { name: "Retry diagram export" }));
  await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  expect(saveDiagramExport).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
  await act(async () => { complete(diagram); await Promise.resolve(); });
  await waitFor(() => expect(saveDiagramExport).toHaveBeenCalledOnce());
  vi.restoreAllMocks();
});
