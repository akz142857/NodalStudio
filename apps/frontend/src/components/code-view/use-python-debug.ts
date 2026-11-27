import { useCallback, useEffect, useRef, useState } from "react";
import type { PythonDebugAction, PythonDebugEvent, PythonDebugPlatform } from "../../platform/code-review";

type Pause = Extract<PythonDebugEvent, { state: "paused" }>;
type Launch = Parameters<PythonDebugPlatform["start"]>[2];

export function usePythonDebug(api: PythonDebugPlatform | undefined, projectId: string) {
  const session = useRef<string | undefined>(undefined);
  const startedSession = useRef<string | undefined>(undefined);
  const pendingBreakpoints = useRef<Map<string, number[]>>(new Map());
  const [mode, setMode] = useState<"idle" | "starting" | "running" | "paused" | "stopping" | "finished">("idle");
  const modeRef = useRef(mode);
  const [paused, setPaused] = useState<Pause>();
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  const breakpointsRef = useRef(breakpoints);
  const [verified, setVerified] = useState<Record<string, number[]>>({});

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { breakpointsRef.current = breakpoints; }, [breakpoints]);

  useEffect(() => () => {
    const id = session.current;
    session.current = undefined;
    startedSession.current = undefined;
    pendingBreakpoints.current.clear();
    if (id) void api?.stop(projectId, id).catch(() => {});
  }, [api, projectId]);

  const receive = useCallback((id: string, event: PythonDebugEvent) => {
    if (session.current !== id) return;
    switch (event.state) {
      case "breakpoints": setVerified((previous) => ({ ...previous, [event.path]: event.lines })); break;
      case "running": setPaused(undefined); setBusy(false); setMode("running"); break;
      case "paused": setPaused(event); setBusy(false); setMode("paused"); break;
      case "output": setOutput((previous) => (previous + event.text).slice(-32_768)); break;
      case "finished":
        session.current = undefined;
        startedSession.current = undefined;
        pendingBreakpoints.current.clear();
        setPaused(undefined);
        setBusy(false);
        setMode("finished");
        if (event.error) setError(event.error);
        break;
    }
  }, []);

  const control = useCallback((action: PythonDebugAction) => {
    const id = session.current;
    if (!api || !id) return;
    if (startedSession.current !== id) {
      if (action.kind === "breakpoints") pendingBreakpoints.current.set(action.path, action.lines);
      return;
    }
    if (action.kind !== "breakpoints") setBusy(true);
    void api.control(projectId, id, action).catch((failure: unknown) => {
      if (session.current !== id) return;
      setBusy(false);
      setError(String(failure));
    });
  }, [api, projectId]);

  const start = useCallback((input: Omit<Launch, "breakpoints">) => {
    if (!api || session.current) return;
    const id = crypto.randomUUID();
    session.current = id;
    startedSession.current = undefined;
    pendingBreakpoints.current.clear();
    setError(undefined);
    setOutput("");
    setPaused(undefined);
    setVerified({});
    setMode("starting");
    void api.start(projectId, id, { ...input, breakpoints: breakpointsRef.current }, (event) => receive(id, event))
      .then(() => {
        // An unmount can request Stop before the native command reserves the session.
        if (session.current !== id) {
          void api.stop(projectId, id).catch(() => {});
          return;
        }
        startedSession.current = id;
        const queued = Array.from(pendingBreakpoints.current.entries());
        pendingBreakpoints.current.clear();
        for (const [path, lines] of queued) {
          void api.control(projectId, id, { kind: "breakpoints", path, lines }).catch(() => {});
        }
      }, (failure: unknown) => receive(id, { state: "finished", error: String(failure) }));
  }, [api, projectId, receive]);

  const stop = useCallback(() => {
    const id = session.current;
    if (!api || !id) return;
    setMode("stopping");
    void api.stop(projectId, id).catch((failure: unknown) => receive(id, { state: "finished", error: String(failure) }));
  }, [api, projectId, receive]);

  const toggle = useCallback((path: string, line: number) => {
    const currentBreakpoints = breakpointsRef.current;
    const previous = currentBreakpoints[path] ?? [];
    const exists = previous.includes(line);
    if (!exists && Object.values(currentBreakpoints).reduce((total, lines) => total + lines.length, 0) >= 256) return;
    const lines = exists ? previous.filter((mark) => mark !== line) : [...previous, line].sort((a, b) => a - b);
    const next = { ...currentBreakpoints };
    if (lines.length) next[path] = lines;
    else delete next[path];
    breakpointsRef.current = next;
    setBreakpoints(next);
    setVerified((current) => ({ ...current, [path]: (current[path] ?? []).filter((mark) => mark !== line) }));
    if (modeRef.current !== "stopping") control({ kind: "breakpoints", path, lines });
  }, [control]);

  return { mode, paused, output, error, busy, breakpoints, verified, start, stop, control, toggle };
}

export type PythonDebugState = ReturnType<typeof usePythonDebug>;
