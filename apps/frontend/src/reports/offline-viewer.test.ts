/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { diagramColumn, diagramTable } from "../test/diagram-comparison-fixture";
import { createOfflineViewer, offlineViewerFileName } from "./offline-viewer";
import { offlineViewerModel } from "./offline-viewer-model";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const emptySemantics = { ...reportSemantics, annotations: [], domainGroups: [], logicalRelationships: [] };
describe("portable offline Viewer", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto)); afterEach(() => vi.unstubAllGlobals());
  it("exports the whole snapshot/dictionary with inert allowlisted graph data and a hash-authorized standalone script", async () => {
    const before = JSON.stringify([reportSnapshot, reportSemantics]);
    const result = await createOfflineViewer(reportSnapshot, reportSemantics); const doc = parse(result.html);
    expect(result).toMatchObject({ tableCount: 3, columnCount: 6, relationshipCount: 2 });
    expect(doc.title).toBe("Commerce — Offline Viewer");
    expect(doc.getElementById("table-1-0")).not.toBeNull(); expect(doc.getElementById("view-0-0")).not.toBeNull(); expect(doc.getElementById("enum-0-0")).not.toBeNull();
    expect(doc.body.textContent).toContain("订单：记录已确认的购买意图");
    expect(doc.body.textContent).toContain("no share-token expiry, revocation or encryption");
    const script = doc.querySelector('script:not([type])')!.textContent;
    const hash = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(script))).toString("base64");
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain(`script-src 'sha256-${hash}'`); expect(csp).toContain("connect-src 'none'"); expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(doc.querySelectorAll("script")).toHaveLength(2); expect(doc.querySelectorAll("script[src],link,iframe,img,form,base,[onclick]")).toHaveLength(0);
    expect(JSON.stringify([reportSnapshot, reportSemantics])).toBe(before);
    expect((await createOfflineViewer(reportSnapshot, reportSemantics)).html).toBe(result.html);
    expect(offlineViewerFileName(reportSnapshot)).toBe("Commerce-offline-viewer-schema-repor.html");
  });
  it("keeps hostile metadata as text and excludes local IDs, settings, layout, tokens, row data and orphaned/foreign semantics", async () => {
    const snapshot = structuredClone(reportSnapshot); const semantics = structuredClone(reportSemantics);
    const payload = '</script><script>alert("x")</script><img src="https://evil.test/" onerror="boom">\u2028&';
    snapshot.database.name = payload; snapshot.schemas[0].tables[0].key.name = payload; snapshot.schemas[0].tables[0].columns[0].formattedType = payload;
    semantics.domainGroups[0].name = payload; semantics.annotations[0].description = payload; semantics.logicalRelationships[0].name = payload;
    Object.assign(snapshot, { password: "password-secret", rows: ["row-secret"], host: "private-host" });
    Object.assign(semantics, { token: "token-secret", settings: { path: "private-path" }, layout: { sourceId: "layout-secret" } });
    semantics.annotations.push({ ...semantics.annotations[0], sourceId: "other", description: "foreign-semantic-secret" });
    semantics.orphanedAnnotations.push({ ...semantics.annotations[0], description: "orphan-secret" });
    const { html } = await createOfflineViewer(snapshot, semantics); const doc = parse(html);
    expect(doc.title).toBe(`${payload} — Offline Viewer`); expect(doc.querySelectorAll("script")).toHaveLength(2); expect(doc.querySelectorAll("img,[onerror]")).toHaveLength(0);
    const raw = doc.getElementById("offline-model")!.textContent;
    expect(raw).not.toContain("<"); expect(raw).not.toContain("\u2028");
    const model = JSON.parse(raw) as ReturnType<typeof offlineViewerModel>;
    expect(model.tables[0].name).toBe(payload);
    for (const value of [snapshot.id, snapshot.sourceId, "private-logical-id", "domain-private-id", "password-secret", "row-secret", "private-host", "token-secret", "private-path", "layout-secret", "foreign-semantic-secret", "orphan-secret"]) expect(html).not.toContain(value);
  });
  it("separates qualified dotted identities and counts unavailable endpoints instead of inventing nodes or candidate edges", () => {
    const snapshot = structuredClone(reportSnapshot); const semantics = structuredClone(reportSemantics);
    snapshot.schemas[0].tables.push({ ...diagramTable("c"), key: { kind: "table", schema: "a.b", name: "c" } }, { ...diagramTable("b.c"), key: { kind: "table", schema: "a", name: "b.c" } });
    snapshot.schemas[0].tables[1].foreignKeys[0].referencedTable = "missing";
    semantics.logicalRelationships.push({ ...semantics.logicalRelationships[0], id: "disabled", status: "disabled" }, { ...semantics.logicalRelationships[0], id: "missing", target: { schema: "public", table: "orders", columns: ["removed"] } }, { ...semantics.logicalRelationships[0], sourceId: "foreign", name: "foreign" });
    const model = offlineViewerModel(snapshot, semantics); expect(model.tables).toHaveLength(5); expect(new Set(model.tables.map((table) => table.id)).size).toBe(5);
    expect(model.relations).toHaveLength(1); expect(model.unavailableRelations).toBe(2); expect(model.relations[0].kind).toBe("logical");
    expect(JSON.stringify(model)).not.toContain("disabled"); expect(JSON.stringify(model)).not.toContain("foreign");
  });
  it("keeps the dictionary as a script-disabled fallback, including empty and MySQL snapshots", async () => {
    const result = await createOfflineViewer({ ...reportSnapshot, database: { ...reportSnapshot.database, databaseType: "mySql", version: "8.4" }, schemas: [] }, emptySemantics);
    const doc = parse(result.html); expect(doc.body.textContent).toContain("MySQL 8.4"); expect(doc.body.textContent).toContain("No schemas in this snapshot");
    expect(doc.getElementById("viewer-controls")!.hasAttribute("hidden")).toBe(true); expect(doc.getElementById("viewer-fallback")!.hasAttribute("hidden")).toBe(false);
    expect(result.tableCount).toBe(0);
  });
  it("supports 500 tables / 5,000 columns without truncation and explicitly rejects larger/ambiguous/temporary models", async () => {
    const snapshot = { ...reportSnapshot, schemas: [{ name: "public", views: [], enums: [], tables: Array.from({ length: 500 }, (_, i) => diagramTable(`t${i}`, Array.from({ length: 10 }, (_, j) => diagramColumn(`c${j}`, j + 1)))) }] };
    const result = await createOfflineViewer(snapshot, emptySemantics); expect(result.tableCount).toBe(500); expect(result.columnCount).toBe(5000); expect(result.html).toContain('id="table-0-499"');
    const extra = structuredClone(snapshot); extra.schemas[0].tables.push(diagramTable("too-many")); expect(() => offlineViewerModel(extra, emptySemantics)).toThrow("500 tables");
    extra.schemas[0].tables.pop(); extra.schemas[0].tables[0].columns.push(diagramColumn("extra")); expect(() => offlineViewerModel(extra, emptySemantics)).toThrow("5,000 columns");
    expect(() => offlineViewerModel({ ...reportSnapshot, sourceId: "ddl-preview:test" }, reportSemantics)).toThrow("Temporary DDL");
    const duplicate = structuredClone(reportSnapshot); duplicate.schemas[0].tables.push(duplicate.schemas[0].tables[0]); expect(() => offlineViewerModel(duplicate, reportSemantics)).toThrow("Duplicate");
  });
  it("rejects graph relationship overflow and final HTML size overflow, with no silent truncation", async () => {
    const snapshot = structuredClone(reportSnapshot); const fk = snapshot.schemas[0].tables[1].foreignKeys[0]; snapshot.schemas[0].tables[1].foreignKeys = Array.from({ length: 5001 }, () => fk);
    expect(() => offlineViewerModel(snapshot, emptySemantics)).toThrow("5,000 physical");
    const big = structuredClone(reportSnapshot); big.schemas[0].tables[0].comment = "中".repeat(12_000_000);
    await expect(createOfflineViewer(big, emptySemantics)).rejects.toThrow("32 MB");
  });
});

describe("exported script interactions without app or network APIs", () => {
  const documentListeners = vi.spyOn(document, "addEventListener"); const windowListeners = vi.spyOn(window, "addEventListener");
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); documentListeners.mockClear(); windowListeners.mockClear(); });
  afterEach(() => {
    for (const [type, listener] of documentListeners.mock.calls) document.removeEventListener(type, listener);
    for (const [type, listener] of windowListeners.mock.calls) window.removeEventListener(type, listener);
    document.body.replaceChildren(); vi.unstubAllGlobals();
  });
  async function mount(snapshot = reportSnapshot, semantics = reportSemantics) {
    const doc = parse((await createOfflineViewer(snapshot, semantics)).html); document.body.innerHTML = doc.body.innerHTML;
    // Execute exactly the exported trusted script in a fresh lexical scope, catching accidental module references.
    runInNewContext(document.querySelector('script:not([type])')!.textContent, { document, window });
  }
  const input = () => document.getElementById("viewer-search") as HTMLInputElement;
  const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
  const graph = () => document.getElementById("viewer-graph")!;
  const nodes = () => graph().querySelectorAll("[data-table]");
  const button = (id: string) => document.getElementById(id)!;
  it("searches metadata/semantics, filters schema/domain and reveals filtered detail-link destinations", async () => {
    await mount(); expect(nodes()).toHaveLength(3);
    fireEvent.input(input(), { target: { value: "订单" } }); expect(nodes()).toHaveLength(1); expect(document.getElementById("table-1-0")).toHaveAttribute("hidden");
    fireEvent.click(document.querySelector('#contents a[href="#table-1-0"]')!); expect(nodes()).toHaveLength(3); expect(document.getElementById("table-1-0")).not.toHaveAttribute("hidden");
    fireEvent.change(select("viewer-schema"), { target: { value: "archive" } }); expect(nodes()).toHaveLength(1); expect(document.getElementById("view-0-0")).toHaveAttribute("hidden");
    fireEvent.click(button("viewer-reset")); fireEvent.change(select("viewer-domain"), { target: { value: "domain-0" } }); expect(nodes()).toHaveLength(2);
    fireEvent.input(input(), { target: { value: "no-match" } }); expect(nodes()).toHaveLength(0); expect(graph().textContent).toContain("No matching tables");
    fireEvent.click(button("viewer-reset")); fireEvent.input(input(), { target: { value: "Aggregated totals" } }); expect(document.getElementById("view-0-0")).not.toHaveAttribute("hidden");
  });
  it("distinguishes physical/logical edges, exposes table details and navigates one-hop relations within filters", async () => {
    await mount(); expect(graph().querySelectorAll(".viewer-edge.physical")).toHaveLength(1); expect(graph().querySelectorAll(".viewer-edge.logical")).toHaveLength(1);
    fireEvent.click(graph().querySelector('[data-table="table-0-0"]')!); expect(button("viewer-selected").textContent).toContain("public.customers");
    expect(button("viewer-selected").querySelector("a")).toHaveAttribute("href", "#table-0-0");
    fireEvent.click(button("viewer-neighbors")); expect(nodes()).toHaveLength(2); expect(button("viewer-status").textContent).toContain("One-hop focus");
    fireEvent.click(button("viewer-logical")); expect(graph().querySelectorAll(".logical")).toHaveLength(0);
    fireEvent.click(button("viewer-physical")); expect(nodes()).toHaveLength(1); expect(graph().querySelectorAll(".viewer-edge")).toHaveLength(0);
    fireEvent.click(button("viewer-reset")); fireEvent.click(graph().querySelector('[data-table="table-1-0"]')!);
    fireEvent.click(button("viewer-selected").querySelector("button")!); expect(button("viewer-selected").textContent).toContain("public.orders"); expect(nodes()).toHaveLength(3);
  });
  it("supports keyboard selection, zoom/pan/fit and starts again without persisted state or source writes", async () => {
    await mount(); const initial = graph().getAttribute("viewBox");
    fireEvent.keyDown(nodes()[0], { key: "Enter" }); expect(nodes()[0]).toHaveClass("selected");
    fireEvent.click(button("viewer-zoom-in")); expect(graph().getAttribute("viewBox")).not.toBe(initial);
    fireEvent.click(button("viewer-fit")); expect(graph().getAttribute("viewBox")).toBe(initial);
    fireEvent.keyDown(graph(), { key: "ArrowRight" }); expect(graph().getAttribute("viewBox")).not.toBe(initial);
    fireEvent.click(button("viewer-fit")); fireEvent.keyDown(graph(), { key: "+" }); expect(graph().getAttribute("viewBox")).not.toBe(initial);
    fireEvent.input(input(), { target: { value: "archive" } }); await mount(); expect(input().value).toBe(""); expect(nodes()).toHaveLength(3);
    const source = document.querySelector('script:not([type])')!.textContent;
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|navigator\.clipboard|invoke\(/u);
    expect(document.querySelectorAll("textarea,[contenteditable],form,input[type=file]")).toHaveLength(0);
  });
  it("renders hostile model names as text even when the executable script runs", async () => {
    const snapshot = structuredClone(reportSnapshot); snapshot.schemas[0].tables[0].columns[0].formattedType = '</script><img src="https://evil.test" onerror="boom">';
    await mount(snapshot); expect(nodes()).toHaveLength(3); expect(document.querySelectorAll("img,[onerror]")).toHaveLength(0); expect(graph().textContent).toContain("</script><img");
  });
  it("pans only empty graph space, then stops on pointer completion/cancellation", async () => {
    await mount(); Object.defineProperty(graph(), "setPointerCapture", { value: vi.fn() });
    const pointer = (type: string, x: number, target: Element = graph()) => fireEvent(target, Object.assign(new Event(type, { bubbles: true }), { button: 0, pointerId: 1, clientX: x, clientY: 10 }));
    const initial = graph().getAttribute("viewBox"); pointer("pointerdown", 10); pointer("pointermove", 20); expect(graph().getAttribute("viewBox")).not.toBe(initial);
    pointer("pointerup", 20); const stopped = graph().getAttribute("viewBox"); pointer("pointermove", 30); expect(graph().getAttribute("viewBox")).toBe(stopped);
    pointer("pointerdown", 10, nodes()[0]); pointer("pointermove", 20); expect(graph().getAttribute("viewBox")).toBe(stopped);
    pointer("pointerdown", 10); pointer("pointercancel", 20); pointer("pointermove", 30); expect(graph().getAttribute("viewBox")).toBe(stopped);
  });
  it("abbreviates large cards without truncating their complete details", async () => {
    const snapshot = structuredClone(reportSnapshot); snapshot.schemas[0].tables[0].columns = Array.from({ length: 25 }, (_, i) => diagramColumn(`column_${i}`, i + 1));
    await mount(snapshot, emptySemantics); const card = nodes()[0];
    expect(card.querySelectorAll(".node-column")).toHaveLength(13); expect(card.textContent).toContain("+ 13 columns in complete details");
    expect(document.getElementById("table-0-0")!.textContent).toContain("column_24");
  });
});
