import { useDeferredValue, type ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

/** Global schema-search input state, kept out of App so typing re-renders only its subscribers. */
export interface SchemaSearchState {
  query: string;
  open: boolean;
  active: number;
  setQuery: (query: string) => void;
  setOpen: (open: boolean) => void;
  setActive: (active: number) => void;
}

export type SchemaSearchStore = StoreApi<SchemaSearchState>;

export function createSchemaSearchStore(): SchemaSearchStore {
  return createStore<SchemaSearchState>()((set) => ({
    query: "",
    open: false,
    active: 0,
    setQuery: (query) => set({ query }),
    setOpen: (open) => set({ open }),
    setActive: (active) => set({ active }),
  }));
}

export function useSchemaSearch<T>(store: SchemaSearchStore, selector: (state: SchemaSearchState) => T): T {
  return useStore(store, selector);
}

/** Supplies the deferred search query so heavy consumers (the canvas) yield to typing. */
export function DeferredSearchQuery({ store, children }: { store: SchemaSearchStore; children: (query: string) => ReactNode }) {
  const query = useDeferredValue(useSchemaSearch(store, (state) => state.query));
  return children(query);
}
