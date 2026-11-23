import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { systemAccentTokens } from "./system-accent";

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
function contrast(first: string, second: string) {
  const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + .05) / (low + .05);
}
const dark = palette(css.split(':root[data-theme="light"]')[0]);
const light = { ...dark, ...palette(css.split(':root[data-theme="light"]')[1].split("@media")[0]) };

it.each([["dark", dark], ["light", light]] as const)("keeps %s text, SQL syntax and status labels at AA contrast", (_theme, colors) => {
  const pairs = [
    ...["text", "secondary", "tertiary"].flatMap((text) => ["window", "sidebar", "surface", "field", "subtle", "control"].map((surface) => [text, surface])),
    ...["syntax-keyword", "syntax-string", "syntax-number", "syntax-function", "syntax-type"].map((text) => [text, "field"]),
    ...["positive", "warning", "danger", "logical"].map((status) => [status, `${status}-soft`]),
    ...["accent-fill", "positive-fill", "danger-fill", "logical-fill"].map((fill) => ["on-accent", fill]),
    ["on-accent", "accent-hover"],
    ["selection-text", "selection"],
    ["list-focus-text", "list-focus"],
  ];
  for (const [text, surface] of pairs) {
    expect(contrast(colors[text], colors[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
});

it.each([["dark", dark], ["light", light]] as const)("keeps %s focus indicators distinct from adjacent surfaces", (_theme, colors) => {
  for (const surface of ["window", "field", "surface", "sidebar", "control", "list-focus"]) {
    expect(contrast(colors["focus-color"], colors[surface]), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});

it("gives System light the same palette as explicit Light", () => {
  expect({ ...dark, ...palette(css.split("@media (prefers-color-scheme: light)")[1]) }).toEqual(light);
});

it.each([["dark", dark], ["light", light]] as const)("keeps %s chart marks and selection indicators distinct", (_theme, colors) => {
  for (const mark of ["chart-mark", "chart-highlight", "chart-mark-strong", "chart-highlight-strong"]) {
    expect(contrast(colors[mark], colors.surface), mark).toBeGreaterThanOrEqual(mark.endsWith("-strong") ? 4.5 : 3);
  }
  for (const surface of ["sidebar", "field", "selection"]) {
    expect(contrast(colors.accent, colors[surface]), `selection marker on ${surface}`).toBeGreaterThanOrEqual(3);
  }
  expect(contrast(colors["selection-strong-text"], colors["selection-strong"])).toBeGreaterThanOrEqual(7);
  for (const fill of ["accent-fill-strong", "accent-hover-strong"]) {
    expect(contrast(colors["on-accent"], colors[fill])).toBeGreaterThanOrEqual(7);
  }
});

it.each([["dark", dark], ["light", light]] as const)("adapts native tint to readable %s controls and selection", (theme, colors) => {
  const style = document.createElement("div").style;
  for (const [name, color] of Object.entries(colors)) style.setProperty(`--ds-${name}`, color);
  const seeds = [[0, .48, 1], [.4, .72, .3], [.98, .79, .13], [.56, .56, .58], [.65, .18, .39]] as const;
  for (const seed of seeds) {
    for (const increased of [false, true]) {
      const tokens = systemAccentTokens(seed, style, theme === "dark", increased);
      const hex = (token: keyof typeof tokens) => "#" + (tokens[token].match(/\d+/g) ?? []).map((value) => Number(value).toString(16).padStart(2, "0")).join("");
      const minimum = increased ? 7 : 4.5;
      expect(contrast(hex("--ds-accent-fill"), "#fff"), `primary label for ${seed.join(", ")}`).toBeGreaterThanOrEqual(minimum);
      expect(contrast(hex("--ds-accent-hover"), "#fff"), `primary hover label for ${seed.join(", ")}`).toBeGreaterThanOrEqual(minimum);
      expect(contrast(hex("--ds-selection-text"), hex("--ds-selection"))).toBeGreaterThanOrEqual(minimum);
      expect(contrast(hex("--ds-accent"), colors.hover)).toBeGreaterThanOrEqual(increased ? 6 : 4.5);
      for (const background of [colors.sidebar, colors.field, hex("--ds-selection")]) {
        expect(contrast(hex("--ds-selection-marker"), background)).toBeGreaterThanOrEqual(increased ? 4.5 : 3);
      }
    }
  }
});
