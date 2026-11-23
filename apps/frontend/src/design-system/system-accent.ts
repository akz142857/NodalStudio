import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { invoke } from "../platform/desktop-invoke";
import { useResolvedTheme } from "./theme";

type RGB = readonly [number, number, number];
type NativeAccents = readonly [RGB, RGB];
const white: RGB = [1, 1, 1];
const black: RGB = [0, 0, 0];

function mix(from: RGB, to: RGB, amount: number): RGB {
  const channel = (index: number) => from[index] + (to[index] - from[index]) * amount;
  return [channel(0), channel(1), channel(2)];
}

function luminance([r, g, b]: RGB) {
  const linear = (channel: number) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  return .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
}

function contrast(first: RGB, second: RGB) {
  const a = luminance(first) + .05;
  const b = luminance(second) + .05;
  return Math.max(a, b) / Math.min(a, b);
}

function accessibleColor(color: RGB, backgrounds: readonly RGB[], toward: RGB, minimum: number) {
  for (let step = 0; step < 40; step++) {
    const candidate = mix(color, toward, step / 40);
    if (backgrounds.every((background) => contrast(candidate, background) >= minimum + .02)) return candidate;
  }
  return toward;
}

function cssColor(color: RGB) {
  return `rgb(${color.map((channel) => Math.round(channel * 255)).join(", ")})`;
}

export function systemAccentTokens(seed: RGB, style: CSSStyleDeclaration, dark: boolean, increased: boolean) {
  const get = (name: string): RGB => {
    const hex = style.getPropertyValue(`--ds-${name}`).trim().slice(1);
    if (hex.length === 3) return [parseInt(hex[0], 16) / 15, parseInt(hex[1], 16) / 15, parseInt(hex[2], 16) / 15];
    const channel = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return [channel(0), channel(2), channel(4)];
  };
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const color: RGB = [clamp(seed[0]), clamp(seed[1]), clamp(seed[2])];
  const toward = dark ? white : black;
  const surfaces = ["window", "sidebar", "surface", "field", "control", "hover", "subtle", "selected-control"].map(get);
  const selection = mix(get("sidebar"), color, increased ? .28 : .17);
  const listFocus = mix(get("sidebar"), color, increased ? .36 : .26);
  const textMinimum = increased ? 7 : 4.5;
  const fill = accessibleColor(color, [white], black, textMinimum);
  const text = accessibleColor(mix(color, get("text"), .42), [selection], toward, textMinimum);
  return {
    "--ds-accent": cssColor(accessibleColor(color, surfaces, toward, increased ? 6 : 4.5)),
    "--ds-accent-fill": cssColor(fill),
    "--ds-accent-hover": cssColor(mix(fill, black, .15)),
    "--ds-focus-color": cssColor(accessibleColor(color, [...surfaces, selection, listFocus], toward, increased ? 4.5 : 3)),
    "--ds-selection": cssColor(selection),
    "--ds-selection-text": cssColor(text),
    "--ds-selection-marker": cssColor(accessibleColor(color, [...surfaces, selection], toward, increased ? 4.5 : 3)),
    "--ds-list-focus": cssColor(listFocus),
    "--ds-list-focus-text": cssColor(accessibleColor(text, [listFocus], toward, textMinimum)),
  };
}

export function useSystemAccent() {
  const theme = useResolvedTheme();
  const [accents, setAccents] = useState<NativeAccents>();

  useEffect(() => {
    if (!isTauri() || !navigator.platform.startsWith("Mac")) return;
    let request = 0;
    const refresh = () => {
      const version = ++request;
      void invoke<NativeAccents | null>("get_system_accent").then((value) => {
        if (request === version && value?.every((color) => color.length === 3 && color.every(Number.isFinite))) setAccents(value);
      }).catch(() => {});
    };
    refresh();
    // System Settings changes take effect when the app returns to the foreground.
    window.addEventListener("focus", refresh);
    return () => { request++; window.removeEventListener("focus", refresh); };
  }, []);

  useEffect(() => {
    if (!accents) return;
    const increased = window.matchMedia("(prefers-contrast: more)");
    const forced = window.matchMedia("(forced-colors: active)");
    const root = document.documentElement;
    let applied: string[] = [];
    const clear = () => applied.forEach((name) => root.style.removeProperty(name));
    const apply = () => {
      clear();
      if (forced.matches) return;
      const tokens = systemAccentTokens(accents[theme === "light" ? 0 : 1], getComputedStyle(root), theme === "dark", increased.matches);
      applied = Object.keys(tokens);
      for (const [name, color] of Object.entries(tokens)) root.style.setProperty(name, color);
    };
    apply();
    increased.addEventListener("change", apply);
    forced.addEventListener("change", apply);
    return () => {
      increased.removeEventListener("change", apply);
      forced.removeEventListener("change", apply);
      clear();
    };
  }, [accents, theme]);
}
