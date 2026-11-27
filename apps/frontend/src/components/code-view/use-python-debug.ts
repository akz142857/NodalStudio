import { useEffect, useRef, useState } from "react";
import type { PythonDebugAction, PythonDebugEvent, PythonDebugPlatform } from "../../platform/code-review";

type Pause = Extract<PythonDebugEvent, { state: "paused" }>;
type Launch = Parameters<PythonDebugPlatform["start"]>[2];

export function usePythonDebug(api: PythonDebugPlatform | undefined, projectId: string) {
  const session = useRef<string | undefined>(undefined);
  const [mode, setMode] = useState<"idle" | "starting" | "running" | "paused" | "stopping" | "finished">("idle");
  const [paused, setPaused] = useState<Pause>();
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  const [verified, setVerified] = useState<Record<string, number[]>>({});

  useEffect(() => () => {
    const id = session.current;
    session.current = undefined;
    if (id) void api?.stop(projectId, id).catch(() => {});
  }, [api, projectId]);

  function receive(id: string, event: PythonDebugEvent) {
    if (session.current !== id) return;
    switch (event.state) {
      case "breakpoints": setVerified((previous) => ({ ...previous, [event.path]: event.lines })); break;
      case "running": setPaused(undefined); setBusy(false); setMode("running"); break;
      case "paused": setPaused(event); setBusy(false); setMode("paused"); break;
      case "output": setOutput((previous) => (previous + event.text).slice(-32_768)); break;
      case "finished":
        session.current = undefined;
        setPaused(undefined);
        setBusy(false);
        setMode("finished");
        if (event.error) setError(event.error);
        break;
    }
  }

  function start(input: Omit<Launch, "breakpoints">) {
    if (!api || session.current) return;
    const id = crypto.randomUUID();
    session.current = id;
    setError(undefined);
    setOutput("");
    setPaused(undefined);
    setVerified({});
    setMode("starting");
    void api.start(projectId, id, { ...input, breakpoints }, (event) => receive(id, event))
      .then(() => {
        // An unmount can request Stop before the native command reserves the session.
        if (session.current !== id) void api.stop(projectId, id).catch(() => {});
      }, (failure: unknown) => receive(id, { state: "finished", error: String(failure) }));
  }

  function stop() {
    const id = session.current;
    if (!api || !id) return;
    setMode("stopping");
    void api.stop(projectId, id).catch((failure: unknown) => receive(id, { state: "finished", error: String(failure) }));
  }

  function control(action: PythonDebugAction) {
    const id = session.current;
    if (!api || !id) return;
    if (action.kind !== "breakpoints") setBusy(true);
    void api.control(projectId, id, action).catch((failure: unknown) => {
      if (session.current !== id) return;
      setBusy(false);
      setError(String(failure));
    });
  }

  function toggle(path: string, line: number) {
    const previous = breakpoints[path] ?? [];
    const exists = previous.includes(line);
    if (!exists && Object.values(breakpoints).reduce((total, lines) => total + lines.length, 0) >= 256) return;
    const lines = exists ? previous.filter((mark) => mark !== line) : [...previous, line].sort((a, b) => a - b);
    const next = { ...breakpoints };
    if (lines.length) next[path] = lines;
    else delete next[path];
    setBreakpoints(next);
    setVerified((current) => ({ ...current, [path]: (current[path] ?? []).filter((mark) => mark !== line) }));
    if (mode !== "stopping") control({ kind: "breakpoints", path, lines });
  }

  return { mode, paused, output, error, busy, breakpoints, verified, start, stop, control, toggle };
}

export type PythonDebugState = ReturnType<typeof usePythonDebug>;
