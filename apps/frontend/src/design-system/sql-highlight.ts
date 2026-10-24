import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
export const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--ds-syntax-keyword)", fontWeight: "650" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--ds-syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ds-syntax-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--ds-tertiary)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--ds-syntax-function)" },
  { tag: [tags.typeName, tags.className], color: "var(--ds-syntax-type)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--ds-secondary)" },
  { tag: tags.variableName, color: "var(--ds-text)" },
]);
