import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryInput, DiscoveryPreview, DiscoveryResult, NodalStudioPlatform } from "../platform";
import { reportSnapshot } from "../test/schema-report-fixture";
import { discoveryPreview, discoveryResult, discoverySettings } from "../test/discovery-fixture";
import { DiscoveryAssistant } from "./DiscoveryAssistant";

afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; }
function props() {
  const input: DiscoveryInput = { snapshotId: reportSnapshot.id, domainId: null, task: { operation: "rank", question: "订单", root: reportSnapshot.schemas[0].tables[1].key, candidates: [reportSnapshot.schemas[0].tables[1].key], pathTables: [], pathRelationships: [] } };
  const previews = new Map<string, DiscoveryPreview>();
  const mocks = { prepareDiscovery: vi.fn().mockImplementation((value: DiscoveryInput) => { const preview = discoveryPreview(value); previews.set(preview.requestId, preview); return Promise.resolve(preview); }), runDiscovery: vi.fn().mockImplementation((id: string) => Promise.resolve(discoveryResult(previews.get(id)!))), cancelDiscovery: vi.fn().mockResolvedValue(undefined) };
  return { input, platform: mocks as unknown as NodalStudioPlatform, mocks, snapshot: reportSnapshot, settings: discoverySettings(), binding: "local-query-1", available: true, onApplyTerms: vi.fn(), onLocate: vi.fn(), onOpenSettings: vi.fn() };
}
async function prepare() { fireEvent.click(screen.getByRole("button", { name: "Prepare discovery preview" })); await screen.findByRole("button", { name: "Send this discovery request" }); }
async function send() { fireEvent.click(screen.getByRole("button", { name: "Send this discovery request" })); await screen.findByRole("region", { name: "Discovery answer" }); }
describe("discovery request lifecycle", () => {
  it("requires an actual preview then an explicit send, with bounded AI ranking and evidence navigation", async () => {
    const p = props(); render(<DiscoveryAssistant {...p} />); await prepare();
    expect(p.mocks.runDiscovery).not.toHaveBeenCalled(); expect(screen.getByText("Actual request preview")).toBeVisible();
    await send(); expect(p.mocks.runDiscovery).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/not a whole-database ranking/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Inspect discovery evidence e1" }));
    expect(screen.getByRole("region", { name: "Located discovery evidence" })).toBeVisible();
    expect(document.activeElement).toHaveAttribute("data-evidence-target", "true");
    expect(document.activeElement).toHaveTextContent("customer_id");
    expect(p.mocks.prepareDiscovery).toHaveBeenCalledExactlyOnceWith({ ...p.input, replyLanguage: { currentQuestion: p.input.task.question, uiLocale: "en" } });
  });
  it.each([false, true])("cleans up preparation after cancellation (direct send: %s)", async (directSend) => {
    const p = props(); const pending = deferred<DiscoveryPreview>(); const preview = discoveryPreview(p.input);
    p.mocks.prepareDiscovery.mockReturnValue(pending.promise); render(<DiscoveryAssistant {...p} directSend={directSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare discovery preview" })); fireEvent.click(screen.getByRole("button", { name: "Cancel AI step" }));
    await act(async () => { pending.resolve(preview); await pending.promise; });
    expect(p.mocks.runDiscovery).not.toHaveBeenCalled(); expect(p.mocks.cancelDiscovery).toHaveBeenCalledWith(preview.requestId); expect(screen.queryByRole("button", { name: "Send this discovery request" })).toBeNull();
  });
  it("discards a late answer after cancel and accepts only the new task", async () => {
    const p = props(); const pending = deferred<DiscoveryResult>(); const old = discoveryPreview(p.input);
    p.mocks.prepareDiscovery.mockResolvedValueOnce(old); p.mocks.runDiscovery.mockReturnValueOnce(pending.promise);
    render(<DiscoveryAssistant {...p} />); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Send this discovery request" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel AI step" })); await prepare(); await send();
    const late = discoveryResult(old); late.answer.unknowns = ["OLD RESPONSE MUST NOT APPEAR"];
    await act(async () => { pending.resolve(late); await pending.promise; }); expect(screen.queryByText("OLD RESPONSE MUST NOT APPEAR")).toBeNull();
    expect(p.mocks.cancelDiscovery).toHaveBeenCalledWith(old.requestId);
  });
  it.each(["question", "root", "domain", "operation", "source", "snapshot", "settings", "bindings"])("clears results and evidence when %s changes, including switching back", async (kind) => {
    const p = props(); const view = render(<DiscoveryAssistant {...p} />); await prepare(); await send();
    fireEvent.click(screen.getByRole("button", { name: "Inspect discovery evidence e1" }));
    const next = { ...p, input: structuredClone(p.input), snapshot: structuredClone(p.snapshot), settings: structuredClone(p.settings) };
    if (kind === "question") next.input.task.question = "different question";
    if (kind === "root") next.input.task.root = reportSnapshot.schemas[0].tables[0].key;
    if (kind === "domain") next.input.domainId = "another-domain";
    if (kind === "operation") next.input.task.operation = "expand";
    if (kind === "source") next.snapshot.sourceId = "different-source";
    if (kind === "snapshot") next.snapshot.id = "different-snapshot";
    if (kind === "settings") next.settings.source!.ai.includeComments = !next.settings.source!.ai.includeComments;
    if (kind === "bindings") next.binding = "new-semantic-revision";
    view.rerender(<DiscoveryAssistant {...next} />); view.rerender(<DiscoveryAssistant {...p} />);
    expect(screen.queryByRole("region", { name: "Discovery answer" })).toBeNull(); expect(screen.queryByRole("region", { name: "Located discovery evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send this discovery request" })).toBeNull();
  });
  it("ignores a running old operation after switching to another operation", async () => {
    const p = props(); const preview = discoveryPreview(p.input); const pending = deferred<DiscoveryResult>();
    p.mocks.prepareDiscovery.mockResolvedValueOnce(preview); p.mocks.runDiscovery.mockReturnValueOnce(pending.promise);
    const view = render(<DiscoveryAssistant {...p} />); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Send this discovery request" }));
    const input = { ...p.input, task: { ...p.input.task, operation: "expand" as const } }; view.rerender(<DiscoveryAssistant {...p} input={input} />);
    await act(async () => { pending.resolve(discoveryResult(preview)); await pending.promise; });
    expect(screen.queryByRole("region", { name: "Discovery answer" })).toBeNull(); expect(p.mocks.cancelDiscovery).toHaveBeenCalledWith(preview.requestId);
    await prepare(); await send(); expect(screen.getByRole("button", { name: "Apply terms to local search" })).toBeVisible();
    expect(p.onApplyTerms).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Apply terms to local search" })); expect(p.onApplyTerms).toHaveBeenCalledWith(["order", "customer", "payment"]);
  });
  it("expires on return from a suspended tab and rejects a response arriving after expiry", async () => {
    const p = props(); const preview = discoveryPreview(p.input); const pending = deferred<DiscoveryResult>();
    p.mocks.prepareDiscovery.mockResolvedValue(preview); p.mocks.runDiscovery.mockReturnValue(pending.promise);
    render(<DiscoveryAssistant {...p} />); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Send this discovery request" }));
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(preview.expiresAt) + 1); fireEvent(window, new Event("focus"));
    await act(async () => { pending.resolve(discoveryResult(preview)); await pending.promise; });
    expect(screen.getByText(/Preview expired/)).toBeVisible(); expect(screen.queryByRole("region", { name: "Discovery answer" })).toBeNull();
  });
  it.each(["scope", "operation", "source", "model", "expiry"])("rejects mismatched %s previews before enabling send", async (kind) => {
    const p = props(); const preview = discoveryPreview(p.input);
    if (kind === "scope") preview.context.scope = "domain";
    if (kind === "operation") preview.context.operation = "expand";
    if (kind === "source") preview.sourceId = "other-source";
    if (kind === "model") preview.model = "other-model";
    if (kind === "expiry") preview.expiresAt = "invalid";
    p.mocks.prepareDiscovery.mockResolvedValue(preview); render(<DiscoveryAssistant {...p} />); fireEvent.click(screen.getByRole("button", { name: "Prepare discovery preview" }));
    if (kind === "expiry") await screen.findByText(/Preview expired/); else await screen.findByRole("alert");
    expect(p.mocks.cancelDiscovery).toHaveBeenCalledWith(preview.requestId); expect(screen.queryByRole("button", { name: "Send this discovery request" })).toBeNull();
  });
  it("blocks stale settings, historical/Web and offline remote requests", () => {
    const p = props(); const view = render(<DiscoveryAssistant {...p} available={false} />); expect(screen.queryByRole("button", { name: "Prepare discovery preview" })).toBeNull();
    const settings = structuredClone(p.settings); settings.app.privacy.offlineMode = true; view.rerender(<DiscoveryAssistant {...p} settings={settings} />); expect(screen.queryByRole("button", { name: "Prepare discovery preview" })).toBeNull();
    settings.app.privacy.offlineMode = false; settings.source!.sourceId = "previous-source"; view.rerender(<DiscoveryAssistant {...p} settings={settings} />); expect(screen.queryByRole("button", { name: "Prepare discovery preview" })).toBeNull();
    expect(p.mocks.prepareDiscovery).not.toHaveBeenCalled();
  });
});
