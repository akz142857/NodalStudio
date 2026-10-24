import { useEffect, type ReactNode } from "react";
import { I18nContext, useI18n } from "./use-i18n";

export function I18nProvider({ value, children }: { value: ReturnType<typeof useI18n>; children: ReactNode }) {
  useEffect(() => { document.documentElement.lang = value.locale; }, [value.locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
