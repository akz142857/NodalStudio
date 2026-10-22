import { useId, useState } from "react";
import type { ConnectionSecurity, NodalStudioPlatform, SslMode } from "../platform";
import "./connection-security.css";

function FileField({ label, value, disabled, placeholder, platform, onChange }: {
  label: string; value?: string | null; disabled: boolean; placeholder?: string;
  platform: NodalStudioPlatform; onChange: (value: string | null) => void;
}) {
  const id = useId();
  const [error, setError] = useState<string>();
  async function choose() {
    setError(undefined);
    try { const path = await platform.pickConnectionFile(); if (path) onChange(path); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div className="connection-file-field"><label htmlFor={id}>{label}</label><div>
    <input id={id} value={value ?? ""} disabled={disabled} placeholder={placeholder ?? "Choose a local PEM file…"} onChange={(event) => onChange(event.target.value || null)} spellCheck={false} autoComplete="off" />
    <button type="button" disabled={disabled} onClick={() => void choose()} aria-label={`Choose ${label.toLowerCase()}`}>Choose…</button>
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
  const current = security ?? { tls: {} };
  const ssh = current.ssh;
  const updateTls = (key: keyof ConnectionSecurity["tls"], value: string | null) => onChange({ ...current, tls: { ...current.tls, [key]: value } });
  const updateSsh = (patch: Partial<NonNullable<ConnectionSecurity["ssh"]>>) => { if (ssh) onChange({ ...current, ssh: { ...ssh, ...patch } }); };
  return <div className="connection-security-options">
    {section !== "ssh" && sslMode !== "disable" ? <details className="connection-security-disclosure" open={section === "tls" ? true : undefined}>
      <summary>Certificates <span>{Object.values(current.tls).some(Boolean) ? "Configured" : "Optional"}</span></summary>
      <div className="connection-security-content">
        <p>For remote databases, Verify full checks both the certificate and database hostname. Leave the CA file empty to use the system trust store.</p>
        <FileField label="CA certificate" value={current.tls.caCertificate} disabled={disabled} platform={platform} onChange={(value) => updateTls("caCertificate", value)} />
        <details><summary>Client authentication</summary><p>Only needed when the database requires a client certificate. Provide both PEM files; encrypted TLS keys are not supported.</p>
          <FileField label="Client certificate" value={current.tls.clientCertificate} disabled={disabled} platform={platform} onChange={(value) => updateTls("clientCertificate", value)} />
          <FileField label="Client private key" value={current.tls.clientKey} disabled={disabled} platform={platform} onChange={(value) => updateTls("clientKey", value)} />
        </details>
      </div>
    </details> : null}
    {section !== "tls" ? <section className="connection-ssh-section" aria-label="SSH tunnel">
      <label className="connection-ssh-toggle"><input type="checkbox" checked={Boolean(ssh)} disabled={disabled} onChange={(event) => onChange({ ...current, ssh: event.target.checked ? { host: "", port: 22, username: "", authentication: "agent" } : null })} /><span><strong>Connect through SSH</strong><small>Reach a private database through a jump host.</small></span></label>
      {ssh ? <div className="connection-security-content">
        <div className="connection-form-grid">
          <label>SSH host<input value={ssh.host} disabled={disabled} placeholder="bastion.example.com" onChange={(event) => updateSsh({ host: event.target.value.trim() })} autoComplete="off" spellCheck={false} /></label>
          <label>SSH port<input type="number" min="1" max="65535" value={ssh.port} disabled={disabled} onChange={(event) => updateSsh({ port: Number(event.target.value) })} /></label>
          <label>SSH username<input value={ssh.username} disabled={disabled} onChange={(event) => updateSsh({ username: event.target.value.trim() })} autoComplete="off" spellCheck={false} /></label>
          <label>Authentication<select value={ssh.authentication} disabled={disabled} onChange={(event) => updateSsh({ authentication: event.target.value as "agent" | "privateKey" | "password" })}><option value="agent">SSH Agent</option><option value="privateKey">Private key</option><option value="password">Password</option></select></label>
        </div>
        {ssh.authentication === "privateKey" ? <FileField label="SSH private key" value={ssh.privateKey} disabled={disabled} platform={platform} placeholder="Choose an OpenSSH private key…" onChange={(privateKey) => updateSsh({ privateKey })} /> : null}
        {ssh.authentication === "password" ? <div className="connection-ssh-password"><label>SSH password<input type="password" autoComplete="new-password" value={sshPassword ?? ""} disabled={disabled} placeholder={hasSavedSshPassword ? "Leave blank to keep saved password" : "SSH password"} onChange={(event) => onSshPasswordChange?.(event.target.value)} /></label><p>{hasSavedSshPassword ? "Saved in the system keychain. Leave blank to keep it, or enter a new password to replace it." : "Saved in the system keychain after verification. It is separate from your database password."}</p></div> : <p>Unlock encrypted private keys in your system SSH Agent before connecting.</p>}
        <details><summary>Server identity</summary>
          <FileField label="Known hosts file" value={ssh.knownHosts} disabled={disabled} platform={platform} placeholder="System known_hosts" onChange={(knownHosts) => updateSsh({ knownHosts })} />
          <p>The SSH server must already be trusted in known_hosts. Verify a new server’s fingerprint with your administrator before trusting it in Terminal.</p>
        </details>
        <p>The database host above is resolved from the jump host. TLS still verifies that database’s identity. SSH tunneling is available on macOS and Linux.</p>
      </div> : null}
    </section> : null}
  </div>;
}
