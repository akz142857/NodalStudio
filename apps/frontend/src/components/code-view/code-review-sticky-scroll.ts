import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export type ReaderScope = { line: number; from: number; text: string };

const declarationBodies: Partial<Record<string, readonly string[]>> = {
  ImplItem: ["DeclarationList"],
  TraitItem: ["DeclarationList"],
  ModItem: ["DeclarationList"],
  StructItem: ["FieldDeclarationList"],
  EnumItem: ["EnumVariantList"],
  FunctionItem: ["Block"],
  FunctionDeclaration: ["Block"],
  ClassDeclaration: ["ClassBody", "DeclarationList"],
  InterfaceDeclaration: ["InterfaceBody", "ObjectType", "DeclarationList"],
  EnumDeclaration: ["EnumBody"],
  RecordDeclaration: ["ClassBody", "RecordBody"],
  MethodDeclaration: ["Block"],
  ConstructorDeclaration: ["ConstructorBody"],
  Property: ["Block"],
  ClassDefinition: ["Body"],
  FunctionDefinition: ["Body", "Block"],
  TypeSpec: ["StructType", "InterfaceType"],
  FunctionDecl: ["Block"],
  MethodDecl: ["Block"],
  VariableDeclaration: ["ArrowFunction", "FunctionExpression"],
};

export function readerScopesAtLine(state: EditorState, lineNumber: number): ReaderScope[] {
  const { doc } = state;
  let anchorLine = doc.line(lineNumber);
  // In indentation-sensitive grammars (such as Python), blank lines may sit outside the enclosing Body node.
  while (!anchorLine.text.trim() && anchorLine.number < doc.lines) {
    anchorLine = doc.line(anchorLine.number + 1);
  }
  const indent = anchorLine.text.search(/\S/);
  const probe = indent >= 0 ? anchorLine.from + indent : anchorLine.from;
  const scopes: ReaderScope[] = [];
  const resolved = syntaxTree(state).resolveInner(probe, 1);
  for (let ancestor: typeof resolved | null = resolved; ancestor; ancestor = ancestor.parent) {
    const node = ancestor;
    const bodies = declarationBodies[node.name];
    if (!bodies || (node.name === "VariableDeclaration" && node.getChildren("VariableDefinition").length !== 1)) continue;
    const body = bodies.map((name) => node.getChild(name)).find((part) => part && part.from <= probe && probe < part.to);
    if (!body) continue;
    // Java nodes may begin with annotations on earlier lines.
    const header = doc.lineAt(node.getChild("Definition")?.from ?? node.from);
    if (header.number < lineNumber) scopes.push({ line: header.number, from: header.from, text: header.text.trim() });
    if (scopes.length === 3) break;
  }
  return scopes.reverse();
}

export function trackReaderScopes(showScopes: (scopes: ReaderScope[]) => void) {
  return ViewPlugin.fromClass(class {
    private readonly measure = {
      read: (view: EditorView) => {
        const height = Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop);
        const line = view.state.doc.lineAt(view.lineBlockAtHeight(height).from).number;
        return readerScopesAtLine(view.state, line);
      },
      write: showScopes,
    };

    constructor(view: EditorView) { view.requestMeasure(this.measure); }

    update(update: ViewUpdate) {
      if (update.geometryChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        update.view.requestMeasure(this.measure);
      }
    }

    onScroll(view: EditorView) { view.requestMeasure(this.measure); }
  }, { eventObservers: { scroll(_event, view) { this.onScroll(view); } } });
}
