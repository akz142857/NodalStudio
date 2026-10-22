import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagramAfter, diagramBefore, diagramChangeSet } from "../test/diagram-comparison-fixture";
import { captureDiagramSvg, createDiagramSvgCapture, diagramFileName, pngDimensions } from "./diagram-export";

function diagramFixture(zoom = 1) {
  const root = document.createElement("div");
  root.innerHTML = `<svg class="react-flow__marker"><defs><marker id="arrow"><path d="M0,0 L8,4 L0,8 Z" fill="blue"/></marker></defs></svg>
    <svg><g class="react-flow__edge" data-box="-50 20 450 150"><path d="M10,50 L350,50" marker-end="url(#arrow)" style="stroke:rgb(196,62,72);stroke-dasharray:8 5;fill:none"/><path class="react-flow__edge-interaction" d="M10,50 L350,50"/></g></svg>
    <article class="table-node" data-change="deleted" data-box="10 20 280 150" style="border:2px dashed red;background:white;overflow:hidden;border-radius:7px;font:12px sans-serif;color:black">
      <header data-box="12 22 276 40"><strong data-box="20 28 220 14">orders &amp; &lt;script&gt;alert('x')&lt;/script&gt;</strong></header>
      <div data-box="12 62 276 27" style="background:rgb(255,240,240);overflow:hidden"><span data-box="20 67 90 12">legacy_note</span><em data-box="115 67 65 12">− Deleted</em></div>
      <p data-box="20 110 245 14">+17 more unchanged fields</p>
      <div class="table-node-actions" data-box="20 28 50 14">Preview rows</div>
    </article>`;
  document.body.append(root);
  for (const node of root.querySelectorAll<HTMLElement>("[style]")) {
    for (const declaration of node.getAttribute("style")!.split(";")) {
      const separator = declaration.indexOf(":");
      if (separator !== -1) node.style.setProperty(declaration.slice(0, separator), declaration.slice(separator + 1));
    }
  }
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === root) return rect(100, 200, 800, 600);
    const values = this.getAttribute("data-box")?.split(" ").map(Number) ?? [10, 20, 280, 150];
    return rect(100 + 30 + values[0] * zoom, 200 + 40 + values[1] * zoom, values[2] * zoom, values[3] * zoom);
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: function (this: Range) {
    return (this.startContainer.parentElement ?? root).getBoundingClientRect();
  } });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: function (this: Range) { return [this.getBoundingClientRect()]; } });
  return { root, viewport: { x: 30, y: 40, zoom } };
}

describe("diagram export", () => {
  beforeEach(() => { document.documentElement.dataset.theme = "dark"; });
  afterEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.theme;
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exports standalone vector shapes, clipped text, arrows and comparison legends with escaped object names", () => {
    const result = captureDiagramSvg({ ...diagramFixture(), snapshot: diagramAfter, changeSet: diagramChangeSet, beforeSnapshot: diagramBefore, scope: "Focus: public.orders" });
    const document = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.querySelector("foreignObject, script, image")).toBeNull();
    expect(document.querySelector("marker#arrow")).not.toBeNull();
    expect(document.querySelector(".react-flow__edge-interaction")).toBeNull();
    expect(document.getElementsByTagNameNS("http://www.w3.org/2000/svg", "clipPath").length).toBeGreaterThan(0);
    expect(document.documentElement.textContent).toContain("orders & <script>alert('x')</script>");
    expect(result.svg).not.toContain("Preview rows");
    expect(document.documentElement.textContent).toContain("Before diagram-befo → After diagram-afte");
    expect(document.documentElement.textContent).toContain("− Deleted · Before");
    expect(document.documentElement.textContent).toContain("Inferred candidate · not a constraint");
    expect(document.documentElement.textContent).toContain("Focus: public.orders");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(result.svg).toMatch(/stroke-dasharray:\s*8 5/);
    expect(result.svg).toContain("translate(82 166)");
  });

  it("collects table detail in separate batches without duplicating relationships or accepting incomplete output", () => {
    const fixture = diagramFixture();
    const first = fixture.root.querySelector<HTMLElement>(".table-node")!;
    const second = first.cloneNode(true) as HTMLElement; second.querySelector("strong")!.textContent = "second_table";
    fixture.root.append(second);
    const capture = createDiagramSvgCapture({ ...fixture, snapshot: diagramAfter, changeSet: diagramChangeSet, beforeSnapshot: diagramBefore });
    expect(() => capture.finish()).toThrow("Some tables were not captured");
    first.dataset.overview = "true";
    expect(() => capture.appendTables([first])).toThrow("Table details are not ready");
    delete first.dataset.overview;
    capture.appendTables([first]);
    expect(() => capture.appendTables([first])).toThrow("diagram changed");
    expect(() => capture.appendTables([document.createElement("article")])).toThrow("diagram changed");
    expect(() => capture.finish()).toThrow("Some tables were not captured");
    capture.appendTables([second]);
    const result = capture.finish(); const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(svg.querySelectorAll(".react-flow__edge")).toHaveLength(1);
    expect(svg.querySelectorAll("[data-table-id]")).toHaveLength(2);
    expect(svg.documentElement.textContent).toContain("second_table");
    expect(svg.documentElement.textContent).toContain("− Deleted · Before");
    expect(svg.documentElement.textContent).not.toContain("Zoom in for details");
  });

  it("reuses one live text Range across batches and removed table DOM", () => {
    const fixture = diagramFixture();
    const first = fixture.root.querySelector<HTMLElement>(".table-node")!;
    const second = first.cloneNode(true) as HTMLElement;
    second.querySelector("strong")!.textContent = "短表"; fixture.root.append(second);
    const ranges = vi.spyOn(document, "createRange");
    const elements = vi.spyOn(document, "createElement");
    // Exercise the character-level path too: a previous text's range endpoint
    // must never leak into the next, shorter text node.
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: function (this: Range) { return [this.getBoundingClientRect(), this.getBoundingClientRect()]; } });
    const capture = createDiagramSvgCapture({ ...fixture, snapshot: diagramAfter });
    capture.appendTables([first]); first.remove(); capture.appendTables([second]);
    const result = capture.finish();
    expect(ranges).toHaveBeenCalledOnce();
    expect(elements.mock.calls.filter(([tag]) => tag === "span").length).toBeLessThan(6);
    const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(svg.querySelector("parsererror")).toBeNull();
    expect(svg.documentElement.textContent).toContain("短表");
    expect(svg.documentElement.textContent).toContain("orders & <script>alert('x')</script>");
    expect(svg.querySelectorAll("[data-table-id]")).toHaveLength(2);
  });

  it("streams detached table/edge batches, enforces complete unique identities and retains marker definitions", () => {
    const fixture = diagramFixture();
    const first = fixture.root.querySelector<HTMLElement>(".table-node")!;
    const second = first.cloneNode(true) as HTMLElement;
    const wrap = (table: HTMLElement, id: string) => { const node = document.createElement("div"); node.className = "react-flow__node"; node.dataset.id = id; node.append(table); return node; };
    const a = wrap(first, "a"), b = wrap(second, "b");
    second.querySelector("strong")!.textContent = "second";
    const edge = fixture.root.querySelector(".react-flow__edge")!; edge.setAttribute("data-id", "relation");
    edge.remove(); a.remove();
    const capture = createDiagramSvgCapture({ ...fixture, snapshot: diagramAfter, tableIds: new Set(["a", "b"]), edgeIds: new Set(["relation"]) });
    fixture.root.append(a); capture.appendTables([first]); a.remove();
    fixture.root.append(b); capture.appendTables([second]); b.remove();
    expect(() => capture.finish()).toThrow("Some relationships");
    fixture.root.querySelector("svg")!.append(edge); capture.appendEdges();
    expect(() => capture.appendEdges()).toThrow("relationships changed"); edge.remove();
    const result = capture.finish(), svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(svg.querySelector("parsererror")).toBeNull();
    expect(svg.querySelectorAll("[data-table-id]")).toHaveLength(2);
    expect(svg.querySelectorAll(".react-flow__edge")).toHaveLength(1);
    expect(svg.querySelector("marker#arrow")).not.toBeNull();
    expect(svg.documentElement.textContent).toContain("second");
    expect(result.svg).toContain("translate(82 120)");
  });

  it("keeps output dimensions and layout independent of pan and zoom", () => {
    const original = captureDiagramSvg({ ...diagramFixture(), snapshot: diagramAfter });
    vi.restoreAllMocks(); document.body.innerHTML = "";
    const zoomed = captureDiagramSvg({ ...diagramFixture(0.25), snapshot: diagramAfter });
    expect([zoomed.width, zoomed.height]).toEqual([original.width, original.height]);
    expect(zoomed.svg).toContain("M10,50 L350,50");
  });

  it("omits unnecessary overflow clips while retaining clips for actual overflow", () => {
    const fixture = diagramFixture();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(280);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(150);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(280);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(150);
    expect(captureDiagramSvg({ ...fixture, snapshot: diagramAfter }).svg).not.toContain("clipPath");
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    const result = captureDiagramSvg({ ...fixture, snapshot: diagramAfter });
    expect(result.svg).toContain("clipPath"); expect(result.svg).toContain("legacy_note");
    expect(result.svg).toContain("diagram-text-0");
    expect(new DOMParser().parseFromString(result.svg, "image/svg+xml").querySelector("parsererror")).toBeNull();
  });

  it("exports shared relationship paint exactly once while ignoring empty React Flow wrappers", () => {
    const fixture = diagramFixture();
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    empty.innerHTML = '<g class="react-flow__edge" data-id="edge" aria-hidden="true" />';
    fixture.root.prepend(empty);
    fixture.root.querySelector(".react-flow__edge:not([aria-hidden])")!.setAttribute("data-shared-edge", "true");
    const result = captureDiagramSvg({ ...fixture, snapshot: diagramAfter });
    const exported = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(exported.querySelectorAll(".react-flow__edge")).toHaveLength(1);
    expect(exported.querySelector('[data-shared-edge="true"] path')?.getAttribute("marker-end")).toBe("url(#arrow)");
  });

  it("preserves light theme, color-blind legend and partial comparison coverage", () => {
    document.documentElement.dataset.theme = "light";
    const result = captureDiagramSvg({ ...diagramFixture(), snapshot: diagramAfter, changeSet: diagramChangeSet, colorBlindPalette: true });
    expect(result.svg).toContain('data-theme="light"');
    expect(result.svg).toContain("#0072b2");
    expect(result.svg).toContain("#d55e00");
    expect(result.svg).toContain("Partial comparison: Before snapshot unavailable");
  });

  it("exports the resolved System theme after the OS appearance changes", () => {
    document.documentElement.dataset.theme = "system";
    const fixture = diagramFixture();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(captureDiagramSvg({ ...fixture, snapshot: diagramAfter }).svg).toContain('data-theme="light"');
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(captureDiagramSvg({ ...fixture, snapshot: diagramAfter }).svg).toContain('data-theme="dark"');
  });

  it("preserves quoted marker references containing theme variable names", () => {
    const fixture = diagramFixture();
    const id = "color=var(--ds-relation-physical)&type=arrowclosed";
    fixture.root.querySelector("marker")!.id = id;
    const path = fixture.root.querySelector<SVGElement>(".react-flow__edge path")!;
    path.style.setProperty("marker-end", `url("http://localhost/#${id}")`);
    const result = captureDiagramSvg({ ...fixture, snapshot: diagramAfter });
    const exported = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(exported.getElementById(id)).not.toBeNull();
    expect(exported.querySelector(".react-flow__edge path")?.getAttribute("style")).toContain(`url("#${id}")`);
  });

  it("rejects an empty diagram and invalid raster dimensions", () => {
    expect(() => captureDiagramSvg({ root: document.createElement("div"), viewport: { x: 0, y: 0, zoom: 1 }, snapshot: diagramAfter })).toThrow(/no tables/);
    expect(() => pngDimensions(NaN, 10)).toThrow(/invalid dimensions/);
  });

  it("caps PNG allocation while retaining 2x resolution for ordinary diagrams", () => {
    expect(pngDimensions(1000, 800)).toEqual({ width: 2000, height: 1600 });
    for (const [width, height] of [[30_000, 15_000], [1_000_000, 100], [10_000, 10_000]]) {
      const size = pngDimensions(width, height);
      expect(size.width).toBeLessThanOrEqual(8192);
      expect(size.height).toBeLessThanOrEqual(8192);
      expect(size.width * size.height).toBeLessThanOrEqual(16_000_000);
    }
  });

  it("uses portable filenames without allowing path segments", () => {
    expect(diagramFileName("../../客户 db<>:/", "12/ab", "svg")).toBe("db-diagram-12ab.svg");
    expect(diagramFileName("客户", "!", "png")).toBe("database-diagram-current.png");
  });
});
