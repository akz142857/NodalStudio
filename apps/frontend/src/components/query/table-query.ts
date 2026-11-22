import type { ExecuteReadonlyQueryInput, NodalStudioPlatform } from "../../platform";

// The desktop engine admits one query per source. A new preview or quick query
// waits for the previous request to settle, including after aborting it.
const pendingBySource = new Map<string, Promise<void>>();

export function executeTableQuery(platform: NodalStudioPlatform, input: Omit<ExecuteReadonlyQueryInput, "queryId">, signal: AbortSignal) {
  const { sourceId } = input;
  const previous = pendingBySource.get(sourceId) ?? Promise.resolve();
  const result = previous.then(async () => {
    signal.throwIfAborted();
    const queryId = crypto.randomUUID();
    let registered = false;
    const cancel = () => {
      if (registered) void platform.cancelQuery(queryId).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await platform.executeReadonlyQuery({ ...input, queryId }, () => {
        registered = true;
        if (signal.aborted) cancel();
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  });
  const settled = result.then(() => {}, () => {});
  pendingBySource.set(sourceId, settled);
  void settled.then(() => {
    if (pendingBySource.get(sourceId) === settled) pendingBySource.delete(sourceId);
  });
  return result;
}
