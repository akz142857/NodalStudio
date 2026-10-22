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
function setup() {
  const previews = new Map<string, DiscoveryPreview>();
  const mocks = {
    listSnapshots: vi.fn().mockResolvedValue([{ id: reportSnapshot.id }]), listQueryHistory: vi.fn().mockResolvedValue([]),
    prepareDiscovery: vi.fn().mockImplementation((input: DiscoveryInput) => { const p = discoveryPreview(input); previews.set(p.requestId, p); return Promise.resolve(p); }),
    runDiscovery: vi.fn().mockImplementation((id: string) => { const p = previews.get(id)!; const r = discoveryResult(p); r.answer = { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql, explanation: "Lists order IDs and totals.", assumptions: [], clarification: [] } }; return Promise.resolve(r); }),
    cancelDiscovery: vi.fn().mockResolvedValue(undefined),
    executeReadonlyQuery: vi.fn().mockResolvedValue({ queryId: "q", columns: [], rows: [], rowCount: 0, durationMs: 1, truncated: false, notices: [] }),
  };
  return { platform: mocks as unknown as NodalStudioPlatform, mocks, snapshot: reportSnapshot, settings: discoverySettings(), semantics: reportSemantics };
}
async function generate() {
  fireEvent.click(await screen.findByRole("button", { name: "Review AI request" }));
  fireEvent.click(await screen.findByRole("button", { name: "Generate SQL" }));
  await screen.findByLabelText("Generated SQL");
}
describe("SQL drafting", () => {
  beforeEach(() => { clearQuerySessions(); });
  it("reuses context, requires preview/send and editor replacement, permits undo, and never runs automatically", async () => {
    const p = setup(); saveQuerySession("query-workspace", { ...loadQuerySession("query-workspace"), draft: "SELECT 42;" });
    const { container } = render(<QueryPage {...p} runtimeKind="desktop" draftSeed={seed} />);
    expect(screen.getByLabelText("Question")).toHaveValue(seed.question);
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
    screen.getAllByRole("checkbox").forEach((checkbox) => expect(checkbox).not.toBeVisible());
    expect(screen.getByRole("heading", { name: "What would you like to know?" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Show public.orders IDs" } });
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    await screen.findByRole("button", { name: "Generate SQL" });
    expect((p.mocks.prepareDiscovery.mock.calls[0][0] as DiscoveryInput).task.candidates).toEqual(seed.tables);
    expect(p.mocks.runDiscovery).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "orders" } });
    expect(screen.queryByRole("button", { name: "Generate SQL" })).toBeNull();
    expect(p.mocks.cancelDiscovery).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    expect(screen.getByRole("region", { name: "Clarify query context" })).toBeVisible();
    expect(p.mocks.prepareDiscovery).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^public\.orders/ }));
    await screen.findByRole("button", { name: "Generate SQL" });
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Show public.customers" } });
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    await screen.findByRole("button", { name: "Generate SQL" });
    expect((p.mocks.prepareDiscovery.mock.calls.at(-1)![0] as DiscoveryInput).task.candidates).toEqual([reportSnapshot.schemas[0].tables[0].key]);
  });
  it("shows clarification without an actionable SQL draft", async () => {
    const p = setup(); p.mocks.runDiscovery.mockImplementation(async () => ({ ...discoveryResult(discoveryPreview({ snapshotId: reportSnapshot.id, domainId: null, task: { operation: "draftSql", question: seed.question, root: seed.root, candidates: seed.tables, pathTables: [], pathRelationships: [] } })), requestId: p.mocks.prepareDiscovery.mock.results[0] ? (await p.mocks.prepareDiscovery.mock.results[0].value as DiscoveryPreview).requestId : "", answer: { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql: null, explanation: "Business definition needed", assumptions: [], clarification: ["What counts as active?"] } } }));
    render(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review AI request" })); fireEvent.click(await screen.findByRole("button", { name: "Generate SQL" }));
    expect(await screen.findByText("What counts as active?")).toBeVisible(); expect(screen.queryByRole("button", { name: "Review in editor" })).toBeNull();
  });
  it("cancels an in-flight draft when the question changes and rejects late output", async () => {
    const p = setup(); let finish!: (r: DiscoveryResult) => void;
    p.mocks.runDiscovery.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review AI request" })); fireEvent.click(await screen.findByRole("button", { name: "Generate SQL" }));
    const preview = await p.mocks.prepareDiscovery.mock.results[0].value as DiscoveryPreview;
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Changed question" } });
    expect(p.mocks.cancelDiscovery).toHaveBeenCalledWith(preview.requestId);
    await act(async () => { finish({ ...discoveryResult(preview), answer: { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql, explanation: "Late answer", assumptions: [], clarification: [] } } }); await Promise.resolve(); });
    expect(screen.queryByLabelText("Generated SQL")).toBeNull();
  });
  it("blocks out-of-scope carried tables and offline configuration without silently changing scope", async () => {
    const p = setup(); p.settings.source!.ai.contextScope = "currentTable";
    const view = render(<QueryDraftPanel {...p} seed={{ ...seed, tables: reportSnapshot.schemas[0].tables.map((t) => t.key) }} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("outside the configured AI scope"); expect(screen.queryByRole("button", { name: "Review AI request" })).toBeNull();
    p.settings.app.privacy.offlineMode = true; view.rerender(<QueryDraftPanel {...p} seed={seed} onUseSql={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open AI settings" })).toBeVisible(); expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled();
    await waitFor(() => expect(p.mocks.listSnapshots).toHaveBeenCalled());
  });
});
