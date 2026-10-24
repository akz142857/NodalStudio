import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { preflightText } from "./preflight-text";
import { runSchemaPreflight } from "./schema-preflight";
import { reportSnapshot } from "../test/schema-report-fixture";

describe("preflight presentation translation", () => {
  it("localizes explanations and evidence without translating identifiers or mutating review evidence", () => {
    const snapshot = structuredClone(reportSnapshot);
    snapshot.schemas[0].tables[0].primaryKey = null;
    const report = runSchemaPreflight(snapshot);
    const before = JSON.stringify(report);
    const zh = createTranslator("zh-CN");
    expect(preflightText(report.findings[0].message, zh)).toBe("此表未采集到主键。");
    expect(preflightText('Source columns: ["customer_id"]', zh)).toBe('来源字段：["customer_id"]');
    expect(preflightText('Pair 1: "id" → "id"', zh)).toBe('字段配对 1: "id" → "id"');
    expect(preflightText(report.coverage[0].name, zh)).toBe("主键存在性");
    expect(preflightText(report.findings[0].message, createTranslator("en"))).toBe(report.findings[0].message);
    expect(JSON.stringify(report)).toBe(before);
  });
});
