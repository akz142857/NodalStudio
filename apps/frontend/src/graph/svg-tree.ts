class SvgFragment {
  constructor(readonly xml: string, readonly bytes: number) {}
}

/** TextEncoder's scalar-value replacement rules, without allocating a typed
 * array for each tiny XML token during thousands of table captures. */
function utf8Size(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** Export-only records: never allocate a second native SVG rendering tree. */
export class SvgTree {
  private attributes = new Map<string, string>();
  private children: Array<SvgTree | SvgFragment | string> = [];
  private styles = new Map<string, string>();
  readonly style = { setProperty: (name: string, value: string, priority?: string) => {
    this.styles.set(name, `${value}${priority ? ` !${priority}` : ""}`);
  } };
  constructor(private tag: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  set textContent(value: string) { this.children = [value]; }
  append(...children: Array<SvgTree | string>) { this.children.push(...children); }
  /** Only accept XML produced by our escaping serializer, never caller markup.
   * The caller can release each measured table's object tree immediately. */
  appendSerialized(child: SvgTree, maxBytes: number): number {
    const { xml, bytes } = child.serializeWithSize(maxBytes);
    this.children.push(new SvgFragment(xml, bytes));
    return bytes;
  }
  serialize(maxBytes: number): string {
    return this.serializeWithSize(maxBytes).xml;
  }
  serializeWithSize(maxBytes: number): { xml: string; bytes: number } {
    const chunks: string[] = []; let bytes = 0;
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    const write = (value: string, size = utf8Size(value)) => {
      bytes += size;
      if (bytes > maxBytes) throw new Error("The SVG exceeds 32 MB. Export a smaller filtered view.");
      chunks.push(value);
    };
    const visit = (node: SvgTree | SvgFragment | string) => {
      if (typeof node === "string") { write(escape(node)); return; }
      if (node instanceof SvgFragment) { write(node.xml, node.bytes); return; }
      if (node.tag === "g" && !node.attributes.size && !node.styles.size) { for (const child of node.children) visit(child); return; }
      write(`<${node.tag}`);
      for (const [name, value] of node.attributes) write(` ${name}="${escape(value)}"`);
      if (node.styles.size) write(` style="${escape([...node.styles].map(([name, value]) => `${name}:${value}`).join(";"))}"`);
      write(">"); for (const child of node.children) visit(child); write(`</${node.tag}>`);
    };
    visit(this); return { xml: chunks.join(""), bytes };
  }
}
