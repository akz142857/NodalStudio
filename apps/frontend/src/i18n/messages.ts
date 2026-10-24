import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";
import type { Locale } from "./locale";

export type MessageKey = keyof typeof en;
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
type ParametersFor<K extends MessageKey> = [Placeholders<(typeof en)[K]>] extends [never] ? [] : [params: Record<Placeholders<(typeof en)[K]>, string | number>];
export type StaticMessageKey = { [K in MessageKey]: ParametersFor<K> extends [] ? K : never }[MessageKey];
export type Translate = <K extends MessageKey>(key: K, ...args: ParametersFor<K>) => string;

export function createTranslator(locale: Locale): Translate {
  const dictionary: Partial<Record<MessageKey, string>> = locale === "zh-CN" ? zhCN : en;
  return (key: MessageKey, params?: Record<string, string | number>) => {
    const message = dictionary[key] ?? en[key];
    if (message === undefined) {
      if (import.meta.env.DEV) console.warn(`Missing translation: ${key}`);
      return key;
    }
    return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => typeof params?.[name] === "number" ? new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(params[name]) : String(params?.[name] ?? placeholder));
  };
}
