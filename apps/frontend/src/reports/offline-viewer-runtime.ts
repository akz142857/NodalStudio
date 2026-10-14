import type { OfflineViewerModel, OfflineTable } from "./offline-viewer-model";

/** Serialized into exported HTML. Keep every value/helper inside this function; no app APIs. */
export function offlineViewerRuntime() {
  const model = JSON.parse(document.getElementById("offline-model")!.textContent) as OfflineViewerModel;
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const search = get<HTMLInputElement>("viewer-search"); const schema = get<HTMLSelectElement>("viewer-schema"); const domain = get<HTMLSelectElement>("viewer-domain");
  const physical = get<HTMLInputElement>("viewer-physical"); const logical = get<HTMLInputElement>("viewer-logical");
  const stage = get("viewer-stage"); const list = get("viewer-list"); const status = get("viewer-status"); const details = get("viewer-selected");
  const svg = document.getElementById("viewer-graph") as unknown as SVGSVGElement;
  const ns = "http://www.w3.org/2000/svg";
  const element = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
    const result = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([name, value]) => result.setAttribute(name, String(value))); return result;
  };
  const label = (value: string, x: number, y: number, className: string) => { const result = element("text", { x, y, class: className }); result.textContent = value.length > 48 ? `${value.slice(0, 47)}…` : value; return result; };
  const option = (select: HTMLSelectElement, name: string, value: string) => { const item = document.createElement("option"); item.textContent = name; item.value = value; select.append(item); };
  [...new Set([...model.tables, ...model.objects].map((table) => table.schema))].sort().forEach((value) => option(schema, value, value));
  model.domains.forEach((item) => option(domain, item.name, item.id));
  const articles = [...document.querySelectorAll<HTMLElement>('article[id^="table-"],article[id^="view-"],article[id^="enum-"],article[id^="logical-"]')];
  const searchable = new Map(articles.map((article) => [article.id, article.textContent.toLocaleLowerCase()]));
  const tablesById = new Map(model.tables.map((table) => [table.id, table]));
  const objectsById = new Map(model.objects.map((object) => [object.id, object]));
  let selected: string | undefined; let focus: string | undefined; let visible: OfflineTable[] = []; let totalWidth = 800; let totalHeight = 600;
  let box = { x: 0, y: 0, width: 800, height: 600 };
  const applyBox = () => svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  const fit = () => { const ratio = Math.max(1, stage.clientWidth) / Math.max(1, stage.clientHeight); const width = Math.max(totalWidth, totalHeight * ratio); box = { x: (totalWidth - width) / 2, y: (totalHeight - width / ratio) / 2, width, height: width / ratio }; applyBox(); };
  const zoom = (factor: number) => {
    const width = Math.min(25000, Math.max(200, box.width * factor)); const height = box.height * width / box.width;
    box = { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height }; applyBox();
  };
  const relations = () => model.relations.filter((relation) => relation.kind === "physical" ? physical.checked : logical.checked);
  const select = (id: string) => {
    selected = id; const table = tablesById.get(id); if (!table) return;
    details.replaceChildren(); const heading = document.createElement("h3"); heading.textContent = `${table.schema}.${table.name}`; details.append(heading);
    const link = document.createElement("a"); link.href = `#${id}`; link.textContent = "Read complete table details"; details.append(link);
    const related = relations().filter((relation) => relation.source === id || relation.target === id);
    const description = document.createElement("p"); description.textContent = `${table.columns.length} columns · ${related.length} available relationships (current kind filters).`; details.append(description);
    const ul = document.createElement("ul");
    for (const relation of related) {
      const other = relation.source === id ? relation.target : relation.source; const target = tablesById.get(other)!;
      const li = document.createElement("li"); const button = document.createElement("button"); button.type = "button";
      button.textContent = `${relation.kind === "physical" ? "Physical FK" : "Saved logical"} · ${relation.name} → ${target.schema}.${target.name}`;
      button.addEventListener("click", () => { focus = undefined; schema.value = ""; domain.value = ""; search.value = ""; selected = other; update(); }); li.append(button); ul.append(li);
    }
    details.append(ul); get<HTMLButtonElement>("viewer-neighbors").disabled = false;
    svg.querySelectorAll("[data-table]").forEach((node) => node.classList.toggle("selected", node.getAttribute("data-table") === selected));
    list.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.table === selected)));
  };
  function render() {
    svg.replaceChildren(); list.replaceChildren();
    const defs = element("defs"); const marker = element("marker", { id: "viewer-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }); marker.append(element("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#475467" })); defs.append(marker); svg.append(defs);
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(visible.length))));
    const rowHeight = 360; totalWidth = Math.max(400, columns * 400); totalHeight = Math.max(360, Math.ceil(visible.length / columns) * rowHeight);
    const positions = new Map(visible.map((table, index) => [table.id, { x: 30 + (index % columns) * 400, y: 30 + Math.floor(index / columns) * rowHeight, height: 64 + Math.min(table.columns.length, 12) * 20 }]));
    for (const relation of relations()) {
      const a = positions.get(relation.source); const b = positions.get(relation.target); if (!a || !b) continue;
      const leftward = b.x < a.x; const sameColumn = b.x === a.x;
      const x = a.x + (leftward ? 0 : 320); const y = a.y + 24;
      const targetX = b.x + (leftward || sameColumn ? 326 : -6); const targetY = b.y + 24;
      const middle = sameColumn ? a.x + 355 : (x + targetX) / 2;
      // End outside the card so node backgrounds cannot hide relationship direction.
      const path = element("path", { d: relation.source === relation.target ? `M ${x} ${y} h 30 v -40 H ${a.x - 15} V ${y} H ${a.x - 6}` : `M ${x} ${y} H ${middle} V ${targetY} H ${targetX}`, class: `viewer-edge ${relation.kind}`, "marker-end": "url(#viewer-arrow)" });
      const title = element("title"); title.textContent = `${relation.kind === "physical" ? "Physical FK" : "Saved logical"}: ${relation.name}`; path.append(title); svg.append(path);
    }
    for (const table of visible) {
      const p = positions.get(table.id)!;
      const node = element("g", { transform: `translate(${p.x},${p.y})`, "data-table": table.id, class: "viewer-node", tabindex: 0, role: "button", "aria-label": `Select ${table.schema}.${table.name}` });
      node.append(element("rect", { width: 320, height: p.height, rx: 8 }));
      const title = element("title"); title.textContent = `${table.schema}.${table.name}`; node.append(title, label(`${table.schema}.${table.name}`, 12, 26, "node-title"));
      table.columns.slice(0, 12).forEach((column, index) => { const line = label(`${column.primary ? "PK · " : ""}${column.name} · ${column.type}${column.nullable ? "" : " · NN"}`, 12, 52 + index * 20, "node-column"); const title = element("title"); title.textContent = `${column.name}: ${column.type}`; line.append(title); node.append(line); });
      if (table.columns.length > 12) node.append(label(`+ ${table.columns.length - 12} columns in complete details`, 12, p.height - 8, "node-column"));
      node.addEventListener("click", () => select(table.id)); node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(table.id); } }); svg.append(node);
      const button = document.createElement("button"); button.type = "button"; button.dataset.table = table.id; button.textContent = `${table.schema}.${table.name}`; button.addEventListener("click", () => select(table.id)); list.append(button);
    }
    if (!visible.length) { const message = element("text", { x: 30, y: 70 }); message.textContent = "No matching tables. Adjust filters or show all."; svg.append(message); }
    fit();
    if (selected && visible.some((table) => table.id === selected)) select(selected);
    else { selected = undefined; details.textContent = "Select a table to read its details and relationships."; get<HTMLButtonElement>("viewer-neighbors").disabled = true; }
  }
  function update() {
    const query = search.value.trim().toLocaleLowerCase();
    const neighbors = focus ? new Set([focus, ...relations().filter((relation) => relation.source === focus || relation.target === focus).flatMap((relation) => [relation.source, relation.target])]) : undefined;
    visible = model.tables.filter((table) => (!schema.value || table.schema === schema.value) && (!domain.value || table.domains.includes(domain.value)) && (!query || searchable.get(table.id)?.includes(query)) && (!neighbors || neighbors.has(table.id)));
    const ids = new Set(visible.map((table) => table.id));
    articles.forEach((article) => {
      const table = tablesById.get(article.id);
      article.hidden = table ? !ids.has(table.id) : Boolean(domain.value || focus || query && !searchable.get(article.id)?.includes(query) || schema.value && objectsById.get(article.id)?.schema !== schema.value);
    });
    const edgeCount = relations().filter((relation) => ids.has(relation.source) && ids.has(relation.target)).length;
    status.textContent = `${visible.length} / ${model.tables.length} tables · ${edgeCount} visible relationships${focus ? " · One-hop focus" : ""}. Filters change this view only; the complete dictionary remains embedded.`;
    get("viewer-fallback").hidden = true; get("viewer-controls").hidden = false; get("viewer-workspace").hidden = false;
    render();
  }
  const reset = () => { search.value = ""; schema.value = ""; domain.value = ""; physical.checked = true; logical.checked = true; focus = undefined; update(); };
  search.addEventListener("input", () => { focus = undefined; update(); });
  [schema, domain, physical, logical].forEach((control) => control.addEventListener("change", () => { if (control === schema || control === domain) focus = undefined; update(); }));
  get("viewer-reset").addEventListener("click", reset); get("viewer-fit").addEventListener("click", fit);
  get("viewer-zoom-in").addEventListener("click", () => zoom(.8)); get("viewer-zoom-out").addEventListener("click", () => zoom(1.25));
  get("viewer-neighbors").addEventListener("click", () => { if (selected) { focus = selected; update(); } });
  let drag: { x: number; y: number; box: typeof box; pointer: number } | undefined;
  svg.addEventListener("pointerdown", (event) => { if (event.button !== 0 || (event.target as Element).closest("[data-table]")) return; drag = { x: event.clientX, y: event.clientY, box: { ...box }, pointer: event.pointerId }; svg.setPointerCapture(event.pointerId); });
  svg.addEventListener("pointermove", (event) => { if (!drag || drag.pointer !== event.pointerId) return; box.x = drag.box.x - (event.clientX - drag.x) * drag.box.width / Math.max(1, stage.clientWidth); box.y = drag.box.y - (event.clientY - drag.y) * drag.box.height / Math.max(1, stage.clientHeight); applyBox(); });
  const stop = () => { drag = undefined; }; svg.addEventListener("pointerup", stop); svg.addEventListener("pointercancel", stop); svg.addEventListener("lostpointercapture", stop);
  svg.addEventListener("keydown", (event) => { const step = box.width / 20; if (event.target !== svg) return; if (event.key === "+" || event.key === "=") zoom(.8); else if (event.key === "-") zoom(1.25); else if (event.key === "ArrowLeft") box.x -= step; else if (event.key === "ArrowRight") box.x += step; else if (event.key === "ArrowUp") box.y -= step; else if (event.key === "ArrowDown") box.y += step; else return; event.preventDefault(); applyBox(); });
  // Internal detail links always reveal their destination, even after filtering.
  document.addEventListener("click", (event) => { const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]'); if (!link) return; const target = document.getElementById(link.hash.slice(1)); if (!target) return; if (target.hidden || target.closest("[hidden]")) reset(); });
  window.addEventListener("resize", fit);
  update();
}
