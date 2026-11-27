import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasm from "vscode-oniguruma/release/onig.wasm?url";
import { INITIAL, parseRawGrammar, Registry, type IGrammar } from "vscode-textmate";
import type { ExtensionWorkerRequest, ExtensionWorkerResponse, SyntaxToken } from "./code-extension-runtime";

let onigReady: Promise<void> | undefined;
const grammarCache = new Map<string, { registry: Registry; grammar: IGrammar }>();
const maxCachedGrammars = 8;

async function ensureOniguruma() {
  onigReady ??= (async () => {
    const response = await fetch(onigWasm);
    if (!response.ok) throw new Error("Unable to load the TextMate tokenizer.");
    await loadWASM(await response.arrayBuffer());
  })().catch((error: unknown) => {
    onigReady = undefined;
    throw error;
  });
  await onigReady;
}

function tokenStyle(scopes: string[]): SyntaxToken["style"] | undefined {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (/^comment\b/.test(scope)) return "comment";
    if (/^string\b/.test(scope)) return "string";
    if (/^constant\.numeric\b/.test(scope)) return "number";
    if (/^(keyword|storage)\b/.test(scope)) return "keyword";
    if (/^variable\b/.test(scope)) return "variable";
    if (/^(entity\.name\.type|support\.type)\b/.test(scope)) return "type";
  }
}

async function getGrammar(scopeName: string, rawGrammar: string): Promise<IGrammar> {
  const key = `${scopeName}\0${rawGrammar.length}\0${rawGrammar.slice(0, 64)}\0${rawGrammar.slice(-64)}`;
  const cached = grammarCache.get(key);
  if (cached) {
    grammarCache.delete(key);
    grammarCache.set(key, cached);
    return cached.grammar;
  }
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: (scope) => Promise.resolve(scope === scopeName ? parseRawGrammar(rawGrammar, "syntax.json") : null),
  });
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) {
    registry.dispose();
    throw new Error("Unable to load the extension's grammar.");
  }
  if (grammarCache.size >= maxCachedGrammars) {
    const oldest = grammarCache.keys().next().value;
    if (oldest !== undefined) {
      grammarCache.get(oldest)?.registry.dispose();
      grammarCache.delete(oldest);
    }
  }
  grammarCache.set(key, { registry, grammar });
  return grammar;
}

async function syntax(source: Extract<ExtensionWorkerRequest["source"], { capability: "syntax" }>, text: string): Promise<ExtensionWorkerResponse> {
  await ensureOniguruma();
  const grammar = await getGrammar(source.scopeName, source.grammar);
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
}

self.onmessage = ({ data }: MessageEvent<Extract<ExtensionWorkerRequest, { path?: never }>>) => {
  void syntax(data.source, data.text)
    .then((result) => self.postMessage(result))
    .catch((error: unknown) => self.postMessage({ error: String(error).slice(0, 400) } satisfies ExtensionWorkerResponse));
};
