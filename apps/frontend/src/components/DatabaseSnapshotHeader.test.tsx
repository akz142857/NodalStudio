import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabaseSnapshotHeader } from "./DatabaseSnapshotHeader";
import { reportSnapshot } from "../test/schema-report-fixture";

describe("Database snapshot context", () => {
  it("keeps capture time accessible in the history control and distinguishes historical snapshots", () => {
    const onOpenHistory = vi.fn();
    const {rerender} = render(<DatabaseSnapshotHeader snapshot={reportSnapshot} latestSnapshotId="newer" refreshState="refreshing" onOpenHistory={onOpenHistory}/>);
    expect(screen.getByText("Historical snapshot")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing schema");
    expect(screen.getByRole("button", { name: "Open schema history" })).toHaveAttribute("title", expect.stringContaining("Schema captured"));
    expect(document.querySelector("time")).toHaveAttribute("datetime",reportSnapshot.capturedAt);
    fireEvent.click(screen.getByRole("button",{name:"Open schema history"}));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button",{name:/Refresh/})).toBeNull();
    rerender(<DatabaseSnapshotHeader snapshot={reportSnapshot} latestSnapshotId={reportSnapshot.id} refreshState="idle" onOpenHistory={onOpenHistory}/>);
    expect(screen.queryByText("Historical snapshot")).toBeNull();
  });
});
