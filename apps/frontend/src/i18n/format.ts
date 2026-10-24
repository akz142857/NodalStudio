import type { Locale } from "./locale";

export function formatDate(value: string | Date, locale: Locale, format: "local" | "iso8601" = "local", options?: Intl.DateTimeFormatOptions) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return format === "iso8601" ? date.toISOString() : new Intl.DateTimeFormat(locale, options ?? { dateStyle: "medium", timeStyle: "medium" }).format(date);
}
export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(locale, options).format(value);
}
