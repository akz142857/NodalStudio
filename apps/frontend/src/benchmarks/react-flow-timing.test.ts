import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { instrumentReactFlow } from "../../benchmark-react-flow-timing";
it("instruments the installed store actions without losing valid JavaScript or silently missing a timing target", () => {
  const original = readFileSync(resolve("node_modules/@xyflow/react/dist/esm/index.mjs"), "utf8");
  const code = instrumentReactFlow(original);
  const result = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  expect(result.diagnostics).toHaveLength(0);
  expect(code).toContain('__canvasStart("react-flow:setNodes")');
  expect(code).toContain('__canvasWork("react-flow:publish-edges"');
  expect(() => instrumentReactFlow("export const renamed = true;")).toThrow("timing target changed");
});
