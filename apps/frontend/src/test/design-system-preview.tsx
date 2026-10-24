// Development-only fixture. No platform calls or persistent preference writes.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "../i18n";
import type { Language } from "../platform/settings-types";
import { Button } from "../design-system/Button";
import { SettingsGroup, SelectRow, TextRow, ToggleRow, RangeRow } from "../design-system/forms";
import { IconButton } from "../components/IconButton";
import "../styles.css";
import "./design-system-preview.css";

export function Preview() {
  const params = new URLSearchParams(location.search);
  const [language, setLanguage] = useState<Language>(params.get("language") === "zh-CN" ? "zhCn" : "en");
  const [theme, setTheme] = useState(params.get("theme") ?? "dark");
  const [density, setDensity] = useState(params.get("density") ?? "comfortable");
  const [font, setFont] = useState(params.get("font") === "18" ? 18 : 13);
  const [enabled, setEnabled] = useState(true);
  const [value, setValue] = useState("orders_订单_very_long_identifier");
  const i18n = useI18n(language);
  const { t } = i18n;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.style.setProperty("--ui-font-size", `${font}px`);
  }, [theme, density, font]);
  return <I18nProvider value={i18n}><main className="ds-surface design-system-preview">
    <header><h1>Nodal Studio · {t("settings.appearance")}</h1><p>{t("settings.workspaceDensityAccessibilityAndPanelDefaults")}</p></header>
    <SettingsGroup title={t("settings.display")}>
      <SelectRow label={t("settings.language")} value={language} onChange={(v) => setLanguage(v as Language)} options={[["en", "English"], ["zhCn", "简体中文"], ["system", t("settings.followSystem")]]} />
      <SelectRow label={t("settings.theme")} value={theme} onChange={setTheme} options={[["light", t("settings.light")], ["dark", t("settings.dark")], ["system", t("settings.followSystem")]]} />
      <SelectRow label={t("settings.informationDensity")} value={density} onChange={setDensity} options={[["comfortable", t("settings.comfortable")], ["compact", t("settings.compact")]]} />
      <RangeRow label={t("settings.uIFontSize")} value={font} min={11} max={18} unit=" px" onChange={setFont} />
    </SettingsGroup>
    <SettingsGroup title={t("settings.workspacePanels")}>
      <TextRow label={t("settings.model")} value={value} onChange={setValue} />
      <ToggleRow label={t("settings.reopenLastWorkspace")} description={t("settings.restoreTheLastSourceAndViewModeOn")} checked={enabled} onChange={setEnabled} />
      <ToggleRow label={t("settings.anonymousDiagnostics")} description={t("settings.versionRuntimeDurationBucketOutcomeClassAndRedacted")} checked={false} managed={{ source: t("settings.teamProjectPolicy"), reason: t("settings.managedByProjectOrOrganization") }} onChange={() => undefined} />
    </SettingsGroup>
    <section className="preview-actions" aria-label={t("navigation.applicationTools")}>
      <Button variant="primary">{t("settings.save")}</Button><Button>{t("settings.cancelDraft")}</Button><Button variant="ghost">{t("settings.close")}</Button><Button variant="danger">{t("settings.removeConnection")}</Button>
      <Button disabled>{t("settings.unavailable")}</Button><Button busy>{t("settings.saving")}</Button><IconButton label={t("settings.searchSettings")} icon="search" />
    </section>
    <section className="preview-status" role="status">{t("settings.savedLocally")}</section>
    <section className="preview-error" role="alert">{t("settings.operationFailed")} {t("settings.tryAnotherSearchTerm")}</section>
    <section className="preview-empty"><h2>{t("settings.noActiveDataSource")}</h2><p>{t("settings.connectOrSelectADataSourceToConfigure")}</p></section>
  </main></I18nProvider>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
