import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { OperationFeedbackState } from "./OperationFeedback";

interface OperationMessages<T> { running: string; success: (result: T) => string; failure: string }
export function useOperation(scope: string) {
  const generation = useRef(0);
  const currentScope = useRef(scope);
  const active = useRef<{ generation: number } | undefined>(undefined);
  const [result, setResult] = useState<{ scope: string; state: OperationFeedbackState }>();
  const [storedScope, setStoredScope] = useState(scope);
  if (storedScope !== scope) {
    setStoredScope(scope);
    setResult(undefined);
  }
  useLayoutEffect(() => {
    currentScope.current = scope;
    const version = ++generation.current;
    return () => { generation.current = version + 1; };
  }, [scope]);
  const run = useCallback(async <T,>(job: (isCurrent: () => boolean) => Promise<T>, messages: OperationMessages<T>) => {
    if (currentScope.current !== scope || active.current?.generation === generation.current) return;
    const token = { generation: generation.current };
    active.current = token;
    const isCurrent = () => token.generation === generation.current;
    setResult({ scope, state: { phase: "running", summary: messages.running } });
    try {
      const value = await job(isCurrent);
      if (isCurrent()) setResult({ scope, state: { phase: "success", summary: messages.success(value) } });
    } catch (reason) {
      if (isCurrent()) setResult({ scope, state: { phase: "error", summary: messages.failure, details: reason instanceof Error ? reason.message : String(reason) } });
    } finally {
      if (active.current === token) active.current = undefined;
    }
  }, [scope]);
  const state = result?.scope === scope && storedScope === scope ? result.state : undefined;
  const dismiss = useCallback(() => setResult((current) => current?.scope === scope && current.state.phase !== "running" ? undefined : current), [scope]);
  return { state, busy: state?.phase === "running", run, dismiss };
}
