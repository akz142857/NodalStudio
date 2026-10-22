import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/design-system/tokens.css", "utf8");

function palette(block: string) {
  return Object.fromEntries([...block.matchAll(/--ds-([\w-]+):\s*(#[\da-f]+);/gi)].map((match) => [match[1], match[2]]));
}
function luminance(hex: string) {
  const value = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit.repeat(2)).join("") : hex.slice(1);
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const dark = palette(css.split(':root[data-theme="light"]')[0]);
const light = { ...dark, ...palette(css.split(':root[data-theme="light"]')[1].split("@media")[0]) };

it.each([["dark", dark], ["light", light]] as const)("keeps %s text, SQL syntax and status labels at AA contrast", (_theme, colors) => {
  const pairs = [
    ...["text", "secondary", "tertiary"].flatMap((text) => ["window", "sidebar", "surface", "field", "subtle", "control"].map((surface) => [text, surface])),
    ...["syntax-keyword", "syntax-string", "syntax-number", "syntax-function", "syntax-type"].map((text) => [text, "field"]),
    ...["positive", "warning", "danger", "logical"].map((status) => [status, `${status}-soft`]),
    ...["accent-fill", "positive-fill", "danger-fill", "logical-fill"].map((fill) => ["on-accent", fill]),
    ["selection-text", "selection"],
  ];
  for (const [text, surface] of pairs) {
    const [low, high] = [luminance(colors[text]), luminance(colors[surface])].sort((a, b) => a - b);
    expect((high + .05) / (low + .05), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
});

it("gives System light the same palette as explicit Light", () => {
  expect({ ...dark, ...palette(css.split("@media (prefers-color-scheme: light)")[1]) }).toEqual(light);
});
