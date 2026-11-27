import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { EditorState, Text } from "@codemirror/state";
import { expect, it } from "vitest";
import { sourceChanges } from "./code-review-source-changes";
import { readerScopesAtLine } from "./code-review-sticky-scroll";

it("maps changes to Source lines, including removed lines and an end-of-file insertion", () => {
  const compare = (before: string, after: string) => sourceChanges(Text.of(after.split("\n")), before, undefined);
  expect(compare("head\nold\ntail", "head\nnew\ntail")).toEqual([{ from: 2, to: 2, kind: "modified" }]);
  expect(compare("head\nremoved\ntail", "head\ntail")).toEqual([{ from: 2, to: 2, kind: "deleted" }]);
  expect(compare("head\ntail", "head")).toEqual([{ from: 1, to: 1, kind: "deleted" }]);
  expect(compare("head", "head\ntail")).toEqual([{ from: 2, to: 2, kind: "added" }]);
  expect(compare("same\n", "same\n")).toEqual([]);
  expect(sourceChanges(Text.of(["first", "last", ""]), undefined, "added")).toEqual([{ from: 1, to: 2, kind: "added" }]);
});

it("keeps unchanged regions between distant edits in a long source file", () => {
  const original = Array.from({ length: 530 }, (_, index) => `const before_${index} = resolve_source_line(${index});`);
  const revised = original.map((line, index) => index < 520 && (index % 40 === 0 || index === 519)
    ? `function after_${index}() { return newType(${'"different editor state repeated "'.repeat(10)}); }` : line);
  const changes = sourceChanges(Text.of(revised), original.join("\n"), undefined);
  expect(changes).toContainEqual({ from: 201, to: 201, kind: "modified" });
  expect(changes.some(({ from, to }) => from <= 205 && 205 <= to)).toBe(false);
});

it("pins only the enclosing Rust scopes that have scrolled past the top line", () => {
  const doc = ["impl Record {", "    fn read(&self) {", "        work();", "    }", "", "    fn next() {}", "}", "", "fn other() {}"].join("\n");
  const state = EditorState.create({ doc, extensions: [rust()] });
  expect(readerScopesAtLine(state, 1)).toEqual([]);
  expect(readerScopesAtLine(state, 2).map(({ text }) => text)).toEqual(["impl Record {"]);
  expect(readerScopesAtLine(state, 3).map(({ line, text }) => [line, text])).toEqual([
    [1, "impl Record {"], [2, "fn read(&self) {"],
  ]);
  expect(readerScopesAtLine(state, 6).map(({ text }) => text)).toEqual(["impl Record {"]);
  expect(readerScopesAtLine(state, 8)).toEqual([]);
});

it("finds a Java method below its annotation and a TypeScript arrow function", () => {
  const javaState = EditorState.create({ doc: "class Record {\n    @Override\n    public String toString() {\n        return \"\";\n    }\n}", extensions: [java()] });
  expect(readerScopesAtLine(javaState, 4).map(({ line }) => line)).toEqual([1, 3]);
  const scriptState = EditorState.create({ doc: "const inspect = (name: string) => {\n    return name;\n};", extensions: [javascript({ typescript: true })] });
  expect(readerScopesAtLine(scriptState, 2).map(({ text }) => text)).toEqual(["const inspect = (name: string) => {"]);
});
