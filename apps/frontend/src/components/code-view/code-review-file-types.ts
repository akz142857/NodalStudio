const fileTypes: Record<string, string> = {
  go: "Go", java: "Java", php: "PHP", phtml: "PHP", py: "Python", pyw: "Python", rs: "Rust", js: "JavaScript",
  jsx: "JSX", ts: "TypeScript", tsx: "TSX", json: "JSON", md: "Markdown", yml: "YAML", yaml: "YAML", sql: "SQL",
  c: "C", cc: "C++", cpp: "C++", cxx: "C++", "c++": "C++", h: "C/C++", hh: "C++", hpp: "C++", hxx: "C++",
  cs: "C#", swift: "Swift", swiftinterface: "Swift", pyi: "Python", cjs: "JavaScript", mjs: "JavaScript",
  cts: "TypeScript", mts: "TypeScript", ixx: "C++",
};

const nonProgrammingFiles = new Set(["json", "md", "yml", "yaml", "sql"]);

export const fileExtension = (path: string) => /\.([^./]+)$/.exec(path)?.[1].toLowerCase() ?? "";

export function codeFileType(path: string) {
  const extension = fileExtension(path);
  return Object.hasOwn(fileTypes, extension) ? fileTypes[extension] : undefined;
}

export function supportsCodeNavigation(path: string) {
  const extension = fileExtension(path);
  return Object.hasOwn(fileTypes, extension) && !nonProgrammingFiles.has(extension);
}
