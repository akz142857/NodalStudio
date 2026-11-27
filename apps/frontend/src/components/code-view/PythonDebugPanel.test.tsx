import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../../i18n";
import type { PythonDebugEvent, PythonDebugPlatform } from "../../platform/code-review";
import { PythonDebugPanel } from "./PythonDebugPanel";
import { usePythonDebug } from "./use-python-debug";

function Harness({ api, path = "main.py" }: { api: PythonDebugPlatform; path?: string }) {
  const debug = usePythonDebug(api, "project-1");
  return <>
    <button type="button" onClick={() => debug.toggle(path, 7)}>Toggle line 7</button>
    <PythonDebugPanel api={api} projectId="project-1" path={path} ready offline={false}
      debug={debug} onExtensions={vi.fn()} onFrame={vi.fn()} />
  </>;
}

function renderHarness(api: PythonDebugPlatform) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper() {
    return <I18nProvider value={useI18n("en")}>
      <QueryClientProvider client={client}><Harness api={api} /></QueryClientProvider>
    </I18nProvider>;
  }
  return render(<Wrapper />);
}

it("exposes discovered interpreters, preserves launch inputs across runs, and queues breakpoints during startup", async () => {
  let resolveStart!: () => void;
  let emit!: (event: PythonDebugEvent) => void;
  const start = vi.fn().mockImplementation((_projectId, _id, _input, receive: (event: PythonDebugEvent) => void) => {
    emit = receive;
    return new Promise<void>((resolve) => { resolveStart = resolve; });
  });
  const control = vi.fn().mockResolvedValue(undefined);
  const api: PythonDebugPlatform = {
    prepare: vi.fn().mockResolvedValue({
      root: "/workspace/demo",
      program: "/workspace/demo/main.py",
      interpreters: ["/workspace/demo/.venv/bin/python", "/usr/bin/python3"],
    }),
    start,
    control,
    stop: vi.fn().mockResolvedValue(undefined),
  };

  renderHarness(api);
  const interpreter = await screen.findByLabelText("Python interpreter");
  expect(interpreter).toHaveValue("/workspace/demo/.venv/bin/python");
  const listId = interpreter.getAttribute("list");
  expect(listId).toBeTruthy();
  const options = Array.from(document.querySelectorAll(`#${CSS.escape(listId!)} option`)).map((node) => node.getAttribute("value"));
  expect(options).toEqual(["/workspace/demo/.venv/bin/python", "/usr/bin/python3"]);

  fireEvent.change(interpreter, { target: { value: "/opt/homebrew/bin/python3" } });
  fireEvent.change(screen.getByLabelText(/^Working folder/), { target: { value: "src" } });
  fireEvent.change(screen.getByLabelText("Arguments, one per line"), { target: { value: "--count\n6" } });
  fireEvent.click(screen.getByRole("button", { name: "Start Debugging" }));

  // Toggling a breakpoint before start resolves should queue instead of firing control prematurely.
  fireEvent.click(screen.getByRole("button", { name: "Toggle line 7" }));
  expect(control).not.toHaveBeenCalled();

  await act(async () => { resolveStart(); await Promise.resolve(); });
  await waitFor(() => expect(control).toHaveBeenCalledWith("project-1", expect.any(String), { kind: "breakpoints", path: "main.py", lines: [7] }));

  act(() => { emit({ state: "finished", error: null }); });
  expect(await screen.findByLabelText("Python interpreter")).toHaveValue("/opt/homebrew/bin/python3");
  expect(screen.getByLabelText(/^Working folder/)).toHaveValue("src");
  expect(screen.getByLabelText("Arguments, one per line")).toHaveValue("--count\n6");
});
