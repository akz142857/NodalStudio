import { useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider, useI18n, useEventTranslator, resolveLocale, createTranslator, formatDate, formatNumber } from ".";
import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";
import type { Language } from "../platform/settings-types";

afterEach(() => vi.restoreAllMocks());
it.each([
  ["zhCn", ["en-US"], "zh-CN"], ["en", ["zh-CN"], "en"],
  ["system", ["zh-CN"], "zh-CN"], ["system", ["zh-SG"], "zh-CN"],
  ["system", ["zh-Hans-TW"], "zh-CN"], ["system", ["zh"], "zh-CN"],
  ["system", ["zh-Hant-CN", "en-GB"], "en"], ["system", ["zh-TW", "zh-CN"], "zh-CN"],
  ["system", ["fr-FR", "en-US", "zh-CN"], "en"], ["system", ["bad_tag", "zh-SG"], "zh-CN"],
  ["system", ["ja-JP"], "en"], ["system", [], "en"],
] as const)("resolves %s / %j to %s", (preference, languages, expected) => {
  expect(resolveLocale(preference, languages)).toBe(expected);
});
it("ships complete catalogs with exactly matching interpolation parameters", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  const params = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    expect(zhCN[key].trim(), key).not.toBe("");
    expect(params(zhCN[key]), key).toEqual(params(en[key]));
  }
});
it("interpolates data as text without interpreting SQL, markup or nested placeholders", () => {
  const t = createTranslator("zh-CN");
  const name = '<script>SELECT {value1} FROM orders</script>';
  expect(t("settings.createdProject", { value0: name })).toBe(`已创建项目 ${name}。`);
  expect(t("settings.sources.count.other", { count: 1200 })).toBe("已保存 1,200 个数据源");
});
it("formats dates with the app locale while preserving explicit ISO", () => {
  const date = new Date("2026-10-24T10:00:00Z");
  expect(formatDate(date, "zh-CN", "local", { dateStyle: "long", timeZone: "UTC" })).toBe("2026年10月24日");
  expect(formatDate(date, "en", "iso8601")).toBe(date.toISOString());
  expect(formatDate("invalid", "en")).toBe("—");
  expect(formatNumber(1234.5, "en")).toBe("1,234.5");
});
it("follows OS language changes without remounting children or rerunning effect work", async () => {
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  const effect = vi.fn();
  function Child() {
    const { t } = useI18n();
    const translate = useEventTranslator(t);
    const [draft, setDraft] = useState("");
    useEffect(() => { effect(translate("settings.language")); }, [translate]);
    return <label>{t("settings.language")}<input value={draft} onChange={(e) => setDraft(e.target.value)} /></label>;
  }
  function Harness({ preference }: { preference: Language }) {
    const i18n = useI18n(preference);
    return <I18nProvider value={i18n}><Child /></I18nProvider>;
  }
  const view = render(<Harness preference="system" />);
  fireEvent.change(screen.getByRole("textbox", { name: "Language" }), { target: { value: "SELECT * FROM orders" } });
  languages.mockReturnValue(["zh-SG"]);
  await act(async () => { window.dispatchEvent(new Event("languagechange")); await Promise.resolve(); });
  expect(screen.getByRole("textbox", { name: "语言" })).toHaveValue("SELECT * FROM orders");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(effect).toHaveBeenCalledOnce();
  view.rerender(<Harness preference="en" />);
  expect(screen.getByRole("textbox", { name: "Language" })).toHaveValue("SELECT * FROM orders");
  expect(document.documentElement.lang).toBe("en");
  expect(effect).toHaveBeenCalledOnce();
});
