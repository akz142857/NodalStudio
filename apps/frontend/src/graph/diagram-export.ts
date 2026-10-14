import type { Viewport } from "@xyflow/react";
import type { DatabaseSnapshot, SchemaChangeSet } from "../platform";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
type Box = { x: number; y: number; width: number; height: number };

export interface DiagramExportOptions {
  root: HTMLElement;
  viewport: Viewport;
  snapshot: DatabaseSnapshot;
  changeSet?: SchemaChangeSet;
  beforeSnapshot?: DatabaseSnapshot;
  colorBlindPalette?: boolean;
  scope?: string;
}

export interface DiagramSvg {
  svg: string;
  width: number;
  height: number;
}

function element<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function text(parent: SVGElement, value: string, x: number, y: number, color: string, size = 11) {
  const node = element("text", { x, y, fill: color, "font-size": size });
  node.textContent = value;
  parent.append(node);
  return node;
}

export function diagramFileName(databaseName: string, fingerprint: string, format: "svg" | "png") {
  const name = databaseName.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "database";
  const revision = fingerprint.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "current";
  return `${name}-diagram-${revision}.${format}`;
}

export function pngDimensions(width: number, height: number) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("The diagram has invalid dimensions.");
  const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Native SVG text/shapes keep PNG rasterization independent of foreignObject support. */
export function captureDiagramSvg(options: DiagramExportOptions): DiagramSvg {
  const { root, viewport, snapshot, changeSet, beforeSnapshot, colorBlindPalette } = options;
  if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0) throw new Error("The diagram is not ready to export.");
  const flowBox = root.getBoundingClientRect();
  const toBox = (rect: DOMRect): Box => ({
    x: (rect.x - flowBox.x - viewport.x) / viewport.zoom,
    y: (rect.y - flowBox.y - viewport.y) / viewport.zoom,
    width: rect.width / viewport.zoom, height: rect.height / viewport.zoom,
  });
  const tables = Array.from(root.querySelectorAll<HTMLElement>(".table-node"));
  const edges = Array.from(root.querySelectorAll<SVGGElement>(".react-flow__edge"));
  if (!tables.length) throw new Error("There are no tables in this diagram to export.");
  const boxes = [...tables, ...edges].map((node) => toBox(node.getBoundingClientRect())).filter((box) => box.width > 0 && box.height > 0);
  if (!boxes.length) throw new Error("The diagram is still being laid out. Try again when it is ready.");
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const partial = Boolean(changeSet && !beforeSnapshot);
  const headerHeight = changeSet ? partial ? 174 : 154 : 108;
  const width = Math.ceil(Math.max(920, right - left + 64));
  const height = Math.ceil(bottom - top + headerHeight + 64);
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const pageStyle = getComputedStyle(document.documentElement);
  const background = !pageStyle.backgroundColor || ["rgba(0, 0, 0, 0)", "transparent"].includes(pageStyle.backgroundColor) ? theme === "light" ? "#eef0f5" : "#111318" : pageStyle.backgroundColor;
  const foreground = theme === "light" ? "#20242c" : "#e7e9ef";
  const muted = theme === "light" ? "#586274" : "#aab4c3";
  const svg = element("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "data-theme": theme, "font-family": pageStyle.fontFamily || "system-ui, sans-serif" });
  const title = element("title"); title.textContent = `${snapshot.database.name} · Diagram`;
  const description = element("desc");
  description.textContent = `Current diagram: ${tables.length} tables. ${options.scope ?? "All tables"}. ${changeSet ? "Comparison direction: Before → After. Deleted objects use Before definitions." : "Current snapshot."} Inferred candidates are not database constraints.`;
  svg.append(title, description, element("rect", { width, height, fill: background }));
  const defs = element("defs"); svg.append(defs);
  for (const markerDefs of root.querySelectorAll(".react-flow__edges defs, .react-flow__marker defs")) {
    for (const child of markerDefs.children) defs.append(cloneSvg(child));
  }
  const heading = element("g"); svg.append(heading);
  text(heading, `${snapshot.database.name} · Diagram`, 20, 30, foreground, 18);
  text(heading, `${tables.length} tables · ${options.scope ?? "All tables"} · Snapshot ${snapshot.fingerprint.slice(0, 12)}`, 20, 52, muted);
  const relationships = [
    { x: 20, label: "Physical FK", color: colorBlindPalette ? "#0072b2" : "#2563eb", dash: "" },
    { x: 215, label: "Logical relationship", color: "#7c3aed", dash: "8 5" },
    { x: 470, label: "Inferred candidate · not a constraint", color: colorBlindPalette ? "#d55e00" : "#b7791f", dash: "6 4" },
  ];
  for (const item of relationships) {
    heading.append(element("path", { d: `M${item.x},77 h28 m-5,-3 l5,3 -5,3`, fill: "none", stroke: item.color, "stroke-width": 2, "stroke-dasharray": item.dash }));
    text(heading, item.label, item.x + 36, 81, foreground);
  }
  text(heading, "Gray dashed: inactive/conflicted logical relationship", 20, 100, muted, 10);
  if (changeSet) {
    const statuses = [
      { x: 20, width: 100, label: "+ Added", color: colorBlindPalette ? "#005a85" : "#166b33", background: colorBlindPalette ? "#e2f3fc" : "#e3f5e8" },
      { x: 145, width: 110, label: "~ Modified", color: "#805300", background: "#fff1d4" },
      { x: 280, width: 180, label: "− Deleted · Before", color: colorBlindPalette ? "#994000" : "#a52d36", background: colorBlindPalette ? "#fff0e4" : "#ffe8eb" },
    ];
    for (const status of statuses) {
      heading.append(element("rect", { x: status.x, y: 110, width: status.width, height: 19, rx: 3, fill: status.background }));
      text(heading, status.label, status.x + 6, 124, status.color, 12);
    }
    text(heading, "Unmarked: unchanged", 480, 123, muted);
    text(heading, `Before ${beforeSnapshot?.fingerprint.slice(0, 12) ?? "unavailable"} → After ${snapshot.fingerprint.slice(0, 12)}`, 20, 145, foreground);
    if (partial) text(heading, "Partial comparison: Before snapshot unavailable; deleted objects cannot be shown.", 20, 166, muted);
  }
  const content = element("g", { transform: `translate(${32 - left} ${headerHeight + 32 - top})` }); svg.append(content);
  for (const edge of edges) content.append(cloneSvg(edge));
  let clipIndex = 0;
  const renderHtml = (source: HTMLElement, parent: SVGElement) => {
    if (source.closest(".table-node-actions")) return;
    const style = getComputedStyle(source);
    if (style.display === "none" || style.visibility === "hidden") return;
    const box = toBox(source.getBoundingClientRect());
    if (!box.width || !box.height) return;
    const group = element("g"); parent.append(group);
    const radius = parseFloat(style.borderTopLeftRadius) || 0;
    if ([style.overflow, style.overflowX, style.overflowY].some((value) => value === "hidden" || value === "clip")) {
      const id = `diagram-clip-${clipIndex++}`;
      const clip = element("clipPath", { id }); clip.append(element("rect", { ...box, rx: radius })); defs.append(clip);
      group.setAttribute("clip-path", `url(#${id})`);
    }
    if (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") group.append(element("rect", { ...box, rx: radius, fill: style.backgroundColor }));
    drawBorders(group, box, style, radius);
    if (source.classList.contains("table-node") && source.dataset.domain === "true") {
      group.append(element("rect", { x: box.x, y: box.y, width: 4, height: box.height, fill: style.getPropertyValue("--domain-color") || "transparent" }));
    }
    if (style.boxShadow.includes("inset")) {
      const color = style.boxShadow.match(/rgba?\([^)]+\)|#[\da-f]+/i)?.[0];
      if (color) group.append(element("rect", { x: box.x, y: box.y, width: 3, height: box.height, fill: color }));
    }
    for (const child of source.childNodes) {
      if (child instanceof HTMLElement) renderHtml(child, group);
      else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) drawText(child as Text, group, style, toBox);
    }
  };
  for (const table of tables) renderHtml(table, content);
  const payload = new XMLSerializer().serializeToString(svg);
  if (new TextEncoder().encode(payload).length > MAX_EXPORT_BYTES) throw new Error("The SVG exceeds 32 MB. Export a smaller filtered view.");
  return { svg: payload, width, height };
}

function drawBorders(parent: SVGElement, box: Box, style: CSSStyleDeclaration, radius: number) {
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  if (sides.every((side) => style[`border${side}Width`] === style.borderTopWidth && style[`border${side}Style`] === style.borderTopStyle && style[`border${side}Color`] === style.borderTopColor)) {
    const strokeWidth = parseFloat(style.borderTopWidth);
    if (strokeWidth && style.borderTopStyle !== "none") parent.append(element("rect", { x: box.x + strokeWidth / 2, y: box.y + strokeWidth / 2, width: box.width - strokeWidth, height: box.height - strokeWidth, rx: radius, fill: "none", stroke: style.borderTopColor, "stroke-width": strokeWidth, "stroke-dasharray": style.borderTopStyle === "dashed" ? "5 4" : "" }));
    return;
  }
  const coordinates = [
    [box.x, box.y, box.x + box.width, box.y], [box.x + box.width, box.y, box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height, box.x + box.width, box.y + box.height], [box.x, box.y, box.x, box.y + box.height],
  ];
  sides.forEach((side, index) => {
    const strokeWidth = parseFloat(style[`border${side}Width`]);
    if (!strokeWidth || style[`border${side}Style`] === "none") return;
    const [x1, y1, x2, y2] = coordinates[index];
    parent.append(element("line", { x1, y1, x2, y2, stroke: style[`border${side}Color`], "stroke-width": strokeWidth, "stroke-dasharray": style[`border${side}Style`] === "dashed" ? "5 4" : "" }));
  });
}

function drawText(source: Text, parent: SVGElement, style: CSSStyleDeclaration, toBox: (rect: DOMRect) => Box) {
  const range = document.createRange(); range.selectNodeContents(source);
  const rects = Array.from(range.getClientRects());
  const runs: { value: string; box: Box }[] = [];
  if (rects.length <= 1) runs.push({ value: source.data, box: toBox(range.getBoundingClientRect()) });
  else {
    for (let index = 0; index < source.length; index++) {
      range.setStart(source, index); range.setEnd(source, index + 1);
      const box = toBox(range.getBoundingClientRect());
      if (!box.width || !box.height) continue;
      const last = runs.at(-1);
      if (last && Math.abs(last.box.y - box.y) < 1) last.value += source.data[index];
      else runs.push({ value: source.data[index], box });
    }
  }
  for (const run of runs) {
    if (!run.box.height) continue;
    const value = style.textTransform === "uppercase" ? run.value.toUpperCase() : style.textTransform === "lowercase" ? run.value.toLowerCase() : style.textTransform === "capitalize" ? run.value.replace(/\b\w/g, (letter) => letter.toUpperCase()) : run.value;
    const node = text(parent, value, run.box.x, run.box.y + run.box.height * 0.8, style.color, parseFloat(style.fontSize) || 12);
    if (style.fontFamily) node.setAttribute("font-family", style.fontFamily);
    if (style.fontWeight) node.setAttribute("font-weight", style.fontWeight);
    if (style.fontStyle) node.setAttribute("font-style", style.fontStyle);
    node.setAttribute("text-decoration", style.textDecorationLine);
  }
}

function cloneSvg(source: Element): SVGElement {
  const clone = source.cloneNode(false) as SVGElement;
  const style = getComputedStyle(source);
  for (const property of ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "marker-start", "marker-end"]) {
    const value = style.getPropertyValue(property).replace(/url\(["']?([^"')]+)["']?\)/g, (_match, url: string) => {
      const fragment = url.indexOf("#");
      return fragment === -1 ? "none" : `url("${url.slice(fragment)}")`;
    });
    if (value) clone.style.setProperty(property, value);
  }
  for (const child of source.childNodes) {
    if (child instanceof Element && !child.classList.contains("react-flow__edge-interaction")) clone.append(cloneSvg(child));
    else if (child.nodeType === Node.TEXT_NODE) clone.append(child.cloneNode());
  }
  return clone;
}

export async function diagramPng(document: DiagramSvg): Promise<{ blob: Blob; width: number; height: number }> {
  const dimensions = pngDimensions(document.width, document.height);
  const canvas = window.document.createElement("canvas");
  canvas.width = dimensions.width; canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG export is unavailable in this browser. Try SVG.");
  const reader = new FileReader();
  const rasterSvg = new DOMParser().parseFromString(document.svg, "image/svg+xml").documentElement;
  rasterSvg.setAttribute("width", String(dimensions.width));
  rasterSvg.setAttribute("height", String(dimensions.height));
  const dataUrl = await new Promise<string>((resolve, reject) => {
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unable to prepare the diagram image."));
    reader.onerror = () => reject(new Error("Unable to prepare the diagram image."));
    reader.readAsDataURL(new Blob([new XMLSerializer().serializeToString(rasterSvg)], { type: "image/svg+xml;charset=utf-8" }));
  });
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Unable to render PNG. Try SVG."));
    image.src = dataUrl;
  });
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Unable to encode PNG. Try SVG.")), "image/png"));
  if (blob.size > MAX_EXPORT_BYTES) throw new Error("The PNG exceeds 32 MB. Export a smaller filtered view.");
  canvas.width = 0; canvas.height = 0;
  return { blob, ...dimensions };
}
