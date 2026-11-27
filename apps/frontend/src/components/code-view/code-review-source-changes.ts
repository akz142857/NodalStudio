import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import { reviewDiffConfig } from "./code-review-checks";

export type SourceChangeKind = "added" | "modified" | "deleted";
export type SourceChange = { from: number; to: number; kind: SourceChangeKind };

export function sourceChanges(doc: Text, baseline: string | undefined, wholeFile: "added" | "deleted" | undefined): SourceChange[] {
  if (wholeFile) return doc.length ? [{ from: 1, to: doc.lineAt(doc.length - 1).number, kind: wholeFile }] : [];
  if (baseline === undefined) return [];
  const before = Text.of(baseline.split("\n"));
  const chunks = Chunk.build(before, doc, reviewDiffConfig);
  const [first] = chunks;
  // Give the overview a short retry when the default scan merges nearly the whole file into one marker.
  const coversMostOfFile = chunks.length === 1 && first.toA - first.fromA >= before.length * 0.9
    && first.toB - first.fromB >= doc.length * 0.9;
  const ranges = coversMostOfFile ? Chunk.build(before, doc, { scanLimit: 1500, timeout: 35 }) : chunks;
  return ranges.map((chunk) => {
    const change = chunk.changes.length === 1 ? chunk.changes[0] : undefined;
    const start = chunk.fromB + (change?.fromB ?? 0);
    const oldStart = chunk.fromA + (change?.fromA ?? 0);
    // A last-line insertion or deletion can include the preceding newline.
    const addedAtEnd = change && change.fromA === change.toA && oldStart === before.length
      && doc.sliceString(start, start + 1) === "\n";
    const deletedAtEnd = change && change.fromB === change.toB && start === doc.length
      && before.sliceString(oldStart, oldStart + 1) === "\n";
    const kind = chunk.fromB === chunk.toB || deletedAtEnd ? "deleted"
      : chunk.fromA === chunk.toA || addedAtEnd ? "added" : "modified";
    const from = doc.lineAt(Math.min(doc.length, addedAtEnd ? start + 1 : chunk.fromB)).number;
    const to = kind === "deleted" ? from : doc.lineAt(Math.min(doc.length, chunk.toB - 1)).number;
    return { from, to, kind };
  });
}

class ChangeMarker extends GutterMarker {
  constructor(readonly elementClass: string) { super(); }
}

const markers = {
  added: new ChangeMarker("cm-source-added"),
  modified: new ChangeMarker("cm-source-modified"),
  deleted: new ChangeMarker("cm-source-deleted"),
};

export function sourceChangeGutter(changes: readonly SourceChange[]) {
  return gutter({
    class: "cm-source-changes",
    lineMarker: (view, block) => {
      const line = view.state.doc.lineAt(block.from).number;
      let low = 0;
      let high = changes.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (changes[middle].to < line) low = middle + 1;
        else high = middle;
      }
      const change = changes[low];
      return change && change.from <= line ? markers[change.kind] : null;
    },
  });
}
