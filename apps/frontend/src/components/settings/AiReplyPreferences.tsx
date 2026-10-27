import { useI18n } from "../../i18n";
import type { AiReplyPreferences as Preferences } from "../../platform/settings-types";
import { defaultAiReplyPreferences } from "../../platform/settings-defaults";
import { SettingsGroup, SelectRow } from "./SettingsControls";

export function AiReplyPreferences({ value, onChange }: { value?: Preferences; onChange: (value: Preferences) => void }) {
  const { t } = useI18n();
  const prefs = value ?? defaultAiReplyPreferences();
  return <SettingsGroup title={t("settings.reply.title")} description={t("settings.reply.priority")}>
    <SelectRow label={t("settings.reply.language")} value={prefs.language} onChange={(language) => onChange({ ...prefs, language: language as Preferences["language"] })} options={[["interface", t("settings.reply.interface")], ["english", "English"], ["chinese", "简体中文"]]} />
    <SelectRow label={t("settings.reply.detail")} value={prefs.detail} onChange={(detail) => onChange({ ...prefs, detail: detail as Preferences["detail"] })} options={[["concise", t("settings.reply.concise")], ["balanced", t("settings.reply.balanced")], ["detailed", t("settings.reply.detailed")]]} />
    <SelectRow label={t("settings.reply.terminology")} value={prefs.terminology} onChange={(terminology) => onChange({ ...prefs, terminology: terminology as Preferences["terminology"] })} options={[["plain", t("settings.reply.plain")], ["technical", t("settings.reply.technical")], ["bilingual", t("settings.reply.bilingual")]]} />
    <label className="ai-reply-instructions"><strong>{t("settings.reply.instructions")}</strong><textarea aria-label={t("settings.reply.instructions")} rows={4} maxLength={1000} value={prefs.additionalInstructions} placeholder={t("settings.reply.example")} onChange={(e) => onChange({ ...prefs, additionalInstructions: e.target.value })} /><small>{t("settings.reply.boundary")}</small></label>
  </SettingsGroup>;
}
