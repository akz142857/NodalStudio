import { useI18n } from "../i18n";
import { useEffect, useId, useState } from "react";
import type { ConnectionSecurity, NodalStudioPlatform, SslMode } from "../platform";
import "./connection-security.css";

function FileField({ label, value, disabled, placeholder, help, platform, onChange }: {
  label: string; value?: string | null; disabled: boolean; placeholder?: string; help?: string;
  platform: NodalStudioPlatform; onChange: (value: string | null) => void;
}) {
  const { t: bt } = useI18n();
  const id = useId();
  const [error, setError] = useState<string>();
  async function choose() {
    setError(undefined);
    try { const path = await platform.pickConnectionFile(); if (path) onChange(path); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div className="connection-sheet-row connection-file-field">
    <label htmlFor={id}>{label}</label>
    <div className="connection-file-picker">
      <input id={id} value={value ?? ""} disabled={disabled} placeholder={placeholder ?? bt("business.chooseALocalPEMFile")}
        aria-describedby={help ? `${id}-help` : undefined} onChange={(event) => onChange(event.target.value || null)}
        spellCheck={false} autoComplete="off" />
      <button type="button" disabled={disabled} onClick={() => void choose()}
        aria-label={bt("business.choose", { value0: label.toLowerCase() })}>{bt("business.chooseDetail")}</button>
    </div>
    {help ? <p className="connection-field-help" id={`${id}-help`}>{help}</p> : null}
    {error ? <p className="connection-field-help" role="alert">{error}</p> : null}
  </div>;
}

export function ConnectionSecurityFields({ security, sslMode, disabled, platform, onChange, section, sshPassword, onSshPasswordChange, hasSavedSshPassword, sshKeyPassphrase, onSshKeyPassphraseChange }: {
  security?: ConnectionSecurity; sslMode: SslMode; disabled: boolean; platform: NodalStudioPlatform;
  onChange: (security: ConnectionSecurity) => void;
  section?: "tls" | "ssh";
  sshPassword?: string;
  onSshPasswordChange?: (password: string) => void;
  hasSavedSshPassword?: boolean;
  sshKeyPassphrase?: string;
  onSshKeyPassphraseChange?: (passphrase: string) => void;
}) {
  const { t: bt } = useI18n();
  const id = useId();
  const [isMas, setIsMas] = useState(false);
  useEffect(() => { let active = true; void platform.getRuntimeInfo?.().then(info => { if (active) setIsMas(info.distribution === "macAppStore"); }).catch(() => {}); return () => { active = false; }; }, [platform]);
  const current = security ?? { tls: {} };
  const ssh = current.ssh;
  const updateTls = (key: keyof ConnectionSecurity["tls"], value: string | null) => onChange({ ...current, tls: { ...current.tls, [key]: value } });
  const updateSsh = (patch: Partial<NonNullable<ConnectionSecurity["ssh"]>>) => { if (ssh) onChange({ ...current, ssh: { ...ssh, ...patch } }); };
  return <div className="connection-security-options">
    {section !== "ssh" && sslMode !== "disable" ? <>
      <details className="connection-sheet-group connection-security-disclosure">
        <summary>{bt("business.certificates")} <span>{bt(current.tls.caCertificate ? "business.configured" : "business.optional")}</span></summary>
        <div className="connection-sheet-group">
          <FileField label={bt("business.cACertificate")} value={current.tls.caCertificate} disabled={disabled}
            platform={platform} help={bt("connectionSetup.caHelp")} onChange={(value) => updateTls("caCertificate", value)} />
        </div>
      </details>
      <details className="connection-sheet-group connection-security-disclosure">
        <summary>{bt("business.clientAuthentication")} <span>{bt(current.tls.clientCertificate || current.tls.clientKey ? "business.configured" : "business.optional")}</span></summary>
        <div className="connection-sheet-group">
          <FileField label={bt("business.clientCertificate")} value={current.tls.clientCertificate} disabled={disabled}
            platform={platform} onChange={(value) => updateTls("clientCertificate", value)} />
          <FileField label={bt("business.clientPrivateKey")} value={current.tls.clientKey} disabled={disabled}
            platform={platform} help={bt("business.onlyNeededWhenTheDatabaseRequiresAClientCertificate")} onChange={(value) => updateTls("clientKey", value)} />
        </div>
      </details>
    </> : null}
    {section !== "tls" ? <section className="connection-ssh-section" aria-label={bt("business.sSHTunnel")}>
      <div className="connection-sheet-group">
        <div className="connection-sheet-row connection-ssh-toggle-row">
          <label className="connection-ssh-toggle">
            <input type="checkbox" checked={Boolean(ssh)} disabled={disabled} aria-describedby={ssh ? undefined : `${id}-ssh-help`}
              onChange={(event) => onChange({ ...current, ssh: event.target.checked ? { host: "", port: 22, username: "", authentication: isMas ? "privateKey" : "agent" } : null })} />
            {bt("business.connectThroughSSH")}
          </label>
          {!ssh && <p id={`${id}-ssh-help`} className="connection-field-help">{bt("connectionSetup.sshHelp")}</p>}
        </div>
      </div>
      {ssh ? <>
        <div className="connection-sheet-group">
          <div className="connection-sheet-row">
            <label htmlFor={`${id}-host`}>{bt("business.sSHHost")}</label>
            <div className="connection-address">
              <input id={`${id}-host`} value={ssh.host} disabled={disabled} placeholder="bastion.example.com"
                onChange={(event) => updateSsh({ host: event.target.value.trim() })} autoComplete="off" spellCheck={false} />
              <label htmlFor={`${id}-port`}>{bt("business.sSHPort")}</label>
              <input id={`${id}-port`} type="number" min="1" max="65535" value={ssh.port} disabled={disabled}
                onChange={(event) => updateSsh({ port: Number(event.target.value) })} />
            </div>
          </div>
          <div className="connection-sheet-row">
            <label htmlFor={`${id}-username`}>{bt("business.sSHUsername")}</label>
            <input id={`${id}-username`} value={ssh.username} disabled={disabled}
              onChange={(event) => updateSsh({ username: event.target.value.trim() })} autoComplete="off" spellCheck={false} />
          </div>
          <div className="connection-sheet-row">
            <label htmlFor={`${id}-authentication`}>{bt("business.authentication")}</label>
            <select id={`${id}-authentication`} value={ssh.authentication} disabled={disabled}
              onChange={(event) => updateSsh({ authentication: event.target.value as NonNullable<ConnectionSecurity["ssh"]>["authentication"] })}>
              <option value="agent" disabled={isMas}>{bt("business.sSHAgent")}</option>
              <option value="privateKey">{bt("business.privateKey")}</option>
              <option value="password">{bt("business.password")}</option>
            </select>
            {isMas ? <p className="connection-field-help">{bt("submission.masSsh")}</p> : null}
          </div>
          {ssh.authentication === "privateKey" ? <>
            <FileField label={bt("business.sSHPrivateKey")} value={ssh.privateKey} disabled={disabled} platform={platform}
              placeholder={bt("business.chooseAnOpenSSHPrivateKey")} onChange={(privateKey) => updateSsh({ privateKey })} />
            <div className="connection-sheet-row">
              <label htmlFor={`${id}-passphrase`}>{bt("business.sSHKeyPassphrase")}</label>
              <input id={`${id}-passphrase`} type="password" autoComplete="new-password" value={sshKeyPassphrase ?? ""} disabled={disabled}
                aria-describedby={`${id}-passphrase-help`} onChange={(event) => onSshKeyPassphraseChange?.(event.target.value)} />
              <p id={`${id}-passphrase-help`} className="connection-field-help">{bt("business.sSHKeyPassphraseHelp")}</p>
            </div>
          </> : null}
          {ssh.authentication === "password" ? <div className="connection-sheet-row">
            <label htmlFor={`${id}-password`}>{bt("business.sSHPassword")}</label>
            <input id={`${id}-password`} type="password" autoComplete="new-password" value={sshPassword ?? ""} disabled={disabled}
              placeholder={hasSavedSshPassword ? bt("business.leaveBlankToKeepSavedPassword") : undefined}
              aria-describedby={`${id}-password-help`} onChange={(event) => onSshPasswordChange?.(event.target.value)} />
            <p id={`${id}-password-help`} className="connection-field-help">{bt(hasSavedSshPassword ? "business.savedInTheSystemKeychainLeaveBlankToKeep" : "business.savedInTheSystemKeychainAfterVerificationItIs")}</p>
          </div> : null}
        </div>
        <section className="connection-sheet-group" aria-labelledby={`${id}-identity`}>
          <h3 id={`${id}-identity`} className="connection-section-title">{bt("business.serverIdentity")}</h3>
          <FileField label={bt(isMas ? "submission.masKnownHostsRequired" : "business.knownHostsFile")} value={ssh.knownHosts}
            disabled={disabled} platform={platform} placeholder={isMas ? "~/.ssh/known_hosts" : bt("business.systemKnownHosts")}
            help={bt(isMas ? "submission.masKnownHostsHelp" : "business.theSSHServerMustAlreadyBeTrustedInKnown")}
            onChange={(knownHosts) => updateSsh({ knownHosts })} />
        </section>
      </> : null}
    </section> : null}
  </div>;
}
