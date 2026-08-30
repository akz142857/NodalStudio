import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot } from "../platform";
import { SnapshotSummary } from "./SnapshotSummary";

const snapshot = {
  id: "snapshot",
  sourceId: "source",
  capturedAt: "2026-08-30T09:41:00Z",
  fingerprint: "abcdef1234567890",
  database: { name: "flow", databaseType: "postgres" },
  schemas: [
    { name: "public", tables: [{}, {}, {}], views: [], enums: [] },
    { name: "audit", tables: [{}], views: [], enums: [] },
  ],
} as unknown as DatabaseSnapshot;

describe("SnapshotSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts tables across every schema and shortens the fingerprint", () => {
    render(
      <SnapshotSummary
        snapshot={snapshot}
        refreshState="idle"
        canRefresh
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("4 tables")).toBeVisible();
    expect(screen.getByText("abcdef12")).toHaveAttribute("title", "abcdef1234567890");
  });

  it("reports refresh progress in place of the capture time", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <SnapshotSummary
        snapshot={snapshot}
        refreshState="idle"
        canRefresh
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalled();

    rerender(
      <SnapshotSummary
        snapshot={snapshot}
        refreshState="refreshing"
        canRefresh
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText("Refreshing…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();

    rerender(
      <SnapshotSummary
        snapshot={snapshot}
        refreshState="error"
        canRefresh
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText("Refresh failed")).toBeVisible();
  });

  it("asks the inspector for its history segment rather than owning one", () => {
    const listener = vi.fn();
    window.addEventListener("nodalstudio:inspect-history", listener);
    render(
      <SnapshotSummary
        snapshot={snapshot}
        refreshState="idle"
        canRefresh
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Compare…" }));
    expect(listener).toHaveBeenCalled();
    window.removeEventListener("nodalstudio:inspect-history", listener);
  });

  it("cannot refresh on a runtime that has no database connection", () => {
    render(
      <SnapshotSummary
        snapshot={snapshot}
        refreshState="idle"
        canRefresh={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });
});
