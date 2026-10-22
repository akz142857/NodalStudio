import type { KeyboardEvent } from "react";

export const queryKeys = /Mac|iPhone|iPad/.test(navigator.platform) ? { run: "⌘R", current: "⇧⌘R", stop: "⌘." } : { run: "Ctrl+R", current: "Ctrl+Shift+R", stop: "Ctrl+." };
export function queryMenuKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}
