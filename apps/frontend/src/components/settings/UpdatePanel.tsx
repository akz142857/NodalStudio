import { useI18n } from "../../i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppSettings, NodalStudioPlatform, RuntimeInfo, UpdateStatus } from "../../platform";
import { assertUpdateCanRestart } from "../../platform/update-guard";
import { SettingsGroup, ToggleRow, TextRow, SelectRow } from "./SettingsControls";
import "./updates.css";
import { PurchasePanel } from "./PurchasePanel";

const labels = {"idle":"updates.phase.idle","checking":"updates.phase.checking","available":"updates.phase.available","upToDate":"updates.phase.upToDate","downloading":"updates.phase.downloading","verifying":"updates.phase.verifying","ready":"updates.phase.ready","installing":"updates.phase.installing","error":"updates.phase.error"} as const;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type UpdatePanelProps = {
  platform: NodalStudioPlatform; runtime?: RuntimeInfo; app: AppSettings;
  managed?: { source: string; reason: string }; onSave: (app: AppSettings) => Promise<void>;
};

export function UpdatePanel(props: UpdatePanelProps) {
  if (!props.runtime) return null;
  return props.runtime?.distribution === "macAppStore"
    ? <PurchasePanel platform={props.platform} version={props.runtime.version} />
    : <DirectUpdatePanel {...props} />;
}

function DirectUpdatePanel({ platform, runtime, app, managed, onSave }: {
  platform: NodalStudioPlatform; runtime?: RuntimeInfo; app: AppSettings;
  managed?: { source: string; reason: string }; onSave: (app: AppSettings) => Promise<void>;
}) {
  const { t, formatDate } = useI18n();

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
    <SettingsGroup title={t("updates.updates")}>
      <div className="update-summary" aria-live="polite" aria-atomic="true">
        <span className="update-symbol" aria-hidden="true">↻</span>
        <div><h3>{t(labels[phase])}</h3><p>{t("updates.installedVersion", { version: status?.currentVersion ?? runtime?.version ?? "—", available: status?.availableVersion ? t("updates.available", { value0: status.availableVersion }) : "" })}</p></div>
        {status?.canInstall ? <span className="update-verified">{t("updates.signatureVerified")}</span> : null}
      </div>
      {!desktop ? <p className="update-help">{t("updates.applicationUpdatesAreAvailableInTheDesktopApp")}</p> : null}
      {status?.source ? <p className="update-help">{t("updates.updateSource")}{" "}{status.source}</p> : null}
      {app.privacy.offlineMode ? <p className="update-help">{t("updates.offlineModeBlocksUpdateChecksAndDownloads")}</p> : managed ? <p className="update-help">{managed.reason}</p> : status?.configurationMessage ? <p className="update-help">{status.configurationMessage}</p> : null}
      {status?.notes ? <details className="settings-disclosure" open><summary>{t("updates.whatSNew")}</summary><p className="update-notes">{status.notes}</p></details> : null}
      {phase === "downloading" || phase === "verifying" ? <div className="update-progress"><progress aria-label={t("updates.updateDownload")} max={100} value={phase === "verifying" ? undefined : progress} /><span>{phase === "verifying" ? t("updates.checkingTheSignatureAndApplicationIdentity") : status?.totalBytes ? t("updates.download.progress", { downloaded: megabytes(status.downloadedBytes), total: megabytes(status.totalBytes) }) : t("updates.download.amount", { downloaded: megabytes(status?.downloadedBytes ?? 0) })}</span></div> : null}
      {error || status?.error ? <p className="update-error" role="alert">{error || status?.error}</p> : null}
      <div className="setting-action-row update-actions">
        {status?.canInstall ? <button type="button" className="update-primary" disabled={busy || !desktop || !status.configured} onClick={install}>{t("updates.installAndRestart")}</button> : status?.canDownload ? <button type="button" className="update-primary" disabled={busy || blocked} onClick={() => void run(() => platform.downloadUpdate())}>{t("updates.downloadUpdate")}</button> : null}
        <button type="button" disabled={busy || blocked} onClick={() => void run(() => platform.checkForUpdates())}>{t("updates.checkForUpdates")}</button>
        {desktop && status?.source === "GitHub Releases" ? <button type="button" disabled={busy || blocked} onClick={() => void run(() => platform.openUpdateReleases())}>{status.manualOnly && status.availableVersion ? t("updates.getUpdateOnGitHub") : t("updates.viewGitHubReleases")}</button> : null}
        {phase === "downloading" ? <button type="button" onClick={() => void platform.cancelUpdateDownload().catch((e: unknown) => setError(reason(e)))}>{t("updates.cancelDownload")}</button> : null}
      </div>
      {status?.checkedAt ? <p className="update-help">{t("updates.lastChecked")}{" "}{formatDate(status.checkedAt, app.general.dateTimeFormat)}</p> : null}
      <ToggleRow label={t("updates.automaticallyCheckForUpdates")} description={t("updates.checkWhenTheAppStartsDownloadsAndInstallation")} checked={app.updates.automaticChecks} managed={managed} onChange={(automaticChecks) => void onSave({ ...app, updates: { ...app.updates, automaticChecks } })} />
      <details className="settings-disclosure update-advanced-settings">
        <summary>{t("updates.advancedUpdateSettings")}</summary>
        <fieldset className="update-advanced-fields" aria-label={t("updates.advancedUpdateSettings")} disabled={busy || Boolean(managed)}>
          <SelectRow label={t("updates.updateChannel")} value={app.updates.channel} options={[["stable", t("settings.stable")], ["beta", t("updates.beta")]]} onChange={(channel) => void run(() => onSave({ ...app, updates: { ...app.updates, channel: channel as AppSettings["updates"]["channel"] } }))} />
          <TextRow label={t("updates.updateFeed")} value={app.updates.customFeedUrl ?? ""} placeholder={t("updates.useGitHubReleases")} onChange={(customFeedUrl) => void onSave({ ...app, updates: { ...app.updates, customFeedUrl: customFeedUrl || null } }).catch((e: unknown) => setError(reason(e)))} />
          <p className="update-advanced-help">{t("updates.customFeedsMustUseTheSigningKeyTrusted")}</p>
        </fieldset>
      </details>
    </SettingsGroup>
    {confirm ? <InstallConfirmation version={status?.availableVersion ?? ""} onCancel={() => setConfirm(false)} onInstall={async () => { assertUpdateCanRestart(); await platform.installUpdate(); }} /> : null}
  </>;
}
function InstallConfirmation({ version, onCancel, onInstall }: { version: string; onCancel: () => void; onInstall: () => Promise<void> }) {
  const { t } = useI18n();

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
    <h2 id="update-install-title">{t("updates.installNodalStudio")}{" "}{version}?</h2>
    <p id="update-install-description">{t("updates.theAppWillBackUpItsLocalDatabase")}</p>
    <p>{t("updates.yourSavedConnectionsSnapshotsModelRelationshipsAndSQL")}</p>
    {error ? <p className="update-error" role="alert">{error}</p> : null}
    <footer><button ref={cancel} type="button" disabled={busy} onClick={onCancel}>{t("updates.notNow")}</button><button type="button" className="update-primary" disabled={busy} onClick={() => void install()}>{busy ? t("updates.installingAndRestarting") : t("updates.installAndRestartDetail")}</button></footer>
  </dialog>, document.body);
}
