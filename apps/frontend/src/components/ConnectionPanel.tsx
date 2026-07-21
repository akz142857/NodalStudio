import { type FormEvent, useEffect, useState } from "react";
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

export function ConnectionPanel({ enabled, platform, onSnapshot, onSourceDeleted, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const [form, setForm] = useState<SaveDataSourceInput>(() => newConnectionForm(defaultDatabaseType, defaultSslMode));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DataSourceProfile>();

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
          {profiles.map((profile) => (
            <article className="saved-source" key={profile.id}>
              <button
                type="button"
                className="source-open-button"
                aria-label={`Open ${profile.displayName}`}
                disabled={pending}
                onClick={() => void handleExistingOpen(profile)}
              >
                <strong>{profile.displayName}</strong>
                <span>
                  {profile.host}:{profile.port}/{profile.database}
                </span>
              </button>
              <button
                type="button"
                className="source-edit-button"
                aria-label={`Edit ${profile.displayName}`}
                title="Edit connection"
                disabled={pending}
                onClick={() => openEditDialog(profile)}
              >
                <span aria-hidden="true">✎</span>
              </button>
            </article>
          ))}
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
                <span className="dialog-eyebrow">Data source</span>
                <h2 id="connection-dialog-title">{editingProfile ? "Edit database connection" : "Create database connection"}</h2>
              </div>
              <button type="button" className="dialog-close-button" aria-label="Close connection dialog" onClick={closeDialog} disabled={pending}>×</button>
            </header>
            <p className="dialog-description">
              {editingProfile
                ? "Update the connection and enter its password to verify access and refresh the schema."
                : "Connect securely, verify access, then create the first schema snapshot."}
            </p>
            <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
              <label>
                Database engine
                <select
                  autoFocus
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
              <label>
                Name
                <input value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} disabled={!enabled || pending} />
              </label>
              <div className="connection-row">
                <label>
                  Host
                  <input value={form.host} onChange={(event) => updateField("host", event.target.value)} disabled={!enabled || pending} />
                </label>
                <label>
                  Port
                  <input type="number" min={1} max={65535} value={form.port} onChange={(event) => updateField("port", Number(event.target.value))} disabled={!enabled || pending} />
                </label>
              </div>
              <label>
                Database
                <input value={form.database} onChange={(event) => updateField("database", event.target.value)} disabled={!enabled || pending} />
              </label>
              <div className="connection-row connection-credentials-row">
                <label>
                  Username
                  <input autoComplete="username" value={form.username} onChange={(event) => updateField("username", event.target.value)} disabled={!enabled || pending} />
                </label>
                <label>
                  Password
                  <input type="password" autoComplete="current-password" placeholder={editingProfile ? "Required to save changes" : undefined} value={form.password} onChange={(event) => updateField("password", event.target.value)} disabled={!enabled || pending} />
                </label>
              </div>
              <label>
                SSL mode
                <select value={form.sslMode} onChange={(event) => updateField("sslMode", event.target.value as SslMode)} disabled={!enabled || pending}>
                  <option value="disable">Disable</option>
                  <option value="prefer">Prefer</option>
                  <option value="require">Require</option>
                  <option value="verifyCa">Verify CA</option>
                  <option value="verifyFull">Verify full</option>
                </select>
              </label>
              {error ? <p className="error-message">{error}</p> : null}
              <footer>
                {editingProfile ? (
                  <button type="button" className="delete-source-button" onClick={() => void deleteEditingSource()} disabled={pending}>Delete data source</button>
                ) : <span />}
                <div>
                  <button type="button" className="secondary-button" onClick={closeDialog} disabled={pending}>Cancel</button>
                  <button type="submit" disabled={!enabled || pending || form.password.length === 0}>
                    {pending ? "Reading schema…" : editingProfile ? "Save changes" : "Save and map"}
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
