import type { KeyboardEvent } from "react";
import type { CodeReviewChange, CodeReviewDirectory } from "../../platform/code-review";

const basename = (path: string) => path.split("/").at(-1) ?? path;
const folderName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export type TreeEntry = CodeReviewDirectory["entries"][number] & { kind?: CodeReviewChange["kind"] };
export type ChangedPaths = Map<string, Map<string, TreeEntry>>;

export function treeEntryKey(entry: TreeEntry) {
  return entry.directory ? `${entry.path}/` : entry.path;
}

export function indexChangedPaths(changes: readonly CodeReviewChange[]): ChangedPaths {
  const index: ChangedPaths = new Map();
  function add(path: string, directory: boolean, kind: CodeReviewChange["kind"]) {
    const parent = folderName(path);
    let children = index.get(parent);
    if (!children) {
      children = new Map();
      index.set(parent, children);
    }
    const entry = { path, name: basename(path), directory, kind };
    const key = treeEntryKey(entry);
    const previous = children.get(key);
    if (!previous) {
      children.set(key, entry);
      return true;
    }
    if (!directory || previous.kind === kind || previous.kind === "conflict") return false;
    // Mixed changes use the modified color, and conflicts take precedence.
    const merged = kind === "conflict" ? kind : "modified";
    if (previous.kind === merged) return false;
    previous.kind = merged;
    return true;
  }
  for (const { path, kind } of changes) {
    add(path, false, kind);
    const folderKind = kind === "renamed" ? "modified" : kind;
    for (let parent = folderName(path); parent; parent = folderName(parent)) {
      if (!add(parent, true, folderKind)) break;
    }
  }
  return index;
}

export function navigateFiles(event: KeyboardEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute("data-code-row")) return;
  const current = event.target;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-code-row]")];
  const index = rows.indexOf(current);
  let target: HTMLButtonElement | undefined | null;
  const expanded = current.getAttribute("aria-expanded");
  switch (event.key) {
    case "ArrowDown": target = rows[index + 1]; break;
    case "ArrowUp": target = rows[index - 1]; break;
    case "Home": target = rows[0]; break;
    case "End": target = rows.at(-1); break;
    case "ArrowRight":
      if (expanded === "false") current.click();
      if (expanded === "true") target = current.parentElement?.querySelector(":scope > ul > li > button[data-code-row]");
      break;
    case "ArrowLeft":
      if (expanded === "true") current.click();
      else target = current.parentElement?.parentElement?.closest("li")?.querySelector(":scope > button[data-code-row]");
      break;
    default: return;
  }
  event.preventDefault();
  target?.focus();
}
