import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolvedTheme, useResolvedTheme } from "./theme";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it("tracks OS changes in System mode while keeping explicit preferences", async () => {
  let light = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return light; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })));
  document.documentElement.dataset.theme = "system";
  const { result, unmount } = renderHook(useResolvedTheme);
  expect(result.current).toBe("light");
  act(() => { light = false; listeners.forEach((listener) => listener()); });
  expect(result.current).toBe("dark");

  document.documentElement.dataset.theme = "light";
  await waitFor(() => expect(result.current).toBe("light"));
  act(() => { listeners.forEach((listener) => listener()); });
  expect(result.current).toBe("light");
  document.documentElement.dataset.theme = "dark";
  await waitFor(() => expect(result.current).toBe("dark"));
  act(() => { light = true; listeners.forEach((listener) => listener()); });
  expect(result.current).toBe("dark");

  document.documentElement.dataset.theme = "system";
  await waitFor(() => expect(result.current).toBe("light"));
  unmount();
  expect(listeners.size).toBe(0);
});

it("uses the OS preference before settings load and supports non-browser tests", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(resolvedTheme()).toBe("light");
  vi.stubGlobal("matchMedia", undefined);
  expect(resolvedTheme()).toBe("dark");
});
