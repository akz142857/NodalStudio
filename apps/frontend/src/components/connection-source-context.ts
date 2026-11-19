import { createContext } from "react";
import type { DataSourceProfile } from "../platform";

export const ConnectionSourceContext = createContext<DataSourceProfile | undefined>(undefined);
