import quickjs from "@jitl/quickjs-wasmfile-release-sync";
import quickjsWasm from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { createVsixDocumentHost, installVsixWebPrimitives } from "./vsix-document-host";
import type { CodeDefinitionPosition } from "../../platform/code-review";
import type { ExtensionDiagnostic, ExtensionWorkerRequest, ExtensionWorkerResponse } from "./code-extension-runtime";

let quickjsModule: Promise<QuickJSWASMModule> | undefined;

function ensureQuickJs(): Promise<QuickJSWASMModule> {
  quickjsModule ??= newQuickJSWASMModuleFromVariant(newVariant(quickjs, { wasmLocation: quickjsWasm })).catch((error: unknown) => {
    quickjsModule = undefined;
    throw error;
  });
  return quickjsModule;
}

function position(value: unknown): CodeDefinitionPosition | undefined {
  if (!value || typeof value !== "object" || !("line" in value) || !("character" in value)) return;
  const { line, character } = value;
  if (typeof line === "number" && Number.isSafeInteger(line) && line >= 0
    && typeof character === "number" && Number.isSafeInteger(character) && character >= 0) return { line, character };
}

export function validateDiagnosticReport(serialized: string, limit: number): Extract<ExtensionWorkerResponse, { findings: ExtensionDiagnostic[] }> {
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
  const core = await ensureQuickJs();
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
        if (typeof result === "string") return validateDiagnosticReport(result, limit);
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

self.onmessage = ({ data }: MessageEvent<Extract<ExtensionWorkerRequest, { path: string }>>) => {
  void diagnostics(data)
    .then((result) => self.postMessage(result))
    .catch((error: unknown) => self.postMessage({ error: String(error).slice(0, 400) } satisfies ExtensionWorkerResponse));
};
