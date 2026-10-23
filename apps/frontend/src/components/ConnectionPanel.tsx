import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ConnectionTestStatus } from "./ConnectionTestStatus";
import { connectionFailure, type ConnectionTestState } from "./connection-test-state";
import { ConnectionSecurityFields } from "./ConnectionSecurityFields";
import { ConnectionManager } from "./ConnectionManager";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import { ActionIcon } from "./ActionIcon";
import "./model-navigation.css";
import { TreeDisclosureIcon } from "./TreeDisclosureIcon";
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
  /** The schema tree for the active source, rendered as that row's children. */
  children?: ReactNode;
  platform: NodalStudioPlatform;
  onSnapshot: (result: CaptureSnapshotResult) => void;
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
): SaveDataSourceInput {
  return {
    ...initialForm,
    databaseType,
    port: databaseType === "mySql" ? 3306 : 5432,
    sslMode,
  };
}

const sslModeDescriptions: Record<SslMode, string> = {
  disable: "TLS is disabled for this connection.",
  prefer: "Use TLS when available; this mode can fall back to an unencrypted connection.",
  require: "Require encryption without verifying the server identity.",
  verifyCa: "Require TLS and verify the certificate authority.",
  verifyFull: "Require TLS and verify the database server identity.",
};

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

export function ConnectionPanel({ enabled, activeSourceId, children, platform, onSnapshot, onSourceDeleted, onRefresh, refreshDisabled, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const navigation = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [managerOpen, setManagerOpen] = useState(false);
  const [form, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const testController = useRef<AbortController | null>(null);
  useEffect(() => () => { testController.current?.abort(); testController.current = null; }, []);
  const [testState, setTestState] = useState<ConnectionTestState>({ status: "idle" });
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"general" | "tls" | "ssh">("general");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();
  const [disclosure, setDisclosure] = useState({ sourceId: activeSourceId, collapsed: false });
  // Selecting another source opens its directory; refreshing this source keeps
  // the user's disclosure choice and never reloads the canvas just to toggle it.
  if (disclosure.sourceId !== activeSourceId) setDisclosure({ sourceId: activeSourceId, collapsed: false });
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

  async function handleExistingOpen(profile: DataSourceProfile) {
    setPending(true);
    setError(undefined);
    setConnectionResult(undefined);
    try {
      const snapshots = await platform.listSnapshots(profile.id);
      const latest = snapshots[0];
      if (!latest) {
        throw new Error("This data source has no saved schema snapshot. Edit the connection to create one.");
      }
      const snapshot = await platform.getSnapshot(latest.id);
      onSnapshot({ snapshot, stored: false, changeSet: null });
    } catch (reason) {
      setError(connectionFailure(reason).message);
    } finally {
      setPending(false);
    }
  }

  function openCreateDialog() {
    setForm(newConnectionForm(defaultDatabaseType, defaultSslMode));
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
      `Delete “${editingProfile.displayName}”?\n\nThis permanently removes its local snapshots, semantics, settings, and saved credentials. The database itself is not changed.`,
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
      setProfiles((current) => current.filter((profile) => profile.id !== editingProfile.id));
      setDialogOpen(false);
      onSourceDeleted?.(editingProfile.id);
    } catch (reason) {
      setError(connectionFailure(reason).message);
    } finally {
      setPending(false);
    }
  }

  const activeProfile = profiles.find((profile) => profile.id === activeSourceId);
  const expanded = !disclosure.collapsed;

  return (
    <section ref={navigation} className="connection-stack model-navigation" aria-label="Data sources" tabIndex={0}
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
        <h2 id="data-sources-title">Databases</h2>
        <button type="button" className="create-connection-button" aria-label="Add database" onClick={openCreateDialog} disabled={!enabled || pending}><span aria-hidden="true">＋</span> Add</button>
      </header>
      {activeProfile ? <div className="source-navigation-current">
        <div className="source-navigation-picker">
          <div className="source-navigation-summary" aria-hidden="true">
            <ActionIcon name="database" />
            <div><strong>{activeProfile.displayName}</strong><span>{activeProfile.database}</span></div>
            <ActionIcon name="chevronDown" />
          </div>
          <select id="active-data-source" aria-label="Data source" value={activeProfile.id} disabled={pending} title={`Switch database: ${activeProfile.displayName} — ${activeProfile.database}`} onChange={(event) => {
            const profile = profiles.find((item) => item.id === event.target.value);
            if (profile && profile.id !== activeSourceId) void handleExistingOpen(profile);
          }}>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
          </select>
        </div>
        <div className="source-navigation-details">
          <span>{activeProfile.databaseType === "mySql" ? "MySQL" : "PostgreSQL"}</span>
          <button type="button" aria-label={`Edit ${activeProfile.displayName}`} title="Edit connection" disabled={pending} onClick={() => openEditDialog(activeProfile)}>Edit connection…</button>
        </div>
        <button className="source-disclosure" type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${activeProfile.displayName}`} aria-expanded={expanded} onClick={() => setDisclosure({ sourceId: activeSourceId, collapsed: expanded })}><TreeDisclosureIcon open={expanded} /><span>Model navigation</span></button>
      </div> : null}
      {menu ? <SchemaObjectMenu {...menu} name="Databases" actions={[
        { label: "New connection…", disabled: !enabled || pending, run: openCreateDialog },
        { label: "Manage connections…", disabled: !enabled || pending, run: () => setManagerOpen(true) },
        { label: "Refresh schema", separatorBefore: true, disabled: !activeProfile || !onRefresh || refreshDisabled || pending, run: () => onRefresh?.() },
      ]} onClose={(restore) => { setMenu(undefined); if (restore) navigation.current?.focus(); }} /> : null}
      {managerOpen ? <ConnectionManager profiles={profiles} activeSourceId={activeSourceId} onClose={() => setManagerOpen(false)}
        onCreate={() => { setManagerOpen(false); openCreateDialog(); }}
        onEdit={(profile) => { setManagerOpen(false); openEditDialog(profile); }}
        onOpen={(profile) => { setManagerOpen(false); if (profile.id !== activeSourceId) void handleExistingOpen(profile); }} /> : null}
      {profiles.length > 0 ? (
        <div className="saved-sources">
          {profiles.filter((profile) => !activeProfile || profile.id === activeSourceId).map((profile) => {
            const active = profile.id === activeSourceId;
            const expanded = active && !(disclosure.sourceId === profile.id && disclosure.collapsed);
            return (
              <div className="tree-node" key={profile.id}>
                <div className="tree-row tree-row-source" data-active={active || undefined} hidden={active}>
                  <button
                    type="button"
                    className="tree-row-main"
                    aria-label={active ? `${expanded ? "Collapse" : "Expand"} ${profile.displayName}` : `Open local snapshot for ${profile.displayName}`}
                    aria-expanded={expanded}
                    title={`${profile.host}:${profile.port}/${profile.database}`}
                    disabled={pending}
                    onClick={() => {
                      if (active) setDisclosure({ sourceId: profile.id, collapsed: expanded });
                      else void handleExistingOpen(profile);
                    }}
                  >
                    <TreeDisclosureIcon open={expanded} />
                    <span className="tree-label">{profile.displayName}</span>
                  </button>
                  <button
                    type="button"
                    className="tree-row-action"
                    aria-label={`Edit ${profile.displayName}`}
                    title="Edit connection"
                    disabled={pending}
                    onClick={() => openEditDialog(profile)}
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                </div>
                {active ? <div hidden={!expanded}>{children}</div> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <button type="button" className="empty-data-source" onClick={openCreateDialog} disabled={!enabled}>
          <strong>No database connected</strong>
          <span>Create a connection to map its schema.</span>
        </button>
      )}

      {!enabled ? <p className="connection-note">Install the desktop app to connect a database.</p> : null}
      {connectionResult ? (
        <p className="success-message connection-status">
          Connected to {connectionResult.database.name} · {connectionResult.database.databaseType === "mySql" ? "MySQL" : "PostgreSQL"} {connectionResult.database.version}
          {` · SSL ${connectionResult.sslActive === null ? "unknown" : connectionResult.sslActive ? "active" : "off"}`}
          {` · server ${connectionResult.serverReadOnly === null ? "read-only unknown" : connectionResult.serverReadOnly ? "read-only" : "writes allowed"}`}
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
                    ? `${editingProfile.databaseType === "mySql" ? "MySQL" : "PostgreSQL"} data source`
                    : "New data source"}
                </span>
                <h2 id="connection-dialog-title">
                  {editingProfile ? `Edit ${editingProfile.displayName}` : "Create database connection"}
                </h2>
              </div>
              <button type="button" className="dialog-close-button" aria-label="Close connection dialog" onClick={closeDialog} disabled={pending}>×</button>
            </header>
            <p className="dialog-description">
              {editingProfile
                ? "Test connection changes before saving. Existing passwords are reused when left blank."
                : "Add a database, verify access, and create its first local schema snapshot."}
            </p>
            <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
              <div className="connection-tabs" role="tablist" aria-label="Connection settings">
                {([['general', 'Connection'], ['tls', 'TLS'], ['ssh', 'SSH']] as const).map(([tab, label]) => <button key={tab} type="button" role="tab" id={`connection-tab-${tab}`} aria-controls={`connection-panel-${tab}`} aria-selected={connectionTab === tab} tabIndex={connectionTab === tab ? 0 : -1} onClick={() => setConnectionTab(tab)} onKeyDown={(event) => {
                  const tabs = ['general', 'tls', 'ssh'] as const;
                  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                  event.preventDefault();
                  const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(tab) + direction + 3) % 3;
                  setConnectionTab(tabs[index]);
                  document.getElementById(`connection-tab-${tabs[index]}`)?.focus();
                }}>{label}{tab === 'ssh' && form.security?.ssh ? <span className="connection-tab-dot" aria-label="Enabled" /> : null}</button>)}
              </div>
              <div className="connection-dialog-body">
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-general" aria-labelledby="connection-tab-general" hidden={connectionTab !== "general"}>
              <section className="connection-form-section" aria-labelledby="connection-identity-title">
                <div className="connection-section-heading">
                  <strong id="connection-identity-title">Connection</strong>
                  <span>Name and network location</span>
                </div>
                <div className="connection-form-grid connection-identity-grid">
                  <label>
                    Name
                    <input autoFocus={Boolean(editingProfile)} value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    Database engine
                    <select
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
                    Host
                    <input value={form.host} onChange={(event) => updateField("host", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    Port
                    <input type="number" min={1} max={65535} value={form.port} onChange={(event) => updateField("port", Number(event.target.value))} disabled={!enabled || pending} />
                  </label>
                  <label className="connection-database-field">
                    Database
                    <input value={form.database} onChange={(event) => updateField("database", event.target.value)} disabled={!enabled || pending} />
                  </label>
                </div>
              </section>

              <section className="connection-form-section" aria-labelledby="connection-access-title">
                <div className="connection-section-heading">
                  <strong id="connection-access-title">Access & security</strong>
                  <span className="connection-keychain-status">System credential storage</span>
                </div>
                <div className="connection-form-grid connection-access-grid">
                  <label>
                    Username
                    <input autoComplete="username" value={form.username} onChange={(event) => updateField("username", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <label>
                    Password
                    <input aria-label="Password" type="password" autoComplete="current-password" placeholder={editingProfile ? "Optional — keep current password" : "Database password"} value={form.password} onChange={(event) => updateField("password", event.target.value)} disabled={!enabled || pending} />
                  </label>
                  <p className="connection-credential-note">
                    {editingProfile
                      ? "Leave blank to keep the password already stored in the system credential store."
                      : "The password is saved to the system credential store after the connection succeeds."}
                  </p>
                </div>
              </section>
              </div>
              <div className="connection-tab-panel" role="tabpanel" id="connection-panel-tls" aria-labelledby="connection-tab-tls" hidden={connectionTab !== "tls"}>
                <div className="connection-security-setting">
                  <div>
                    <strong>Transport security</strong>
                    <span>{sslModeDescriptions[form.sslMode]}</span>
                  </div>
                  <label>
                    <span>SSL mode</span>
                    <select value={form.sslMode} onChange={(event) => updateField("sslMode", event.target.value as SslMode)} disabled={!enabled || pending}>
                      <option value="disable">Disable</option>
                      <option value="prefer">Prefer</option>
                      <option value="require">Require</option>
                      <option value="verifyCa">Verify CA</option>
                      <option value="verifyFull">Verify full</option>
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
                      <strong>Live database</strong>
                      <span>
                        {requiresLiveVerification
                          ? "Connection details changed. Verify before saving and replace the saved schema snapshot."
                          : "Connect now using the saved database password and replace the saved schema snapshot."}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void verifyAndRefreshEditingSource()}
                      disabled={!enabled || pending}
                    >
                      {pending ? "Working…" : "Verify & refresh"}
                    </button>
                  </div>
                ) : null}
              <ConnectionTestStatus state={testState} form={form} onCancel={cancelConnectionTest} />
              {requiresLiveVerification && testState.status === "idle" ? <p className="connection-test-hint">Connection details changed. Test the connection before saving.</p> : null}
              {error ? <p className="error-message" role="alert">{error}</p> : null}
              <footer>
                {editingProfile ? (
                  <div className="connection-danger-action">
                    <button type="button" className="delete-source-button" onClick={() => void deleteEditingSource()} disabled={pending}>Delete data source</button>
                    <span>Removes local data only</span>
                  </div>
                ) : <span />}
                <div className="connection-footer-actions">
                  <button type="button" className="secondary-button" onClick={closeDialog} disabled={pending}>Cancel</button>
                  <button type="button" className="secondary-button" onClick={() => void testConnection()} disabled={!enabled || pending}>{testState.status === "testing" ? "Testing…" : "Test connection"}</button>
                  <button type="submit" disabled={!enabled || pending || ((!editingProfile || requiresLiveVerification) && testState.status !== "success")}>

                    {pending && testState.status !== "testing" ? (editingProfile ? "Saving…" : "Reading schema…") : editingProfile ? "Save changes" : "Save and map"}
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
