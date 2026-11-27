import { describe, expect, it } from "vitest";
import { validateDiagnosticReport } from "./code-extension-diagnostics.worker";

describe("validateDiagnosticReport", () => {
  it("accepts valid diagnostic payloads and clamps overly long text fields", () => {
    const payload = JSON.stringify({
      total: 2,
      findings: [{
        rule: "R".repeat(300),
        message: "M".repeat(2_500),
        severity: "warning",
        start: { line: 1, character: 2 },
        end: { line: 1, character: 5 },
      }],
    });
    const report = validateDiagnosticReport(payload, 10);
    expect(report.total).toBe(2);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].rule).toHaveLength(200);
    expect(report.findings[0].message).toHaveLength(2_000);
    expect(report.findings[0].start).toEqual({ line: 1, character: 2 });
  });

  it("rejects reports that exceed limit, have inconsistent total, or use invalid severity", () => {
    expect(() => validateDiagnosticReport(JSON.stringify({ total: 1, findings: [{}, {}] }), 10)).toThrow();
    expect(() => validateDiagnosticReport(JSON.stringify({
      total: 2,
      findings: [
        { rule: "a", message: "m", severity: "error" },
        { rule: "b", message: "m", severity: "error" },
      ],
    }), 1)).toThrow();
    expect(() => validateDiagnosticReport(JSON.stringify({
      total: 1,
      findings: [{ rule: "a", message: "m", severity: "info" }],
    }), 10)).toThrow();
  });
});
