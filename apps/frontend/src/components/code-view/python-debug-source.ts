import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";

export interface PythonDebugSource {
  lines: number[];
  verified: number[];
  paused?: number;
  toggle: (line: number) => void;
}

class Breakpoint extends GutterMarker {
  constructor(readonly verified: boolean) { super(); }

  toDOM() {
    const mark = document.createElement("span");
    mark.className = "python-debug-breakpoint";
    mark.dataset.verified = String(this.verified);
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }
}

export function pythonDebugSourceExtension(state: EditorState, debug: PythonDebugSource): Extension {
  const selected = new Set(debug.lines);
  const verified = new Set(debug.verified);
  const hollow = new Breakpoint(false);
  const solid = new Breakpoint(true);
  const line = debug.paused;
  return [
    gutter({
      class: "cm-python-debug-gutter",
      renderEmptyElements: true,
      lineMarker(view, block) {
        const number = view.state.doc.lineAt(block.from).number;
        return selected.has(number) ? (verified.has(number) ? solid : hollow) : null;
      },
      domEventHandlers: {
        mousedown(view, block, event) {
          if (!(event instanceof MouseEvent) || event.button !== 0) return false;
          debug.toggle(view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    line && line <= state.doc.lines ? EditorView.decorations.of(Decoration.set([
      Decoration.line({ class: "cm-python-debug-paused" }).range(state.doc.line(line).from),
    ])) : [],
  ];
}
