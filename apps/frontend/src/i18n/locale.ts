import type { Language } from "../platform/settings-types";

export type Locale = "en" | "zh-CN";

/** Persisted preferences stay compatible with existing Rust/settings documents. */
export function resolveLocale(preference: Language, languages: readonly string[]): Locale {
  if (preference === "zhCn") return "zh-CN";
  if (preference === "en") return "en";
  for (const tag of languages) {
    try {
      const locale = new Intl.Locale(tag);
      if (locale.language === "en") return "en";
      if (locale.language !== "zh") continue;
      if (locale.script === "Hans") return "zh-CN";
      if (locale.script) continue;
      if (!locale.region || ["CN", "SG"].includes(locale.region)) return "zh-CN";
    } catch { /* Ignore malformed platform language tags. */ }
  }
  return "en";
}
