import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type ReviewDock = "checks" | "note" | "languages" | "debug";

export const codeReviewSidebarMinWidth = 280;

export interface CodeReviewLayoutState {
  sidebarWidth: number;
  outlineWidth: number;
  dockSizes: Record<ReviewDock, number>;
  setSidebarWidth: (width: number) => void;
  setOutlineWidth: (width: number) => void;
  setDockSize: (dock: ReviewDock, height: number) => void;
}

export function createCodeReviewStore() {
  return createStore<CodeReviewLayoutState>((set) => ({
    sidebarWidth: codeReviewSidebarMinWidth,
    outlineWidth: 224,
    dockSizes: { checks: 300, note: 270, languages: 225, debug: 330 },
    setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
    setOutlineWidth: (outlineWidth) => set({ outlineWidth }),
    setDockSize: (dock, height) => set((state) => ({
      dockSizes: state.dockSizes[dock] === height ? state.dockSizes : { ...state.dockSizes, [dock]: height },
    })),
  }));
}

export type CodeReviewStore = ReturnType<typeof createCodeReviewStore>;

export function useCodeReviewLayout<T>(store: CodeReviewStore, selector: (state: CodeReviewLayoutState) => T): T {
  return useStore(store, selector);
}
