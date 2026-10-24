import { describe, expect, it } from "vitest";
import { reportSnapshot, reportSemantics } from "../../test/schema-report-fixture";
import { discoverySettings } from "../../test/discovery-fixture";
import { resolveDraftContext } from "./query-context";
import { diagramColumn, diagramForeignKey, diagramTable } from "../../test/diagram-comparison-fixture";
const unique = { ...reportSnapshot, schemas: [reportSnapshot.schemas[0]] };
const semantics = { ...reportSemantics, logicalRelationships: [] };
const mailTables = [
  diagramTable("mail_send_task", [diagramColumn("id"), diagramColumn("create_at"), diagramColumn("state")]),
  { ...diagramTable("mail_task_relation", [diagramColumn("id"), diagramColumn("task_id"), diagramColumn("mail_id"), diagramColumn("state")]), foreignKeys: [diagramForeignKey("task_fk", "task_id", "mail_send_task"), diagramForeignKey("mail_fk", "mail_id", "mail_list")] },
  diagramTable("mail_list", [diagramColumn("id"), diagramColumn("create_at"), diagramColumn("state")]),
  diagramTable("states", [diagramColumn("id"), diagramColumn("name")]),
];
const mailSnapshot = { ...unique, schemas: [{ ...unique.schemas[0], tables: mailTables }] };
describe("question-first query context", () => {
  it("does not confuse state filters with an unrelated states table in a monthly query", () => {
    const result = resolveDraftContext(mailSnapshot, semantics, discoverySettings(), "只使用 public.mail_list：按 create_at 统计每月新增数量，state 不过滤。排除空日期，不补零月份，返回最近 12 个月。每条记录计为一个新增地址，不返回个人字段。");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.context.tables).toEqual([mailTables[2].key]);
  });
  it("uses the confirmed bridge as the automatic OneHop root for three-table monthly distinct counts", () => {
    const result = resolveDraftContext(mailSnapshot, semantics, discoverySettings(), "只使用 public.mail_send_task、public.mail_task_relation、public.mail_list。按任务 create_at 的年月统计，关联 state=20、邮件列表 state=10，同月按 mail_id 去重，最近 12 个有记录月份，不返回个人字段。");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.context.root).toEqual(mailTables[1].key);
      expect(result.context.tables.map((t) => t.name).sort()).toEqual(["mail_list", "mail_send_task", "mail_task_relation"]);
    }
    const settings = discoverySettings(); settings.source!.ai.contextScope = "currentTable";
    expect(resolveDraftContext(mailSnapshot, semantics, settings, "public.mail_send_task public.mail_task_relation public.mail_list").kind).toBe("blocked");
    const disconnected = { ...mailSnapshot, schemas: [{ ...mailSnapshot.schemas[0], tables: mailTables.map((t) => ({ ...t, foreignKeys: [] })) }] };
    expect(resolveDraftContext(disconnected, semantics, discoverySettings(), "public.mail_send_task public.mail_task_relation public.mail_list").kind).toBe("clarify");
  });
  it("finds relevant data without a manually selected root and uses only confirmed paths", () => {
    const settings = discoverySettings();
    const result = resolveDraftContext(unique, semantics, settings, "按客户统计订单数量");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") expect(result.context.tables.map((t) => t.name).sort()).toEqual(["customers", "orders"]);
  });
  it("asks for clarification for same-name schemas and never silently selects one", () => {
    const result = resolveDraftContext(reportSnapshot, reportSemantics, discoverySettings(), "orders");
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.choices.map((c) => c.key.schema)).toContain("archive");
    const qualified = resolveDraftContext(reportSnapshot, reportSemantics, discoverySettings(), "List public.orders IDs");
    expect(qualified.kind).toBe("ready");
    if (qualified.kind === "ready") expect(qualified.context.tables).toEqual([reportSnapshot.schemas[0].tables[1].key]);
  });
  it("does not expand current-table scope or guess a domain", () => {
    const settings = discoverySettings(); settings.source!.ai.contextScope = "currentTable";
    expect(resolveDraftContext(unique, semantics, settings, "customers orders").kind).toBe("blocked");
    settings.source!.ai.contextScope = "domain";
    expect(resolveDraftContext(unique, semantics, settings, "orders").kind).toBe("blocked");
    expect(resolveDraftContext(unique, semantics, settings, "orders", reportSemantics.domainGroups[0].id).kind).toBe("ready");
  });
  it("asks a focused question for no match and ignores an unrelated inspected table", () => {
    expect(resolveDraftContext(unique, semantics, discoverySettings(), "天气", "", unique.schemas[0].tables[0].key).kind).toBe("clarify");
    const result = resolveDraftContext(unique, semantics, discoverySettings(), "当前表数量", "", unique.schemas[0].tables[0].key);
    expect(result.kind).toBe("ready");
  });
  it("does not invent a relationship between matched subjects", () => {
    const snapshot = { ...unique, schemas: unique.schemas.map((s) => ({ ...s, tables: s.tables.map((t) => ({ ...t, foreignKeys: [] })) })) };
    expect(resolveDraftContext(snapshot, semantics, discoverySettings(), "customers orders").kind).toBe("clarify");
  });
});
