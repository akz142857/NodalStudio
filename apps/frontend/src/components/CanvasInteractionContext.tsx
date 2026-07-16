import { createContext, useContext } from "react";

interface CanvasInteractionState {
  spacePanMode: boolean;
}

const CanvasInteractionContext = createContext<CanvasInteractionState>({
  spacePanMode: false,
});

export const CanvasInteractionProvider = CanvasInteractionContext.Provider;
export const useCanvasInteraction = () => useContext(CanvasInteractionContext);
