import { StateEffect, type Text } from "@codemirror/state";
import { searchPanelOpen } from "@codemirror/search";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { CodeDefinitionPosition, CodeDocumentHighlightRange } from "../../platform/code-review";

const referenceMark = Decoration.mark({ class: "cm-code-reference" });
const showReferences = StateEffect.define<DecorationSet>();

function offsetAt(doc: Text, { line, character }: CodeDefinitionPosition) {
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || line >= doc.lines || character < 0) return undefined;
  const row = doc.line(line + 1);
  return character <= row.length ? row.from + character : undefined;
}

export function codeReferenceHighlights(load: (position: CodeDefinitionPosition) => Promise<CodeDocumentHighlightRange[]>) {
  return ViewPlugin.fromClass(class {
    decorations = Decoration.none;
    private timer?: ReturnType<typeof setTimeout>;
    private queued?: CodeDefinitionPosition;
    private running = false;
    private revision = 0;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      const finding = searchPanelOpen(update.state);
      if (update.selectionSet || update.docChanged || finding !== searchPanelOpen(update.startState)) {
        this.revision += 1;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.queued = undefined;
        this.decorations = Decoration.none;
        if (finding || !update.selectionSet || update.state.selection.ranges.length !== 1) return;
        const selection = update.state.selection.main;
        const word = update.state.wordAt(selection.from);
        if (selection.empty || !word || selection.from !== word.from || selection.to !== word.to) return;
        const line = update.state.doc.lineAt(word.from);
        this.queued = { line: line.number - 1, character: word.from - line.from };
        this.schedule();
      }
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(showReferences)) this.decorations = effect.value;
        }
      }
    }

    private schedule() {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.loadReferences();
      }, 140);
    }

    private async loadReferences() {
      if (this.running || !this.queued) return;
      const position = this.queued;
      const revision = this.revision;
      this.queued = undefined;
      this.running = true;
      try {
        const response = await load(position);
        if (this.revision !== revision) return;
        const { doc } = this.view.state;
        const ranges = response.flatMap(({ start, end }) => {
          const from = offsetAt(doc, start);
          const to = offsetAt(doc, end);
          return from !== undefined && to !== undefined && from < to ? [referenceMark.range(from, to)] : [];
        });
        if (ranges.length) {
          this.view.dispatch({ effects: showReferences.of(Decoration.set(ranges, true)) });
        }
      } catch {
        // Reference highlighting is optional when the project or language server is unavailable.
      } finally {
        this.running = false;
        if (this.queued && this.timer === undefined) this.schedule();
      }
    }

    destroy() {
      this.revision += 1;
      this.queued = undefined;
      clearTimeout(this.timer);
    }
  }, { decorations: (plugin) => plugin.decorations });
}
