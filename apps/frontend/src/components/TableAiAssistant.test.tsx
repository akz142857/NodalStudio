import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform, TableAiPreview, TableAiResult } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { aiTable, tableAiPreview, tableAiResult, tableAiSettings } from "../test/table-ai-fixture";
import { TableAiAssistant } from "./TableAiAssistant";
import { InspectorPanel } from "./InspectorPanel";

afterEach(() => vi.useRealTimers());
function freshPreview(): TableAiPreview { return { ...tableAiPreview, expiresAt: new Date(Date.now() + 300_000).toISOString() }; }
function platformMock() {
  const mocks = { prepareTableExplanation: vi.fn().mockImplementation(() => Promise.resolve(freshPreview())), runTableExplanation: vi.fn().mockResolvedValue(tableAiResult), cancelTableExplanation: vi.fn().mockResolvedValue(undefined) }; return { mocks, platform: mocks as unknown as NodalStudioPlatform };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function props() { return { ...platformMock(), snapshot: reportSnapshot, table: aiTable, settings: tableAiSettings(), domains: reportSemantics.domainGroups, desktop: true, onOpenSettings: vi.fn(), onLocateEvidence: vi.fn(), onTaskChange: vi.fn() }; }
async function prepare() { fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" })); await screen.findByRole("button", { name: "Send this request" }); }

describe("single-table understanding", () => {
  it("requires a reviewed preview, locates evidence and exposes no AI save action", async () => {
    const p = props(); render(<TableAiAssistant {...p} />);
    await prepare(); expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
    expect(screen.getByText("Actual request preview")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    await screen.findByText(tableAiResult.answer.interpretations[0].text);
    expect(p.mocks.runTableExplanation).toHaveBeenCalledExactlyOnceWith("fixture-request");
    fireEvent.click(screen.getByRole("button", { name: "Inspect evidence e1" }));
    expect(p.onLocateEvidence).toHaveBeenCalledWith(tableAiPreview.context.evidence[0], tableAiPreview.requestId);
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("requires an explicit domain and passes the selected field without expanding scope locally", async () => {
    const p = props(); p.settings.source!.ai.contextScope = "domain";
    p.mocks.prepareTableExplanation.mockResolvedValue({ ...freshPreview(), context: { ...tableAiPreview.context, scope: "domain" } }); render(<TableAiAssistant {...p} />);
    expect(screen.getByRole("button", { name: "Prepare request preview" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Business domain/), { target: { value: "domain-private-id" } });
    fireEvent.change(screen.getByLabelText("Focus field"), { target: { value: "customer_id" } });
    await prepare();
    expect(p.mocks.prepareTableExplanation).toHaveBeenCalledWith(expect.objectContaining({ domainId: "domain-private-id", focusColumn: "customer_id", target: aiTable.key }));
  });

  it("cancels an in-flight preparation and cleans up its late preview", async () => {
    const p = props(); const pending = deferred<TableAiPreview>(); vi.mocked(p.mocks.prepareTableExplanation).mockReturnValue(pending.promise);
    render(<TableAiAssistant {...p} />); fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => { pending.resolve(tableAiPreview); await pending.promise; });
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith("fixture-request");
    expect(screen.queryByRole("button", { name: "Send this request" })).not.toBeInTheDocument();
  });

  it("discards a late answer after cancellation and can prepare a fresh request", async () => {
    const p = props(); const pending = deferred<TableAiResult>(); vi.mocked(p.mocks.runTableExplanation).mockReturnValue(pending.promise);
    render(<TableAiAssistant {...p} />); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await act(async () => { pending.resolve(tableAiResult); await pending.promise; });
    expect(screen.queryByText(tableAiResult.answer.interpretations[0].text)).not.toBeInTheDocument();
    await prepare(); expect(p.mocks.prepareTableExplanation).toHaveBeenCalledTimes(2);
  });

  it("shows expiry/provider failures and retries through a new preview", async () => {
    const p = props(); vi.mocked(p.mocks.runTableExplanation).mockRejectedValue(new Error("The preview expired."));
    render(<TableAiAssistant {...p} />); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("expired");
    expect(screen.queryByRole("button", { name: "Send this request" })).not.toBeInTheDocument();
    await prepare(); expect(p.mocks.prepareTableExplanation).toHaveBeenCalledTimes(2);
  });

  it("blocks Web and remote offline mode while allowing the offline provider", () => {
    const p = props(); const view = render(<TableAiAssistant {...p} desktop={false} />);
    expect(screen.queryByRole("button", { name: "Prepare request preview" })).not.toBeInTheDocument();
    p.settings.app.privacy.offlineMode = true; view.rerender(<TableAiAssistant {...p} />);
    expect(screen.queryByRole("button", { name: "Prepare request preview" })).not.toBeInTheDocument();
    p.settings.source!.ai.provider = "offline"; view.rerender(<TableAiAssistant {...p} />);
    expect(screen.getByRole("button", { name: "Prepare request preview" })).toBeEnabled();
    expect(p.mocks.prepareTableExplanation).not.toHaveBeenCalled();
  });
  it("blocks stale source settings until the current source settings arrive", async () => {
    const p = props();
    const staleSettings = tableAiSettings();
    staleSettings.source!.sourceId = "previous-source";
    staleSettings.source!.ai.provider = "offline";
    const view = render(<TableAiAssistant {...p} settings={staleSettings} />);
    expect(screen.getByText(/AI settings for this source are not loaded/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Prepare request preview" })).not.toBeInTheDocument();
    expect(p.mocks.prepareTableExplanation).not.toHaveBeenCalled();
    view.rerender(<TableAiAssistant {...p} />);
    await prepare();
    fireEvent.click(screen.getByText("View exact request body (API key excluded)"));
    const body = screen.getByText(/Synthetic metadata fixture for UI verification only/, { selector: "pre" });
    expect(body).toBeVisible();
    expect(JSON.parse(body.textContent)).toEqual(tableAiPreview.requestBody);
    expect(screen.queryByRole("button", { name: "Show offline explanation" })).not.toBeInTheDocument();
  });

  it.each(["provider", "scope", "model"])("rejects a preview with changed %s instead of disguising its send behavior", async (change) => {
    const p = props();
    const next = freshPreview();
    if (change === "provider") p.settings.source!.ai.provider = "offline";
    if (change === "scope") next.context = { ...next.context, scope: "oneHop" };
    if (change === "model") next.model = "different-model";
    p.mocks.prepareTableExplanation.mockResolvedValue(next);
    render(<TableAiAssistant {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI settings changed");
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith(next.requestId);
    expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Send this request|Show offline explanation/ })).not.toBeInTheDocument();
  });

  it("labels an offline preview as local only when the prepared provider agrees", async () => {
    const p = props(); p.settings.source!.ai.provider = "offline";
    p.mocks.prepareTableExplanation.mockResolvedValue({ ...freshPreview(), provider: "offline-schema", model: null, endpoint: null, requestBody: null });
    render(<TableAiAssistant {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" }));
    await screen.findByRole("button", { name: "Show offline explanation" });
    expect(screen.getByText("View local evidence context")).toBeVisible();
    expect(screen.queryByText("View exact request body (API key excluded)")).not.toBeInTheDocument();
  });

  it.each(["timer", "visibility", "focus", "send"])("expires a preview using the absolute deadline on %s", async (trigger) => {
    vi.useFakeTimers();
    const p = props(); const preview = freshPreview(); p.mocks.prepareTableExplanation.mockResolvedValue(preview);
    render(<TableAiAssistant {...p} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" })); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Send this request" })).toBeEnabled();
    if (trigger === "timer") await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    else {
      // A suspended tab can return after its deadline without first running its timer.
      vi.setSystemTime(Date.parse(preview.expiresAt) + 1);
      if (trigger === "visibility") fireEvent(document, new Event("visibilitychange"));
      if (trigger === "focus") fireEvent(window, new Event("focus"));
      if (trigger === "send") fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    }
    expect(screen.getByRole("status")).toHaveTextContent("Preview expired");
    expect(screen.queryByRole("button", { name: "Send this request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Structural evidence" })).not.toBeInTheDocument();
    expect(p.onTaskChange).toHaveBeenLastCalledWith(undefined);
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith(preview.requestId);
    expect(p.mocks.runTableExplanation).not.toHaveBeenCalled();
    p.mocks.prepareTableExplanation.mockResolvedValue(freshPreview());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" })); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Send this request" })).toBeEnabled();
  });

  it.each(["timer", "late response"])("discards an expired in-flight result even with a delayed %s", async (trigger) => {
    vi.useFakeTimers(); const p = props(); const preview = freshPreview();
    const pending = deferred<TableAiResult>(); p.mocks.runTableExplanation.mockReturnValue(pending.promise);
    render(<TableAiAssistant {...p} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" })); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    if (trigger === "timer") await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    else vi.setSystemTime(Date.parse(preview.expiresAt) + 1);
    await act(async () => { pending.resolve(tableAiResult); await pending.promise; });
    expect(screen.getByRole("status")).toHaveTextContent("Preview expired");
    expect(screen.queryByText(tableAiResult.answer.interpretations[0].text)).not.toBeInTheDocument();
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith(preview.requestId);
  });

  it.each(["expired", "invalid"])("never enables a newly delivered %s deadline", async (expiry) => {
    const p = props(); p.mocks.prepareTableExplanation.mockResolvedValue({ ...freshPreview(), expiresAt: expiry === "invalid" ? "invalid-date" : new Date(Date.now() - 1).toISOString() });
    render(<TableAiAssistant {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare request preview" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Preview expired"));
    expect(screen.queryByRole("button", { name: "Send this request" })).not.toBeInTheDocument();
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith(tableAiPreview.requestId);
  });

});

describe("inspector evidence and task identity", () => {
  function panelProps() {
    return { snapshot: reportSnapshot, selectedTable: aiTable, semantics: reportSemantics, settings: tableAiSettings(), ...platformMock(), runtime: { kind: "desktop" } as Parameters<typeof InspectorPanel>[0]["runtime"], historyRevision: "current", onSaveAnnotation: vi.fn(), onSemanticsChange: vi.fn(), onApplyView: vi.fn(), onOpenSettings: vi.fn(), onSelectSnapshot: vi.fn(), onCompareSnapshots: vi.fn() };
  }
  it("opens the actual field and preserves the answer when returning", async () => {
    const p = panelProps(); const { container } = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "AI" })); await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Send this request" })); await screen.findByText(tableAiResult.answer.interpretations[0].text);
    fireEvent.click(screen.getByRole("button", { name: "Inspect evidence e1" }));
    expect(screen.getByRole("region", { name: "Located evidence" })).toHaveTextContent("customer_id");
    expect(container.querySelector('[data-evidence-focus="true"]')).toHaveTextContent("customer_id");
    fireEvent.click(screen.getByRole("button", { name: "Back to AI explanation" }));
    expect(screen.getByText(tableAiResult.answer.interpretations[0].text)).toBeVisible(); expect(p.onSaveAnnotation).not.toHaveBeenCalled();
  });
  it.each(["table", "snapshot", "settings", "source"])("invalidates a running answer when %s changes", async (change) => {
    const p = panelProps(); const pending = deferred<TableAiResult>(); vi.mocked(p.mocks.runTableExplanation).mockReturnValue(pending.promise);
    const view = render(<InspectorPanel {...p} />); fireEvent.click(screen.getByRole("button", { name: "AI" })); await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    const next = { ...p, settings: structuredClone(p.settings) };
    if (change === "table") next.selectedTable = reportSnapshot.schemas[0].tables[0];
    if (change === "source") next.snapshot = { ...reportSnapshot, sourceId: "different-source" };
    if (change === "snapshot") next.snapshot = { ...reportSnapshot, id: "new-snapshot" };
    if (change === "settings") next.settings.source!.ai.contextScope = "oneHop";
    view.rerender(<InspectorPanel {...next} />);
    await waitFor(() => expect(p.mocks.cancelTableExplanation).toHaveBeenCalledWith("fixture-request"));
    await act(async () => { pending.resolve(tableAiResult); await pending.promise; });
    expect(screen.queryByText(tableAiResult.answer.interpretations[0].text)).not.toBeInTheDocument();
  });
  it.each(["question", "field", "cancel", "prepare"])("clears an earlier evidence selection when changing %s", async (change) => {
    const p = panelProps(); render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "AI" })); await prepare();
    fireEvent.click(screen.getByRole("button", { name: /Locate evidence e1/ }));
    expect(screen.getByRole("region", { name: "Located evidence" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to AI explanation" }));
    if (change === "question") fireEvent.change(screen.getByLabelText("Question"), { target: { value: "New question" } });
    if (change === "field") fireEvent.change(screen.getByLabelText("Focus field"), { target: { value: "customer_id" } });
    if (change === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    if (change === "prepare") await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.queryByRole("region", { name: "Located evidence" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-evidence-focus="true"]')).not.toBeInTheDocument();
  });

  it("never reuses an evidence ID across domain requests or keeps the old neighbor heading", async () => {
    const p = panelProps(); p.settings.source!.ai.contextScope = "domain";
    const customers = reportSnapshot.schemas[0].tables[0];
    const archived = reportSnapshot.schemas[1].tables[0];
    p.semantics = { ...reportSemantics, domainGroups: [...reportSemantics.domainGroups, { ...reportSemantics.domainGroups[0], id: "archive", name: "Archive", tableKeys: [aiTable.key, archived.key] }] };
    const previewFor = (table: typeof customers, id: string): TableAiPreview => ({ ...freshPreview(), requestId: id, context: { ...tableAiPreview.context, scope: "domain", tables: [aiTable.key, table.key], evidence: [{ ...tableAiPreview.context.evidence[0], id: "e10", tableKey: table.key, objectKey: { kind: "column", schema: `${table.key.schema}.${table.key.name}`, name: "id" }, label: `${table.key.schema}.${table.key.name} · id`, columns: ["id"] }] } });
    p.mocks.prepareTableExplanation.mockResolvedValueOnce(previewFor(customers, "commerce-request")).mockResolvedValueOnce(previewFor(archived, "archive-request"));
    render(<InspectorPanel {...p} />); fireEvent.click(screen.getByRole("button", { name: "AI" }));
    fireEvent.change(screen.getByLabelText(/Business domain/), { target: { value: "domain-private-id" } }); await prepare();
    fireEvent.click(screen.getByRole("button", { name: /Locate evidence e10/ }));
    expect(screen.getByRole("heading", { name: "public.customers" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to AI explanation" }));
    fireEvent.change(screen.getByLabelText(/Business domain/), { target: { value: "archive" } }); await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.queryByRole("region", { name: "Located evidence" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "orders" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    fireEvent.click(screen.getByRole("button", { name: /Locate evidence e10/ }));
    expect(screen.getByRole("heading", { name: "archive.orders" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Located evidence" })).toHaveTextContent("archive.orders");
  });

  it.each(["table", "historical", "source", "snapshot", "settings", "semantics", "deselection", "disconnect"])("never restores a destroyed task's evidence after a %s round trip", async (change) => {
    const p = panelProps();
    const view = render(<StrictMode><InspectorPanel {...p} /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "AI" })); await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect evidence e1" }));
    expect(screen.getByRole("region", { name: "Located evidence" })).toBeVisible();

    const away: Parameters<typeof InspectorPanel>[0] = { ...p };
    if (change === "table") away.selectedTable = reportSnapshot.schemas[0].tables[0];
    if (change === "historical") away.historicalSelection = true;
    if (change === "source") away.snapshot = { ...reportSnapshot, sourceId: "other-source" };
    if (change === "snapshot") away.snapshot = { ...reportSnapshot, id: "other-snapshot" };
    if (change === "settings") {
      away.settings = tableAiSettings(); away.settings.source!.ai.enabled = false;
    }
    if (change === "semantics") away.semantics = { ...reportSemantics, domainGroups: [] };
    if (change === "deselection") away.selectedTable = undefined;
    if (change === "disconnect") away.snapshot = undefined;
    view.rerender(<StrictMode><InspectorPanel {...away} /></StrictMode>);
    expect(screen.queryByRole("region", { name: "Located evidence" })).not.toBeInTheDocument();
    view.rerender(<StrictMode><InspectorPanel {...p} /></StrictMode>);
    expect(screen.queryByRole("region", { name: "Located evidence" })).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-evidence-focus="true"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "orders", level: 2 })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(screen.queryByText(tableAiResult.answer.interpretations[0].text)).not.toBeInTheDocument();
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: /Locate evidence e2/ }));
    expect(screen.getByRole("region", { name: "Located evidence" })).toHaveTextContent("orders_customer_idx");
    expect(document.activeElement).toHaveTextContent("orders_customer_idx");
  });

  it("keeps the replacement task's evidence when the unmounted task answers late", async () => {
    const p = panelProps(); const old = deferred<TableAiResult>(); const replacement = deferred<TableAiResult>();
    p.mocks.prepareTableExplanation.mockResolvedValueOnce(freshPreview()).mockResolvedValueOnce({ ...freshPreview(), requestId: "replacement" });
    p.mocks.runTableExplanation.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const view = render(<StrictMode><InspectorPanel {...p} /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "AI" })); await prepare();
    fireEvent.click(screen.getByRole("button", { name: /Locate evidence e1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back to AI explanation" }));
    fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    view.rerender(<StrictMode><InspectorPanel {...p} selectedTable={reportSnapshot.schemas[0].tables[0]} /></StrictMode>);
    view.rerender(<StrictMode><InspectorPanel {...p} /></StrictMode>);
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Send this request" }));
    await act(async () => { old.resolve(tableAiResult); await old.promise; });
    expect(screen.getByRole("status")).toHaveTextContent("Generating explanation");
    expect(screen.queryByText(tableAiResult.answer.interpretations[0].text)).not.toBeInTheDocument();
    expect(p.mocks.cancelTableExplanation).toHaveBeenCalledExactlyOnceWith("fixture-request");
    const answer = { ...tableAiResult, requestId: "replacement", answer: { interpretations: [{ text: "New task interpretation", evidenceIds: ["e2"] }], unknowns: [] } };
    await act(async () => { replacement.resolve(answer); await replacement.promise; });
    fireEvent.click(screen.getByRole("button", { name: "Inspect evidence e2" }));
    expect(screen.getByRole("region", { name: "Located evidence" })).toHaveTextContent("orders_customer_idx");
    fireEvent.click(screen.getByRole("button", { name: "Back to AI explanation" }));
    expect(screen.getByText("New task interpretation")).toBeVisible();
  });

});
