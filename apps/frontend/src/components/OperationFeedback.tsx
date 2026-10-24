import { useI18n } from "../i18n";
import type { StaticMessageKey } from "../i18n/messages";
import { useEffect, useEffectEvent, useState } from "react";

export interface OperationFeedbackState {
  phase: "running" | "success" | "error" | "info";
  summary: string;
  summaryKey?: StaticMessageKey;
  details?: string;
}

/** Shared presentation; callers retain ownership of operation scope and retry semantics. */
export function OperationFeedback({ label, state, onRetry, retryLabel, retryDisabled, onDismiss, dismissLabel, autoDismissMs = 0 }: {
  label: string;
  state?: OperationFeedbackState;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
  autoDismissMs?: number;
}) {
  const { t: bt } = useI18n();
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
      <p><strong>{state.phase === "running" ? bt("business.running") : state.phase === "success" ? bt("business.completed") : state.phase === "error" ? bt("business.failed") : bt("business.information")}</strong> · <span>{state.summaryKey ? bt(state.summaryKey) : state.summary}</span></p>
      {state.details ? <details open={state.phase === "error"}><summary>{state.phase === "error" ? bt("business.errorDetails") : bt("business.resultDetails")}</summary><p>{state.details}</p></details> : null}
    </div>
    {state.phase === "error" && onRetry ? <button type="button" disabled={retryDisabled} onClick={onRetry}>{retryLabel ?? bt("business.retry")}</button> : null}
    {state.phase !== "running" && onDismiss ? <button type="button" aria-label={dismissLabel ?? bt("business.dismissResult")} onClick={onDismiss}>{bt("business.dismiss")}</button> : null}
  </div>;
}
