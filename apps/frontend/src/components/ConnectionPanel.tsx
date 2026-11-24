import { useI18n } from "../i18n";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure, type ConnectionTestState } from "./connection-test-state";
import { ConnectionSecurityFields } from "./ConnectionSecurityFields";
import { ConnectionManager } from "./ConnectionManager";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import { DataSourcePicker } from "./DataSourcePicker";
import { ConnectionSourceContext } from "./connection-source-context";
import { ActionIcon } from "./ActionIcon";
import { Button } from "../design-system/Button";
import { ModalSurface } from "../design-system/ModalSurface";
import "./model-navigation.css";
import type {
  ConnectionSecurity,
  DataSourceProfile,
  CaptureSnapshotResult,
  NodalStudioPlatform,
  SaveDataSourceInput,
  SslMode,
} from "../platform";

interface ConnectionPanelProps {
  enabled: boolean;
  /** The source whose snapshot is on the canvas; its objects nest beneath it. */
  activeSourceId?: string;
  /** Reload profiles after imports or settings mutations outside this panel. */
  sourcesRevision?: number;
  /** The schema tree rendered below the active source's picker. */
  children?: ReactNode;
  platform: NodalStudioPlatform;
  onSnapshot: (result: CaptureSnapshotResult) => void;
  onSourceSaved?: (source: DataSourceProfile) => void;
  onSourceOpenStart?: () => void;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  onSourceDeleted?: (sourceId: string) => void;
  defaultDatabaseType: SaveDataSourceInput["databaseType"];
  defaultSslMode: SslMode;
}

const initialForm: SaveDataSourceInput = {
  displayName: "Local development",
  host: "127.0.0.1",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "",
  databaseType: "postgreSql",
  sslMode: "disable",
};

class MissingSchemaSnapshotError extends Error {}

function newConnectionForm(
  databaseType: SaveDataSourceInput["databaseType"],
  sslMode: SslMode,
  displayName: string,
): SaveDataSourceInput {
  return {
    ...initialForm,
    displayName,
    databaseType,
    port: databaseType === "mySql" ? 3306 : 5432,
    sslMode,
  };
}



function connectionDetailsDiffer(
  profile: DataSourceProfile,
  form: SaveDataSourceInput,
): boolean {
  return (
    profile.databaseType !== form.databaseType ||
    JSON.stringify(profile.sqlite ?? null) !== JSON.stringify(form.sqlite ?? null) ||
    profile.host.trim() !== form.host.trim() ||
    profile.port !== form.port ||
    profile.database.trim() !== form.database.trim() ||
    profile.username.trim() !== form.username.trim() ||
    profile.sslMode !== form.sslMode ||
    JSON.stringify(profile.security ?? { tls: {} }) !== JSON.stringify(form.security ?? { tls: {} })
  );
}

export function ConnectionPanel({ enabled, activeSourceId, sourcesRevision, children, platform, onSnapshot, onSourceSaved, onSourceOpenStart, onSourceDeleted, onRefresh, refreshDisabled, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const { t: bt } = useI18n();
  const sslModeDescriptions: Record<SslMode, string> = {
  disable: bt("business.tLSIsDisabledForThisConnection"),
  prefer: bt("business.useTLSWhenAvailableThisModeCanFallBack"),
  require: bt("business.requireEncryptionWithoutVerifyingTheServerIdentity"),
  verifyCa: bt("business.requireTLSAndVerifyTheCertificateAuthority"),
  verifyFull: bt("business.requireTLSAndVerifyTheDatabaseServerIdentity"),
};
  const navigation = useRef<HTMLElement>(null);
  const [managerOpen, setManagerOpen] = useState<"manage" | "import">();
  const [form, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode, bt("business.localDevelopment")));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const testController = useRef<AbortController | null>(null);
  useEffect(() => () => { testController.current?.abort(); testController.current = null; }, []);
  const [testState, setTestState] = useState<ConnectionTestState>({ status: "idle" });
  const [error, setError] = useState<string>();
  const openContext = useMemo(() => ({ sourceId: activeSourceId }), [activeSourceId]);
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement; context: typeof openContext }>();
  const [openError, setOpenError] = useState<{
    context: typeof openContext;
    profile: DataSourceProfile;
    message: string;
    missingSnapshot: boolean;
  }>();
  const [pending, setPending] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"general" | "tls" | "ssh">("general");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    profile: DataSourceProfile;
    resolve: (confirmed: boolean) => void;
  }>();
  const pendingLocalSetup = editingProfile?.connectionSync?.pending === true;
  const requiresLiveVerification = editingProfile
    ? pendingLocalSetup || connectionDetailsDiffer(editingProfile, form) || Boolean(form.sshPassword || form.sshKeyPassphrase || form.password)
    : false;

  const savedSsh = pendingLocalSetup ? undefined : editingProfile?.security?.ssh;
  const formSsh = form.security?.ssh;
  const hasSavedSshPassword = savedSsh?.authentication === "password" && formSsh?.host === savedSsh.host
    && formSsh?.port === savedSsh.port && formSsh?.username === savedSsh.username;

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void platform
      .listDataSources()
      .then((next) => { if (current) setProfiles(next); })
      .catch((reason: unknown) => {
        if (current) setError(connectionFailure(reason).message);
      });
    return () => { current = false; };
  }, [enabled, platform, sourcesRevision]);

  function updateField<Key extends keyof SaveDataSourceInput>(
    key: Key,
    value: SaveDataSourceInput[Key],
  ) {
    setTestState({ status: "idle" });
    setError(undefined);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateSshSecurity(security: ConnectionSecurity) {
    setTestState({ status: "idle" });
    setError(undefined);
    setForm((current) => {
      const old = current.security?.ssh;
      const next = security.ssh;
      const sameKey = old && next && old.authentication === next.authentication
        && old.host === next.host && old.port === next.port && old.username === next.username
        && old.privateKey === next.privateKey;
      return { ...current, security, sshKeyPassphrase: sameKey ? current.sshKeyPassphrase : "" };
    });
  }

  async function pickSqlite(folder: boolean) {
    if (!enabled || pending) return;
    setPending(true);
    try {
      const path = await platform.pickWorkspacePath(folder ? "sqliteDirectory" : "openSqlite");
      if (!path) return;
      updateField("sqlite", folder ? { path: form.sqlite?.path ?? "", accessDirectory: path } : { path });
    } catch (reason) { setError(connectionFailure(reason).message); }
    finally { setPending(false); }
  }

  async function capture(sourceId: string) {
    const result = await platform.capturePostgresSnapshot(sourceId);
    onSnapshot(result);
  }

  async function testConnection() {
    if (!enabled || pending || testController.current) return;
    const controller = new AbortController();
    testController.current = controller;
    setPending(true);
    setError(undefined);
    setTestState({ status: "testing", progress: { phase: "configuration", sshConnected: false } });
    try {
      const result = await platform.testPostgresConnection(form, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (testController.current === controller && !controller.signal.aborted) setTestState({ status: "testing", progress });
        },
      });
      if (testController.current !== controller) return;
      if (controller.signal.aborted) setTestState((current) => ({ status: "cancelled", progress: current.status === "testing" ? current.progress : undefined }));
      else setTestState({ status: "success", result });
    } catch (reason) {
      if (testController.current !== controller) return;
      const failure = connectionFailure(reason);
      if (failure.code === "passwordRequired") setConnectionTab("general");
      if (controller.signal.aborted || failure.stage === "cancelled") setTestState((current) => ({ status: "cancelled", progress: current.status === "testing" ? current.progress : undefined }));
      else setTestState((current) => ({ status: "error", failure, progress: current.status === "testing" ? current.progress : undefined }));
    } finally {
      if (testController.current === controller) {
        testController.current = null;
        setPending(false);
      }
    }
  }

  function cancelConnectionTest() {
    const controller = testController.current;
    if (!controller || controller.signal.aborted) return;
    setTestState((current) => current.status === "testing" ? { ...current, cancelling: true } : current);
    controller.abort();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || pending) return;
    if ((!editingProfile || requiresLiveVerification) && testState.status !== "success") return;
    if (editingProfile && requiresLiveVerification) {
      await verifyAndRefreshEditingSource();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      if (editingProfile) {
        const profile = await platform.saveDataSource(form);
        onSourceSaved?.(profile);
        setProfiles((current) => [
          profile,
          ...current.filter((item) => item.id !== profile.id),
        ]);
        setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
        setEditingProfile(profile);
        setDialogOpen(false);
        return;
      }
      await platform.testPostgresConnection(form);
      const profile = await platform.saveDataSource(form);
      onSourceSaved?.(profile);
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      await capture(profile.id);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
      setDialogOpen(false);
    } catch (reason) {
      if (typeof reason === "object" && reason !== null && "stage" in reason) {
        setTestState({ status: "error", failure: connectionFailure(reason) });
      } else {
        setTestState({ status: "idle" });
        setError(connectionFailure(reason).message);
      }
    } finally {
      setPending(false);
    }
  }

  async function verifyAndRefreshEditingSource() {
    if (!enabled || pending || !editingProfile) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await platform.verifyAndRefreshDataSource(form);
      const profile = result.profile;
      onSourceSaved?.(profile);
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      onSnapshot(result.capture);
      setOpenError((current) => current?.profile.id === profile.id ? undefined : current);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "", sshKeyPassphrase: "" }));
      setEditingProfile(profile);
      setDialogOpen(false);
    } catch (reason) {
      if (typeof reason === "object" && reason !== null && "stage" in reason) {
        setTestState({ status: "error", failure: connectionFailure(reason) });
      } else {
        setTestState({ status: "idle" });
        setError(connectionFailure(reason).message);
      }
    } finally {
      setPending(false);
    }
  }

  async function openSavedSnapshot(profile: DataSourceProfile) {
    const snapshots = await platform.listSnapshots(profile.id);
    const latest = snapshots[0];
    if (!latest) {
      throw new MissingSchemaSnapshotError(bt("business.missingSchemaSnapshot", { value0: bt("business.verifyRefresh") }));
    }
    const snapshot = await platform.getSnapshot(latest.id);
    onSnapshot({ snapshot, stored: false, changeSet: null });
  }

  async function handleExistingOpen(profile: DataSourceProfile) {
    if (!enabled || pending) return;
    if (profile.connectionSync?.pending) {
      openEditDialog(profile);
      return;
    }
    onSourceOpenStart?.();
    setPending(true);
    setError(undefined);
    setOpenError(undefined);
    try {
      await openSavedSnapshot(profile);
    } catch (reason) {
      setOpenError({
        context: openContext,
        profile,
        message: connectionFailure(reason).message,
        missingSnapshot: reason instanceof MissingSchemaSnapshotError,
      });
    } finally {
      setPending(false);
    }
  }

  function openCreateDialog() {
    setForm(newConnectionForm(defaultDatabaseType, defaultSslMode, bt("business.localDevelopment")));
    setEditingProfile(undefined);
    setError(undefined);
    setTestState({ status: "idle" });
    setConnectionTab("general");
    setDialogOpen(true);
  }

  function openEditDialog(profile: DataSourceProfile) {
    setForm({ ...profile, password: "", sshPassword: "", sshKeyPassphrase: "" });
    setEditingProfile(profile);
    setError(undefined);
    setTestState({ status: "idle" });
    setConnectionTab("general");
    setDialogOpen(true);
  }

  function closeDialog() {
    if (pending) return;
    setDialogOpen(false);
    setForm((current) => ({ ...current, password: "", sshPassword: "", sshKeyPassphrase: "" }));
    setError(undefined);
  }

  async function deleteSource(profile: DataSourceProfile) {
    if (!enabled || pending || deleteConfirmation) return false;
    const confirmed = await new Promise<boolean>((resolve) => setDeleteConfirmation({ profile, resolve }));
    if (!confirmed) return false;
    setPending(true);
    setError(undefined);
    try {
      await platform.clearCredentials(profile.id, { database: profile.databaseType !== "sqlite", ai: true, cloud: true });
      await platform.deleteSourceData(profile.id, {
        deleteConnection: true,
        deleteHistory: true,
        deleteSemantics: true,
        removeDatabaseCredential: false,
      });
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setOpenError((current) => current?.profile.id === profile.id ? undefined : current);
      if (profile.id === editingProfile?.id) {
        setDialogOpen(false);
        setEditingProfile(undefined);
      }
      onSourceDeleted?.(profile.id);
      const nextProfile = profiles.find((item) => item.id !== profile.id);
      if (profile.id === activeSourceId && nextProfile) {
        // Loading the next model is separate from the completed deletion.
        await openSavedSnapshot(nextProfile).catch((reason: unknown) => setError(connectionFailure(reason).message));
      }
      return true;
    } finally {
      setPending(false);
    }
  }

  function finishDeleteConfirmation(confirmed: boolean) {
    setDeleteConfirmation(undefined);
    deleteConfirmation?.resolve(confirmed);
  }

  const activeProfile = profiles.find((profile) => profile.id === activeSourceId);
  const visibleMenu = menu?.context === openContext ? menu : undefined;
  const menuProfile = visibleMenu && visibleMenu.trigger !== navigation.current ? activeProfile : undefined;
  // A successful open from another entry point supersedes this attempt, even
  // when its rejection arrives after the workspace has already changed.
  const visibleOpenError = openError?.context === openContext ? openError : undefined;

  function openConnectionMenu(event: MouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) {
    if (dialogOpen || managerOpen) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    const fromNavigation = trigger === navigation.current;
    setMenu({
      x: pointer ? event.clientX : bounds.left + (fromNavigation ? 12 : 0),
      y: pointer ? event.clientY : fromNavigation ? bounds.top + 40 : bounds.bottom,
      trigger,
      context: openContext,
    });
  }

  return (
    <section ref={navigation} className="connection-stack model-navigation" aria-label={bt("business.dataSources")} tabIndex={0}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('button, input, select, textarea, a, [role="dialog"], [role="menu"], .tree-row')) return;
        openConnectionMenu(event);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        openConnectionMenu(event);
      }}>
      <header className="source-navigation-heading">
        <h2 id="data-sources-title">{bt("business.databases")}</h2>
        <button type="button" className="create-connection-button" aria-label={bt("business.addDatabase")} onClick={openCreateDialog} disabled={!enabled || pending}><span aria-hidden="true">＋</span> {bt("business.add")}</button>
      </header>
      {profiles.length > 0 ? <div className="source-navigation-current">
        <DataSourcePicker profiles={profiles} activeProfile={activeProfile} disabled={!enabled || pending}
          onSelect={(profile) => { void handleExistingOpen(profile); }}
          onEdit={openEditDialog} onManage={() => setManagerOpen("manage")} onContextMenu={openConnectionMenu} />
      </div> : null}
      {visibleOpenError ? <div className="ds-surface connection-open-error">
        <ActionIcon name="warning" />
        <div className="connection-open-error-content">
          <div role="alert">
            <strong>{bt("business.couldNotOpenDatabase", { value0: visibleOpenError.profile.database })}</strong>
            <p>{visibleOpenError.message}</p>
          </div>
          <Button size="small" disabled={!enabled || pending} onClick={() => {
            if (visibleOpenError.missingSnapshot) openEditDialog(visibleOpenError.profile);
            else void handleExistingOpen(visibleOpenError.profile);
          }}>
            {bt(visibleOpenError.missingSnapshot ? "business.editConnection" : "business.retryOpeningDatabase")}
          </Button>
        </div>
      </div> : null}
      {visibleMenu ? <SchemaObjectMenu x={visibleMenu.x} y={visibleMenu.y}
        name={menuProfile?.database ?? bt("business.databases")}
        actions={[
          { label: bt("business.newConnection"), disabled: !enabled || pending, run: openCreateDialog },
          { label: bt("business.manageConnections"), disabled: !enabled || pending, run: () => setManagerOpen("manage") },
          { label: bt("business.refreshSchema"), separatorBefore: true, disabled: !activeProfile || !onRefresh || refreshDisabled || pending, run: () => onRefresh?.() },
        ]} onClose={(restoreFocus) => {
          setMenu(undefined);
          if (restoreFocus) (visibleMenu.trigger.isConnected ? visibleMenu.trigger : navigation.current)?.focus();
        }} /> : null}
      {managerOpen ? <ConnectionManager profiles={profiles} activeSourceId={activeSourceId} pending={pending} platform={platform}
        startWithImport={managerOpen === "import"} onClose={() => setManagerOpen(undefined)}
        onCreate={() => { setManagerOpen(undefined); openCreateDialog(); }}
        onEdit={(profile) => { setManagerOpen(undefined); openEditDialog(profile); }}
        onOpen={(profile) => { setManagerOpen(undefined); if (profile.id !== activeSourceId) void handleExistingOpen(profile); }}
        onImported={(added) => {
          const ids = new Set(added.map(({ id }) => id));
          setProfiles((current) => [...current.filter(({ id }) => !ids.has(id)), ...added]);
          for (const profile of added) onSourceSaved?.(profile);
        }}
        onDelete={deleteSource} /> : null}
      {profiles.length > 0 ? (
        <div className="saved-sources">
          {activeProfile ? <div key={activeProfile.id}><ConnectionSourceContext.Provider value={activeProfile}>{children}</ConnectionSourceContext.Provider></div> : null}
        </div>
      ) : (<>
        <button type="button" className="empty-data-source" onClick={openCreateDialog} disabled={!enabled}>
          <strong>{bt("business.noDatabaseConnected")}</strong>
          <span>{bt("business.createAConnectionToMapItsSchema")}</span>
        </button>
        {enabled ? <Button className="connection-sync-shortcut" onClick={() => setManagerOpen("import")} disabled={pending}>{bt("connectionSync.open")}</Button> : null}
      </>
      )}

      {!enabled ? <p className="connection-note">{bt("business.installTheDesktopAppToConnectADatabase")}</p> : null}
      {error && !dialogOpen ? <p className="error-message connection-status">{error}</p> : null}

      {deleteConfirmation ? <ModalSurface labelledBy="delete-connection-title" describedBy="delete-connection-detail" onDismiss={() => finishDeleteConfirmation(false)}>
        <div className="connection-confirmation-backdrop">
          <section className="ds-surface connection-confirmation">
            <h2 id="delete-connection-title">{bt("business.deleteConnectionConfirmation", { value0: deleteConfirmation.profile.displayName })}</h2>
            <p id="delete-connection-detail">{bt("business.deleteConnectionImpact")}</p>
            <footer>
              <Button data-modal-focus onClick={() => finishDeleteConfirmation(false)}>{bt("business.cancel")}</Button>
              <Button variant="danger" onClick={() => finishDeleteConfirmation(true)}>{bt("businessMeta.delete")}</Button>
            </footer>
          </section>
        </div>
      </ModalSurface> : null}

      {dialogOpen ? (
        <ModalSurface labelledBy="connection-dialog-title" describedBy="connection-dialog-description" onDismiss={closeDialog}>
        <div className="connection-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section className="connection-dialog">
            <header>
              <div>
                <h2 id="connection-dialog-title">
                  {editingProfile ? bt("business.edit", { value0: editingProfile.displayName }) : bt("business.createDatabaseConnection")}
                </h2>
              </div>
              <button type="button" className="dialog-close-button" aria-label={bt("business.closeConnectionDialog")} onClick={closeDialog} disabled={pending}>×</button>
            </header>
            <p id="connection-dialog-description" className="dialog-description">
              {form.databaseType === "sqlite" ? bt("sqlite.readonly") : editingProfile
                ? bt("business.testConnectionChangesBeforeSavingExistingPasswordsAreReused")
                : bt("business.addADatabaseVerifyAccessAndCreateItsFirst")}
            </p>
            <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
              {form.databaseType !== "sqlite" ? <div className="connection-tabs" role="tablist" aria-label={bt("business.connectionSettings")}>
                {([['general', bt("business.connection")], ['tls', 'TLS'], ['ssh', 'SSH']] as const).filter(([tab]) => form.databaseType !== 'sqlite' || tab === 'general').map(([tab, label]) => <button key={tab} type="button" role="tab" id={`connection-tab-${tab}`} aria-controls={`connection-panel-${tab}`} aria-selected={connectionTab === tab} tabIndex={connectionTab === tab ? 0 : -1} onClick={() => setConnectionTab(tab)} onKeyDown={(event) => {
                  const tabs: ("general" | "tls" | "ssh")[] = form.databaseType === "sqlite" ? ["general"] : ["general", "tls", "ssh"];
                  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                  event.preventDefault();
                  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + direction + tabs.length) % tabs.length;
                  setConnectionTab(tabs[index]);
                  document.getElementById(`connection-tab-${tabs[index]}`)?.focus();
                }}>{label}{tab === 'ssh' && form.security?.ssh ? <span className="connection-tab-dot" aria-label={bt("business.enabled")} /> : null}</button>)}
              </div> : null}
              <div className="connection-dialog-body">
              <div className="connection-tab-panel" role={form.databaseType === "sqlite" ? undefined : "tabpanel"} id="connection-panel-general" aria-labelledby={form.databaseType === "sqlite" ? undefined : "connection-tab-general"} hidden={connectionTab !== "general"}>
              <section className="connection-form-section">
                <div className="connection-form-grid connection-identity-grid">
                  <label>
                    {bt("business.name")}<input data-modal-focus={editingProfile ? true : undefined} value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.databaseEngine")}<select
                      data-modal-focus={editingProfile ? undefined : true}
                      value={form.databaseType}
                      onChange={(event) => {
                        const databaseType = event.target.value as SaveDataSourceInput["databaseType"];
                        setTestState({ status: "idle" });
                        setError(undefined);
                        setConnectionTab("general");
                        setForm((current) => ({
                          ...current,
                          databaseType,
                          sqlite: undefined,
                          port: databaseType === "mySql" ? 3306 : 5432,
                          ...(databaseType === "sqlite" || current.databaseType === "sqlite"
                            ? { password: "", sshPassword: "", sshKeyPassphrase: "", security: undefined, sslMode: databaseType === "sqlite" ? "disable" as const : defaultSslMode }
                            : {}),
                        }));
                      }}
                      disabled={!enabled || pending}
                    >
                      <option value="postgreSql">PostgreSQL</option>
                      <option value="mySql">MySQL</option>
                      <option value="sqlite">SQLite</option>
                    </select>
                  </label>
                  {form.databaseType === "sqlite" ? <div className="sqlite-file-fields">
                    <label htmlFor="sqlite-file-path">{bt("sqlite.file")}</label>
                    <div className="sqlite-file-picker">
                      <input id="sqlite-file-path" readOnly value={form.sqlite?.path ?? ""} title={form.sqlite?.path} placeholder={bt("sqlite.noFile")} aria-invalid={testState.status === "error" || undefined} aria-describedby={testState.status !== "idle" ? "connection-test-detail" : "sqlite-file-help"} />
                      <button className="secondary-button" type="button" aria-label={bt("sqlite.choose")} disabled={pending} onClick={() => void pickSqlite(false)}>{bt("sqlite.chooseShort")}</button>
                    </div>
                    <p id="sqlite-file-help" className="connection-field-help">{bt("sqlite.fileHelp")}</p>
                    <details className="sqlite-file-access">
                      <summary>{bt("sqlite.fileAccess")}</summary>
                      <div>
                        <p>{bt("sqlite.folderHelp")}</p>
                        <button className="secondary-button" type="button" disabled={pending || !form.sqlite?.path} onClick={() => void pickSqlite(true)}>{bt("sqlite.folder")}</button>
                        {form.sqlite?.accessDirectory ? <small title={form.sqlite.accessDirectory}>{form.sqlite.accessDirectory}</small> : null}
                      </div>
                    </details>
                  </div> : <><label className="connection-host-field">
                    {bt("business.host")}<input value={form.host} onChange={(event) => updateField("host", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.port")}<input type="number" min={1} max={65535} value={form.port} onChange={(event) => updateField("port", Number(event.target.value))} disabled={!enabled || pending} />
                  </label>
                  <label className="connection-database-field">
                    {bt("business.database")}<input value={form.database} onChange={(event) => updateField("database", event.target.value)} disabled={!enabled || pending} />
                  </label></>}
                </div>
              </section>

              <section hidden={form.databaseType === "sqlite"} className="connection-form-section" aria-labelledby="connection-access-title">
                <div className="connection-section-heading">
                  <strong id="connection-access-title">{bt("business.accessSecurity")}</strong>
                  <span className="connection-keychain-status">{bt("business.systemCredentialStorage")}</span>
                </div>
                <div className="connection-form-grid connection-access-grid">
                  <label>
                    {bt("business.username")}<input autoComplete="username" value={form.username} onChange={(event) => updateField("username", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.password")}<input aria-label={bt("business.password")} type="password" autoComplete="current-password" placeholder={editingProfile && !pendingLocalSetup ? bt("business.optionalKeepCurrentPassword") : bt("business.databasePassword")} value={form.password} onChange={(event) => updateField("password", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <p className="connection-credential-note">
                    {editingProfile && !pendingLocalSetup
                      ? bt("business.leaveBlankToKeepThePasswordAlreadyStoredIn")
                      : bt("business.thePasswordIsSavedToTheSystemCredentialStore")}
                  </p>
                </div>
              </section>
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-tls" aria-labelledby="connection-tab-tls" hidden={form.databaseType === "sqlite" || connectionTab !== "tls"}>
                <div className="connection-security-setting">
                  <div>
                    <strong>{bt("business.transportSecurity")}</strong>
                    <span>{sslModeDescriptions[form.sslMode]}</span>
                  </div>
                  <label>
                    <span>{bt("business.sSLMode")}</span>
                    <select value={form.sslMode} onChange={(event) => updateField("sslMode", event.target.value as SslMode)} disabled={!enabled || pending}>
                      <option value="disable">{bt("business.disable")}</option>
                      <option value="prefer">{bt("business.prefer")}</option>
                      <option value="require">{bt("business.require")}</option>
                      <option value="verifyCa">{bt("business.verifyCA")}</option>
                      <option value="verifyFull">{bt("business.verifyFull")}</option>
                    </select>
                  </label>
                </div>
                <ConnectionSecurityFields section="tls" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={(security) => updateField("security", security)} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={hasSavedSshPassword} />
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-ssh" aria-labelledby="connection-tab-ssh" hidden={form.databaseType === "sqlite" || connectionTab !== "ssh"}>
                <ConnectionSecurityFields section="ssh" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={updateSshSecurity} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={hasSavedSshPassword} sshKeyPassphrase={form.sshKeyPassphrase} onSshKeyPassphraseChange={(passphrase) => updateField("sshKeyPassphrase", passphrase)} />
              </div>
                {editingProfile && !requiresLiveVerification && testState.status === "idle" ? (
                  <div className="connection-live-action">
                    <div>
                      <strong>{bt("business.liveDatabase")}</strong>
                      <span>
                        {requiresLiveVerification
                          ? bt("business.connectionDetailsChangedVerifyBeforeSavingAndReplaceThe")
                          : bt(form.databaseType === "sqlite" ? "sqlite.refreshSavedFile" : "business.connectNowUsingTheSavedDatabasePasswordAndReplace")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void verifyAndRefreshEditingSource()}
                      disabled={!enabled || pending}
                    >
                      {pending ? bt("business.working") : bt("business.verifyRefresh")}
                    </button>
                  </div>
                ) : null}
              <ConnectionTestStatus state={testState} form={form} onCancel={cancelConnectionTest} />
              {requiresLiveVerification && testState.status === "idle" ? <p className="connection-test-hint">{bt(pendingLocalSetup
                ? form.databaseType === "sqlite" ? "connectionSync.setupSqlite" : "connectionSync.setupNetwork"
                : "business.connectionDetailsChangedTestTheConnectionBeforeSaving")}</p> : null}
              {error ? <p className="error-message" role="alert">{error}</p> : null}
              </div>
              <footer>
                <div className="connection-footer-leading">
                  <button type="button" className="secondary-button" onClick={() => void testConnection()} disabled={!enabled || pending}>{testState.status === "testing" ? bt("business.testing") : bt("business.testConnection")}</button>
                {editingProfile ? (
                  <div className="connection-danger-action">
                    <button type="button" className="delete-source-button" onClick={() => {
                      void deleteSource(editingProfile).catch((reason: unknown) => setError(connectionFailure(reason).message));
                    }} disabled={pending}>{bt("business.deleteDataSource")}</button>
                    <span>{bt("business.removesLocalDataOnly")}</span>
                  </div>
                ) : null}
                </div>
                <div className="connection-footer-actions">
                  <button type="button" className="secondary-button" onClick={closeDialog} disabled={pending}>{bt("business.cancel")}</button>

                  <button type="submit" className="connection-primary-button" disabled={!enabled || pending || ((!editingProfile || requiresLiveVerification) && testState.status !== "success")}>

                    {pending && testState.status !== "testing" ? (editingProfile ? bt("business.saving") : bt("business.readingSchema")) : editingProfile ? bt("business.saveChanges") : bt("business.saveAndMap")}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
        </ModalSurface>
      ) : null}
    </section>
  );
}
