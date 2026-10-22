import { useSyncExternalStore } from "react";

/** CSS handles the palette; canvas libraries and exports need the same resolved mode. */
export function resolvedTheme(): "light" | "dark" {
  const preference = document.documentElement.dataset.theme;
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function subscribe(listener: () => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  media?.addEventListener("change", listener);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", listener);
  };
}

export function useResolvedTheme() {
  return useSyncExternalStore(subscribe, resolvedTheme, () => "dark" as const);
}
