import { afterEach, expect, it, vi } from "vitest";
import { SvgTree } from "./svg-tree";

afterEach(() => vi.restoreAllMocks());

it("serializes standalone XML with escaped text, attributes and inline style priority", () => {
  const root = new SvgTree("svg"); root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const text = new SvgTree("text"); text.textContent = '<script>& "quoted" 中文';
  text.setAttribute("data-name", '" onload="x<y&z'); text.style.setProperty("fill", "red", "important"); root.append(text);
  const parsed = new DOMParser().parseFromString(root.serialize(Infinity), "image/svg+xml");
  expect(parsed.querySelector("parsererror, script")).toBeNull();
  expect(parsed.querySelector("text")!.textContent).toBe('<script>& "quoted" 中文');
  expect(parsed.querySelector("text")!.hasAttribute("onload")).toBe(false);
  expect(parsed.querySelector("text")!.getAttribute("data-name")).toBe('" onload="x<y&z');
  expect(parsed.querySelector("text")!.getAttribute("style")).toBe("fill:red !important");
});

it("enforces bytes after XML escaping and UTF-8 encoding", () => {
  const root = new SvgTree("svg"); root.textContent = "中&";
  const size = new TextEncoder().encode(root.serialize(Infinity)).length;
  expect(root.serialize(size)).toContain("中&amp;");
  expect(root.serializeWithSize(size)).toEqual({ xml: root.serialize(size), bytes: size });
  expect(() => root.serialize(size - 1)).toThrow("exceeds 32 MB");
});

it("releases measured subtrees into escaped fragments without changing XML or bypassing the final byte limit", () => {
  const table = new SvgTree("g"); table.setAttribute("data-table-id", '"<中文&');
  const text = new SvgTree("text"); text.textContent = '<script>& 🐱'; table.append(text);
  const expected = new SvgTree("svg"); expected.append(table);
  const streamed = new SvgTree("svg");
  const size = streamed.appendSerialized(table, Infinity);
  expect(size).toBe(new TextEncoder().encode(table.serialize(Infinity)).length);
  expect(streamed.serialize(Infinity)).toBe(expected.serialize(Infinity));
  const total = new TextEncoder().encode(expected.serialize(Infinity)).length;
  expect(() => streamed.serialize(total - 1)).toThrow("exceeds 32 MB");
  expect(() => new SvgTree("svg").appendSerialized(table, size - 1)).toThrow("exceeds 32 MB");
});

it("counts all UTF-8 scalar widths and isolated surrogates without allocating encoding buffers", () => {
  const values = ["", "<&\"'>", "\x7f\u0080\u07ff\u0800\ud7ff\ue000\uffff", "🐱𐀀\udbff\udfff", "\ud800a\udc00\ud800\ud800\udc00"];
  const encoder = new TextEncoder();
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  for (const value of values) {
    const text = new SvgTree("text"); text.textContent = value; text.setAttribute("data-name", value);
    const streamed = new SvgTree("svg");
    encode.mockClear();
    streamed.appendSerialized(text, Infinity);
    const result = streamed.serializeWithSize(Infinity);
    expect(encode).not.toHaveBeenCalled();
    expect(result.bytes).toBe(encoder.encode(result.xml).length);
    expect(() => streamed.serialize(result.bytes - 1)).toThrow("exceeds 32 MB");
  }
});
