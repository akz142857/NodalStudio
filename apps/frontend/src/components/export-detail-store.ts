/** Only nodes entering/leaving the detail batch need a React update. */
export function createExportDetailStore() {
  let ids: ReadonlySet<string> | undefined;
  const listeners = new Map<string, Set<() => void>>();
  return {
    includes: (id: string) => ids === undefined || ids.has(id),
    override: (id: string) => ids?.has(id),
    subscribe(id: string, listener: () => void) {
      let subscribers = listeners.get(id);
      if (!subscribers) { subscribers = new Set(); listeners.set(id, subscribers); }
      subscribers.add(listener);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(id); };
    },
    set(next: ReadonlySet<string> | undefined) {
      const previous = ids; ids = next;
      for (const [id, subscribers] of listeners) {
        if (previous?.has(id) !== next?.has(id)) for (const listener of subscribers) listener();
      }
    },
  };
}
export type ExportDetailStore = ReturnType<typeof createExportDetailStore>;
