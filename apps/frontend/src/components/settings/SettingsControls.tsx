import { useId, type ReactNode } from "react";

type ManagedSetting = { source: string; reason: string };

export function SettingsSection({ title, description, children, managed }: { title: string; description: string; children: ReactNode; managed?: ManagedSetting }) {
  const titleId = useId();
  return <section className="settings-section" aria-labelledby={titleId}>
    <header><h2 id={titleId}>{title}</h2><p>{description}</p>{managed ? <em className="managed-section" title={managed.reason}>Managed · {managed.source}</em> : null}</header>
    <fieldset className="settings-card" disabled={Boolean(managed)} aria-label={`${title} preferences`}>{children}</fieldset>
  </section>;
}

export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <fieldset className="settings-group"><legend>{title}</legend>{description ? <p className="settings-group-description">{description}</p> : null}<div className="settings-group-content">{children}</div></fieldset>;
}

export function ToggleRow({ label, description, checked, managed, onChange }: { label: string; description?: string; checked: boolean; managed?: ManagedSetting; onChange: (value: boolean) => void }) {
  const descriptionId = useId();
  return <label className="setting-row setting-toggle"><span><strong>{label}</strong><span id={descriptionId}>{description ? <small>{description}</small> : null}{managed ? <em title={managed.reason}>Managed · {managed.source}</em> : null}</span></span><input className="ds-switch" aria-label={label} aria-describedby={description || managed ? descriptionId : undefined} type="checkbox" checked={checked} disabled={Boolean(managed)} onChange={(event) => onChange(event.target.checked)} /></label>;
}

export function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong></span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>;
}

export function RangeRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  const id = useId();
  return <label className="setting-row setting-range"><span><strong>{label}</strong></span><span className="setting-range-control"><input id={id} aria-label={label} type="range" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /><output htmlFor={id}>{value}{unit}</output></span></label>;
}

export function NumberRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="setting-row setting-number"><span><strong>{label}</strong>{unit ? <small>{unit}</small> : null}</span><input aria-label={label} type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function TextRow({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong></span><input type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function SecretRow({ label, value, configured, onChange, onSave, showSave = true }: { label: string; value: string; configured: boolean; onChange: (value: string) => void; onSave: () => void; showSave?: boolean }) {
  const id = useId();
  const descriptionId = useId();
  return <div className="setting-row"><label htmlFor={id}><strong>{label}</strong><small id={descriptionId}>{configured ? "Stored in the system credential store" : "Not configured"}</small></label><div className="secret-setting"><input id={id} aria-describedby={descriptionId} type="password" value={value} placeholder="••••••••" onChange={(event) => onChange(event.target.value)} />{showSave ? <button type="button" disabled={!value.trim()} onClick={onSave}>Save</button> : null}</div></div>;
}
