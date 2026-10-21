import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ExportDetailStore } from "./export-detail-store";

interface CanvasInteractionState {
  spacePanMode: boolean;
  rowConnectionActive?: boolean;
  layoutEditingDisabled?: boolean;
  overviewEnabled?: boolean;
  exportRendering?: boolean;
  /** Export-only card copies have no interactive React Flow wrapper/ports. */
  exportReplica?: boolean;
  exportDetails?: ExportDetailStore;
}

const CanvasInteractionContext = createContext<CanvasInteractionState>({
  spacePanMode: false,
});

export const CanvasInteractionProvider = CanvasInteractionContext.Provider;
export const useCanvasInteraction = () => useContext(CanvasInteractionContext);

export function useExportTableDetail(id: string) {
  const { exportDetails } = useCanvasInteraction();
  return useSyncExternalStore(
    useCallback((listener) => exportDetails?.subscribe(id, listener) ?? (() => {}), [exportDetails, id]),
    useCallback(() => exportDetails?.override(id), [exportDetails, id]),
    () => undefined,
  );
}
