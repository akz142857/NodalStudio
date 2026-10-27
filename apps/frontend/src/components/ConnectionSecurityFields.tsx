import { useI18n } from "../i18n";
import { useEffect, useId, useState } from "react";
import type { ConnectionSecurity, NodalStudioPlatform, SslMode } from "../platform";
import "./connection-security.css";

function FileField({ label, value, disabled, placeholder, platform, onChange }: {
  label: string; value?: string | null; disabled: boolean; placeholder?: string;
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
  return <div className="connection-file-field"><label htmlFor={id}>{label}</label><div>
    <input id={id} value={value ?? ""} disabled={disabled} placeholder={placeholder ?? bt("business.chooseALocalPEMFile")} onChange={(event) => onChange(event.target.value || null)} spellCheck={false} autoComplete="off" />
    <button type="button" disabled={disabled} onClick={() => void choose()} aria-label={bt("business.choose", { value0: label.toLowerCase() })}>{bt("business.chooseDetail")}</button>
  </div>{error ? <p role="alert">{error}</p> : null}</div>;
}

export function ConnectionSecurityFields({ security, sslMode, disabled, platform, onChange, section, sshPassword, onSshPasswordChange, hasSavedSshPassword }: {
  security?: ConnectionSecurity; sslMode: SslMode; disabled: boolean; platform: NodalStudioPlatform;
  onChange: (security: ConnectionSecurity) => void;
  section?: "tls" | "ssh";
  sshPassword?: string;
  onSshPasswordChange?: (password: string) => void;
  hasSavedSshPassword?: boolean;
}) {
  const { t: bt } = useI18n();
  const [isMas, setIsMas] = useState(false);
  useEffect(() => { let active = true; void platform.getRuntimeInfo?.().then(info => { if (active) setIsMas(info.distribution === "macAppStore"); }).catch(() => {}); return () => { active = false; }; }, [platform]);
  const current = security ?? { tls: {} };
  const ssh = current.ssh;
  const updateTls = (key: keyof ConnectionSecurity["tls"], value: string | null) => onChange({ ...current, tls: { ...current.tls, [key]: value } });
  const updateSsh = (patch: Partial<NonNullable<ConnectionSecurity["ssh"]>>) => { if (ssh) onChange({ ...current, ssh: { ...ssh, ...patch } }); };
  return <div className="connection-security-options">
    {section !== "ssh" && sslMode !== "disable" ? <details className="connection-security-disclosure" open={section === "tls" ? true : undefined}>
      <summary>{bt("business.certificates")} <span>{Object.values(current.tls).some(Boolean) ? bt("business.configured") : bt("business.optional")}</span></summary>
      <div className="connection-security-content">
        <p>{bt("business.forRemoteDatabasesVerifyFullChecksBothTheCertificate")}</p>
        <FileField label={bt("business.cACertificate")} value={current.tls.caCertificate} disabled={disabled} platform={platform} onChange={(value) => updateTls("caCertificate", value)} />
        <details><summary>{bt("business.clientAuthentication")}</summary><p>{bt("business.onlyNeededWhenTheDatabaseRequiresAClientCertificate")}</p>
          <FileField label={bt("business.clientCertificate")} value={current.tls.clientCertificate} disabled={disabled} platform={platform} onChange={(value) => updateTls("clientCertificate", value)} />
          <FileField label={bt("business.clientPrivateKey")} value={current.tls.clientKey} disabled={disabled} platform={platform} onChange={(value) => updateTls("clientKey", value)} />
        </details>
      </div>
    </details> : null}
    {section !== "tls" ? <section className="connection-ssh-section" aria-label={bt("business.sSHTunnel")}>
      <label className="connection-ssh-toggle"><input type="checkbox" checked={Boolean(ssh)} disabled={disabled} onChange={(event) => onChange({ ...current, ssh: event.target.checked ? { host: "", port: 22, username: "", authentication: isMas ? "privateKey" : "agent" } : null })} /><span><strong>{bt("business.connectThroughSSH")}</strong><small>{bt("business.reachAPrivateDatabaseThroughAJumpHost")}</small></span></label>
      {ssh ? <div className="connection-security-content">
        {isMas ? <p>{bt("submission.masSsh")}</p> : null}
        <div className="connection-form-grid">
          <label>{bt("business.sSHHost")}<input value={ssh.host} disabled={disabled} placeholder="bastion.example.com" onChange={(event) => updateSsh({ host: event.target.value.trim() })} autoComplete="off" spellCheck={false} /></label>
          <label>{bt("business.sSHPort")}<input type="number" min="1" max="65535" value={ssh.port} disabled={disabled} onChange={(event) => updateSsh({ port: Number(event.target.value) })} /></label>
          <label>{bt("business.sSHUsername")}<input value={ssh.username} disabled={disabled} onChange={(event) => updateSsh({ username: event.target.value.trim() })} autoComplete="off" spellCheck={false} /></label>
          <label>{bt("business.authentication")}<select value={ssh.authentication} disabled={disabled} onChange={(event) => updateSsh({ authentication: event.target.value as "agent" | "privateKey" | "password" })}><option value="agent" disabled={isMas}>{bt("business.sSHAgent")}</option><option value="privateKey">{bt("business.privateKey")}</option><option value="password">{bt("business.password")}</option></select></label>
        </div>
        {ssh.authentication === "privateKey" ? <FileField label={bt("business.sSHPrivateKey")} value={ssh.privateKey} disabled={disabled} platform={platform} placeholder={bt("business.chooseAnOpenSSHPrivateKey")} onChange={(privateKey) => updateSsh({ privateKey })} /> : null}
        {ssh.authentication === "password" ? <div className="connection-ssh-password"><label>{bt("business.sSHPassword")}<input type="password" autoComplete="new-password" value={sshPassword ?? ""} disabled={disabled} placeholder={hasSavedSshPassword ? bt("business.leaveBlankToKeepSavedPassword") : bt("business.sSHPassword")} onChange={(event) => onSshPasswordChange?.(event.target.value)} /></label><p>{hasSavedSshPassword ? bt("business.savedInTheSystemKeychainLeaveBlankToKeep") : bt("business.savedInTheSystemKeychainAfterVerificationItIs")}</p></div> : <p>{bt(isMas ? "submission.masSshKey" : "business.unlockEncryptedPrivateKeysInYourSystemSSHAgent")}</p>}
        <details><summary>{bt("business.serverIdentity")}</summary>
          <FileField label={bt("business.knownHostsFile")} value={ssh.knownHosts} disabled={disabled} platform={platform} placeholder={bt("business.systemKnownHosts")} onChange={(knownHosts) => updateSsh({ knownHosts })} />
          <p>{bt("business.theSSHServerMustAlreadyBeTrustedInKnown")}</p>
        </details>
        <p>{bt("business.theDatabaseHostAboveIsResolvedFromTheJump")}</p>
      </div> : null}
    </section> : null}
  </div>;
}
