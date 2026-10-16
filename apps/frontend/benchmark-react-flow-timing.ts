import ts from "typescript";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Instrument the installed dependency in diagnostic bundles only; never edit
 * node_modules or infer browser paint from JavaScript frame gaps. */
export function instrumentReactFlow(code: string, workModule = resolve("src/graph/canvas-work.ts")) {
  const source = ts.createSourceFile("flow.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: { at: number; text: string }[] = [];
  const found = new Set<string>();
  const wrap = (node: ts.Node, kind: string) => {
    edits.push({ at: node.getStart(source), text: `__canvasWork(${JSON.stringify(kind)}, () => (` });
    edits.push({ at: node.end, text: "))" }); found.add(kind);
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) {
      const name = node.name.text, arg = node.initializer.parameters[0]?.name;
      if ((name === "setNodes" && arg && ts.isIdentifier(arg) && arg.text === "nodes") || (name === "setEdges" && arg && ts.isIdentifier(arg) && arg.text === "edges")) {
        const kind = `react-flow:${name}`, body = node.initializer.body;
        edits.push({ at: body.getStart(source) + 1, text: `const __end = __canvasStart(${JSON.stringify(kind)}); try {` });
        edits.push({ at: body.end - 1, text: "} finally { __end(); }" }); found.add(kind);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "updateConnectionLookup") wrap(node, "react-flow:connection-lookup");
      if (node.expression.text === "adoptUserNodes") wrap(node, "react-flow:adopt-nodes");
      if (node.expression.text === "set" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) && node.arguments[0].properties.some((prop) => ts.isShorthandPropertyAssignment(prop) && prop.name.text === "edges")) wrap(node, "react-flow:publish-edges");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const kind of ["react-flow:setNodes", "react-flow:setEdges", "react-flow:connection-lookup", "react-flow:adopt-nodes", "react-flow:publish-edges"]) {
    if (!found.has(kind)) throw new Error(`Installed React Flow timing target changed: ${kind}`);
  }
  for (const edit of edits.sort((a, b) => b.at - a.at)) code = code.slice(0, edit.at) + edit.text + code.slice(edit.at);
  return `import { startCanvasWork as __canvasStart, withCanvasWork as __canvasWork } from ${JSON.stringify(workModule)};\n${code}`;
}
export function reactFlowTimingPlugin(): Plugin {
  let root = "";
  return { name: "benchmark-react-flow-timing", enforce: "pre", configResolved(config) { root = config.root; }, transform(code, id) {
    if (/@xyflow\/react\/dist\/esm\/index\.(?:m?js)(?:\?|$)/.test(id.split("\\").join("/"))) return { code: instrumentReactFlow(code, resolve(root, "src/graph/canvas-work.ts")), map: null };
  } };
}
