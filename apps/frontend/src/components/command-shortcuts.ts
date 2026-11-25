export const WORKSPACE_SHORTCUTS = [
  ["navigation.openModel", "Mod+1"],
  ["navigation.openOntology", "Mod+2"],
  ["navigation.openDatabase", "Mod+3"],
  ["navigation.openQuery", "Mod+4"],
] as const;
export const QUERY_SAVE_SHORTCUT = "Mod+S";

export function usesAppleKeyboard() {
  return /Mac|iPhone|iPad/i.test(navigator.platform);
}

export function formatCommandShortcut(binding: string, mac = usesAppleKeyboard()) {
  const parts = binding.trim().toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return "";
  const modifiers = mac
    ? [parts.includes("alt") && "⌥", parts.includes("shift") && "⇧", parts.includes("mod") && "⌘"]
    : [parts.includes("mod") && "Ctrl", parts.includes("alt") && "Alt", parts.includes("shift") && "Shift"];
  const keyNames: Record<string, string> = mac
    ? { enter: "↵", escape: "⎋", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" }
    : { enter: "Enter", escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
  return [...modifiers.filter(Boolean), keyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key)].join(mac ? "" : "+");
}
