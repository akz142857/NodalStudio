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

export function ConnectionPanel({ enabled, platform, onSnapshot, defaultDatabaseType, defaultSslMode }: ConnectionPanelProps) {
  const [form, setForm] = useState<SaveDataSourceInput>(() => ({ ...initialForm, databaseType: defaultDatabaseType, port: defaultDatabaseType === "mySql" ? 3306 : 5432, sslMode: defaultSslMode }));
  const [profiles, setProfiles] = useState<DataSourceProfile[]>([]);
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    void platform
      .listDataSources()
      .then(setProfiles)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [enabled, platform]);

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
    try {
      const testResult = await platform.testPostgresConnection(form);
      const profile = await platform.saveDataSource(form);
      setConnectionResult(testResult);
      setProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      await capture(profile.id);
      setForm((current) => ({ ...current, id: profile.id, password: "" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  async function handleExistingCapture(profile: DataSourceProfile) {
    setPending(true);
    setError(undefined);
    setForm({ ...profile, password: "" });
    try {
      await capture(profile.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="connection-stack">
      {profiles.length > 0 ? (
        <div className="saved-sources">
          {profiles.map((profile) => (
            <button
              type="button"
              key={profile.id}
              disabled={pending}
              onClick={() => void handleExistingCapture(profile)}
            >
              <strong>{profile.displayName}</strong>
              <span>
                {profile.host}:{profile.port}/{profile.database}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <form className="connection-panel" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          Database engine
          <select
            value={form.databaseType}
            onChange={(event) => {
              const databaseType = event.target.value as SaveDataSourceInput["databaseType"];
              setForm((current) => ({
                ...current,
                databaseType,
                port: databaseType === "mySql" ? 3306 : 5432,
              }));
            }}
            disabled={!enabled || pending}
          >
            <option value="postgreSql">PostgreSQL</option>
            <option value="mySql">MySQL</option>
          </select>
        </label>
        <label htmlFor="display-name">Name</label>
        <input
          id="display-name"
          value={form.displayName}
          onChange={(event) => updateField("displayName", event.target.value)}
          disabled={!enabled || pending}
        />
        <div className="connection-row">
          <label>
            Host
            <input
              value={form.host}
              onChange={(event) => updateField("host", event.target.value)}
              disabled={!enabled || pending}
            />
          </label>
          <label>
            Port
            <input
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(event) => updateField("port", Number(event.target.value))}
              disabled={!enabled || pending}
            />
          </label>
        </div>
        <label>
          Database
          <input
            value={form.database}
            onChange={(event) => updateField("database", event.target.value)}
            disabled={!enabled || pending}
          />
        </label>
        <label>
          Username
          <input
            autoComplete="username"
            value={form.username}
            onChange={(event) => updateField("username", event.target.value)}
            disabled={!enabled || pending}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(event) => updateField("password", event.target.value)}
            disabled={!enabled || pending}
          />
        </label>
        <label>
          SSL mode
          <select
            value={form.sslMode}
            onChange={(event) => updateField("sslMode", event.target.value as SslMode)}
            disabled={!enabled || pending}
          >
            <option value="disable">Disable</option>
            <option value="prefer">Prefer</option>
            <option value="require">Require</option>
            <option value="verifyCa">Verify CA</option>
            <option value="verifyFull">Verify full</option>
          </select>
        </label>
        <button type="submit" disabled={!enabled || pending || form.password.length === 0}>
          {pending ? "Reading schema…" : "Save and map"}
        </button>
        {!enabled ? <p>Install the desktop app to connect a database.</p> : null}
        {connectionResult ? (
          <p className="success-message">
            Connected to {connectionResult.database.name} · {connectionResult.database.databaseType === "mySql" ? "MySQL" : "PostgreSQL"} {connectionResult.database.version}
            {` · SSL ${connectionResult.sslActive === null ? "unknown" : connectionResult.sslActive ? "active" : "off"}`}
            {` · server ${connectionResult.serverReadOnly === null ? "read-only unknown" : connectionResult.serverReadOnly ? "read-only" : "writes allowed"}`}
          </p>
        ) : null}
        {error ? <p className="error-message">{error}</p> : null}
      </form>
    </div>
  );
}
