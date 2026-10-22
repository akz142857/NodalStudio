import { useEffect, useEffectEvent, useState } from "react";

export interface OperationFeedbackState {
  phase: "running" | "success" | "error" | "info";
  summary: string;
  details?: string;
}

/** Shared presentation; callers retain ownership of operation scope and retry semantics. */
export function OperationFeedback({ label, state, onRetry, retryLabel = "Retry", retryDisabled, onDismiss, dismissLabel = "Dismiss result", autoDismissMs = 0 }: {
  label: string;
  state?: OperationFeedbackState;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
  autoDismissMs?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const canDismiss = Boolean(onDismiss);
  const dismiss = useEffectEvent(() => onDismiss?.());
  useEffect(() => {
    if (state?.phase !== "success" || !autoDismissMs || hovered || focused || !canDismiss) return;
    const timer = window.setTimeout(() => dismiss(), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [state, autoDismissMs, hovered, focused, canDismiss]);
  if (!state) return null;
  return <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }} className="operation-feedback" data-phase={state.phase} role="group" aria-label={label} aria-busy={state.phase === "running"}>
    <div role={state.phase === "error" ? "alert" : "status"} aria-atomic="true">
      <p><strong>{state.phase === "running" ? "Running" : state.phase === "success" ? "Completed" : state.phase === "error" ? "Failed" : "Information"}</strong> · <span>{state.summary}</span></p>
      {state.details ? <details open={state.phase === "error"}><summary>{state.phase === "error" ? "Error details" : "Result details"}</summary><p>{state.details}</p></details> : null}
    </div>
    {state.phase === "error" && onRetry ? <button type="button" disabled={retryDisabled} onClick={onRetry}>{retryLabel}</button> : null}
    {state.phase !== "running" && onDismiss ? <button type="button" aria-label={dismissLabel} onClick={onDismiss}>Dismiss</button> : null}
  </div>;
}
