import { describe, expect, it } from "vitest";
import type { QueryCell, QueryExecutionResult } from "../../platform";
import { presentResult } from "./result-presentation";
import { queryAnswerCatalog, queryAnswerSpec } from "./query-answer-spec";

const text = (value: string): QueryCell => ({ kind: "text", value, truncated: false });
const number = (value: number): QueryCell => ({ kind: "number", value });
function result(rows: QueryCell[][], names = ["month", "recipient_count"], types = ["VARCHAR", "BIGINT UNSIGNED"]): QueryExecutionResult {
  return { queryId: "test", columns: names.map((name, i) => ({ name, databaseType: types[i] })), rows, rowCount: rows.length, durationMs: 12, truncated: false, notices: [] };
}
describe("local result presentation", () => {
  it("sorts monthly points without changing SQL row order, adding missing months or summing distinct counts", () => {
    const data = result([[text("2022-03"), number(11)], [text("2022-01"), number(8)]]);
    const plan = presentResult(data);
    expect(plan).toMatchObject({ kind: "chart", temporal: true, period: "month", points: [{ label: "2022-01", value: 8 }, { label: "2022-03", value: 11 }] });
    expect(plan).not.toHaveProperty("total");
    expect(data.rows[0][0]).toEqual(text("2022-03"));
  });
  it("preserves categories and signed values in query order", () => {
    expect(presentResult(result([[text("Refunds"), number(-3)], [text("Sales"), number(9)]], ["category", "amount"]))).toMatchObject({ kind: "chart", temporal: false, points: [{ label: "Refunds", value: -3 }, { label: "Sales", value: 9 }] });
  });
  it("uses numeric IDs only as labels, not measures", () => {
    expect(presentResult(result([[number(12), number(5)], [number(3), number(0)]], ["task_id", "recipient_count"], ["INT", "BIGINT"]))).toMatchObject({ kind: "chart", dimension: "Task id", temporal: false });
    expect(presentResult(result([[number(1)]], ["id"], ["INT"]))).toMatchObject({ kind: "table" });
  });
  it("uses a metric only for a complete single numeric value", () => {
    const data = result([[text("1234.50")]], ["revenue"], ["DECIMAL(12,2)"]);
    expect(presentResult(data)).toEqual({ kind: "metric", title: "Revenue", value: "1234.50" });
    expect(presentResult({ ...data, truncated: true })).toMatchObject({ kind: "table" });
  });
  it.each([null, "9007199254740993", "1.12345678901234567", "1e-9999", "NaN"])("keeps unsupported numeric value %s in the table instead of coercing it", (value) => {
    const cell: QueryCell = value === null ? { kind: "null" } : text(value);
    expect(presentResult(result([[text("a"), cell], [text("b"), number(2)]]))).toMatchObject({ kind: "table" });
  });
  it("does not combine duplicate labels or hide extra measures", () => {
    const duplicate = presentResult(result([[text("a"), number(1)], [text("a"), number(2)]]));
    expect(duplicate.kind).toBe("table");
    if (duplicate.kind === "table") expect(duplicate.reason).toContain("Repeated labels");
    expect(presentResult(result([[text("a"), number(1), number(2)], [text("b"), number(3), number(4)]], ["label", "first", "second"], ["TEXT", "INT", "INT"]))).toMatchObject({ kind: "table" });
  });
  it("does not interpret invalid dates as time series or change timezone", () => {
    expect(presentResult(result([[text("2024-02-29"), number(1)], [text("2024-03-01"), number(2)]]))).toMatchObject({ kind: "chart", temporal: true, period: "day" });
    expect(presentResult(result([[text("2023-02-29"), number(1)], [text("2023-03-01"), number(2)]]))).toMatchObject({ kind: "chart", temporal: false });
  });
  it("falls back for empty, truncated cells and large result sets", () => {
    expect(presentResult(result([]))).toMatchObject({ kind: "table", reason: "No rows matched this query." });
    expect(presentResult(result([[{ kind: "text", value: "partial", truncated: true }, number(1)], [text("b"), number(2)]]))).toMatchObject({ kind: "table" });
    expect(presentResult(result(Array.from({ length: 61 }, (_, i) => [text(`item ${i}`), number(i)])))).toMatchObject({ kind: "table" });
  });
  it("catalog-validates the local artifact and never creates it from an unexecuted draft", () => {
    const draft = { sql: "SELECT month, recipient_count", explanation: "Monthly recipients", assumptions: [], clarification: [] };
    expect(queryAnswerSpec(draft).elements).not.toHaveProperty("result");
    const spec = queryAnswerSpec(draft, result([[text("2022-02"), number(0)], [text("2022-01"), number(1)]]));
    expect(queryAnswerCatalog.validate(spec).success).toBe(true);
    expect(spec.elements.answer.children!.indexOf("result")).toBeLessThan(spec.elements.answer.children!.indexOf("sql"));
  });
});
