import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform, TableAiInput, TableAiPreview, TableAiResult } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { aiTable, tableAiPreview, tableAiResult, tableAiSettings } from "../test/table-ai-fixture";
import { TableAiAssistant } from "./TableAiAssistant";
import { InspectorPanel } from "./InspectorPanel";

afterEach(() => vi.useRealTimers());
const summary = tableAiResult.answer.summary!.text;
function freshPreview(): TableAiPreview { return { ...tableAiPreview, expiresAt: new Date(Date.now() + 300_000).toISOString() }; }
function platformMock() {
  const mocks = { prepareTableExplanation: vi.fn().mockImplementation(() => Promise.resolve(freshPreview())), runTableExplanation: vi.fn().mockResolvedValue(tableAiResult), cancelTableExplanation: vi.fn().mockResolvedValue(undefined) };
  return { mocks, platform: mocks as unknown as NodalStudioPlatform };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function props() { return { ...platformMock(), snapshot: reportSnapshot, table: aiTable, settings: tableAiSettings(), domains: reportSemantics.domainGroups, desktop: true, onOpenSettings: vi.fn(), onLocateEvidence: vi.fn(), onTaskChange: vi.fn() }; }
async function ready(name = "Send and answer") { await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled()); }
async function answer() { await ready(); fireEvent.click(screen.getByRole("button", { name: "Send and answer" })); await screen.findByText(summary); }
function showAllEvidence() { fireEvent.click(screen.getByText("Request details")); fireEvent.click(screen.getByText("All captured evidence")); }
function showAnswerEvidence() { fireEvent.click(screen.getByText("View supporting evidence")); }

describe("task-first table understanding", () => {
  it("prepares locally, requires one explicit send, and keeps diagnostics collapsed", async () => {
    const p = props(); render(<TableAiAssistant {...p} />); await ready();
    expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Prepare request preview" })).not.toBeInTheDocument();
    expect(screen.getByText("Request details").parentElement).not.toHaveAttribute("open");
    expect(screen.getByText(/no rows or credentials/)).toBeVisible();
    await answer();
    expect(p.mocks.runTableExplanation).toHaveBeenCalledExactlyOnceWith("fixture-request");
    expect(screen.getByText("View supporting evidence").parentElement).not.toHaveAttribute("open");
    showAnswerEvidence(); fireEvent.click(within(screen.getByLabelText("Answer")).getByRole("button", { name: "customer_id · field" }));
    expect(p.onLocateEvidence).toHaveBeenCalledWith(tableAiPreview.context.evidence[0], "fixture-request");
    expect(screen.queryByRole("button", { name: /draft|save/i })).not.toBeInTheDocument();
  });
  it("retains the last answer while editing, but invalidates the pending request immediately", async () => {
    const p = props(); render(<TableAiAssistant {...p} />); await answer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A different question" } });
    expect(screen.getByText(summary)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send and answer" })).toBeDisabled();
    await ready(); expect(p.mocks.runTableExplanation).toHaveBeenCalledTimes(1);
  });
  it("prepares again when choosing the suggestion that is already in the composer", async () => {
    const p = props(); render(<TableAiAssistant {...p} />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "What does one row represent?" }));
    expect(screen.getByRole("button", { name: "Send and answer" })).toBeDisabled();
    await ready();
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith("fixture-request");
    expect(p.mocks.prepareTableExplanation).toHaveBeenCalledTimes(2);
    expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
  });
  it("does not prepare a hidden panel, and suggestions never send", async () => {
    vi.useFakeTimers(); const p = props(); const view = render(<TableAiAssistant {...p} active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); }); expect(p.mocks.prepareTableExplanation).not.toHaveBeenCalled();
    view.rerender(<TableAiAssistant {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "How is this table related?" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(p.mocks.prepareTableExplanation).toHaveBeenCalledOnce(); expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
  });
  it("requires a selected domain and binds the focused field without expanding scope", async () => {
    const p = props(); p.settings.source!.ai.contextScope = "domain";
    p.mocks.prepareTableExplanation.mockImplementation((input: TableAiInput) => Promise.resolve({ ...freshPreview(), context: { ...tableAiPreview.context, scope: "domain", focusColumn: input.focusColumn } }));
    render(<TableAiAssistant {...p} />);
    expect(screen.getByRole("button", { name: "Send and answer" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Business domain"), { target: { value: "domain-private-id" } });
    fireEvent.click(screen.getByText("Selected business domain"));
    fireEvent.change(screen.getByLabelText("Focus field"), { target: { value: "customer_id" } });
    await ready(); expect(p.mocks.prepareTableExplanation).toHaveBeenCalledWith(expect.objectContaining({ domainId: "domain-private-id", focusColumn: "customer_id", target: aiTable.key }));
  });
  it("cancels an in-flight preparation and disposes its late preview", async () => {
    const p = props(); const pending = deferred<TableAiPreview>(); p.mocks.prepareTableExplanation.mockReturnValue(pending.promise);
    render(<TableAiAssistant {...p} />); await waitFor(() => expect(p.mocks.prepareTableExplanation).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => { pending.resolve(freshPreview()); await pending.promise; });
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith("fixture-request"); expect(screen.getByRole("button", { name: "Send and answer" })).toBeDisabled();
  });
  it.each(["cancel", "edit"])("discards a late answer after %s", async reason => {
    const p = props(); const pending = deferred<TableAiResult>(); p.mocks.runTableExplanation.mockReturnValue(pending.promise);
    render(<TableAiAssistant {...p} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Send and answer" }));
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else fireEvent.change(screen.getByRole("textbox"), { target: { value: "New question" } });
    await act(async () => { pending.resolve(tableAiResult); await pending.promise; });
    expect(screen.queryByText(summary)).not.toBeInTheDocument(); expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith("fixture-request");
  });
  it.each(["truncated at its token limit", "invalid structured output", "network timeout"])("keeps questions and allows safe retry after %s", async message => {
    const p = props(); p.mocks.runTableExplanation.mockRejectedValue(new Error(message));
    render(<TableAiAssistant {...p} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Send and answer" }));
    await screen.findByRole("alert"); expect(screen.getByRole("textbox")).toHaveValue("What does one row represent?");
    expect(screen.queryByText(summary)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh request" })); await ready(); expect(p.mocks.prepareTableExplanation).toHaveBeenCalledTimes(2);
    expect(p.mocks.runTableExplanation).toHaveBeenCalledTimes(1);
  });
  it("blocks Web, stale settings and remote offline mode", () => {
    const p = props(); const view = render(<TableAiAssistant {...p} desktop={false} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const settings = tableAiSettings(); settings.app.privacy.offlineMode = true;
    view.rerender(<TableAiAssistant {...p} settings={settings} />); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    settings.app.privacy.offlineMode = false; settings.source!.sourceId = "other";
    view.rerender(<TableAiAssistant {...p} settings={settings} />); expect(screen.getByText(/AI settings for this source are not loaded/)).toBeVisible();
    expect(p.mocks.prepareTableExplanation).not.toHaveBeenCalled();
  });
  it("labels the offline provider honestly and permits only a local action", async () => {
    const p = props(); p.settings.source!.ai.provider = "offline";
    p.mocks.prepareTableExplanation.mockResolvedValue({ ...freshPreview(), provider: "offline-schema", model: null, endpoint: null, requestBody: null });
    p.mocks.runTableExplanation.mockResolvedValue({ ...tableAiResult, provider: "offline-schema", model: null, answer: { schemaVersion: 2, summary: null, interpretations: [], unknowns: [] } });
    render(<TableAiAssistant {...p} />); await ready("Show local structure");
    expect(screen.getByText("Local analysis only; no network request")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show local structure" })); expect(await screen.findByText(/does not infer business meaning/)).toBeVisible();
  });
  it.each(["provider", "scope", "model", "field", "snapshot"])("rejects mismatched preview %s", async change => {
    const p = props(); const next = freshPreview();
    if (change === "provider") next.provider = "offline-schema";
    if (change === "scope") next.context = { ...next.context, scope: "oneHop" };
    if (change === "model") next.model = "other-model";
    if (change === "field") next.context = { ...next.context, focusColumn: "unexpected" };
    if (change === "snapshot") next.snapshotId = "other";
    p.mocks.prepareTableExplanation.mockResolvedValue(next); render(<TableAiAssistant {...p} />);
    await screen.findByRole("alert"); expect(p.mocks.runTableExplanation).not.toHaveBeenCalled(); expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith(next.requestId);
  });
  it.each(["timer", "visibility", "focus", "send"])("enforces the absolute expiry on %s", async trigger => {
    vi.useFakeTimers(); const p = props(); const preview = freshPreview(); p.mocks.prepareTableExplanation.mockResolvedValue(preview);
    render(<TableAiAssistant {...p} />); await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    if (trigger === "timer") await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    else {
      vi.setSystemTime(Date.parse(preview.expiresAt) + 1);
      if (trigger === "visibility") fireEvent(document, new Event("visibilitychange"));
      if (trigger === "focus") fireEvent(window, new Event("focus"));
      if (trigger === "send") fireEvent.click(screen.getByRole("button", { name: "Send and answer" }));
    }
    expect(screen.getByRole("status")).toHaveTextContent("Preview expired"); expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
    expect(p.onTaskChange).toHaveBeenLastCalledWith(undefined);
  });
  it("rejects a late response after expiry even when the timer has not fired", async () => {
    vi.useFakeTimers(); const p = props(); const preview = freshPreview(); const pending = deferred<TableAiResult>();
    p.mocks.prepareTableExplanation.mockResolvedValue(preview); p.mocks.runTableExplanation.mockReturnValue(pending.promise);
    render(<TableAiAssistant {...p} />); await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole("button", { name: "Send and answer" })); vi.setSystemTime(Date.parse(preview.expiresAt) + 1);
    await act(async () => { pending.resolve(tableAiResult); await pending.promise; }); expect(screen.queryByText(summary)).not.toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("Preview expired");
  });
  it.each(["invalid-date", "2000-01-01T00:00:00Z"])("never enables a delivered invalid/expired deadline %s", async expiresAt => {
    const p = props(); p.mocks.prepareTableExplanation.mockResolvedValue({ ...freshPreview(), expiresAt }); render(<TableAiAssistant {...p} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Preview expired")); expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
  });
  it("provides one whole-answer draft action and uses the app language", async () => {
    const p = props(); p.settings.app.general.language = "zhCn";
    render(<TableAiAssistant {...p} onKnowledgeSaved={vi.fn()} />); await ready("发送并回答"); fireEvent.click(screen.getByRole("button", { name: "发送并回答" })); await screen.findByText(summary);
    expect(screen.getAllByRole("button", { name: "整理成表说明" })).toHaveLength(1); expect(screen.getByText("查看回答依据")).toBeVisible();
  });
});

describe("inspector task identity", () => {
  function panelProps() { return { snapshot: reportSnapshot, selectedTable: aiTable, semantics: reportSemantics, settings: tableAiSettings(), ...platformMock(), runtime: { kind: "desktop" } as Parameters<typeof InspectorPanel>[0]["runtime"], historyRevision: "current", onSaveAnnotation: vi.fn(), onRefreshSemantics: vi.fn().mockResolvedValue(undefined), onSemanticsChange: vi.fn(), onApplyView: vi.fn(), onOpenSettings: vi.fn(), onSelectSnapshot: vi.fn(), onCompareSnapshots: vi.fn() }; }
  it("locates named evidence and preserves the answer on return", async () => {
    const p = panelProps(); const { container } = render(<InspectorPanel {...p} />); fireEvent.click(screen.getByRole("button", { name: "AI" })); await answer(); showAnswerEvidence();
    fireEvent.click(within(screen.getByLabelText("Answer")).getByRole("button", { name: "customer_id · field" }));
    expect(screen.getByRole("region", { name: "Located evidence" })).toHaveTextContent("customer_id"); expect(container.querySelector('[data-evidence-focus="true"]')).toHaveTextContent("customer_id");
    fireEvent.click(screen.getByRole("button", { name: "Back to AI explanation" })); expect(screen.getByText(summary)).toBeVisible(); expect(p.onSaveAnnotation).not.toHaveBeenCalled();
  });
  it.each(["table", "historical", "source", "snapshot", "settings", "semantics", "deselection", "disconnect"])("does not restore stale evidence after a %s round trip", async change => {
    const p = panelProps(); const view = render(<StrictMode><InspectorPanel {...p} /></StrictMode>); fireEvent.click(screen.getByRole("button", { name: "AI" })); await answer(); showAnswerEvidence();
    fireEvent.click(within(screen.getByLabelText("Answer")).getByRole("button", { name: "customer_id · field" }));
    const away: Parameters<typeof InspectorPanel>[0] = { ...p };
    if (change === "table") away.selectedTable = reportSnapshot.schemas[0].tables[0];
    if (change === "historical") away.historicalSelection = true;
    if (change === "source") away.snapshot = { ...reportSnapshot, sourceId: "other" };
    if (change === "snapshot") away.snapshot = { ...reportSnapshot, id: "other" };
    if (change === "settings") { away.settings = tableAiSettings(); away.settings.source!.ai.enabled = false; }
    if (change === "semantics") away.semantics = { ...reportSemantics, domainGroups: [] };
    if (change === "deselection") away.selectedTable = undefined;
    if (change === "disconnect") away.snapshot = undefined;
    view.rerender(<StrictMode><InspectorPanel {...away} /></StrictMode>); expect(screen.queryByRole("region", { name: "Located evidence" })).not.toBeInTheDocument();
    view.rerender(<StrictMode><InspectorPanel {...p} /></StrictMode>); expect(screen.queryByText(summary)).not.toBeInTheDocument(); expect(view.container.querySelector('[data-evidence-focus="true"]')).toBeNull();
  });
  it("keeps qualified names when inspecting a same-name neighbor", async () => {
    const p = panelProps(); const archived = { ...aiTable, key: { ...aiTable.key, schema: "archive" } };
    p.snapshot = { ...reportSnapshot, schemas: [...reportSnapshot.schemas, { name: "archive", tables: [archived], views: [], enums: [] }] };
    p.mocks.prepareTableExplanation.mockResolvedValue({ ...freshPreview(), context: { ...tableAiPreview.context, evidence: [...tableAiPreview.context.evidence, { ...tableAiPreview.context.evidence[0], id: "e10", tableKey: archived.key, objectKey: { kind: "column", schema: "archive.orders", name: "customer_id" }, label: "archive.orders · customer_id" }] } });
    render(<InspectorPanel {...p} />); fireEvent.click(screen.getByRole("button", { name: "AI" })); await ready(); showAllEvidence();
    fireEvent.click(screen.getByRole("button", { name: "archive.orders.customer_id · field" })); expect(screen.getByRole("region", { name: "Located evidence" })).toHaveTextContent("archive.orders");
  });
  it("discards an in-flight answer after changing the selected object", async () => {
    const p = panelProps(); const pending = deferred<TableAiResult>(); p.mocks.runTableExplanation.mockReturnValue(pending.promise);
    const view = render(<InspectorPanel {...p} />); fireEvent.click(screen.getByRole("button", { name: "AI" })); await ready(); fireEvent.click(screen.getByRole("button", { name: "Send and answer" }));
    view.rerender(<InspectorPanel {...p} selectedTable={reportSnapshot.schemas[0].tables[0]} />);
    await act(async () => { pending.resolve(tableAiResult); await pending.promise; }); expect(screen.queryByText(summary)).not.toBeInTheDocument(); expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith("fixture-request");
  });
});

it("retains question and in-flight answer across a language preference change", async () => {
  const p = props();
  const pending = deferred<TableAiResult>();
  p.mocks.runTableExplanation.mockReturnValue(pending.promise);
  const view = render(<TableAiAssistant {...p} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Keep this unsaved question" } });
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Send and answer" }));
  const prepared = p.mocks.prepareTableExplanation.mock.calls.length;
  const cancelled = p.mocks.cancelTableExplanation.mock.calls.length;
  const settings = structuredClone(p.settings); settings.app.general.language = "zhCn";
  view.rerender(<TableAiAssistant {...p} settings={settings} />);
  expect(screen.getByRole("textbox")).toHaveValue("Keep this unsaved question");
  expect(p.mocks.prepareTableExplanation).toHaveBeenCalledTimes(prepared);
  expect(p.mocks.cancelTableExplanation).toHaveBeenCalledTimes(cancelled);
  await act(async () => { pending.resolve(tableAiResult); await pending.promise; });
  expect(screen.getByText(summary)).toBeVisible();
  expect(p.mocks.runTableExplanation).toHaveBeenCalledOnce();
});
