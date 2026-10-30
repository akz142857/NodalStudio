import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabaseSnapshotHeader } from "./DatabaseSnapshotHeader";
import { reportSnapshot } from "../test/schema-report-fixture";

describe("Database snapshot context", () => {
  it.each(["DDL preview — not a database capture", "", "invalid date"])("renders a model without a capture timestamp instead of crashing (%s)", (capturedAt) => {
    render(<DatabaseSnapshotHeader snapshot={{ ...reportSnapshot, capturedAt }} tableCount={11} />);
    expect(screen.getByRole("heading", { name: "Full model" })).toBeVisible();
    expect(screen.getByText("Capture time unavailable")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open schema history" })).not.toBeInTheDocument();
  });

  it("keeps capture time accessible in the history control and distinguishes historical snapshots", () => {
    const onOpenHistory = vi.fn();
    const {rerender} = render(<DatabaseSnapshotHeader snapshot={reportSnapshot} latestSnapshotId="newer" refreshState="refreshing" onOpenHistory={onOpenHistory}/>);
    expect(screen.getByText("Historical snapshot")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open schema history" })).toHaveAttribute("title", expect.stringContaining("Schema captured"));
    expect(document.querySelector("time")).toHaveAttribute("datetime",reportSnapshot.capturedAt);
    fireEvent.click(screen.getByRole("button",{name:"Open schema history"}));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button",{name:/Refresh/})).toBeNull();
    rerender(<DatabaseSnapshotHeader snapshot={reportSnapshot} latestSnapshotId={reportSnapshot.id} refreshState="idle" onOpenHistory={onOpenHistory}/>);
    expect(screen.queryByText("Historical snapshot")).toBeNull();
  });

  it("keeps canvas header content unchanged throughout a successful refresh and still reports failures", () => {
    const header = (refreshState: "idle" | "refreshing" | "error") => <DatabaseSnapshotHeader snapshot={reportSnapshot} tableCount={3} refreshState={refreshState} />;
    const { container, rerender } = render(header("idle"));
    const initialContent = container.innerHTML;
    rerender(header("refreshing"));
    expect(container.innerHTML).toBe(initialContent);
    rerender(header("idle"));
    expect(container.innerHTML).toBe(initialContent);
    rerender(header("error"));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
  });
});
