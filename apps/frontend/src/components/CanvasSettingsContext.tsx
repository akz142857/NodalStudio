import { createContext, useContext } from "react";
import { defaultAppSettings, type AppSettings } from "../platform";

const CanvasSettingsContext = createContext<AppSettings["canvas"]>(
  defaultAppSettings().canvas,
);

export const CanvasSettingsProvider = CanvasSettingsContext.Provider;
export const useCanvasSettings = () => useContext(CanvasSettingsContext);
