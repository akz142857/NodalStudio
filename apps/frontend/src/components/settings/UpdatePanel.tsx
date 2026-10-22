import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppSettings, NodalStudioPlatform, RuntimeInfo, UpdateStatus } from "../../platform";
import { assertUpdateCanRestart } from "../../platform/update-guard";
import { SettingsGroup, ToggleRow, TextRow, SelectRow } from "./SettingsControls";
import "./updates.css";

const labels: Record<UpdateStatus["phase"], string> = {
  idle: "Software update", checking: "Checking for updates…", available: "An update is available",
  upToDate: "Nodal Studio is up to date", downloading: "Downloading update…", verifying: "Verifying update…",
  ready: "Ready to install", installing: "Installing and restarting…", error: "Update needs attention",
};
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function UpdatePanel({ platform, runtime, app, managed, onSave }: {
  platform: NodalStudioPlatform; runtime?: RuntimeInfo; app: AppSettings;
  managed?: { source: string; reason: string }; onSave: (app: AppSettings) => Promise<void>;
}) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [error, setError] = useState("");
  const [operation, setOperation] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const statusRequest = useRef(0);
  const desktop = runtime?.kind === "desktop";
  const blocked = !desktop || app.privacy.offlineMode || Boolean(managed) || status?.canCheck === false;
  const refreshStatus = useCallback(async (reportError = true) => {
    const generation = lifecycle.current;
    const request = ++statusRequest.current;
    const current = () => mounted.current && generation === lifecycle.current && request === statusRequest.current;
    try {
      const next = await platform.getUpdateStatus();
      if (current()) setStatus(next);
    } catch (e) {
      if (reportError && current()) setError(reason(e));
    }
  }, [platform]);
  useEffect(() => {
    mounted.current = true;
    const dispose = () => { mounted.current = false; lifecycle.current += 1; };
    if (!desktop) return dispose;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try { await refreshStatus(); }
      finally { polling = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => { dispose(); window.clearInterval(timer); };
  }, [refreshStatus, desktop]);

  async function run(action: () => Promise<unknown>) {
    if (pending.current) return;
    const generation = lifecycle.current;
    const current = () => mounted.current && generation === lifecycle.current;
    // A poll started before this action must not restore its previous phase.
    statusRequest.current += 1;
    pending.current = true; setOperation(true); setError("");
    try { await action(); }
    catch (e) { if (current()) setError(reason(e)); }
    finally {
      // Keep the actionable operation error if its follow-up status read fails.
      if (current()) await refreshStatus(false);
      if (mounted.current) setOperation(false);
      pending.current = false;
    }
  }
  const phase = status?.phase ?? "idle";
  const busy = operation || ["checking", "downloading", "verifying", "installing"].includes(phase);
  const progress = status?.totalBytes ? Math.min(100, status.downloadedBytes / status.totalBytes * 100) : undefined;
  const install = () => {
    try { assertUpdateCanRestart(); setError(""); setConfirm(true); }
    catch (e) { setError(reason(e)); }
  };
  return <>
    <SettingsGroup title="Updates">
      <div className="update-summary" aria-live="polite" aria-atomic="true">
        <span className="update-symbol" aria-hidden="true">↻</span>
        <div><h3>{labels[phase]}</h3><p>Installed version {status?.currentVersion ?? runtime?.version ?? "—"}{status?.availableVersion ? ` · Available ${status.availableVersion}` : ""}</p></div>
        {status?.canInstall ? <span className="update-verified">Signature verified</span> : null}
      </div>
      {!desktop ? <p className="update-help">Application updates are available in the desktop app.</p> : null}
      {status?.source ? <p className="update-help">Update source: {status.source}</p> : null}
      {app.privacy.offlineMode ? <p className="update-help">Offline mode blocks update checks and downloads.</p> : managed ? <p className="update-help">{managed.reason}</p> : status?.configurationMessage ? <p className="update-help">{status.configurationMessage}</p> : null}
      {status?.notes ? <details className="settings-disclosure" open><summary>What’s new</summary><p className="update-notes">{status.notes}</p></details> : null}
      {phase === "downloading" || phase === "verifying" ? <div className="update-progress"><progress aria-label="Update download" max={100} value={phase === "verifying" ? undefined : progress} /><span>{phase === "verifying" ? "Checking the signature and application identity…" : `${megabytes(status?.downloadedBytes ?? 0)}${status?.totalBytes ? ` of ${megabytes(status.totalBytes)}` : " downloaded"}`}</span></div> : null}
      {error || status?.error ? <p className="update-error" role="alert">{error || status?.error}</p> : null}
      <div className="setting-action-row update-actions">
        {status?.canInstall ? <button type="button" className="update-primary" disabled={busy || !desktop || !status.configured} onClick={install}>Install and Restart…</button> : status?.canDownload ? <button type="button" className="update-primary" disabled={busy || blocked} onClick={() => void run(() => platform.downloadUpdate())}>Download update</button> : null}
        <button type="button" disabled={busy || blocked} onClick={() => void run(() => platform.checkForUpdates())}>Check for updates</button>
        {desktop && status?.source === "GitHub Releases" ? <button type="button" disabled={busy || blocked} onClick={() => void run(() => platform.openUpdateReleases())}>{status.manualOnly && status.availableVersion ? "Get update on GitHub" : "View GitHub releases"}</button> : null}
        {phase === "downloading" ? <button type="button" onClick={() => void platform.cancelUpdateDownload().catch((e: unknown) => setError(reason(e)))}>Cancel download</button> : null}
      </div>
      {status?.checkedAt ? <p className="update-help">Last checked {new Date(status.checkedAt).toLocaleString()}</p> : null}
      <ToggleRow label="Automatically check for updates" description="Check when the app starts. Downloads and installation require your action." checked={app.updates.automaticChecks} managed={managed} onChange={(automaticChecks) => void onSave({ ...app, updates: { ...app.updates, automaticChecks } })} />
      <details className="settings-disclosure"><summary>Advanced update settings</summary><fieldset disabled={busy || Boolean(managed)}><SelectRow label="Update channel" value={app.updates.channel} options={[["stable", "Stable"], ["beta", "Beta"]]} onChange={(channel) => void run(() => onSave({ ...app, updates: { ...app.updates, channel: channel as AppSettings["updates"]["channel"] } }))} /><TextRow label="Update feed" value={app.updates.customFeedUrl ?? ""} placeholder="Use GitHub Releases" onChange={(customFeedUrl) => void onSave({ ...app, updates: { ...app.updates, customFeedUrl: customFeedUrl || null } }).catch((e: unknown) => setError(reason(e)))} /><p>Custom feeds must use the signing key trusted by this build. Beta in-app updates require a dedicated feed.</p></fieldset></details>
    </SettingsGroup>
    {confirm ? <InstallConfirmation version={status?.availableVersion ?? ""} onCancel={() => setConfirm(false)} onInstall={async () => { assertUpdateCanRestart(); await platform.installUpdate(); }} /> : null}
  </>;
}
function InstallConfirmation({ version, onCancel, onInstall }: { version: string; onCancel: () => void; onInstall: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const previous = document.activeElement; const element = dialog.current;
    element?.showModal(); cancel.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  async function install() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await onInstall(); }
    catch (e) { setError(reason(e)); setBusy(false); pending.current = false; }
  }
  return createPortal(<dialog ref={dialog} className="ds-surface update-confirmation" aria-labelledby="update-install-title" aria-describedby="update-install-description" aria-busy={busy} onKeyDown={(e) => e.stopPropagation()} onCancel={(e) => { e.preventDefault(); if (!pending.current) onCancel(); }}>
    <h2 id="update-install-title">Install Nodal Studio {version}?</h2>
    <p id="update-install-description">The app will back up its local database, install the verified update and restart. Finish your work and save any edits before continuing.</p>
    <p>Your saved connections, snapshots, model relationships and SQL draft stay on this device.</p>
    {error ? <p className="update-error" role="alert">{error}</p> : null}
    <footer><button ref={cancel} type="button" disabled={busy} onClick={onCancel}>Not now</button><button type="button" className="update-primary" disabled={busy} onClick={() => void install()}>{busy ? "Installing and restarting…" : "Install and Restart"}</button></footer>
  </dialog>, document.body);
}
