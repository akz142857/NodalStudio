export const WORKSPACE_SHORTCUTS = [
  ["navigation.openModel", "Mod+1"],
  ["navigation.openOntology", "Mod+2"],
  ["navigation.openDatabase", "Mod+3"],
  ["navigation.openQuery", "Mod+4"],
] as const;
export const QUERY_SAVE_SHORTCUT = "Mod+S";
export const CODE_SHORTCUTS = {
  "new-draft": "Mod+N",
  "close-tab": "Mod+W",
  "close-all-tabs": "Mod+K Mod+W",
  "reopen-tab": "Mod+Shift+T",
  "next-tab": "Ctrl+Tab",
  "previous-tab": "Ctrl+Shift+Tab",
  "project-search": "Mod+Shift+F",
  files: "Mod+Shift+E",
  changes: "Ctrl+Shift+G",
  checks: "Mod+Shift+M",
  extensions: "Mod+Shift+X",
  "debug-panel": "Mod+Shift+D",
  "debug-start": "F5",
  "debug-stop": "Shift+F5",
  "debug-breakpoint": "F9",
  "debug-step-over": "F10",
  "debug-step-in": "F11",
  "debug-step-out": "Shift+F11",
  "go-to-line": "Ctrl+G",
  "definition-back": "Ctrl+-",
  "word-wrap": "Alt+Z",
} as const;

export type CodeShortcut = keyof typeof CODE_SHORTCUTS;
export const codeShortcutEvent = (shortcut: CodeShortcut) => `nodalstudio:code-${shortcut}`;

export function matchesCodeShortcut(event: KeyboardEvent, binding: string, mac: boolean) {
  const parts = binding.toLowerCase().split("+");
  const key = parts.pop();
  const mod = parts.includes("mod");
  const matchesKey = event.key.toLowerCase() === key
    || (mac && event.altKey && key === "z" && event.code === "KeyZ");
  return matchesKey
    && event.metaKey === (mac && mod)
    && event.ctrlKey === (parts.includes("ctrl") || (!mac && mod))
    && event.altKey === parts.includes("alt")
    && event.shiftKey === parts.includes("shift");
}

export function usesAppleKeyboard() {
  return /Mac|iPhone|iPad/i.test(navigator.platform);
}

export function formatCommandShortcut(binding: string, mac = usesAppleKeyboard()): string {
  if (binding.includes(" ")) return binding.trim().split(/\s+/).map((part) => formatCommandShortcut(part, mac)).join(" ");
  const parts = binding.trim().toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return "";
  const modifiers = mac
    ? [parts.includes("ctrl") && "⌃", parts.includes("alt") && "⌥", parts.includes("shift") && "⇧", parts.includes("mod") && "⌘"]
    : [(parts.includes("mod") || parts.includes("ctrl")) && "Ctrl", parts.includes("alt") && "Alt", parts.includes("shift") && "Shift"];
  const keyNames: Record<string, string> = mac
    ? { enter: "↵", escape: "⎋", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" }
    : { enter: "Enter", escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
  return [...modifiers.filter(Boolean), keyNames[key] ?? (key.length === 1 || /^f\d+$/.test(key) ? key.toUpperCase() : key === "tab" ? "Tab" : key)].join(mac ? "" : "+");
}
