import { useId, useState } from "react";
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
import { ActionIcon } from "../ActionIcon";
import { ConnectionMergeRows } from "../ConnectionSync";
import { connectionSyncError, isValidSyncPassphrase, type ConnectionSyncErrorMessage } from "../connection-sync-messages";
import { SelectRow, SettingsGroup, SettingsSection } from "./SettingsControls";

const providers = { iCloud: "iCloud Drive", googleDrive: "Google Drive" } as const;
const providerOptions = Object.entries(providers);

export function ConnectionFolderSettings({ platform, status, offline, onStatus, mergeError, onMergeError, onDataSourcesChanged }: {
  platform: NodalStudioPlatform;
  status?: ConnectionFolderStatus;
  offline: boolean;
  onStatus: (status: ConnectionFolderStatus) => void;
  mergeError?: ConnectionSyncErrorMessage;
  onMergeError?: (error: ConnectionSyncErrorMessage | undefined) => void;
  onDataSourcesChanged: () => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const passphraseHintId = useId();
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
      const operation = input
        ? platform.enableConnectionFolder(input, preview.token)
        : platform.applyConnectionFolderUpdates(preview.token);
      const result = await operation.catch((reason: unknown) => {
        if (!input || preview.rows.length > 0) onMergeError?.(connectionSyncError(reason));
        throw reason;
      });
      onMergeError?.(undefined);
      onStatus(result);
      resetSetup();
      setMessage(t(input ? "connectionFolder.enabled" : "connectionFolder.merged"));
      await onDataSourcesChanged();
    });
  }

  const hasConflicts = preview?.rows.some(({ action }) => action === "conflict");
  const syncProblem = !status?.paused && !offline ? status?.problem : null;
  const mergeProblem = !status?.paused && !offline ? mergeError : undefined;
  const needsAttention = Boolean(syncProblem || mergeProblem);
  const syncActive = !status?.paused && !offline && !needsAttention;
  const errorMessage = error || (mergeError && !busy ? t(mergeError) : "");
  return <SettingsSection title={t("connectionFolder.title")} description={t("connectionFolder.description")}>
    {status?.folder && !folder && !preview ? <SettingsGroup title={t("connectionFolder.state")}>
      <div className="connection-folder-summary" role="status">
        <strong className="connection-folder-state" data-tone={needsAttention ? "warning" : syncActive ? "positive" : undefined}>
          {needsAttention ? <ActionIcon name="warning" /> : syncActive ? <ActionIcon name="check" /> : null}
          {t(status.paused ? "connectionFolder.paused" : offline ? "settings.offline" : mergeProblem ? "connectionFolder.mergeFailed" : syncProblem ? "connectionFolder.needsAttention" : "connectionFolder.active")}
        </strong>
        <span className="connection-folder-counts">{t("connectionFolder.counts", { queued: status.queued, pending: status.pending })}</span>
      </div>
      {syncProblem ? <p className="setting-inline-note">{t(connectionSyncError(syncProblem))}</p> : null}
      {offline && !status.paused ? <p className="setting-inline-note">{t("connectionFolder.offline")}</p> : null}
      {status.lastCheck || status.lastWrite ? <dl className="connection-folder-times">
        {status.lastCheck ? <div className="setting-row">
          <dt>{t("connectionFolder.lastCheck")}</dt>
          <dd><time dateTime={status.lastCheck}>{formatDate(status.lastCheck, "local")}</time></dd>
        </div> : null}
        {status.lastWrite ? <div className="setting-row">
          <dt>{t("connectionFolder.lastWrite")}</dt>
          <dd><time dateTime={status.lastWrite}>{formatDate(status.lastWrite, "local")}</time></dd>
        </div> : null}
      </dl> : null}
      <div className="setting-action-row connection-folder-actions">
        <Button disabled={busy || (offline && status.paused)}
          onClick={() => void run(async () => onStatus(await platform.setConnectionFolderPaused(!status.paused)))}>
          {t(status.paused ? "connectionFolder.resume" : "connectionFolder.pause")}
        </Button>
        <Button disabled={uiLocked || status.paused}
          onClick={() => void run(async () => {
            const result = await platform.checkConnectionFolder();
            onStatus(result);
            if (!result.problem && result.pending === 0) onMergeError?.(undefined);
          })}>
          {t("connectionFolder.check")}
        </Button>
        {status.pending > 0 ? <Button variant="primary" disabled={uiLocked || status.paused}
          onClick={() => void run(async () => setPreview(await platform.previewConnectionFolderUpdates()))}>
          {t("connectionFolder.review")}
        </Button> : null}
      </div>
    </SettingsGroup> : null}
    {!folder && !preview ? <SettingsGroup title={t("connectionFolder.syncFolder")}>
      <SelectRow label={t("connectionFolder.provider")} value={provider} options={providerOptions} disabled={uiLocked}
        onChange={(value) => setProvider(value as ConnectionFolderProvider)} />
      {status?.folder ? <div className="setting-row connection-folder-location">
        <span><strong>{t("connectionFolder.currentFolder")}</strong>
          {status.provider && status.provider !== provider ? <small>{providers[status.provider]}</small> : null}
        </span>
        <span className="connection-folder-path">{status.folder}</span>
      </div> : null}
      {offline && !status?.folder ? <p className="setting-inline-note">{t("connectionFolder.offline")}</p> : null}
      <div className="setting-action-row connection-folder-actions">
        <Button variant={status?.folder ? "secondary" : "primary"} disabled={uiLocked} onClick={chooseFolder}>
          {t(status?.folder ? "connectionFolder.changeFolder" : "connectionFolder.chooseFolder")}
        </Button>
      </div>
    </SettingsGroup> : null}
    {folder && !preview ? <SettingsGroup title={t("connectionFolder.syncFolder")}>
      <form className="connection-folder-form" autoComplete="off" onSubmit={(event) => {
        event.preventDefault();
        const input = setupInput();
        if (!input || !canPreview || uiLocked) return;
        void run(async () => setPreview(await platform.previewConnectionFolderSetup(input)));
      }}>
        <div className="setting-row connection-folder-location">
          <span><strong>{t("connectionFolder.selectedFolder")}</strong><small>{providers[provider]}</small></span>
          <span className="connection-folder-path">{folder}</span>
        </div>
        {libraries === undefined ? <div className="setting-action-row connection-folder-actions">
          <Button disabled={busy} onClick={resetSetup}>{t("business.cancel")}</Button>
          <Button disabled={uiLocked} onClick={() => void run(async () => inspect(folder))}>{t("connectionFolder.recheckFolder")}</Button>
        </div> : <>
          <p className="setting-inline-note">{t(createsLibrary ? "connectionFolder.createDescription" : "connectionFolder.joinDescription")}</p>
          {libraries.length > 1 ? <SelectRow label={t("connectionFolder.library")} value={library ?? ""} disabled={uiLocked}
            options={[["", t("connectionFolder.chooseLibraryOption")], ...libraries.map((id) => [id, id] as const)]}
            onChange={(value) => setLibrary(value || null)} /> : null}
          <div className="connection-folder-passphrases">
            <div className="connection-folder-field">
              <label>
                <strong>{t("connectionFolder.passphrase")}</strong>
                <input type="password" value={passphrase} disabled={uiLocked}
                  autoComplete={createsLibrary ? "new-password" : "off"}
                  aria-describedby={createsLibrary ? passphraseHintId : undefined}
                  onChange={(event) => setPassphrase(event.currentTarget.value)} />
              </label>
              {createsLibrary ? <p id={passphraseHintId} className="setting-inline-note">{t("connectionFolder.passphraseHint")}</p> : null}
            </div>
            {createsLibrary ? <label className="connection-folder-field">
              <strong>{t("connectionFolder.confirmPassphrase")}</strong>
              <input type="password" value={confirmation} disabled={uiLocked}
                autoComplete="new-password" onChange={(event) => setConfirmation(event.currentTarget.value)} />
            </label> : null}
          </div>
          <div className="setting-action-row connection-folder-actions">
            <Button disabled={busy} onClick={resetSetup}>{t("business.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={uiLocked || !canPreview}>{t("connectionFolder.previewSetup")}</Button>
          </div>
        </>}
      </form>
    </SettingsGroup> : null}
    {preview ? <SettingsGroup title={t(folder ? "connectionFolder.previewSetup" : "connectionSync.previewTitle")}>
      <div className="connection-folder-preview">
        {preview.createsLibrary ? <p className="setting-inline-note">{t("connectionFolder.createsLibrary")}</p> : null}
        <p className="setting-inline-note">{preview.deferredIncoming
          ? t("connectionFolder.deferredIncoming", { outgoing: preview.outgoing })
          : t("connectionFolder.previewCounts", { incoming: preview.rows.length, outgoing: preview.outgoing })}</p>
        {hasConflicts ? <p className="setting-inline-note">{t("connectionSync.conflictNote")}</p> : null}
        {preview.rows.length > 0 ? <ConnectionMergeRows rows={preview.rows} /> : null}
      </div>
      <div className="setting-action-row connection-folder-actions">
        <Button disabled={busy} onClick={() => { setPreview(undefined); setError(""); }}>{t("connectionSync.back")}</Button>
        <Button variant="primary" disabled={uiLocked || (!folder && preview.rows.length === 0)} onClick={confirm}>{t(folder ? "connectionFolder.enable" : "connectionFolder.merge")}</Button>
      </div>
    </SettingsGroup> : null}
    {errorMessage ? <p className="settings-operation-error" role="alert">{errorMessage}</p> : null}
    {message ? <p className="setting-inline-note" role="status">{message}</p> : null}
    <p className="setting-inline-note connection-folder-privacy"><ActionIcon name="lock" />{t("connectionSync.localSecrets")}</p>
  </SettingsSection>;
}
