import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import type { Language } from "../platform/settings-types";
import type { NodalStudioPlatform, QueryExecutionResult, SnapshotSummary } from "../platform";
import { reportSnapshot, reportSemantics } from "../test/schema-report-fixture";
import { ConnectionPanel } from "./ConnectionPanel";
import { SchemaTree } from "./SchemaTree";
import { TableKnowledgeForm } from "./TableInspector";
import { RelationshipEditor } from "./relationships/RelationshipEditor";
import { QueryPage } from "./query/QueryPage";
import { clearQuerySessions } from "./query/query-state";
import { HistoryPanel } from "./HistoryPanel";
import { DiagramLayoutActions } from "./DiagramLayoutActions";

it("retranslates a completed layout save when switching language", () => {
  const view = bilingual(<DiagramLayoutActions part="status" selectedCount={0} onArrange={vi.fn()}
    feedback={{ phase: "success", summary: "Layout saved on this device. 2 tables.", summaryKey: "business.savedOnThisDevice" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Saved on this device");
  view.chinese();
  expect(screen.getByRole("status")).not.toHaveTextContent("Layout saved");
  expect(screen.getByRole("status")).toHaveTextContent("已保存在此设备");
});
import { CanvasToolbar } from "./CanvasToolbar";

function Scope({ language, children }: { language: Language; children: ReactNode }) {
  return <I18nProvider value={useI18n(language)}>{children}</I18nProvider>;
}
function bilingual(children: ReactNode) {
  const view = render(<Scope language="en">{children}</Scope>);
  return { ...view, chinese: () => view.rerender(<Scope language="zhCn">{children}</Scope>), english: () => view.rerender(<Scope language="en">{children}</Scope>) };
}
beforeEach(() => {
  clearQuerySessions();
  // JSDOM has no layout; CodeMirror measures text after localized reconfiguration.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});
afterEach(() => { Reflect.deleteProperty(Range.prototype, "getClientRects"); Reflect.deleteProperty(Range.prototype, "getBoundingClientRect"); });

it("keeps a connection draft and in-flight test when language changes", async () => {
  let finish!: (value: { database: typeof reportSnapshot.database; sslActive: boolean; serverReadOnly: boolean }) => void;
  const listDataSources = vi.fn().mockResolvedValue([]);
  const testPostgresConnection = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const platform = { listDataSources, testPostgresConnection } as unknown as NodalStudioPlatform;
  const view = bilingual(<ConnectionPanel enabled platform={platform} onSnapshot={vi.fn()} defaultDatabaseType="postgreSql" defaultSslMode="verifyFull" />);
  await waitFor(() => expect(listDataSources).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Add database" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "客户数据库 untouched" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-only-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  view.chinese();
  expect(screen.getByLabelText("名称")).toHaveValue("客户数据库 untouched");
  expect(screen.getByLabelText("密码")).toHaveValue("test-only-password");
  expect(screen.getByLabelText("连接测试结果")).toHaveTextContent("检查设置和凭据中");
  expect(testPostgresConnection).toHaveBeenCalledOnce();
  expect(listDataSources).toHaveBeenCalledOnce();
  await act(async () => { finish({ database: reportSnapshot.database, sslActive: true, serverReadOnly: true }); await Promise.resolve(); });
  expect(screen.getByText("连接成功")).toBeVisible();
  expect(screen.getByRole("button", { name: "保存并查看结构" })).toBeEnabled();
});

it("preserves tree search and raw object names while translating actions", () => {
  const view = bilingual(<SchemaTree snapshot={reportSnapshot} onSelectTable={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "public.orders" } });
  view.chinese();
  expect(screen.getByRole("searchbox", { name: "搜索数据库对象" })).toHaveValue("public.orders");
  fireEvent.click(screen.getByRole("button", { name: "public.orders 的操作" }));
  expect(screen.getByRole("menuitem", { name: "复制限定名称" })).toBeVisible();
  view.english();
  expect(screen.getByRole("searchbox")).toHaveValue("public.orders");
});

it("preserves table knowledge drafts without saving them on a locale change", () => {
  const save = vi.fn();
  const view = bilingual(<TableKnowledgeForm table={reportSnapshot.schemas[0].tables[0]} sourceId={reportSnapshot.sourceId} onSaveAnnotation={save} />);
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Business draft 未保存" } });
  view.chinese();
  expect(screen.getByLabelText("描述")).toHaveValue("Business draft 未保存");
  expect(save).not.toHaveBeenCalled();
});

it("keeps relationship edits and validation identity while translating cardinalities", async () => {
  const validate = vi.fn().mockResolvedValue({ valid: true, compatible: true, duplicate: false, physicalExists: false, suggestedCardinality: "oneToOne", status: "active", messages: [] });
  const view = bilingual(<RelationshipEditor snapshot={reportSnapshot} relationship={reportSemantics.logicalRelationships[0]} onValidate={validate} onSave={vi.fn()} onSaved={vi.fn()} onCancel={vi.fn()} onStateChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "保留我的关系备注" } });
  const calls = validate.mock.calls.length;
  view.chinese();
  expect(screen.getByLabelText("备注")).toHaveValue("保留我的关系备注");
  expect(screen.getByRole("option", { name: "一对一" })).toBeInTheDocument();
  expect(validate).toHaveBeenCalledTimes(calls);
});

it("reconfigures SQL editor copy without replacing its view, selection, undo or query", async () => {
  let finish!: (value: QueryExecutionResult) => void;
  const executeReadonlyQuery = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const cancelQuery = vi.fn();
  const listQueryHistory = vi.fn().mockResolvedValue([]);
  const platform = { executeReadonlyQuery, cancelQuery, listQueryHistory } as unknown as NodalStudioPlatform;
  const view = bilingual(<QueryPage snapshot={reportSnapshot} platform={platform} runtimeKind="desktop" />);
  const editor = EditorView.findFromDOM(view.container.querySelector<HTMLElement>(".cm-editor")!)!;
  act(() => { editor.dispatch({ changes: { from: 0, insert: "SELECT 42;" }, selection: { anchor: 4 } }); });
  view.chinese();
  expect(EditorView.findFromDOM(view.container.querySelector<HTMLElement>(".cm-editor")!)).toBe(editor);
  expect(editor.state.selection.main.head).toBe(4);
  expect(editor.state.doc.toString()).toBe("SELECT 42;");
  act(() => { undo(editor); });
  expect(editor.state.doc.toString()).toBe("");
  act(() => { editor.dispatch({ changes: { from: 0, insert: "SELECT 42;" } }); });
  fireEvent.click(screen.getByRole("button", { name: /^运行 / }));
  await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledOnce());
  view.english();
  expect(cancelQuery).not.toHaveBeenCalled();
  await act(async () => { finish({ queryId: "language-test", columns: [{ name: "value", databaseType: "int4" }], rows: [[{ kind: "number", value: 42 }]], rowCount: 1, durationMs: 3, truncated: false, notices: [] }); await Promise.resolve(); });
  expect(await screen.findByRole("region", { name: "Query results" })).toBeVisible();
  expect(executeReadonlyQuery).toHaveBeenCalledOnce();
});

it("keeps history comparison direction and selected versions without reloading", async () => {
  const summaries: SnapshotSummary[] = [0, 1].map((i) => ({ id: `snapshot-${i}`, sourceId: reportSnapshot.sourceId, capturedAt: `2026-10-${13-i}T08:00:00Z`, fingerprint: `fingerprint-${i}`, databaseName: "Commerce", schemaCount: 2, tableCount: 3 }));
  const listSnapshots = vi.fn().mockResolvedValue(summaries);
  const view = bilingual(<HistoryPanel sourceId={reportSnapshot.sourceId} revision="same" activeSnapshot={reportSnapshot} platform={{ listSnapshots } as unknown as NodalStudioPlatform} onSelect={vi.fn()} onCompare={vi.fn()} />);
  await screen.findByRole("button", { name: "Swap direction" });
  fireEvent.click(screen.getByRole("button", { name: "Swap direction" }));
  view.chinese();
  expect(screen.getByLabelText("变更前（基线）")).toHaveValue("snapshot-0");
  expect(screen.getByLabelText("变更后（目标）")).toHaveValue("snapshot-1");
  expect(listSnapshots).toHaveBeenCalledOnce();
});

it("retains an expanded canvas tool panel and selection across locale changes", () => {
  const view = bilingual(<CanvasToolbar tableCount={3} selectedCount={2} filters={[]} layoutDisabled={false} onViewAll={vi.fn()} onAutoLayout={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Canvas tools" }));
  view.chinese();
  expect(screen.getByRole("button", { name: "画布工具" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/2 张表 已选择/)).toBeVisible();
});
