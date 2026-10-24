import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryInput, DiscoveryPreview, DiscoveryResult, NodalStudioPlatform } from "../../platform";
import { reportSemantics, reportSnapshot } from "../../test/schema-report-fixture";
import { discoveryPreview, discoveryResult, discoverySettings } from "../../test/discovery-fixture";
import { QueryPage } from "./QueryPage";
import { clearQuerySessions, saveQuerySession, loadQuerySession } from "./query-state";
import { QueryDraftPanel, type QueryDraftSeed } from "./QueryDraftPanel";
const sql = 'SELECT o.id, o.total FROM public.orders AS o LIMIT 100;';
const seed: QueryDraftSeed = { id: 1, sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, question: "Show order IDs and totals", root: reportSnapshot.schemas[0].tables[1].key, tables: [reportSnapshot.schemas[0].tables[1].key], domainId: null };
function setup(databaseType: "postgreSql" | "mySql" = "postgreSql") {
  const draftSql = databaseType === "mySql" ? "SELECT o.`id`, o.`total` FROM `public`.`orders` AS o LIMIT 100;" : sql;
  const previews = new Map<string, DiscoveryPreview>();
  const mocks = {
    listSnapshots: vi.fn().mockResolvedValue([{ id: reportSnapshot.id }]), listQueryHistory: vi.fn().mockResolvedValue([]),
    prepareDiscovery: vi.fn().mockImplementation((input: DiscoveryInput) => { const p = discoveryPreview(input); p.context.dialect = databaseType; previews.set(p.requestId, p); return Promise.resolve(p); }),
    runDiscovery: vi.fn().mockImplementation((id: string) => { const p = previews.get(id)!; const r = discoveryResult(p); r.answer = { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql: draftSql, explanation: "Lists order IDs and totals.", assumptions: [], clarification: [] } }; return Promise.resolve(r); }),
    cancelDiscovery: vi.fn().mockResolvedValue(undefined),
    executeReadonlyQuery: vi.fn().mockResolvedValue({ queryId: "q", columns: [], rows: [], rowCount: 0, durationMs: 1, truncated: false, notices: [] }),
  };
  return { platform: mocks as unknown as NodalStudioPlatform, mocks, draftSql, snapshot: { ...reportSnapshot, database: { ...reportSnapshot.database, databaseType } }, settings: discoverySettings(), semantics: reportSemantics };
}
async function generate() {
  fireEvent.click(await screen.findByRole("button", { name: "Review AI request" }));
  fireEvent.click(await screen.findByRole("button", { name: "Generate SQL" }));
  await screen.findByLabelText("Generated SQL");
}
describe("SQL drafting", () => {
  beforeEach(() => { clearQuerySessions(); });
  it.each(["postgreSql", "mySql"] as const)("%s drafting requires review and replacement, permits undo, and never runs automatically", async (dialect) => {
    const p = setup(dialect); const sql = p.draftSql; saveQuerySession("query-workspace", { ...loadQuerySession("query-workspace"), draft: "SELECT 42;" });
    const { container } = render(<QueryPage {...p} runtimeKind="desktop" draftSeed={seed} />);
    expect(screen.getByLabelText("Question")).toHaveValue("");
    expect(screen.getByText(seed.question)).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Review AI request" }));
    await screen.findByRole("button", { name: "Generate SQL" });
    expect(p.mocks.runDiscovery).not.toHaveBeenCalled();
    expect((p.mocks.prepareDiscovery.mock.calls[0][0] as DiscoveryInput).task).toMatchObject({ operation: "draftSql", question: seed.question, root: seed.root, candidates: seed.tables });
    fireEvent.click(screen.getByRole("button", { name: "Generate SQL" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review in editor" }));
    expect(screen.getByRole("dialog")).toBeVisible(); expect(container.querySelector(".cm-content")).toHaveTextContent("SELECT 42;");
    expect(p.mocks.executeReadonlyQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(container.querySelector(".cm-content")).toHaveTextContent(sql); expect(p.mocks.executeReadonlyQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Undo replacement" }));
    expect(container.querySelector(".cm-content")).toHaveTextContent("SELECT 42;");
    fireEvent.click(screen.getByRole("tab", { name: "Draft query" })); await generate();
    fireEvent.click(screen.getByRole("button", { name: "Review in editor" })); fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(p.mocks.executeReadonlyQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sql })));
    fireEvent.click(screen.getByRole("tab", { name: "Draft query" }));
    expect(await screen.findByRole("region", { name: "Executed query result" })).toBeVisible();
  });
  it("preserves both authoring modes and suppresses execution while composing a question", async () => {
    const p = setup();
    const { container } = render(<QueryPage {...p} runtimeKind="desktop" draftSeed={seed} />);
    const question = screen.getByLabelText("Question");
    fireEvent.change(question, { target: { value: "My revised question" } });
    expect(screen.getByRole("button", { name: /^Run/ })).toBeDisabled();
    fireEvent.keyDown(question, { key: "r", metaKey: true });
    fireEvent.keyDown(question, { key: "R", shiftKey: true, metaKey: true });
    expect(p.mocks.executeReadonlyQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "SQL editor" }));
    expect(screen.getByRole("button", { name: /^Run/ })).toBeEnabled();
    expect(container.querySelector(".cm-content")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("tab", { name: "SQL editor" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Draft query" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Question")).toHaveValue("My revised question");
    await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
  it("starts with a question, automatically prepares matching context, and keeps sending explicit", async () => {
    const p = setup();
    render(<StrictMode><QueryDraftPanel {...p} onUseSql={vi.fn()} onOpenSettings={vi.fn()} /></StrictMode>);
    expect(screen.queryByLabelText("Starting table")).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "What would you like to know?" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Show public.orders IDs" } });
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    await screen.findByRole("button", { name: "Generate SQL" });
    expect((p.mocks.prepareDiscovery.mock.calls[0][0] as DiscoveryInput).task.candidates).toEqual(seed.tables);
    expect(p.mocks.runDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "orders" } });
    expect(screen.queryByRole("button", { name: "Generate SQL" })).toBeNull();
    expect(p.mocks.cancelDiscovery).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    expect(screen.getByRole("region", { name: "Clarify query context" })).toBeVisible();
    expect(p.mocks.prepareDiscovery).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^public\.orders/ }));
    await screen.findByRole("button", { name: "Generate SQL" });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Show public.customers" } });
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    await screen.findByRole("button", { name: "Generate SQL" });
    expect((p.mocks.prepareDiscovery.mock.calls.at(-1)![0] as DiscoveryInput).task.candidates).toEqual([reportSnapshot.schemas[0].tables[0].key]);
  });
  it.each(["postgreSql", "mySql"] as const)("%s shows clarification without an actionable SQL draft", async (dialect) => {
    const p = setup(dialect); p.mocks.runDiscovery.mockImplementation(async () => ({ ...discoveryResult(discoveryPreview({ snapshotId: reportSnapshot.id, domainId: null, task: { operation: "draftSql", question: seed.question, root: seed.root, candidates: seed.tables, pathTables: [], pathRelationships: [] } })), requestId: p.mocks.prepareDiscovery.mock.results[0] ? (await p.mocks.prepareDiscovery.mock.results[0].value as DiscoveryPreview).requestId : "", answer: { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql: null, explanation: "Business definition needed", assumptions: [], clarification: ["What counts as active?"] } } }));
    render(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review AI request" })); fireEvent.click(await screen.findByRole("button", { name: "Generate SQL" }));
    expect(await screen.findByText("What counts as active?")).toBeVisible(); expect(screen.queryByRole("button", { name: "Review in editor" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Active means total greater than zero" } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(p.mocks.prepareDiscovery).toHaveBeenCalledTimes(2));
    expect((p.mocks.prepareDiscovery.mock.calls[1][0] as DiscoveryInput).task.question).toContain("What counts as active?");
    expect((p.mocks.prepareDiscovery.mock.calls[1][0] as DiscoveryInput).task.question).toContain("Active means total greater than zero");
  });
  it.each(["postgreSql", "mySql"] as const)("%s allows composing while a draft runs, cancels on sending the next turn, and rejects late output", async (dialect) => {
    const p = setup(dialect); let finish!: (r: DiscoveryResult) => void;
    p.mocks.runDiscovery.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review AI request" })); fireEvent.click(await screen.findByRole("button", { name: "Generate SQL" }));
    const preview = await p.mocks.prepareDiscovery.mock.results[0].value as DiscoveryPreview;
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Changed question" } });
    expect(p.mocks.cancelDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(p.mocks.cancelDiscovery).toHaveBeenCalledWith(preview.requestId);
    await act(async () => { finish({ ...discoveryResult(preview), answer: { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql, explanation: "Late answer", assumptions: [], clarification: [] } } }); await Promise.resolve(); });
    expect(screen.queryByLabelText("Generated SQL")).toBeNull();
  });
  it("keeps answers above the composer and sends follow-ups with the reviewed tables but without local result rows", async () => {
    const p = setup("mySql");
    const execution = { sql: p.draftSql, result: { queryId: "local", columns: [{ name: "private_note", databaseType: "TEXT" }], rows: [[{ kind: "text" as const, value: "LOCAL_RESULT_ONLY", truncated: false }]], rowCount: 1, durationMs: 2, truncated: false, notices: [] } };
    render(<QueryDraftPanel {...p} seed={seed} execution={execution} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    await generate();
    expect(screen.getByText("LOCAL_RESULT_ONLY")).toBeVisible();
    const question = screen.getByLabelText("Question");
    fireEvent.change(question, { target: { value: "只取前 5 行" } });
    expect(screen.getByLabelText("Generated SQL")).toBeVisible();
    fireEvent.keyDown(question, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(question, { key: "Enter", isComposing: true });
    expect(p.mocks.prepareDiscovery).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(question, { key: "Enter" });
    await waitFor(() => expect(p.mocks.prepareDiscovery).toHaveBeenCalledTimes(2));
    expect(question).toHaveValue("");
    expect(screen.getByText(seed.question)).toBeVisible();
    const input = p.mocks.prepareDiscovery.mock.calls[1][0] as DiscoveryInput;
    expect(input.task.question).toContain(seed.question);
    expect(input.task.question).toContain("只取前 5 行");
    expect(input.task.candidates).toEqual(seed.tables);
    expect(JSON.stringify(input)).not.toContain("LOCAL_RESULT_ONLY");
    expect(p.mocks.runDiscovery).toHaveBeenCalledTimes(1);
    expect(p.mocks.executeReadonlyQuery).not.toHaveBeenCalled();
  });
  it("blocks out-of-scope carried tables and offline configuration without silently changing scope", async () => {
    const p = setup(); p.settings.source!.ai.contextScope = "currentTable";
    const view = render(<QueryDraftPanel {...p} seed={{ ...seed, tables: reportSnapshot.schemas[0].tables.map((t) => t.key) }} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("outside the configured AI scope"); expect(screen.queryByRole("button", { name: "Review AI request" })).toBeNull();
    p.settings.app.privacy.offlineMode = true; view.rerender(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open AI settings" })).toBeVisible(); expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled();
    await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
  it("does not reuse an archived SQL action after relationship evidence changes", async () => {
    const p = setup();
    const view = render(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    await generate();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Limit to 5" } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(screen.getByRole("button", { name: "Review in editor" })).toBeEnabled();
    view.rerender(<QueryDraftPanel {...p} semantics={{ ...p.semantics, logicalRelationships: [] }} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Review in editor" })).toBeDisabled();
    await waitFor(() => expect(p.mocks.prepareDiscovery).toHaveBeenCalled());
  });
  it("keeps an over-limit follow-up editable without sending truncated context", async () => {
    const p = setup();
    render(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    const question = screen.getByLabelText("Question");
    fireEvent.change(question, { target: { value: "x".repeat(2000) } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(screen.getByRole("alert")).toHaveTextContent("context limit");
    expect(question).toHaveValue("x".repeat(2000));
    expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(question).toHaveValue("");
    expect(screen.queryByText(seed.question)).toBeNull();
    await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
});
