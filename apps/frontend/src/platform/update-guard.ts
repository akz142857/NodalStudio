import { useLayoutEffect, useId } from "react";

const blockers = new Map<string, string>();
/** Keeps non-component work protected even when its editor is no longer mounted. */
export function setUpdateBlocker(id: string, message: string | undefined) {
  if (message) blockers.set(id, message);
  else blockers.delete(id);
}
/** Registers unsaved work that must be handled before an explicit restart. */
export function useUpdateBlocker(message: string, blocked: boolean) {
  const id = useId();
  useLayoutEffect(() => {
    setUpdateBlocker(id, blocked ? message : undefined);
    return () => { setUpdateBlocker(id, undefined); };
  }, [id, message, blocked]);
}
export function assertUpdateCanRestart() {
  const messages = [...new Set(blockers.values())];
  if (messages.length) throw new Error(`Before installing: ${messages.join("; ")}.`);
}
