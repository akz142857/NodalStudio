import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { getStyleTags, tags } from "@lezer/highlight";

type Word = { from: number; to: number };
type Point = { x: number; y: number };

const linkMark = Decoration.mark({ class: "cm-definition-link" });
const setLink = StateEffect.define<Word | null>();
const link = StateField.define<Word | null>({
  create: () => null,
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLink)) return effect.value;
    }
    return transaction.docChanged ? null : current;
  },
  provide: (field) => EditorView.decorations.from(field, (word) => word
    ? Decoration.set(linkMark.range(word.from, word.to)) : Decoration.none),
});

const plainTextTags = new Set([tags.comment, tags.literal, tags.keyword]);
const usesCommand = () => navigator.platform.startsWith("Mac");
const modifierHeld = (event: MouseEvent) => usesCommand() ? event.metaKey : event.ctrlKey;

function codePoint(event: MouseEvent): Point | undefined {
  const target = event.target;
  if (target instanceof Element && target.closest(".cm-content .cm-line") && !target.closest(".cm-deletedChunk")) {
    return { x: event.clientX, y: event.clientY };
  }
}

function wordUnderPointer(view: EditorView, point: Point) {
  const hit = view.posAndSideAtCoords(point);
  if (!hit) return null;
  const offset = hit.pos + (hit.assoc < 0 ? -1 : 0);
  if (offset < 0) return null;
  const word = view.state.wordAt(offset);
  if (!word || offset < word.from || offset >= word.to || !/^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u.test(view.state.sliceDoc(word.from, word.to))) return null;
  for (let node = syntaxTree(view.state).resolveInner(word.from, 1); node.parent; node = node.parent) {
    const styles = getStyleTags(node)?.tags;
    if (styles?.some((style) => style.set.some((tag) => plainTextTags.has(tag)))) return null;
    if (styles?.some((style) => style.set.includes(tags.name))) break;
  }
  return word;
}

export function codeDefinitionLinks(visit: (view: EditorView, offset: number) => boolean) {
  return [link, ViewPlugin.fromClass(class {
    private point?: Point;
    private readonly owner: Window | null;

    constructor(private readonly view: EditorView) {
      this.owner = view.dom.ownerDocument.defaultView;
      this.owner?.addEventListener("keydown", this.onKeyDown, true);
      this.owner?.addEventListener("keyup", this.onKeyUp, true);
      this.owner?.addEventListener("blur", this.clear);
    }

    private modifier(key: string) { return key === (usesCommand() ? "Meta" : "Control"); }
    private onKeyDown = (event: KeyboardEvent) => { if (this.modifier(event.key)) this.show(this.point); };
    private onKeyUp = (event: KeyboardEvent) => { if (this.modifier(event.key)) this.show(); };

    clear = () => {
      this.point = undefined;
      this.show();
    };

    move(event: MouseEvent) {
      this.point = codePoint(event);
      this.show(modifierHeld(event) && !event.buttons ? this.point : undefined);
    }

    private show(point?: Point) {
      const word = point ? wordUnderPointer(this.view, point) : null;
      const current = this.view.state.field(link);
      if (current?.from !== word?.from || current?.to !== word?.to) {
        this.view.dispatch({ effects: setLink.of(word) });
      }
    }

    destroy() {
      this.owner?.removeEventListener("keydown", this.onKeyDown, true);
      this.owner?.removeEventListener("keyup", this.onKeyUp, true);
      this.owner?.removeEventListener("blur", this.clear);
    }
  }, {
    eventObservers: {
      mousemove(event) { this.move(event); },
      mouseleave() { this.clear(); },
      scroll() { this.clear(); },
    },
    eventHandlers: {
      mousedown(event, view) {
        if (!modifierHeld(event) || event.button !== 0) return false;
        const point = codePoint(event);
        const word = point && wordUnderPointer(view, point);
        return word ? visit(view, word.from) : false;
      },
    },
  })];
}
