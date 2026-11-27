import type { QuickJSContext } from "quickjs-emscripten-core";

export function installVsixWebPrimitives(vm: QuickJSContext) {
  const segmenter = new Intl.Segmenter();
  const primitive = vm.newFunction("__vsixPrimitive", (kind, value) => {
    const input = vm.getString(value);
    if (input.length > 512 * 1024) throw new Error("Extension input is too large.");
    switch (vm.getString(kind)) {
      case "url":
        try { return vm.newString(new URL(input).href); }
        catch { throw new TypeError("Invalid URL."); }
      case "segments":
        return vm.newString(JSON.stringify([...segmenter.segment(input)].map(({ segment, index }) => ({ segment, index }))));
      default: throw new Error("Unsupported Web API.");
    }
  });
  try { vm.setProp(vm.global, "__vsixPrimitive", primitive); }
  finally { primitive.dispose(); }
}

// This function is serialized into QuickJS. Keep every value in the guest context.
export function createVsixDocumentHost(input: {
  path: string;
  text: string;
  config: unknown;
  limit: number;
}) {
  const webPrimitive = (globalThis as unknown as { __vsixPrimitive: (kind: string, input: string) => string }).__vsixPrimitive;
  class URL {
    readonly href: string;
    constructor(input: string) { this.href = webPrimitive("url", String(input)); }
    toString() { return this.href; }
    static canParse(input: string) {
      try { new URL(input); return true; }
      catch { return false; }
    }
  }
  class Segmenter {
    segment(input: string) { return JSON.parse(webPrimitive("segments", String(input))) as { segment: string; index: number }[]; }
  }
  type Listener<T> = (value: T) => void;
  class Event<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }

  class Position {
    constructor(readonly line: number, readonly character: number) {}
    with(line = this.line, character = this.character) { return new Position(line, character); }
  }

  class Range {
    constructor(readonly start: Position, readonly end: Position) {}
    with(start = this.start, end = this.end) { return new Range(start, end); }
  }

  class Diagnostic {
    code?: string | { value: string | number };
    constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
  }

  class Uri {
    readonly authority = "";
    constructor(readonly scheme: string, readonly path: string, private readonly raw?: string) {}
    get fsPath() { return this.path; }
    toString() { return this.raw ?? this.scheme + ":" + this.path; }
    with(changes: { scheme?: string; path?: string }) { return new Uri(changes.scheme ?? this.scheme, changes.path ?? this.path); }
    static parse(value: string) {
      const delimiter = value.indexOf(":");
      return new Uri(value.slice(0, delimiter), value.slice(delimiter + 1), value);
    }
    static joinPath(base: Uri, ...more: string[]) {
      const result: string[] = [];
      for (const name of [base.path, ...more].join("/").split("/")) {
        if (name === "..") result.pop();
        else if (name && name !== ".") result.push(name);
      }
      return new Uri(base.scheme, "/" + result.join("/"));
    }
  }

  class CodeActionKind {
    static readonly QuickFix = new CodeActionKind("quickfix");
    static readonly SourceFixAll = new CodeActionKind("source.fixAll");
    constructor(readonly value: string) {}
    append(value: string) { return new CodeActionKind(this.value + "." + value); }
  }

  class Decoder {
    decode(bytes = new Uint8Array()) {
      return decodeURIComponent(Array.from(bytes, (byte) => "%" + byte.toString(16).padStart(2, "0")).join(""));
    }
  }

  class Encoder {
    encode(text: string) {
      return Uint8Array.from(unescape(encodeURIComponent(text)), (char) => char.charCodeAt(0));
    }
  }

  const lines = input.text.split("\n");
  const folder = { uri: new Uri("file", "/workspace"), index: 0, name: "workspace" };
  const relative = input.path.split("/").filter(Boolean).filter((name) => name !== "." && name !== "..").join("/");
  const uri = new Uri("file", folder.uri.path + "/" + relative);
  const document = {
    uri, languageId: "markdown", fileName: input.path, version: 1, lineCount: lines.length, isUntitled: false,
    getText: () => input.text,
    lineAt: (line: number) => ({
      lineNumber: line, text: lines[line], range: new Range(new Position(line, 0), new Position(line, lines[line].length)),
    }),
  };
  const didOpen = new Event<typeof document>();
  const editor = { document, selection: { active: new Position(0, 0) } };
  const inertRegistration = () => ({ dispose: () => undefined });
  const fileType = (target: Uri) => target.scheme !== "file" ? 0 : target.path === uri.path ? 1
    : uri.path.startsWith(target.path.replace(/\/$/, "") + "/") ? 2 : 0;
  const missingFile = () => Object.assign(new Error("Virtual workspace file not found."), { code: "ENOENT" });
  const ignore = () => undefined;
  const settings: Record<string, unknown> = { focusMode: false, config: input.config };
  let result: string | undefined;
  let error: string | undefined;
  let output: string | undefined;
  const source = { exports: {} as { activate?: (context: { subscriptions: unknown[] }) => unknown } };

  const api = {
    CodeActionKind, Diagnostic, EventEmitter: Event, Position, Range, Uri,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    TaskScope: { Workspace: 2 },
    CustomExecution: class {},
    Task: class {},
    RelativePattern: class {},
    commands: { registerCommand: inertRegistration },
    tasks: { registerTaskProvider: inertRegistration },
    extensions: { getExtension: ignore },
    window: {
      activeTextEditor: editor, visibleTextEditors: [editor],
      createOutputChannel: () => ({
        append: ignore,
        appendLine: (message: string) => { output = message; },
        dispose: ignore,
        show: () => { if (output?.includes(" ERROR:")) error = output.slice(0, 400); },
        clear: ignore,
      }),
      onDidChangeActiveTextEditor: inertRegistration,
      onDidChangeTextEditorSelection: inertRegistration,
      onDidChangeVisibleTextEditors: inertRegistration,
    },
    workspace: {
      isTrusted: false,
      textDocuments: [document],
      workspaceFolders: [folder],
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => settings[key] ?? fallback,
        has: (key: string) => settings[key] !== undefined,
      }),
      getWorkspaceFolder: (target: Uri) => target.scheme === "file" && target.path.startsWith(folder.uri.path + "/") ? folder : undefined,
      createFileSystemWatcher: () => ({
        onDidCreate: inertRegistration, onDidChange: inertRegistration, onDidDelete: inertRegistration, dispose: ignore,
      }),
      fs: {
        stat: (target: Uri) => {
          const type = fileType(target);
          if (!type) return Promise.reject(missingFile());
          return Promise.resolve({ type, size: type === 1 ? input.text.length : 0, ctime: 0, mtime: 0 });
        },
        readFile: (target: Uri) => {
          if (fileType(target) !== 1) return Promise.reject(missingFile());
          return Promise.resolve().then(() => new Encoder().encode(input.text));
        },
        readDirectory: (target: Uri) => {
          if (fileType(target) !== 2) return Promise.reject(missingFile());
          const children = uri.path.slice(target.path.replace(/\/$/, "").length + 1).split("/");
          return Promise.resolve([[children[0], children.length === 1 ? 1 : 2]]);
        },
      },
      onDidOpenTextDocument: didOpen.event,
      onDidChangeTextDocument: inertRegistration,
      onDidSaveTextDocument: inertRegistration,
      onDidCloseTextDocument: inertRegistration,
      onDidChangeConfiguration: inertRegistration,
      onDidGrantWorkspaceTrust: inertRegistration,
      onDidChangeWorkspaceFolders: inertRegistration,
    },
    languages: {
      registerCodeActionsProvider: inertRegistration,
      registerDocumentRangeFormattingEditProvider: inertRegistration,
      createDiagnosticCollection: () => ({
        clear: ignore, delete: ignore, dispose: ignore,
        set: (target: Uri, diagnostics: Diagnostic[]) => {
          if (target.toString() !== uri.toString() || !Array.isArray(diagnostics)) return;
          const findings = diagnostics.slice(0, input.limit).map((item) => ({
            rule: String(typeof item.code === "object" ? item.code?.value ?? "" : item.code ?? "").slice(0, 200),
            message: typeof item.message === "string" ? item.message.slice(0, 2_000) : "",
            severity: item.severity === 0 ? "error" : "warning",
            start: item.range?.start,
            end: item.range?.end,
          }));
          result = JSON.stringify({ findings, total: diagnostics.length });
        },
      }),
    },
  };

  let timerId = 0;
  let clock = 0;
  const timers = new Map<number, { callback: () => void; when: number }>();
  Object.assign(globalThis, {
    require: (name: string) => {
      if (name !== "vscode") throw new Error("Unsupported module: " + name);
      return api;
    },
    module: source,
    exports: source.exports,
    TextDecoder: Decoder,
    TextEncoder: Encoder,
    URL,
    Intl: { Segmenter },
    console: { log: ignore, warn: ignore, error: ignore },
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++timerId;
      timers.set(id, { callback, when: clock + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    __vsixActivate: () => {
      if (typeof source.exports.activate !== "function") throw new Error("Missing activate function");
      void Promise.resolve(source.exports.activate({ subscriptions: [] }))
        .then(() => didOpen.fire(document))
        .catch((reason: unknown) => { error = String(reason); });
    },
    __vsixResult: () => {
      if (error) throw new Error(error);
      return result;
    },
    __vsixTick: () => {
      let next: [number, { callback: () => void; when: number }] | undefined;
      for (const timer of timers) if (!next || timer[1].when < next[1].when) next = timer;
      if (!next) return false;
      timers.delete(next[0]);
      clock = next[1].when;
      next[1].callback();
      return true;
    },
  });
}
