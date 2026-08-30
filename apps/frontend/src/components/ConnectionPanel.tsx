import { type FormEvent, type ReactNode, useEffect, useState } from "react";
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
  prefer: "Use TLS when the database server supports it.",
  require: "Require an encrypted connection.",
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
    profile.sslMode !== form.sslMode
  );
}

export function ConnectionPanel({ enabled, activeSourceId, children, platform, onSnapshot, onSourceDeleted, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const [form, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();
  const requiresLiveVerification = editingProfile
    ? connectionDetailsDiffer(editingProfile, form)
    : false;

  useEffect(() => {
    if (!enabled) return;
    void platform
      .listDataSources()
      .then(setProfiles)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [enabled, platform]);

  useEffect(() => {
    if (!dialogOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        setDialogOpen(false);
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
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function capture(sourceId: string) {
    const result = await platform.capturePostgresSnapshot(sourceId);
    onSnapshot(result);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setConnectionResult(undefined);
    try {
      if (editingProfile) {
        if (requiresLiveVerification) {
          throw new Error("Verify and refresh the live database before saving connection detail changes.");
        }
        const profile = await platform.saveDataSource(form);
        setProfiles((current) => [
          profile,
          ...current.filter((item) => item.id !== profile.id),
        ]);
        setForm((current) => ({ ...current, id: profile.id, password: "" }));
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
      setForm((current) => ({ ...current, id: profile.id, password: "" }));
      setDialogOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
      setForm((current) => ({ ...current, id: profile.id, password: "" }));
      setEditingProfile(profile);
      setDialogOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  function openCreateDialog() {
    setForm(newConnectionForm(defaultDatabaseType, defaultSslMode));
    setEditingProfile(undefined);
    setConnectionResult(undefined);
    setError(undefined);
    setDialogOpen(true);
  }

  function openEditDialog(profile: DataSourceProfile) {
    setForm({ ...profile, password: "" });
    setEditingProfile(profile);
    setConnectionResult(undefined);
    setError(undefined);
    setDialogOpen(true);
  }

  function closeDialog() {
    if (pending) return;
    setDialogOpen(false);
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
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="connection-stack" aria-labelledby="data-sources-title">
      <header className="section-heading connection-heading">
        <div>
          <h2 id="data-sources-title">Data sources</h2>
          <span>{profiles.length}</span>
        </div>
        <button type="button" className="create-connection-button" onClick={openCreateDialog} disabled={!enabled || pending}>
          <span aria-hidden="true">＋</span> Create
        </button>
      </header>
      {profiles.length > 0 ? (
        <div className="saved-sources">
          {profiles.map((profile) => {
            const active = profile.id === activeSourceId;
            return (
              <div className="tree-node" key={profile.id}>
                <div className="tree-row tree-row-source" data-active={active || undefined}>
                  <button
                    type="button"
                    className="tree-row-main"
                    aria-label={`Open local snapshot for ${profile.displayName}`}
                    aria-expanded={active}
                    title={`${profile.host}:${profile.port}/${profile.database}`}
                    disabled={pending}
                    onClick={() => void handleExistingOpen(profile)}
                  >
                    <span
                      className="tree-twisty"
                      data-open={active || undefined}
                      aria-hidden="true"
                    />
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
                {active ? children : null}
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
                ? "Update the local connection profile below. Saving changes does not contact the database."
                : "Add a database, verify access, and create its first local schema snapshot."}
            </p>
            <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
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
                  <span className="connection-keychain-status">Keychain storage</span>
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
                      ? "Leave blank to keep the password already stored in macOS Keychain."
                      : "The password is saved to macOS Keychain after the connection succeeds."}
                  </p>
                </div>
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
                {editingProfile ? (
                  <div className="connection-live-action">
                    <div>
                      <strong>Live database</strong>
                      <span>
                        {requiresLiveVerification
                          ? "Connection details changed. Verify before saving and replace the saved schema snapshot."
                          : "Connect now using the saved Keychain password and replace the saved schema snapshot."}
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
              </section>
              {error ? <p className="error-message">{error}</p> : null}
              <footer>
                {editingProfile ? (
                  <div className="connection-danger-action">
                    <button type="button" className="delete-source-button" onClick={() => void deleteEditingSource()} disabled={pending}>Delete data source</button>
                    <span>Removes local data only</span>
                  </div>
                ) : <span />}
                <div className="connection-footer-actions">
                  <button type="button" className="secondary-button" onClick={closeDialog} disabled={pending}>Cancel</button>
                  <button type="submit" disabled={!enabled || pending || requiresLiveVerification || (!editingProfile && form.password.length === 0)}>
                    {pending ? (editingProfile ? "Saving…" : "Reading schema…") : editingProfile ? "Save changes" : "Save and map"}
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
