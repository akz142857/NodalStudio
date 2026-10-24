import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure, type ConnectionTestState } from "./connection-test-state";
import { ConnectionSecurityFields } from "./ConnectionSecurityFields";
import { ConnectionManager } from "./ConnectionManager";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import { DataSourcePicker } from "./DataSourcePicker";
import "./model-navigation.css";
import type {
  DataSourceProfile,
  CaptureSnapshotResult,
  ConnectionTestResult,
  NodalStudioPlatform,
  SaveDataSourceInput,
  SslMode,
} from "../platform";

interface ConnectionPanelProps {
  enabled: boolean;
  /** The source whose snapshot is on the canvas; its objects nest beneath it. */
  activeSourceId?: string;
  /** The schema tree rendered below the active source's picker. */
  children?: ReactNode;
  platform: NodalStudioPlatform;
  onSnapshot: (result: CaptureSnapshotResult) => void;
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
  sslMode: "prefer",
};

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
    profile.host.trim() !== form.host.trim() ||
    profile.port !== form.port ||
    profile.database.trim() !== form.database.trim() ||
    profile.username.trim() !== form.username.trim() ||
    profile.sslMode !== form.sslMode ||
    JSON.stringify(profile.security ?? { tls: {} }) !== JSON.stringify(form.security ?? { tls: {} })
  );
}

export function ConnectionPanel({ enabled, activeSourceId, children, platform, onSnapshot, onSourceOpenStart, onSourceDeleted, onRefresh, refreshDisabled, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const { t: bt } = useI18n();
  const sslModeDescriptions: Record<SslMode, string> = {
  disable: bt("business.tLSIsDisabledForThisConnection"),
  prefer: bt("business.useTLSWhenAvailableThisModeCanFallBack"),
  require: bt("business.requireEncryptionWithoutVerifyingTheServerIdentity"),
  verifyCa: bt("business.requireTLSAndVerifyTheCertificateAuthority"),
  verifyFull: bt("business.requireTLSAndVerifyTheDatabaseServerIdentity"),
};
  const navigation = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [managerOpen, setManagerOpen] = useState(false);
  const [form, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode, bt("business.localDevelopment")));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const testController = useRef<AbortController | null>(null);
  useEffect(() => () => { testController.current?.abort(); testController.current = null; }, []);
  const [testState, setTestState] = useState<ConnectionTestState>({ status: "idle" });
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult>();
  const [error, setError] = useState<string>();
  const openContext = useMemo(() => ({ sourceId: activeSourceId }), [activeSourceId]);
  const [openError, setOpenError] = useState<{ context: typeof openContext; profile: DataSourceProfile; message: string }>();
  const [pending, setPending] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"general" | "tls" | "ssh">("general");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();
  const requiresLiveVerification = editingProfile
    ? connectionDetailsDiffer(editingProfile, form) || Boolean(form.sshPassword) || Boolean(form.password)
    : false;

  useEffect(() => {
    if (!enabled) return;
    void platform
      .listDataSources()
      .then(setProfiles)
      .catch((reason: unknown) => {
        setError(connectionFailure(reason).message);
      });
  }, [enabled, platform]);

  useEffect(() => {
    if (!dialogOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        setDialogOpen(false);
        setForm((current) => ({ ...current, password: "", sshPassword: "" }));
        setError(undefined);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dialogOpen, pending]);

  function updateField<Key extends keyof SaveDataSourceInput>(
    key: Key,
    value: SaveDataSourceInput[Key],
  ) {
    setTestState({ status: "idle" });
    setError(undefined);
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function capture(sourceId: string) {
    const result = await platform.capturePostgresSnapshot(sourceId);
    onSnapshot(result);
  }

  async function testConnection() {
    if (testController.current) return;
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
    if ((!editingProfile || requiresLiveVerification) && testState.status !== "success") return;
    if (editingProfile && requiresLiveVerification) {
      await verifyAndRefreshEditingSource();
      return;
    }
    setPending(true);
    setError(undefined);
    setConnectionResult(undefined);
    try {
      if (editingProfile) {
        const profile = await platform.saveDataSource(form);
        setProfiles((current) => [
          profile,
          ...current.filter((item) => item.id !== profile.id),
        ]);
        setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "" }));
        setEditingProfile(profile);
        setDialogOpen(false);
        return;
      }
      const testResult = await platform.testPostgresConnection(form);
      const profile = await platform.saveDataSource(form);
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      await capture(profile.id);
      setConnectionResult(testResult);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "" }));
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
    if (!editingProfile) return;
    setPending(true);
    setError(undefined);
    setConnectionResult(undefined);
    try {
      const result = await platform.verifyAndRefreshDataSource(form);
      const profile = result.profile;
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      onSnapshot(result.capture);
      setConnectionResult(result.connection);
      setForm((current) => ({ ...current, id: profile.id, password: "", sshPassword: "" }));
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
      throw new Error(bt("business.thisDataSourceHasNoSavedSchemaSnapshotEdit"));
    }
    const snapshot = await platform.getSnapshot(latest.id);
    onSnapshot({ snapshot, stored: false, changeSet: null });
  }

  async function handleExistingOpen(profile: DataSourceProfile) {
    onSourceOpenStart?.();
    setPending(true);
    setError(undefined);
    setOpenError(undefined);
    setConnectionResult(undefined);
    try {
      await openSavedSnapshot(profile);
    } catch (reason) {
      setOpenError({ context: openContext, profile, message: connectionFailure(reason).message });
    } finally {
      setPending(false);
    }
  }

  function openCreateDialog() {
    setForm(newConnectionForm(defaultDatabaseType, defaultSslMode, bt("business.localDevelopment")));
    setEditingProfile(undefined);
    setConnectionResult(undefined);
    setError(undefined);
    setTestState({ status: "idle" });
    setConnectionTab("general");
    setDialogOpen(true);
  }

  function openEditDialog(profile: DataSourceProfile) {
    setForm({ ...profile, password: "", sshPassword: "" });
    setEditingProfile(profile);
    setConnectionResult(undefined);
    setError(undefined);
    setTestState({ status: "idle" });
    setConnectionTab("general");
    setDialogOpen(true);
  }

  function closeDialog() {
    if (pending) return;
    setDialogOpen(false);
    setForm((current) => ({ ...current, password: "", sshPassword: "" }));
    setError(undefined);
  }

  async function deleteEditingSource() {
    if (!editingProfile) return;
    const confirmed = window.confirm(
      bt("business.deleteThisPermanentlyRemovesItsLocalSnapshotsSemanticsSettings", { value0: editingProfile.displayName }),
    );
    if (!confirmed) return;
    setPending(true);
    setError(undefined);
    try {
      await platform.clearCredentials(editingProfile.id, { database: true, ai: true, cloud: true });
      await platform.deleteSourceData(editingProfile.id, {
        deleteConnection: true,
        deleteHistory: true,
        deleteSemantics: true,
        removeDatabaseCredential: false,
      });
      const remaining = profiles.filter((profile) => profile.id !== editingProfile.id);
      setProfiles(remaining);
      setDialogOpen(false);
      setEditingProfile(undefined);
      setConnectionResult(undefined);
      onSourceDeleted?.(editingProfile.id);
      // Removing the current source should keep the workspace useful. Opening
      // the next saved model uses local snapshots and needs no live connection.
      if (editingProfile.id === activeSourceId && remaining[0]) {
        await openSavedSnapshot(remaining[0]);
      }
    } catch (reason) {
      setError(connectionFailure(reason).message);
    } finally {
      setPending(false);
    }
  }

  const activeProfile = profiles.find((profile) => profile.id === activeSourceId);
  // A successful open from another entry point supersedes this attempt, even
  // when its rejection arrives after the workspace has already changed.
  const visibleOpenError = openError?.context === openContext ? openError : undefined;

  return (
    <section ref={navigation} className="connection-stack model-navigation" aria-label={bt("business.dataSources")} tabIndex={0}
      onContextMenu={(event) => {
        if (dialogOpen || managerOpen) return;
        if ((event.target as Element).closest('button, input, select, textarea, a, [role="dialog"], [role="menu"], .tree-row')) return;
        event.preventDefault(); event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenu({ x: bounds.left + 12, y: bounds.top + 40 });
      }}>
      <header className="source-navigation-heading">
        <h2 id="data-sources-title">{bt("business.databases")}</h2>
        <button type="button" className="create-connection-button" aria-label={bt("business.addDatabase")} onClick={openCreateDialog} disabled={!enabled || pending}><span aria-hidden="true">＋</span> {bt("business.add")}</button>
      </header>
      {profiles.length > 0 ? <div className="source-navigation-current">
        <DataSourcePicker profiles={profiles} activeProfile={activeProfile} disabled={!enabled || pending}
          onSelect={(profile) => { void handleExistingOpen(profile); }}
          onEdit={openEditDialog} onManage={() => setManagerOpen(true)} />
      </div> : null}
      {visibleOpenError ? <div className="connection-status error-message" role="alert">
        <p>{bt("business.couldNotOpen")} {visibleOpenError.profile.database}. {visibleOpenError.message}</p>
        <button type="button" disabled={pending} onClick={() => { void handleExistingOpen(visibleOpenError.profile); }}>{bt("business.retryOpeningDatabase")}</button>
      </div> : null}
      {menu ? <SchemaObjectMenu {...menu} name={bt("business.databases")} actions={[
        { label: bt("business.newConnection"), disabled: !enabled || pending, run: openCreateDialog },
        { label: bt("business.manageConnections"), disabled: !enabled || pending, run: () => setManagerOpen(true) },
        { label: bt("business.refreshSchema"), separatorBefore: true, disabled: !activeProfile || !onRefresh || refreshDisabled || pending, run: () => onRefresh?.() },
      ]} onClose={(restore) => { setMenu(undefined); if (restore) navigation.current?.focus(); }} /> : null}
      {managerOpen ? <ConnectionManager profiles={profiles} activeSourceId={activeSourceId} onClose={() => setManagerOpen(false)}
        onCreate={() => { setManagerOpen(false); openCreateDialog(); }}
        onEdit={(profile) => { setManagerOpen(false); openEditDialog(profile); }}
        onOpen={(profile) => { setManagerOpen(false); if (profile.id !== activeSourceId) void handleExistingOpen(profile); }} /> : null}
      {profiles.length > 0 ? (
        <div className="saved-sources">
          {activeProfile ? <div key={activeProfile.id}>{children}</div> : null}
        </div>
      ) : (
        <button type="button" className="empty-data-source" onClick={openCreateDialog} disabled={!enabled}>
          <strong>{bt("business.noDatabaseConnected")}</strong>
          <span>{bt("business.createAConnectionToMapItsSchema")}</span>
        </button>
      )}

      {!enabled ? <p className="connection-note">{bt("business.installTheDesktopAppToConnectADatabase")}</p> : null}
      {connectionResult ? (
        <p className="success-message connection-status">
          {bt("business.connectedTo")} {connectionResult.database.name} · {connectionResult.database.databaseType === "mySql" ? "MySQL" : "PostgreSQL"} {connectionResult.database.version}
          {bt("business.sSL", { value0: connectionResult.sslActive === null ? translateUiLabel("unknown", bt) : connectionResult.sslActive ? translateUiLabel("active", bt) : translateUiLabel("off", bt) })}
          {bt("business.server", { value0: connectionResult.serverReadOnly === null ? translateUiLabel("read-only unknown", bt) : connectionResult.serverReadOnly ? translateUiLabel("read-only", bt) : translateUiLabel("writes allowed", bt) })}
        </p>
      ) : null}
      {error && !dialogOpen ? <p className="error-message connection-status">{error}</p> : null}

      {dialogOpen ? (
        <div className="connection-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title">
            <header>
              <div>
                <span className="dialog-eyebrow">
                  {editingProfile
                    ? bt("business.dataSource", { value0: editingProfile.databaseType === "mySql" ? "MySQL" : "PostgreSQL" })
                    : bt("business.newDataSource")}
                </span>
                <h2 id="connection-dialog-title">
                  {editingProfile ? bt("business.edit", { value0: editingProfile.displayName }) : bt("business.createDatabaseConnection")}
                </h2>
              </div>
              <button type="button" className="dialog-close-button" aria-label={bt("business.closeConnectionDialog")} onClick={closeDialog} disabled={pending}>×</button>
            </header>
            <p className="dialog-description">
              {editingProfile
                ? bt("business.testConnectionChangesBeforeSavingExistingPasswordsAreReused")
                : bt("business.addADatabaseVerifyAccessAndCreateItsFirst")}
            </p>
            <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
              <div className="connection-tabs" role="tablist" aria-label={bt("business.connectionSettings")}>
                {([['general', bt("business.connection")], ['tls', 'TLS'], ['ssh', 'SSH']] as const).map(([tab, label]) => <button key={tab} type="button" role="tab" id={`connection-tab-${tab}`} aria-controls={`connection-panel-${tab}`} aria-selected={connectionTab === tab} tabIndex={connectionTab === tab ? 0 : -1} onClick={() => setConnectionTab(tab)} onKeyDown={(event) => {
                  const tabs = ['general', 'tls', 'ssh'] as const;
                  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                  event.preventDefault();
                  const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(tab) + direction + 3) % 3;
                  setConnectionTab(tabs[index]);
                  document.getElementById(`connection-tab-${tabs[index]}`)?.focus();
                }}>{label}{tab === 'ssh' && form.security?.ssh ? <span className="connection-tab-dot" aria-label={bt("business.enabled")} /> : null}</button>)}
              </div>
              <div className="connection-dialog-body">
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-general" aria-labelledby="connection-tab-general" hidden={connectionTab !== "general"}>
              <section className="connection-form-section" aria-labelledby="connection-identity-title">
                <div className="connection-section-heading">
                  <strong id="connection-identity-title">{bt("business.connection")}</strong>
                  <span>{bt("business.nameAndNetworkLocation")}</span>
                </div>
                <div className="connection-form-grid connection-identity-grid">
                  <label>
                    {bt("business.name")}<input autoFocus={Boolean(editingProfile)} value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.databaseEngine")}<select
                      autoFocus={!editingProfile}
                      value={form.databaseType}
                      onChange={(event) => {
                        const databaseType = event.target.value as SaveDataSourceInput["databaseType"];
                        setTestState({ status: "idle" });
                        setError(undefined);
                        setForm((current) => ({ ...current, databaseType, port: databaseType === "mySql" ? 3306 : 5432 }));
                      }}
                      disabled={!enabled || pending}
                    >
                      <option value="postgreSql">PostgreSQL</option>
                      <option value="mySql">MySQL</option>
                    </select>
                  </label>
                  <label className="connection-host-field">
                    {bt("business.host")}<input value={form.host} onChange={(event) => updateField("host", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.port")}<input type="number" min={1} max={65535} value={form.port} onChange={(event) => updateField("port", Number(event.target.value))} disabled={!enabled || pending} />
                  </label>
                  <label className="connection-database-field">
                    {bt("business.database")}<input value={form.database} onChange={(event) => updateField("database", event.target.value)} disabled={!enabled || pending} />
                  </label>
                </div>
              </section>

              <section className="connection-form-section" aria-labelledby="connection-access-title">
                <div className="connection-section-heading">
                  <strong id="connection-access-title">{bt("business.accessSecurity")}</strong>
                  <span className="connection-keychain-status">{bt("business.systemCredentialStorage")}</span>
                </div>
                <div className="connection-form-grid connection-access-grid">
                  <label>
                    {bt("business.username")}<input autoComplete="username" value={form.username} onChange={(event) => updateField("username", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    {bt("business.password")}<input aria-label={bt("business.password")} type="password" autoComplete="current-password" placeholder={editingProfile ? bt("business.optionalKeepCurrentPassword") : bt("business.databasePassword")} value={form.password} onChange={(event) => updateField("password", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <p className="connection-credential-note">
                    {editingProfile
                      ? bt("business.leaveBlankToKeepThePasswordAlreadyStoredIn")
                      : bt("business.thePasswordIsSavedToTheSystemCredentialStore")}
                  </p>
                </div>
              </section>
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-tls" aria-labelledby="connection-tab-tls" hidden={connectionTab !== "tls"}>
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
                <ConnectionSecurityFields section="tls" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={(security) => updateField("security", security)} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={Boolean(editingProfile?.security?.ssh?.authentication === "password" && form.security?.ssh?.host === editingProfile.security.ssh.host && form.security?.ssh?.port === editingProfile.security.ssh.port && form.security?.ssh?.username === editingProfile.security.ssh.username)} />
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-ssh" aria-labelledby="connection-tab-ssh" hidden={connectionTab !== "ssh"}>
                <ConnectionSecurityFields section="ssh" security={form.security} sslMode={form.sslMode} disabled={!enabled || pending} platform={platform} onChange={(security) => updateField("security", security)} sshPassword={form.sshPassword} onSshPasswordChange={(password) => updateField("sshPassword", password)} hasSavedSshPassword={Boolean(editingProfile?.security?.ssh?.authentication === "password" && form.security?.ssh?.host === editingProfile.security.ssh.host && form.security?.ssh?.port === editingProfile.security.ssh.port && form.security?.ssh?.username === editingProfile.security.ssh.username)} />
              </div>
              </div>
                {editingProfile && !requiresLiveVerification && testState.status === "idle" ? (
                  <div className="connection-live-action">
                    <div>
                      <strong>{bt("business.liveDatabase")}</strong>
                      <span>
                        {requiresLiveVerification
                          ? bt("business.connectionDetailsChangedVerifyBeforeSavingAndReplaceThe")
                          : bt("business.connectNowUsingTheSavedDatabasePasswordAndReplace")}
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
              {requiresLiveVerification && testState.status === "idle" ? <p className="connection-test-hint">{bt("business.connectionDetailsChangedTestTheConnectionBeforeSaving")}</p> : null}
              {error ? <p className="error-message" role="alert">{error}</p> : null}
              <footer>
                {editingProfile ? (
                  <div className="connection-danger-action">
                    <button type="button" className="delete-source-button" onClick={() => void deleteEditingSource()} disabled={pending}>{bt("business.deleteDataSource")}</button>
                    <span>{bt("business.removesLocalDataOnly")}</span>
                  </div>
                ) : <span />}
                <div className="connection-footer-actions">
                  <button type="button" className="secondary-button" onClick={closeDialog} disabled={pending}>{bt("business.cancel")}</button>
                  <button type="button" className="secondary-button" onClick={() => void testConnection()} disabled={!enabled || pending}>{testState.status === "testing" ? bt("business.testing") : bt("business.testConnection")}</button>
                  <button type="submit" disabled={!enabled || pending || ((!editingProfile || requiresLiveVerification) && testState.status !== "success")}>

                    {pending && testState.status !== "testing" ? (editingProfile ? bt("business.saving") : bt("business.readingSchema")) : editingProfile ? bt("business.saveChanges") : bt("business.saveAndMap")}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
