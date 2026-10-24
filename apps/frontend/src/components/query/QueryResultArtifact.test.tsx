import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueryExecutionResult } from "../../platform";
import { QueryDraftAnswer } from "./QueryDraftAnswer";
const draft = { sql: "SELECT month, recipients", explanation: "Monthly recipients", assumptions: [], clarification: [] };
function result(values = [9731, 4680]): QueryExecutionResult {
  return { queryId: "q1", columns: [{ name: "month", databaseType: "VARCHAR" }, { name: "recipients", databaseType: "BIGINT" }], rows: values.map((value, i) => [{ kind: "text", value: `2022-0${3 - i}`, truncated: false }, { kind: "number", value }]), rowCount: values.length, durationMs: 64, truncated: false, notices: [] };
}
describe("query result artifact", () => {
  it("renders a chart through json-render, switches to original rows and expands without running SQL", () => {
    const onUseSql = vi.fn();
    render(<QueryDraftAnswer draft={draft} result={result()} onUseSql={onUseSql} />);
    expect(screen.getByRole("img", { name: /Recipients by Month · Line chart/ })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Chart type" }), { target: { value: "bar" } });
    expect(screen.getByRole("img", { name: /Bar chart/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("2022-03"); expect(rows[2]).toHaveTextContent("2022-02");
    fireEvent.click(screen.getByRole("button", { name: "Expand result card" }));
    expect(screen.getByRole("button", { name: "Collapse result card" })).toHaveAttribute("aria-expanded", "true");
    expect(onUseSql).not.toHaveBeenCalled();
  });
  it("labels row-limited charts as partial and keeps exact values keyboard accessible", () => {
    render(<QueryDraftAnswer draft={draft} result={{ ...result(), truncated: true }} />);
    expect(screen.getByText("Partial result")).toBeVisible();
    expect(screen.getByText(/only the returned subset/)).toBeVisible();
    fireEvent.focus(screen.getByRole("button", { name: "2022-02: 4680" }));
    expect(screen.getByText("4680", { selector: "strong" })).toBeVisible();
  });
  it("does not draw a connecting line across missing months and keeps zero scales finite", () => {
    const data = result([0, 0]); data.rows[1][0] = { kind: "text", value: "2022-01", truncated: false };
    const { container } = render(<QueryDraftAnswer draft={draft} result={data} />);
    expect(container.querySelectorAll(".query-chart-line")).toHaveLength(0);
    expect(container.querySelector("svg[role='img']")!.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(screen.getByText(/missing periods are not filled/, { selector: "p" })).toBeVisible();
  });
  it("keeps negative bars on the correct side of zero", () => {
    const { container } = render(<QueryDraftAnswer draft={draft} result={result([-5, 10])} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Chart type" }), { target: { value: "bar" } });
    const baseline = Number(container.querySelector(".query-chart-baseline")!.getAttribute("y1"));
    const bars = [...container.querySelectorAll(".query-chart-bar")];
    expect(Number(bars[0].getAttribute("y"))).toBeLessThan(baseline);
    expect(Number(bars[1].getAttribute("y"))).toBe(baseline);
  });
  it("does not label small nonzero values as zero", () => {
    const { container } = render(<QueryDraftAnswer draft={draft} result={result([0.000001, 0])} />);
    expect([...container.querySelectorAll(".query-chart-label")].map((label) => label.textContent)).toContain("1.0e-6");
  });
  it("resets display mode when a new execution arrives and shows empty state without fabricated chart", () => {
    const { rerender } = render(<QueryDraftAnswer draft={draft} result={result()} />);
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    rerender(<QueryDraftAnswer draft={draft} result={{ ...result(), queryId: "q2" }} />);
    expect(screen.getByRole("button", { name: "Chart" })).toHaveAttribute("aria-pressed", "true");
    rerender(<QueryDraftAnswer draft={draft} result={{ ...result([]), queryId: "q3" }} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("No rows matched this query.")).toBeVisible();
  });
});
