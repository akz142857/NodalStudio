import "./forms.css";
import { Button } from "./Button";
import { useI18n } from "../i18n";
import { useId, type ReactNode } from "react";

type ManagedSetting = { source: string; reason: string };

export function SettingsSection({ title, description, children, managed, disabled = false }: { disabled?: boolean; title: string; description: string; children: ReactNode; managed?: ManagedSetting }) {
  const { t } = useI18n();

  const titleId = useId();
  return <section className="settings-section" aria-labelledby={titleId}>
    <header><h2 id={titleId}>{title}</h2><p>{description}</p>{managed ? <em className="managed-section" title={managed.reason}>{t("settings.managed")}{" "}{managed.source}</em> : null}</header>
    <fieldset className="settings-card" disabled={Boolean(managed) || disabled} aria-label={t("settings.preferences", { value0: title })}>{children}</fieldset>
  </section>;
}

export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <fieldset className="settings-group"><legend>{title}</legend>{description ? <p className="settings-group-description">{description}</p> : null}<div className="settings-group-content">{children}</div></fieldset>;
}

export function ToggleRow({ label, description, checked, managed, onChange }: { label: string; description?: string; checked: boolean; managed?: ManagedSetting; onChange: (value: boolean) => void }) {
  const { t } = useI18n();

  const descriptionId = useId();
  return <label className="setting-row setting-toggle"><span><strong>{label}</strong><span id={descriptionId}>{description ? <small>{description}</small> : null}{managed ? <em title={managed.reason}>{t("settings.managed")}{" "}{managed.source}</em> : null}</span></span><input className="ds-switch" aria-label={label} aria-describedby={description || managed ? descriptionId : undefined} type="checkbox" checked={checked} disabled={Boolean(managed)} onChange={(event) => onChange(event.target.checked)} /></label>;
}

export function SelectRow({ label, value, options, onChange, disabled }: { label: string; value: string; disabled?: boolean; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong></span><select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>;
}

export function RangeRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  const id = useId();
  const { formatNumber } = useI18n();
  return <label className="setting-row setting-range"><span><strong>{label}</strong></span><span className="setting-range-control"><input id={id} aria-label={label} type="range" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /><output htmlFor={id}>{formatNumber(value)}{unit}</output></span></label>;
}

export function NumberRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="setting-row setting-number"><span><strong>{label}</strong>{unit ? <small>{unit}</small> : null}</span><input aria-label={label} type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function TextRow({ label, value, placeholder, readOnly, onChange }: { label: string; value: string; placeholder?: string; readOnly?: boolean; onChange: (value: string) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong></span><input readOnly={readOnly} type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function SecretRow({ label, value, configured, onChange, onSave, showSave = true }: { label: string; value: string; configured: boolean; onChange: (value: string) => void; onSave: () => void; showSave?: boolean }) {
  const { t } = useI18n();

  const id = useId();
  const descriptionId = useId();
  return <div className="setting-row"><label htmlFor={id}><strong>{label}</strong><small id={descriptionId}>{configured ? t("settings.storedInTheSystemCredentialStore") : t("settings.notConfigured")}</small></label><div className="secret-setting"><input id={id} aria-describedby={descriptionId} type="password" value={value} placeholder="••••••••" onChange={(event) => onChange(event.target.value)} />{showSave ? <Button disabled={!value.trim()} onClick={onSave}>{t("settings.save")}</Button> : null}</div></div>;
}
