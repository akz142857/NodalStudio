export interface OperationFeedbackState {
  phase: "running" | "success" | "error" | "info";
  summary: string;
  details?: string;
}

/** Shared presentation; callers retain ownership of operation scope and retry semantics. */
export function OperationFeedback({ label, state, onRetry, retryLabel = "Retry", retryDisabled, onDismiss, dismissLabel = "Dismiss result" }: {
  label: string;
  state?: OperationFeedbackState;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  if (!state) return null;
  return <div className="operation-feedback" data-phase={state.phase} role="group" aria-label={label} aria-busy={state.phase === "running"}>
    <div role={state.phase === "error" ? "alert" : "status"} aria-atomic="true">
      <p><strong>{state.phase === "running" ? "Running" : state.phase === "success" ? "Completed" : state.phase === "error" ? "Failed" : "Information"}</strong> · <span>{state.summary}</span></p>
      {state.details ? <details open={state.phase === "error"}><summary>{state.phase === "error" ? "Error details" : "Result details"}</summary><p>{state.details}</p></details> : null}
    </div>
    {state.phase === "error" && onRetry ? <button type="button" disabled={retryDisabled} onClick={onRetry}>{retryLabel}</button> : null}
    {state.phase !== "running" && onDismiss ? <button type="button" aria-label={dismissLabel} onClick={onDismiss}>Dismiss</button> : null}
  </div>;
}
