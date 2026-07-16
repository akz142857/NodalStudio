import { type FormEvent, useState } from "react";
import type { DataSourceSettings, NodalStudioPlatform } from "../platform";

interface CloudSyncPanelProps {
  sourceId: string;
  platform: NodalStudioPlatform;
  settings: DataSourceSettings["cloud"];
  offline: boolean;
  onOpenSettings: () => void;
}

export function CloudSyncPanel({ sourceId, platform, settings, offline, onOpenSettings }: CloudSyncPanelProps) {
  const [accessToken, setAccessToken] = useState("");
  const [version, setVersion] = useState(settings.baseVersion);
  const [status, setStatus] = useState<"idle" | "syncing" | "synced" | "error">("idle");

  async function sync(event: FormEvent) {
    event.preventDefault();
    setStatus("syncing");
    try {
      const result = await platform.syncProject({
        sourceId,
        projectId: settings.projectId,
        apiUrl: settings.endpoint,
        accessToken,
        baseVersion: version,
      });
      setVersion(result.version);
      setAccessToken("");
      setStatus("synced");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="cloud-sync-panel">
      <div className="section-heading">
        <h3>Cloud sharing</h3>
        <span>{offline ? "Offline" : settings.enabled ? "Enabled" : "Off"}</span>
      </div>
      <p>Off by default. Uploads schema metadata and team knowledge only.</p>
      {settings.enabled && !offline ? (
        <form onSubmit={(event) => void sync(event)}>
          <p>{settings.endpoint || "Cloud endpoint not configured"}</p>
          <p>Project: {settings.projectId || "Not configured"}</p>
          <input aria-label="Cloud access token" type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="Token (blank uses Keychain)" />
          <button type="submit" disabled={status === "syncing" || !settings.endpoint || !settings.projectId}>
            {status === "syncing" ? "Syncing…" : "Publish metadata"}
          </button>
          <small data-status={status}>
            {status === "synced" ? `Synced · version ${version}` : status === "error" ? "Sync failed or conflicted" : `Cloud version ${version}`}
          </small>
        </form>
      ) : <button type="button" className="panel-settings-link" onClick={onOpenSettings}>Configure in Settings → Cloud Sync</button>}
    </section>
  );
}
