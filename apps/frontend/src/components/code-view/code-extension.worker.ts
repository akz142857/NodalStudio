import quickjs from "@jitl/quickjs-wasmfile-release-sync";
import quickjsWasm from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasm from "vscode-oniguruma/release/onig.wasm?url";
import { INITIAL, parseRawGrammar, Registry } from "vscode-textmate";
import { createVsixDocumentHost, installVsixWebPrimitives } from "./vsix-document-host";
import type { CodeDefinitionPosition } from "../../platform/code-review";
import type { ExtensionDiagnostic, ExtensionWorkerRequest, ExtensionWorkerResponse, SyntaxToken } from "./code-extension-runtime";

function position(value: unknown): CodeDefinitionPosition | undefined {
  if (!value || typeof value !== "object" || !("line" in value) || !("character" in value)) return;
  const { line, character } = value;
  if (typeof line === "number" && Number.isSafeInteger(line) && line >= 0
    && typeof character === "number" && Number.isSafeInteger(character) && character >= 0) return { line, character };
}

function diagnosticReport(serialized: string, limit: number): ExtensionWorkerResponse {
  if (serialized.length > 5 * 1024 * 1024) throw new Error("The diagnostic report is too large.");
  const report = JSON.parse(serialized) as { total?: unknown; findings?: unknown };
  if (!report || typeof report.total !== "number" || !Number.isSafeInteger(report.total)
    || !Array.isArray(report.findings) || report.total < report.findings.length || report.findings.length > limit) {
    throw new Error("The extension returned an invalid diagnostic report.");
  }
  const findings = report.findings.map((finding: unknown): ExtensionDiagnostic => {
    if (!finding || typeof finding !== "object") throw new Error("The extension returned an invalid diagnostic.");
    const { message, rule, severity, start, end } = finding as Record<string, unknown>;
    if (typeof message !== "string" || typeof rule !== "string" || (severity !== "error" && severity !== "warning")) {
      throw new Error("The extension returned an invalid diagnostic.");
    }
    return { message: message.slice(0, 2_000), rule: rule.slice(0, 200), severity, start: position(start), end: position(end) };
  });
  return { total: report.total, findings };
}

async function diagnostics(request: Extract<ExtensionWorkerRequest, { path: string }>): Promise<ExtensionWorkerResponse> {
  const { source, path, text, config, limit } = request;
  const core = await newQuickJSWASMModuleFromVariant(newVariant(quickjs, { wasmLocation: quickjsWasm }));
  const runtime = core.newRuntime({
    memoryLimitBytes: 64 * 1024 * 1024, maxStackSizeBytes: 2 * 1024 * 1024,
    interruptHandler: shouldInterruptAfterDeadline(Date.now() + 4_500),
  });
  try {
    const vm = runtime.newContext();
    try {
      installVsixWebPrimitives(vm);
      const evaluate = (script: string) => {
        const handle = vm.unwrapResult(vm.evalCode(script, "vsix.js", { type: "global" }));
        try { return vm.dump(handle) as unknown; }
        finally { handle.dispose(); }
      };
      evaluate("(" + createVsixDocumentHost.toString() + ")(" + JSON.stringify({ path, text, config, limit }) + ")");
      vm.unwrapResult(vm.evalCode(source.script, "extension.js", { type: "global" })).dispose();
      evaluate("__vsixActivate()");
      for (let step = 0; step < 128; step += 1) {
        vm.unwrapResult(runtime.executePendingJobs(2_000));
        const result = evaluate("__vsixResult()");
        if (typeof result === "string") return diagnosticReport(result, limit);
        if (!evaluate("__vsixTick()")) break;
      }
      throw new Error("The extension did not publish diagnostics for this document.");
    } finally {
      vm.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

function tokenStyle(scopes: string[]): SyntaxToken["style"] | undefined {
  for (const scope of [...scopes].reverse()) {
    if (/^comment\b/.test(scope)) return "comment";
    if (/^string\b/.test(scope)) return "string";
    if (/^constant\.numeric\b/.test(scope)) return "number";
    if (/^(keyword|storage)\b/.test(scope)) return "keyword";
    if (/^variable\b/.test(scope)) return "variable";
    if (/^(entity\.name\.type|support\.type)\b/.test(scope)) return "type";
  }
}

async function syntax(source: Extract<ExtensionWorkerRequest["source"], { capability: "syntax" }>, text: string): Promise<ExtensionWorkerResponse> {
  const response = await fetch(onigWasm);
  if (!response.ok) throw new Error("Unable to load the TextMate tokenizer.");
  await loadWASM(await response.arrayBuffer());
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: (scope) => Promise.resolve(scope === source.scopeName ? parseRawGrammar(source.grammar, "syntax.json") : null),
  });
  try {
    const grammar = await registry.loadGrammar(source.scopeName);
    if (!grammar) throw new Error("Unable to load the extension's grammar.");
    let state = INITIAL;
    let offset = 0;
    const tokens: SyntaxToken[] = [];
    const deadline = performance.now() + 3_000;
    for (const line of text.split("\n")) {
      const parsed = grammar.tokenizeLine(line, state, 50);
      if (parsed.stoppedEarly || performance.now() > deadline) throw new Error("The extension grammar took too long.");
      state = parsed.ruleStack;
      for (const token of parsed.tokens) {
        const style = tokenStyle(token.scopes);
        const end = Math.min(token.endIndex, line.length);
        if (style && end > token.startIndex) tokens.push({ from: offset + token.startIndex, to: offset + end, style });
        if (tokens.length >= 30_000) return { tokens };
      }
      offset += line.length + 1;
    }
    return { tokens };
  } finally {
    registry.dispose();
  }
}

self.onmessage = ({ data }: MessageEvent<ExtensionWorkerRequest>) => {
  void (data.path === undefined
    ? syntax(data.source, data.text) : diagnostics(data))
    .then((result) => self.postMessage(result))
    .catch((error: unknown) => self.postMessage({ error: String(error).slice(0, 400) } satisfies ExtensionWorkerResponse));
};
