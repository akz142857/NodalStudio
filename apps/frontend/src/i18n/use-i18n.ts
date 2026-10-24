import { createContext, useContext, useMemo, useSyncExternalStore, useRef, useLayoutEffect, useCallback } from "react";
import type { Language } from "../platform/settings-types";
import { resolveLocale } from "./locale";
import { createTranslator } from "./messages";
import { formatDate, formatNumber } from "./format";

function subscribe(listener: () => void) {
  window.addEventListener("languagechange", listener);
  return () => window.removeEventListener("languagechange", listener);
}
function systemLanguages() { return (navigator.languages?.length ? navigator.languages : [navigator.language]).join("\u0000"); }
export const I18nContext = createContext<ReturnType<typeof createI18n> | undefined>(undefined);
function createI18n(locale: ReturnType<typeof resolveLocale>) {
  return {
    locale,
    t: createTranslator(locale),
    formatDate: (value: string | Date, format: "local" | "iso8601" = "local", options?: Intl.DateTimeFormatOptions) => formatDate(value, locale, format, options),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, locale, options),
    plural: (count: number) => new Intl.PluralRules(locale).select(count),
  };
}

/** Without an explicit preference, inherit the nearest application/preview scope. */
export function useI18n(preference?: Language) {
  const inherited = useContext(I18nContext);
  const languages = useSyncExternalStore(subscribe, systemLanguages, () => "en");
  const locale = resolveLocale(preference ?? "system", languages.split("\u0000"));
  const own = useMemo(() => createI18n(locale), [locale]);
  return preference === undefined && inherited ? inherited : own;
}

/** For async callbacks/effects only; render text must use the reactive t. */
export function useEventTranslator(t: ReturnType<typeof createTranslator>) {
  const latest = useRef(t);
  useLayoutEffect(() => { latest.current = t; }, [t]);
  return useCallback<ReturnType<typeof createTranslator>>((key, ...args) => latest.current(key, ...args), []);
}
