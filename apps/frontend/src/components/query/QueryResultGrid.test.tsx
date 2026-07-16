import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryExecutionResult } from "../../platform";
import { QueryResultGrid } from "./QueryResultGrid";

describe("QueryResultGrid", () => {
  it("keeps null, JSON, binary, and truncated text semantically distinct", () => {
    const result: QueryExecutionResult = {
      queryId: "query",
      columns: [
        { name: "nothing", databaseType: "text" },
        { name: "payload", databaseType: "jsonb" },
        { name: "content", databaseType: "text" },
        { name: "blob", databaseType: "bytea" },
      ],
      rows: [[
        { kind: "null" },
        { kind: "json", value: { active: true }, truncated: false },
        { kind: "text", value: "partial", truncated: true },
        { kind: "binary", byteLength: 42 },
      ]],
      rowCount: 1,
      durationMs: 4,
      truncated: false,
      notices: [],
    };
    render(<QueryResultGrid result={result} />);
    expect(screen.getByText("NULL")).toHaveClass("query-null");
    expect(screen.getByText('{"active":true}')).toBeInTheDocument();
    expect(screen.getByText("partial…")).toBeInTheDocument();
    expect(screen.getByText("<42 bytes>")).toBeInTheDocument();

    const selectedRow = screen.getByText("partial…").closest("tr");
    expect(selectedRow).not.toBeNull();
    fireEvent.click(selectedRow!);
    expect(selectedRow).toHaveAttribute("aria-selected", "true");

    const resizer = screen.getByRole("separator", { name: "Resize content column" });
    expect(resizer).toHaveAttribute("aria-valuenow", "220");
    fireEvent.mouseDown(resizer, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 360 });
    fireEvent.mouseUp(window, { clientX: 360 });
    expect(resizer).toHaveAttribute("aria-valuenow", "280");
    expect(document.body).not.toHaveClass("is-resizing-query-column");
  });
});
