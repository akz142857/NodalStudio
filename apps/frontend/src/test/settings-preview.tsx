// Development-only visual fixture: synthetic settings, no persistence or network calls.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPage } from "../components/SettingsPage";
import { defaultEffectiveSettings, type DataSourceProfile, type NodalStudioPlatform } from "../platform";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
const initial = defaultEffectiveSettings(params.get("source") === "none" ? undefined : "preview-source");
initial.app.general.theme = params.get("theme") === "light" ? "light" : params.get("theme") === "system" ? "system" : "dark";
initial.app.appearance.uiFontSize = params.get("font") === "18" ? 18 : 13;
initial.app.appearance.density = params.get("density") === "compact" ? "compact" : "comfortable";
initial.app.general.language = params.get("language") === "zh-CN" ? "zhCn" : params.get("language") === "en" ? "en" : "system";
initial.app.notifications.quietHoursEnabled = true;
initial.app.advanced.betaFeatures = true;
if (initial.source) {
  initial.source.ai = { ...initial.source.ai, provider: "openAiCompatible", model: "preview-model", endpoint: "https://api.example.test/v1", enabled: true };
  initial.source.cloud = { ...initial.source.cloud, endpoint: "https://sync.example.test", viewerUrl: "https://viewer.example.test", accountLabel: "Preview account", teamId: "preview-team", projectId: "preview-project", enabled: true, credentialConfigured: params.get("bootstrap") !== "1" };
}
if (params.get("managed") === "1") initial.managed = [{ path: "privacy.offlineMode", source: "Preview organization", reason: "Policy fixture" }];
const profile: DataSourceProfile = { id: "preview-source", displayName: "Product development", host: "localhost", port: 5432, database: "studio_preview", username: "preview", databaseType: "postgreSql", sslMode: "prefer", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
const noop = () => Promise.resolve();
const platform = {
  getStorageUsage: () => Promise.resolve({ snapshotBytes: 4096000, semanticBytes: 12288, layoutBytes: 4096, syncQueueBytes: 2048, settingsBytes: 8192, snapshotCount: 24 }),
  getSecurityStatus: () => Promise.resolve({ databaseCredentialConfigured: true, aiCredentialConfigured: false, cloudCredentialConfigured: true, weakSslSources: 0, staleModelSources: 0, unresolvedGitConflictReports: 0, failedOrConflictedSyncItems: 0 }),
  listExternalAccess: () => Promise.resolve([]),
  listSyncDiagnostics: () => Promise.resolve([{ id: "preview", eventKind: "Semantics updated", state: "pending", attempts: 0 }]),
  listCloudAudit: () => Promise.resolve([]),
  listCloudShares: () => Promise.resolve([]),
  getDiagnosticInfo: () => Promise.resolve({ appVersion: "0.1.0", rustVersion: "1.95", target: "aarch64-apple-darwin", dataDirectory: "/Preview/Application Support/NodalStudio", logDirectory: "/Preview/Logs/NodalStudio" }),
  testAiProvider: () => Promise.resolve({ provider: "Preview", model: "preview-model", testedAt: "2026-10-21T00:00:00Z", networkUsed: false }),
  checkForUpdates: () => Promise.resolve({ phase: "upToDate", currentVersion: "0.1.0", availableVersion: null, notes: "Synthetic preview; no request was sent.", downloadedBytes: 0, totalBytes: null, checkedAt: null, error: null, configured: true, canDownload: false, canInstall: false }),
  getUpdateStatus: () => Promise.resolve({ phase: "idle", currentVersion: "0.1.0", availableVersion: null, downloadedBytes: 0, totalBytes: null, checkedAt: null, error: null, configured: true, canDownload: false, canInstall: false }),
} as unknown as NodalStudioPlatform;

export function Preview() {
  const [settings, setSettings] = useState(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.app.general.theme;
    document.documentElement.dataset.density = settings.app.appearance.density;
    document.documentElement.dataset.reduceMotion = String(settings.app.appearance.reduceMotion);
    document.documentElement.style.setProperty("--ui-font-size", `${settings.app.appearance.uiFontSize}px`);
  }, [settings.app]);
  return <SettingsPage settings={settings} runtime={{ kind: params.get("runtime") === "web" ? "web" : "desktop", label: "Preview", version: "0.1.0" }} dataSources={settings.source ? [profile] : []} activeSourceId={settings.source?.sourceId}
    activeDatabase={{ name: "studio_preview", databaseType: "postgreSql", version: "17" }} platform={platform} onClose={() => window.history.back()}
    onUpdateApp={(app) => { setSettings((current) => ({ ...current, app })); return Promise.resolve(); }}
    onUpdateSource={(source) => { setSettings((current) => ({ ...current, source })); return Promise.resolve(); }}
    onResetApp={() => { setSettings((current) => ({ ...current, app: defaultEffectiveSettings().app })); return Promise.resolve(); }}
    onResetSource={noop} onReload={noop} onDataSourcesChanged={noop} onFactoryReset={noop} />;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
