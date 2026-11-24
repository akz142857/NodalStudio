import { useState } from "react";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { NodalStudioPlatform } from "../../platform";
import type {
  ConnectionFolderPreview,
  ConnectionFolderProvider,
  ConnectionFolderSetup,
  ConnectionFolderStatus,
} from "../../platform/types";
import { useUpdateBlocker } from "../../platform/update-guard";
import { ConnectionMergeRows } from "../ConnectionSync";
import { connectionSyncError, isValidSyncPassphrase } from "../connection-sync-messages";
import { SelectRow, SettingsSection } from "./SettingsControls";

const providers = { iCloud: "iCloud Drive", googleDrive: "Google Drive" } as const;
const providerOptions = Object.entries(providers);

export function ConnectionFolderSettings({ platform, status, offline, onStatus, onDataSourcesChanged }: {
  platform: NodalStudioPlatform;
  status?: ConnectionFolderStatus;
  offline: boolean;
  onStatus: (status: ConnectionFolderStatus) => void;
  onDataSourcesChanged: () => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const [providerChoice, setProvider] = useState<ConnectionFolderProvider>();
  const provider = providerChoice ?? status?.provider ?? "iCloud";
  const [folder, setFolder] = useState<string>();
  const [libraries, setLibraries] = useState<string[]>();
  const [library, setLibrary] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<ConnectionFolderPreview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const createsLibrary = libraries?.length === 0;
  const canPreview = libraries !== undefined && (createsLibrary || library !== null)
    && isValidSyncPassphrase(passphrase) && (!createsLibrary || passphrase === confirmation);
  const uiLocked = busy || offline;
  useUpdateBlocker(t("connectionFolder.busy"), busy);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (reason) {
      if (reason === "stalePreview") setPreview(undefined);
      if (folder && (reason === "chooseLibrary" || reason === "folderChanged")) {
        setPreview(undefined);
        setLibraries(undefined);
        setLibrary(null);
        setPassphrase("");
        setConfirmation("");
      }
      setError(t(connectionSyncError(reason)));
    } finally {
      setBusy(false);
    }
  }

  function resetSetup() {
    setFolder(undefined);
    setLibraries(undefined);
    setLibrary(null);
    setPassphrase("");
    setConfirmation("");
    setPreview(undefined);
    setError("");
  }

  async function inspect(path: string) {
    setLibraries(undefined);
    setLibrary(null);
    const result = await platform.inspectConnectionFolder(path);
    setLibraries(result.libraries);
    if (result.libraries.length === 1) setLibrary(result.libraries[0]);
  }

  function chooseFolder() {
    void run(async () => {
      const path = await platform.pickWorkspacePath("connectionSyncFolder");
      if (!path) return;
      resetSetup();
      setFolder(path);
      await inspect(path);
    });
  }

  function setupInput(): ConnectionFolderSetup | undefined {
    return folder ? { folder, provider, library, passphrase } : undefined;
  }

  function confirm() {
    if (!preview) return;
    const input = setupInput();
    void run(async () => {
      const result = input
        ? await platform.enableConnectionFolder(input, preview.token)
        : await platform.applyConnectionFolderUpdates(preview.token);
      onStatus(result);
      resetSetup();
      setMessage(t(input ? "connectionFolder.enabled" : "connectionFolder.merged"));
      await onDataSourcesChanged();
    });
  }

  const hasConflicts = preview?.rows.some(({ action }) => action === "conflict");
  return <SettingsSection title={t("connectionFolder.title")} description={t("connectionFolder.description")}>
    <p className="setting-inline-note">{t("connectionSync.localSecrets")}</p>
    {status?.folder && !folder ? <div className="connection-folder-status">
      <div className="setting-row"><span><strong>{t("connectionFolder.syncFolder")}</strong><small>{status.provider ? providers[status.provider] : ""}</small></span><span className="connection-folder-path">{status.folder}</span></div>
      <div className="setting-row" role="status">
        <span><strong>{t("connectionFolder.state")}</strong>
          {status.lastCheck ? <small>{t("connectionFolder.lastCheck", { when: formatDate(status.lastCheck, "local") })}</small> : null}
          {status.lastWrite ? <small>{t("connectionFolder.lastWrite", { when: formatDate(status.lastWrite, "local") })}</small> : null}
        </span>
        <span>{t(status.paused ? "connectionFolder.paused" : offline ? "connectionFolder.offline" : status.problem ? connectionSyncError(status.problem) : "connectionFolder.active")}</span>
      </div>
      <p className="setting-inline-note">{t("connectionFolder.counts", { queued: status.queued, pending: status.pending })}</p>
      <div className="setting-action-row">
        <Button disabled={uiLocked || status.paused || Boolean(preview)} onClick={() => void run(async () => onStatus(await platform.checkConnectionFolder()))}>{t("connectionFolder.check")}</Button>
        <Button disabled={busy || Boolean(preview) || (offline && status.paused)} onClick={() => void run(async () => onStatus(await platform.setConnectionFolderPaused(!status.paused)))}>{t(status.paused ? "connectionFolder.resume" : "connectionFolder.pause")}</Button>
        {status.pending > 0 && !preview ? <Button variant="primary" disabled={uiLocked || status.paused} onClick={() => void run(async () => setPreview(await platform.previewConnectionFolderUpdates()))}>{t("connectionFolder.review")}</Button> : null}
      </div>
    </div> : null}
    {!folder && !preview ? <>
      <SelectRow label={t("connectionFolder.provider")} value={provider} options={providerOptions} disabled={uiLocked}
        onChange={(value) => setProvider(value as ConnectionFolderProvider)} />
      <div className="setting-action-row"><Button variant={status?.folder ? "secondary" : "primary"} disabled={uiLocked} onClick={chooseFolder}>
        {t(status?.folder ? "connectionFolder.changeFolder" : "connectionFolder.chooseFolder")}
      </Button></div>
      {offline && !status?.folder ? <p className="setting-inline-note">{t("connectionFolder.offline")}</p> : null}
    </> : null}
    {folder && !preview ? <form className="connection-folder-form" autoComplete="off" onSubmit={(event) => {
      event.preventDefault();
      const input = setupInput();
      if (!input || !canPreview || uiLocked) return;
      void run(async () => setPreview(await platform.previewConnectionFolderSetup(input)));
    }}>
      <div className="setting-row"><strong>{t("connectionFolder.syncFolder")}</strong><span className="connection-folder-path">{folder}</span></div>
      {libraries === undefined ? <div className="setting-action-row">
        <Button disabled={busy} onClick={resetSetup}>{t("business.cancel")}</Button>
        <Button disabled={uiLocked} onClick={() => void run(async () => inspect(folder))}>{t("connectionFolder.recheckFolder")}</Button>
      </div> : <>
        <p className="setting-inline-note">{t(createsLibrary ? "connectionFolder.createDescription" : "connectionFolder.joinDescription")}</p>
        {libraries.length > 1 ? <SelectRow label={t("connectionFolder.library")} value={library ?? ""} disabled={uiLocked}
          options={[["", t("connectionFolder.chooseLibraryOption")], ...libraries.map((id) => [id, id] as const)]}
          onChange={(value) => setLibrary(value || null)} /> : null}
        <label className="setting-row"><strong>{t("connectionSync.passphrase")}</strong><input type="password" value={passphrase} disabled={uiLocked}
          autoComplete={createsLibrary ? "new-password" : "off"} onChange={(event) => setPassphrase(event.currentTarget.value)} /></label>
        {createsLibrary ? <>
          <label className="setting-row"><strong>{t("connectionSync.confirmPassphrase")}</strong><input type="password" value={confirmation} disabled={uiLocked}
            autoComplete="new-password" onChange={(event) => setConfirmation(event.currentTarget.value)} /></label>
          <p className="setting-inline-note">{t("connectionSync.passphraseHint")}</p>
        </> : null}
        <div className="setting-action-row">
          <Button disabled={busy} onClick={resetSetup}>{t("business.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={uiLocked || !canPreview}>{t("connectionFolder.previewSetup")}</Button>
        </div>
      </>}
    </form> : null}
    {preview ? <div className="connection-folder-preview">
      <h3>{t(folder ? "connectionFolder.previewSetup" : "connectionSync.previewTitle")}</h3>
      {preview.createsLibrary ? <p className="setting-inline-note">{t("connectionFolder.createsLibrary")}</p> : null}
      <p className="setting-inline-note">{preview.deferredIncoming
        ? t("connectionFolder.deferredIncoming", { outgoing: preview.outgoing })
        : t("connectionFolder.previewCounts", { incoming: preview.rows.length, outgoing: preview.outgoing })}</p>
      {hasConflicts ? <p className="setting-inline-note">{t("connectionSync.conflictNote")}</p> : null}
      {preview.rows.length > 0 ? <ConnectionMergeRows rows={preview.rows} /> : null}
      <div className="setting-action-row">
        <Button disabled={busy} onClick={() => { setPreview(undefined); setError(""); }}>{t("connectionSync.back")}</Button>
        <Button variant="primary" disabled={uiLocked || (!folder && preview.rows.length === 0)} onClick={confirm}>{t(folder ? "connectionFolder.enable" : "connectionFolder.merge")}</Button>
      </div>
    </div> : null}
    {error ? <p className="settings-operation-error" role="alert">{error}</p> : null}
    {message ? <p className="setting-inline-note" role="status">{message}</p> : null}
  </SettingsSection>;
}
