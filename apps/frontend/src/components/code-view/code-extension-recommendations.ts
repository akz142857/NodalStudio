import type { CodeExtension, CodeSyntaxSource } from "../../platform/code-review";
import { matchesCodeSyntaxFile } from "./code-review-file-types";

type MarketplaceRecommendation = Pick<CodeSyntaxSource, "id" | "name" | "extensions" | "filenames" | "filenamePatterns">;

const marketplace: readonly MarketplaceRecommendation[] = [
  { id: "ms-python.debugpy", name: "Python Debugger", extensions: [".py", ".pyw"] },
  { id: "dbaeumer.vscode-eslint", name: "ESLint", extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"] },
  { id: "davidanson.vscode-markdownlint", name: "markdownlint", extensions: [".md", ".markdown"] },
];

type Recommendation = (CodeSyntaxSource & { kind: "syntax" } | MarketplaceRecommendation & { kind: "market" }) & { count: number };

export function recommendCodeExtensions(
  paths: readonly string[],
  syntax: readonly CodeSyntaxSource[],
  installed: readonly CodeExtension[],
  includeMarket: boolean,
): Recommendation[] {
  const filenames = paths.map((path) => path.slice(path.lastIndexOf("/") + 1));
  const enabled = installed.filter((item) => item.enabled);
  const enabledIds = new Set(enabled.map((item) => item.id));
  const activeSyntax = enabled.flatMap((item) => item.capability === "syntax" ? item.languages : []);
  const unhighlighted = activeSyntax.length
    ? filenames.filter((name) => !activeSyntax.some((language) => matchesCodeSyntaxFile(name, language)))
    : filenames;
  const installedIds = new Set(installed.map((item) => item.id));
  const candidates = [
    ...syntax.filter((item) => !enabledIds.has(item.id)).map((item) => ({ ...item, kind: "syntax" as const })),
    ...(includeMarket ? marketplace.filter((item) => !installedIds.has(item.id)).map((item) => ({ ...item, kind: "market" as const })) : []),
  ];
  return candidates.map((item) => ({
    ...item,
    count: (item.kind === "syntax" ? unhighlighted : filenames).reduce((total, name) => total + Number(matchesCodeSyntaxFile(name, item)), 0),
  })).filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en"))
    .slice(0, 3);
}
