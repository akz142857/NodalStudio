import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ModelConnectionsSettings } from "./ModelConnectionsSettings";
import {
  defaultAppSettings,
  defaultProjectSettings,
  type AppSettings,
  type DataSourceProfile,
  type DataSourceSettings,
  type EffectiveSettings,
  type RuntimeInfo,
  type NodalStudioPlatform,
  type StorageUsage,
  type SecurityStatus,
  type MergeDriverStatus,
  type UpdateCheckResult,
  type SyncDiagnostic,
  type AiProviderTestResult,
  type DiagnosticInfo,
  type CloudAuditEntry,
  type CloudShareSummary,
  type ExternalAccessRecord,
} from "../platform";

const categories = [
  ["general", "General", "language theme startup date time"],
  ["appearance", "Appearance", "density font sidebar inspector motion contrast"],
  ["canvas", "Canvas & ER", "field foreign key index relation layout comment"],
  ["code-analysis", "Code Analysis", "local project repository scan gitignore source privacy"],
  ["data-sources", "Data Sources", "database refresh timeout ssl connection"],
  ["history", "History & Storage", "snapshot retention backup cache disk"],
  ["git", "Git", "repository merge driver conflict fingerprint"],
  ["ai", "AI", "provider model context privacy explanation"],
  ["cloud", "Cloud Sync", "team project sync offline queue conflict"],
  ["privacy", "Privacy & Security", "offline diagnostics token keychain log"],
  ["notifications", "Notifications", "schema change conflict warning quiet"],
  ["shortcuts", "Keyboard Shortcuts", "keyboard command focus refresh sidebar"],
  ["updates", "Updates & About", "version update channel license logs"],
  ["advanced", "Advanced", "performance worker beta reset factory"],
] as const;

export type SettingsCategory = (typeof categories)[number][0];

type SettingsPageProps = {
  settings: EffectiveSettings;
  runtime?: RuntimeInfo;
  dataSources: DataSourceProfile[];
  activeSourceId?: string;
  initialCategory?: SettingsCategory;
  onClose: () => void;
  onUpdateApp: (settings: AppSettings) => Promise<void>;
  onUpdateSource: (settings: DataSourceSettings) => Promise<void>;
  onResetApp: () => Promise<void>;
  onResetSource: () => Promise<void>;
  platform: NodalStudioPlatform;
  onReload: () => Promise<void>;
  onDataSourcesChanged: () => Promise<void>;
  onFactoryReset: () => Promise<void>;
};

export function SettingsPage({
  settings,
  runtime,
  dataSources,
  activeSourceId,
  initialCategory = "general",
  onClose,
  onUpdateApp,
  onUpdateSource,
  onResetApp,
  onResetSource,
  platform,
  onReload,
  onDataSourcesChanged,
  onFactoryReset,
}: SettingsPageProps) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [storageUsage, setStorageUsage] = useState<StorageUsage>();
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus>();
  const [mergeStatus, setMergeStatus] = useState<MergeDriverStatus>();
  const [conflictReport, setConflictReport] = useState<{ path: string; contents: string }>();
  const [aiSecret, setAiSecret] = useState("");
  const [cloudSecret, setCloudSecret] = useState("");
  const [operationError, setOperationError] = useState("");
  const [settingsFilePath, setSettingsFilePath] = useState("");
  const [operationMessage, setOperationMessage] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>();
  const [syncDiagnostics, setSyncDiagnostics] = useState<SyncDiagnostic[]>([]);
  const [cloudAudit, setCloudAudit] = useState<CloudAuditEntry[]>([]);
  const [externalAccess, setExternalAccess] = useState<ExternalAccessRecord[]>([]);
  const [aiTestResult, setAiTestResult] = useState<AiProviderTestResult>();
  const [diagnosticInfo, setDiagnosticInfo] = useState<DiagnosticInfo>();
  const [aboutDocument, setAboutDocument] = useState<"releaseNotes" | "license" | "notices">();
  const [performanceSnapshot, setPerformanceSnapshot] = useState<{ uptimeMs: number; domNodes: number; resourceEntries: number; heapBytes: number | null }>();
  const [eventTriggerScript, setEventTriggerScript] = useState("");
  const [cloudEmail, setCloudEmail] = useState("");
  const [cloudDisplayName, setCloudDisplayName] = useState("");
  const [cloudTeamName, setCloudTeamName] = useState("");
  const [cloudBootstrapSecret, setCloudBootstrapSecret] = useState("");
  const [cloudProjectName, setCloudProjectName] = useState("");
  const [aiDraft, setAiDraft] = useState(settings.source?.ai);
  const [cloudDraft, setCloudDraft] = useState(settings.source?.cloud);
  const [shortcutQuery, setShortcutQuery] = useState("");
  const filteredCategories = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? categories.filter((item) => `${item[1]} ${item[2]}`.toLowerCase().includes(normalized))
      : categories;
  }, [query]);
  const visibleCategory = filteredCategories.some(([id]) => id === category)
    ? category
    : (filteredCategories[0]?.[0] ?? category);
  const shortcutConflicts = useMemo(() => {
    const byBinding = new Map<string, string[]>();
    for (const [command, binding] of Object.entries(settings.app.shortcuts.bindings)) {
      const normalized = binding.trim().toLowerCase();
      if (!normalized) continue;
      byBinding.set(normalized, [...(byBinding.get(normalized) ?? []), command]);
    }
    return new Map([...byBinding].filter(([, commands]) => commands.length > 1));
  }, [settings.app.shortcuts.bindings]);

  async function saveApp(next: AppSettings) {
    setSaveState("saving");
    try {
      await onUpdateApp(next);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function saveSource(next: DataSourceSettings) {
    setSaveState("saving");
    try {
      await onUpdateSource(next);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  function chooseCategory(next: SettingsCategory) {
    setCategory(next);
    window.history.replaceState(null, "", `#/settings/${next}`);
  }

  const app = settings.app;
  const source = settings.source;
  const ai = aiDraft ?? source?.ai;
  const cloud = cloudDraft ?? source?.cloud;
  const historySettings = source?.storage ?? app.history;
  const isManaged = (path: string) => settings.managed.find((item) => item.path === path || path.startsWith(`${item.path}.`));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAiDraft(settings.source?.ai);
      setCloudDraft(settings.source?.cloud);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [settings.source]);

  function saveHistory(patch: Partial<DataSourceSettings["storage"]>) {
    if (source) {
      void saveSource({ ...source, storage: { ...source.storage, ...patch } });
    } else {
      void saveApp({ ...app, history: { ...app.history, ...patch } });
    }
  }

  async function runOperation(operation: () => Promise<void>) {
    setOperationError("");
    setOperationMessage("");
    try {
      await operation();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Operation failed.");
    }
  }

  async function confirmSourceDeletion(profile: DataSourceProfile, kind: "history" | "semantics" | "connection") {
    const impact = await platform.previewSourceDataDeletion(profile.id);
    const detail = kind === "history"
      ? `${impact.snapshotRecords} Snapshot records · approximately ${formatBytes(impact.snapshotBytes)}`
      : kind === "semantics"
        ? `${impact.semanticRecords} semantic/layout records and ${impact.pendingSyncRecords} pending sync items · approximately ${formatBytes(impact.semanticBytes + impact.syncQueueBytes)}`
        : `${impact.connectionRecords} connection record and its database Keychain credential; ${impact.snapshotRecords} Snapshots and ${impact.semanticRecords} semantic records remain local`;
    return window.confirm(`${kind === "connection" ? "Remove connection" : kind === "history" ? "Delete local Snapshot history" : "Delete local semantics, layouts, and sync queue"} for ${profile.displayName}?\n\nAffected: ${detail}.\nCloud project data is not deleted.`);
  }

  async function updateSystemNotifications(enabled: boolean) {
    if (enabled && "Notification" in window) {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setOperationError("System notification permission was not granted.");
        return;
      }
    }
    await saveApp({ ...app, notifications: { ...app.notifications, systemNotifications: enabled } });
  }

  async function updateDiagnostics(enabled: boolean) {
    if (enabled && !window.confirm("Enable anonymous diagnostics?\n\nAllowed fields: app version, runtime, operation category, duration bucket, success/failure class, and redacted error code.\n\nNever included: schema names, field names, SQL, connection details, credentials, file paths, row data, comments, or semantics.")) return;
    await saveApp({ ...app, privacy: { ...app.privacy, diagnosticsEnabled: enabled } });
  }

  function updateShortcut(command: string, binding: string) {
    const normalized = binding.trim().toLowerCase();
    const duplicate = Object.entries(app.shortcuts.bindings).find(
      ([otherCommand, otherBinding]) =>
        otherCommand !== command && normalized && otherBinding.trim().toLowerCase() === normalized,
    );
    if (duplicate) {
      setOperationError(`${binding} is already assigned to ${humanize(duplicate[0])}.`);
      return;
    }
    setOperationError("");
    void saveApp({ ...app, shortcuts: { bindings: { ...app.shortcuts.bindings, [command]: binding } } });
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={onClose}>← Back</button>
        <div>
          <p className="eyebrow">CONTROL CENTER</p>
          <h1>Settings</h1>
        </div>
        <label className="settings-search">
          <span>Search settings</span>
          <input
            autoFocus
            type="search"
            placeholder="Search settings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="settings-save-state" data-state={saveState}>
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved locally" : saveState === "error" ? "Save failed" : runtime?.label}
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings categories">
          {filteredCategories.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={visibleCategory === id ? "active" : ""}
              onClick={() => chooseCategory(id)}
            >
              {label}
            </button>
          ))}
          {filteredCategories.length === 0 ? <p>No settings found.</p> : null}
          <footer>
            <span>{runtime?.kind === "web" ? "Web Viewer" : "Desktop"}</span>
            <small>v{runtime?.version ?? "0.1.0"}</small>
          </footer>
        </nav>

        <main className="settings-content" tabIndex={-1}>
          {operationError ? <p className="settings-operation-error">{operationError}</p> : null}
          {operationMessage ? <p className="settings-operation-message">{operationMessage}</p> : null}
          {visibleCategory === "general" ? (
            <SettingsSection title="General" description="Language, theme, startup, and date preferences.">
              <SelectRow label="Language" value={app.general.language} onChange={(language) => void saveApp({ ...app, general: { ...app.general, language: language as AppSettings["general"]["language"] } })} options={[['system','Follow system'],['zhCn','简体中文'],['en','English']]} />
              <SelectRow label="Theme" value={app.general.theme} onChange={(theme) => void saveApp({ ...app, general: { ...app.general, theme: theme as AppSettings["general"]["theme"] } })} options={[['system','Follow system'],['dark','Dark'],['light','Light']]} />
              <RangeRow label="UI scale" value={app.general.uiScalePercent} min={90} max={125} unit="%" onChange={(uiScalePercent) => void saveApp({ ...app, general: { ...app.general, uiScalePercent } })} />
              <SelectRow label="Start page" value={app.general.startPage} onChange={(startPage) => void saveApp({ ...app, general: { ...app.general, startPage: startPage as AppSettings["general"]["startPage"] } })} options={[['lastDataSource','Last data source'],['connection','Connection page'],['blank','Blank workspace']]} />
              <ToggleRow label="Reopen last workspace" description="Restore the last source and view mode on launch." checked={app.general.reopenLastWorkspace} onChange={(reopenLastWorkspace) => void saveApp({ ...app, general: { ...app.general, reopenLastWorkspace } })} />
              <ToggleRow label="Confirm before quit" description="Prevent quitting while an import, sync, or write task is active." checked={app.general.confirmBeforeQuit} onChange={(confirmBeforeQuit) => void saveApp({ ...app, general: { ...app.general, confirmBeforeQuit } })} />
              <SelectRow label="Date and time format" value={app.general.dateTimeFormat} onChange={(dateTimeFormat) => void saveApp({ ...app, general: { ...app.general, dateTimeFormat: dateTimeFormat as AppSettings["general"]["dateTimeFormat"] } })} options={[['local','Local format'],['iso8601','ISO 8601']]} />
              <CategoryReset onReset={() => void saveApp({ ...app, general: defaultAppSettings().general })} />
            </SettingsSection>
          ) : null}

          {visibleCategory === "appearance" ? (
            <SettingsSection title="Appearance" description="Workspace density, accessibility, and panel defaults.">
              <SelectRow label="Information density" value={app.appearance.density} onChange={(density) => void saveApp({ ...app, appearance: { ...app.appearance, density: density as AppSettings["appearance"]["density"] } })} options={[['comfortable','Comfortable'],['compact','Compact']]} />
              <RangeRow label="UI font size" value={app.appearance.uiFontSize} min={11} max={18} unit=" px" onChange={(uiFontSize) => void saveApp({ ...app, appearance: { ...app.appearance, uiFontSize } })} />
              <RangeRow label="Table node font size" value={app.appearance.nodeFontSize} min={9} max={18} unit=" px" onChange={(nodeFontSize) => void saveApp({ ...app, appearance: { ...app.appearance, nodeFontSize } })} />
              <RangeRow label="Monospace font size" value={app.appearance.monospaceFontSize} min={9} max={18} unit=" px" onChange={(monospaceFontSize) => void saveApp({ ...app, appearance: { ...app.appearance, monospaceFontSize } })} />
              <ToggleRow label="Reduce motion" checked={app.appearance.reduceMotion} onChange={(reduceMotion) => void saveApp({ ...app, appearance: { ...app.appearance, reduceMotion } })} />
              <ToggleRow label="High contrast relations" checked={app.appearance.highContrastRelations} onChange={(highContrastRelations) => void saveApp({ ...app, appearance: { ...app.appearance, highContrastRelations } })} />
              <ToggleRow label="Color-blind friendly risk palette" checked={app.appearance.colorBlindPalette} onChange={(colorBlindPalette) => void saveApp({ ...app, appearance: { ...app.appearance, colorBlindPalette } })} />
              <RangeRow label="Left sidebar default width" value={app.appearance.leftSidebarWidth} min={220} max={480} unit=" px" onChange={(leftSidebarWidth) => void saveApp({ ...app, appearance: { ...app.appearance, leftSidebarWidth } })} />
              <ToggleRow label="Left sidebar expanded by default" checked={app.appearance.leftSidebarExpanded} onChange={(leftSidebarExpanded) => void saveApp({ ...app, appearance: { ...app.appearance, leftSidebarExpanded } })} />
              <RangeRow label="Right inspector default width" value={app.appearance.rightSidebarWidth} min={240} max={520} unit=" px" onChange={(rightSidebarWidth) => void saveApp({ ...app, appearance: { ...app.appearance, rightSidebarWidth } })} />
              <ToggleRow label="Right inspector expanded by default" checked={app.appearance.rightSidebarExpanded} onChange={(rightSidebarExpanded) => void saveApp({ ...app, appearance: { ...app.appearance, rightSidebarExpanded } })} />
              <ToggleRow label="Restore sidebar state" checked={app.appearance.restoreSidebarState} onChange={(restoreSidebarState) => void saveApp({ ...app, appearance: { ...app.appearance, restoreSidebarState } })} />
              <button type="button" className="secondary-setting-action" onClick={() => void saveApp({ ...app, appearance: defaultAppSettings().appearance })}>Reset workspace panels</button>
            </SettingsSection>
          ) : null}

          {visibleCategory === "canvas" ? (
            <SettingsSection title="Canvas & ER" description="Choose what the model shows and how relationships are laid out." managed={isManaged("canvas")}>
              <ToggleRow label="Show schema in table headers" checked={app.canvas.showSchema} onChange={(showSchema) => void saveApp({ ...app, canvas: { ...app.canvas, showSchema } })} />
              <ToggleRow label="Show table and field comments" checked={app.canvas.showColumnComments} onChange={(showColumnComments) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnComments, showTableComments: showColumnComments } })} />
              <ToggleRow label="Show column types" checked={app.canvas.showColumnTypes} onChange={(showColumnTypes) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnTypes } })} />
              <ToggleRow label="Show nullability" checked={app.canvas.showColumnNullable} onChange={(showColumnNullable) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnNullable } })} />
              <ToggleRow label="Show default values" checked={app.canvas.showColumnDefaults} onChange={(showColumnDefaults) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnDefaults } })} />
              <ToggleRow label="Show key badges" checked={app.canvas.showKeyBadges} onChange={(showKeyBadges) => void saveApp({ ...app, canvas: { ...app.canvas, showKeyBadges } })} />
              <SelectRow label="Indexes" value={app.canvas.indexes} onChange={(indexes) => void saveApp({ ...app, canvas: { ...app.canvas, indexes: indexes as AppSettings["canvas"]["indexes"] } })} options={[['expanded','Always visible'],['collapsed','Collapsed'],['hidden','Hidden']]} />
              <RangeRow label="Columns initially visible" value={app.canvas.maxInitialColumns} min={10} max={200} unit=" fields" onChange={(maxInitialColumns) => void saveApp({ ...app, canvas: { ...app.canvas, maxInitialColumns } })} />
              <ToggleRow label="Physical foreign keys" checked={app.canvas.showDeclaredRelationships} onChange={(showDeclaredRelationships) => void saveApp({ ...app, canvas: { ...app.canvas, showDeclaredRelationships } })} />
              <ToggleRow label="Inferred relationships" description="Suggestions remain visually distinct from database constraints." checked={app.canvas.showInferredRelationships} onChange={(showInferredRelationships) => void saveApp({ ...app, canvas: { ...app.canvas, showInferredRelationships } })} />
              <ToggleRow label="Field-to-field edges" checked={app.canvas.fieldLevelEdges} onChange={(fieldLevelEdges) => void saveApp({ ...app, canvas: { ...app.canvas, fieldLevelEdges } })} />
              <ToggleRow label="Relationship names" checked={app.canvas.showRelationNames} onChange={(showRelationNames) => void saveApp({ ...app, canvas: { ...app.canvas, showRelationNames } })} />
              <ToggleRow label="Cardinality" checked={app.canvas.showCardinality} onChange={(showCardinality) => void saveApp({ ...app, canvas: { ...app.canvas, showCardinality } })} />
              <ToggleRow label="Referential actions" checked={app.canvas.showReferentialActions} onChange={(showReferentialActions) => void saveApp({ ...app, canvas: { ...app.canvas, showReferentialActions } })} />
              <RangeRow label="Relationship highlight depth" value={app.canvas.relationshipHighlightDepth} min={0} max={2} unit=" hops" onChange={(relationshipHighlightDepth) => void saveApp({ ...app, canvas: { ...app.canvas, relationshipHighlightDepth } })} />
              <SelectRow label="Edge style" value={app.canvas.edgeStyle} onChange={(edgeStyle) => void saveApp({ ...app, canvas: { ...app.canvas, edgeStyle: edgeStyle as AppSettings["canvas"]["edgeStyle"] } })} options={[['orthogonal','Orthogonal'],['curved','Curved']]} />
              <SelectRow label="Layout direction" value={app.canvas.layoutDirection} onChange={(layoutDirection) => void saveApp({ ...app, canvas: { ...app.canvas, layoutDirection: layoutDirection as AppSettings["canvas"]["layoutDirection"] } })} options={[['leftToRight','Left to right'],['topToBottom','Top to bottom']]} />
              <RangeRow label="Node spacing" value={app.canvas.nodeSpacing} min={30} max={180} unit=" px" onChange={(nodeSpacing) => void saveApp({ ...app, canvas: { ...app.canvas, nodeSpacing } })} />
              <RangeRow label="Layer spacing" value={app.canvas.layerSpacing} min={40} max={300} unit=" px" onChange={(layerSpacing) => void saveApp({ ...app, canvas: { ...app.canvas, layerSpacing } })} />
              <RangeRow label="Edge spacing" value={app.canvas.edgeSpacing} min={8} max={100} unit=" px" onChange={(edgeSpacing) => void saveApp({ ...app, canvas: { ...app.canvas, edgeSpacing } })} />
              <RangeRow label="Large-model threshold" value={app.canvas.largeModelThreshold} min={100} max={2000} unit=" tables" onChange={(largeModelThreshold) => void saveApp({ ...app, canvas: { ...app.canvas, largeModelThreshold } })} />
            </SettingsSection>
          ) : null}

          {visibleCategory === "code-analysis" ? (
            <SettingsSection title="Code Analysis" description="Local repository scanning, incremental indexing, and source privacy boundaries.">
              <StatusCard status={app.codeAnalysis.enabled ? "Enabled" : "Off"} label="Source files stay local unless a later AI request is explicitly previewed and allowed." />
              <ToggleRow label="Enable local code analysis" description="Disabling keeps existing results but prevents new scans." checked={app.codeAnalysis.enabled} onChange={(enabled) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, enabled } })} />
              <ToggleRow label="Automatic incremental scans" description="Scan changed files after an already-bound project is reopened." checked={app.codeAnalysis.autoScan} onChange={(autoScan) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, autoScan } })} />
              <ToggleRow label="Respect .gitignore" checked={app.codeAnalysis.includeGitignore} onChange={(includeGitignore) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, includeGitignore } })} />
              <ToggleRow label="Respect .nodalstudioignore" checked={app.codeAnalysis.includeNodalStudioIgnore} onChange={(includeNodalStudioIgnore) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, includeNodalStudioIgnore } })} />
              <NumberRow label="Maximum source file size" value={app.codeAnalysis.maxFileBytes} min={65536} max={10485760} unit="bytes" onChange={(maxFileBytes) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, maxFileBytes } })} />
              <SelectRow label="Open code with" value={app.codeAnalysis.editor} onChange={(editor) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, editor: editor as AppSettings["codeAnalysis"]["editor"] } })} options={[["systemDefault","System default"],["visualStudioCode","Visual Studio Code"],["cursor","Cursor"],["zed","Zed"]]} />
              <div className="data-boundary">
                <h3>Remote AI boundary</h3>
                <p>Both options are off by default. Every remote request still requires local context selection and a request preview.</p>
                <ToggleRow label="Allow uncommitted code in remote AI requests" checked={app.codeAnalysis.allowUncommittedCodeForRemoteAi} onChange={(allowUncommittedCodeForRemoteAi) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, allowUncommittedCodeForRemoteAi } })} />
                <ToggleRow label="Allow source excerpts in remote AI requests" checked={app.codeAnalysis.allowSourceExcerptsForRemoteAi} onChange={(allowSourceExcerptsForRemoteAi) => void saveApp({ ...app, codeAnalysis: { ...app.codeAnalysis, allowSourceExcerptsForRemoteAi } })} />
              </div>
              <CategoryReset onReset={() => void saveApp({ ...app, codeAnalysis: defaultAppSettings().codeAnalysis })} />
            </SettingsSection>
          ) : null}

          {visibleCategory === "data-sources" ? (
            <SettingsSection title="Data Sources" description="Connection behavior and schema refresh policy.">
              <StatusCard status={activeSourceId ? "Configured" : "No active source"} label={`${dataSources.length} saved data source${dataSources.length === 1 ? "" : "s"}`} />
              <SelectRow label="Default database engine" value={app.connectionDefaults.databaseEngine} onChange={(databaseEngine) => void saveApp({ ...app, connectionDefaults: { ...app.connectionDefaults, databaseEngine: databaseEngine as AppSettings["connectionDefaults"]["databaseEngine"] } })} options={[['postgreSql','PostgreSQL'],['mySql','MySQL']]} />
              <SelectRow label="Default SSL mode" value={app.connectionDefaults.sslMode} onChange={(sslMode) => void saveApp({ ...app, connectionDefaults: { ...app.connectionDefaults, sslMode: sslMode as AppSettings["connectionDefaults"]["sslMode"] } })} options={[['disable','Disable'],['prefer','Prefer'],['require','Require'],['verifyCa','Verify CA'],['verifyFull','Verify full']]} />
              <div className="data-source-settings-list">{dataSources.map((profile) => <article key={profile.id}><div><strong>{profile.displayName}</strong><span>{profile.databaseType === "mySql" ? "MySQL" : "PostgreSQL"} · {profile.host}:{profile.port}/{profile.database} · SSL {profile.sslMode}</span></div><div><button type="button" onClick={() => void runOperation(async () => { const displayName = window.prompt("Rename data source", profile.displayName)?.trim(); if (!displayName || displayName === profile.displayName) return; await platform.renameDataSource(profile.id, displayName); await onDataSourcesChanged(); setOperationMessage("Data source renamed."); })}>Rename…</button><button type="button" onClick={() => void runOperation(async () => { const copy = await platform.duplicateDataSource(profile.id); await onDataSourcesChanged(); setOperationMessage(`Created ${copy.displayName} without credentials. Select it in the connection panel to add a password.`); })}>Duplicate parameters</button><button type="button" onClick={() => void runOperation(async () => { if (!window.confirm(`Forget the saved database password for ${profile.displayName}? Snapshots and semantics are unchanged.`)) return; await platform.clearCredentials(profile.id, { database: true, ai: false, cloud: false }); setOperationMessage("Database credential removed from Keychain."); })}>Forget password</button><button type="button" onClick={() => void runOperation(async () => { if (!await confirmSourceDeletion(profile, "history")) return; const count = await platform.deleteSourceData(profile.id, { deleteConnection: false, deleteHistory: true, deleteSemantics: false, removeDatabaseCredential: false }); setOperationMessage(`Deleted ${count} history records.`); })}>Delete history…</button><button type="button" onClick={() => void runOperation(async () => { if (!await confirmSourceDeletion(profile, "semantics")) return; const count = await platform.deleteSourceData(profile.id, { deleteConnection: false, deleteHistory: false, deleteSemantics: true, removeDatabaseCredential: false }); setOperationMessage(`Deleted ${count} semantic records.`); })}>Delete semantics…</button><button type="button" className="danger-setting-action" onClick={() => void runOperation(async () => { if (!await confirmSourceDeletion(profile, "connection")) return; await platform.deleteSourceData(profile.id, { deleteConnection: true, deleteHistory: false, deleteSemantics: false, removeDatabaseCredential: true }); await onDataSourcesChanged(); setOperationMessage("Data source connection removed."); })}>Remove connection…</button></div></article>)}</div>
              {source ? <>
                <SelectRow label="Automatic refresh" value={String(source.refresh.intervalSeconds)} onChange={(value) => void saveSource({ ...source, refresh: { ...source.refresh, intervalSeconds: Number(value) } })} options={[["0","Off"],["30","30 seconds"],["60","1 minute"],["300","5 minutes"],["900","15 minutes"]]} />
                <NumberRow label="Custom refresh interval" value={source.refresh.intervalSeconds} min={0} max={86400} unit="seconds (0 disables)" onChange={(intervalSeconds) => void saveSource({ ...source, refresh: { ...source.refresh, intervalSeconds } })} />
                <ToggleRow label="Pause refresh in background" checked={source.refresh.pauseInBackground} onChange={(pauseInBackground) => void saveSource({ ...source, refresh: { ...source.refresh, pauseInBackground } })} />
                <SelectRow label="Schema change notifications for this source" value={source.refresh.changeNotifications} onChange={(changeNotifications) => void saveSource({ ...source, refresh: { ...source.refresh, changeNotifications: changeNotifications as DataSourceSettings["refresh"]["changeNotifications"] } })} options={[['all','All changes'],['highRisk','High-risk only'],['off','Off']]} />
                <NumberRow label="Connection timeout" value={source.refresh.connectionTimeoutSeconds} min={1} max={120} unit="seconds" onChange={(connectionTimeoutSeconds) => void saveSource({ ...source, refresh: { ...source.refresh, connectionTimeoutSeconds } })} />
                <NumberRow label="Introspection timeout" value={source.refresh.introspectionTimeoutSeconds} min={1} max={600} unit="seconds" onChange={(introspectionTimeoutSeconds) => void saveSource({ ...source, refresh: { ...source.refresh, introspectionTimeoutSeconds } })} />
                <ToggleRow label="Auto-connect on launch" checked={source.refresh.autoConnect} onChange={(autoConnect) => void saveSource({ ...source, refresh: { ...source.refresh, autoConnect } })} />
                <div className="data-boundary"><h3>PostgreSQL Event Trigger enhancement</h3><p>Status: not installed or inspected. Nodal Studio only generates a reviewable administrator script and never installs it automatically.</p><button type="button" disabled={!activeSourceId || dataSources.find((profile) => profile.id === activeSourceId)?.databaseType !== "postgreSql"} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setEventTriggerScript(await platform.generateEventTriggerScript(activeSourceId)); })}>Generate review script</button>{eventTriggerScript ? <><pre>{eventTriggerScript}</pre><button type="button" onClick={() => void navigator.clipboard.writeText(eventTriggerScript)}>Copy script</button></> : null}</div>
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "history" ? (
            <SettingsSection title="History & Storage" description="Snapshot capture, retention, and local disk limits.">
              <SelectRow label="Capture snapshots" value={historySettings.capturePolicy} onChange={(capturePolicy) => saveHistory({ capturePolicy: capturePolicy as AppSettings["history"]["capturePolicy"] })} options={[['onChange','On structural change'],['interval','Fixed interval'],['manual','Manual only']]} />
              <SelectRow label="Retention" value={historySettings.retention} onChange={(retention) => saveHistory({ retention: retention as AppSettings["history"]["retention"] })} options={[['forever','Keep forever'],['count','Keep latest count'],['days','Keep recent days']]} />
              {historySettings.retention !== "forever" ? <NumberRow label={historySettings.retention === "days" ? "Days to keep" : "Snapshots to keep"} value={historySettings.retentionValue} min={1} max={3650} onChange={(retentionValue) => saveHistory({ retentionValue })} /> : null}
              <ToggleRow label="Preserve high-risk changes" checked={historySettings.preserveHighRisk} onChange={(preserveHighRisk) => saveHistory({ preserveHighRisk })} />
              <NumberRow label="Storage warning" value={app.history.storageWarningMegabytes} min={128} max={102400} unit="MB" onChange={(storageWarningMegabytes) => void saveApp({ ...app, history: { ...app.history, storageWarningMegabytes } })} />
              <TextRow label="Portable backup path" value={backupPath} placeholder="/absolute/path/model.nodalmodel" onChange={setBackupPath} />
              <div className="setting-action-row"><button type="button" onClick={() => void runOperation(async () => setStorageUsage(await platform.getStorageUsage()))}>View storage usage</button><button type="button" disabled={!activeSourceId || !backupPath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const receipt = await platform.exportPortableBackup(activeSourceId, backupPath); setOperationMessage(`Backed up ${receipt.snapshots} snapshots and ${receipt.annotations} annotations.`); })}>Export backup</button><button type="button" disabled={!backupPath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { const preview = await platform.previewPortableBackup(backupPath); const identity = [preview.sourceLabel, preview.databaseName, preview.databaseType].filter(Boolean).join(" · "); const accepted = window.confirm(`Import backup ${identity || preview.sourceId}?\n\nFormat v${preview.formatVersion}, exported ${new Date(preview.exportedAt).toLocaleString()}\n${preview.snapshots} snapshots, ${preview.annotations} annotations, ${preview.savedViews} views.\n${preview.willUpdateExistingSource ? "An existing local source will be updated." : "A new local source will be created."}\n\n${preview.conflictStrategy}`); if (!accepted) return; const receipt = await platform.importPortableBackup(backupPath); await onReload(); setOperationMessage(`Restored ${receipt.snapshots} snapshots and ${receipt.annotations} annotations.`); })}>Preview & import…</button><button type="button" onClick={() => void runOperation(async () => { const cleared = await platform.clearRegenerableCache(); setOperationMessage(cleared ? `Cleared ${cleared} cache records.` : "No regenerable cache is currently stored."); })}>Clear cache</button><button type="button" onClick={() => void runOperation(async () => { if (!window.confirm("Clear saved canvas layouts? Snapshots and semantics will be preserved.")) return; await platform.clearLayouts(activeSourceId); setStorageUsage(await platform.getStorageUsage()); })}>Clear layouts…</button><button type="button" onClick={() => void runOperation(async () => { const info = await platform.getDiagnosticInfo(); setDiagnosticInfo(info); setOperationMessage(`Local database directory: ${info.dataDirectory}`); })}>Show local database location</button></div>
              {storageUsage ? <StorageUsageCard usage={storageUsage} /> : null}
            </SettingsSection>
          ) : null}

          {visibleCategory === "git" ? (
            <SettingsSection title="Git Collaboration" description="Reviewable semantics without monolithic model conflicts.">
              <StatusCard status={source?.git.repositoryPath ? "Configured" : "Off"} label="Manual export and import; Nodal Studio never commits or pushes automatically." />
              {source ? <>
                <TextRow label="Repository path" value={source.git.repositoryPath} placeholder="/path/to/repository" onChange={(repositoryPath) => void saveSource({ ...source, git: { ...source.git, repositoryPath } })} />
                <ToggleRow label="Commit reminder" checked={source.git.commitReminders} onChange={(commitReminders) => void saveSource({ ...source, git: { ...source.git, commitReminders } })} />
                <div className="setting-action-row"><button type="button" disabled={!activeSourceId || !source.git.repositoryPath} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setMergeStatus(await platform.checkMergeDriver(activeSourceId, source.git.repositoryPath)); })}>Check repository & merge driver</button><button type="button" disabled={!activeSourceId || !source.git.repositoryPath} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const preview = await platform.previewGitExport(activeSourceId, source.git.repositoryPath); if (!window.confirm(`Export Git workspace?\n\n${preview.addedFiles} added, ${preview.modifiedFiles} modified, ${preview.removedFiles} removed, ${preview.unchangedFiles} unchanged managed files.\nFingerprint: ${preview.schemaFingerprint}\n\nNodal Studio will not commit or push.`)) return; const receipt = await platform.exportGitWorkspace(activeSourceId, source.git.repositoryPath); setOperationMessage(`Exported ${receipt.writtenFiles} managed files; removed ${receipt.removedStaleFiles} stale files.`); })}>Preview & export…</button><button type="button" disabled={!activeSourceId || !source.git.repositoryPath} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const preview = await platform.previewGitImport(activeSourceId, source.git.repositoryPath); if (!window.confirm(`Import reviewed semantics?\n\n${preview.annotations} annotations, ${preview.domainGroups} domains, ${preview.savedViews} views, ${preview.provenance} provenance records, ${preview.lineageLinks} lineage links, ${preview.logicalRelationships} logical relationships.\nRelationship conflicts requiring overwrite confirmation: ${preview.relationshipConflicts.length}${preview.relationshipConflicts.length ? `\n${preview.relationshipConflicts.join("\n")}` : ""}\nFingerprint: ${preview.fingerprintMatches ? "matches" : "WARNING: differs from local snapshot"} (${preview.workspaceFingerprint}).`)) return; const receipt = await platform.importGitWorkspace(activeSourceId, source.git.repositoryPath); await onReload(); setOperationMessage(`Imported ${receipt.importedAnnotations} annotations, ${receipt.importedSavedViews} views, and ${receipt.importedLogicalRelationships} logical relationships.`); })}>Preview & import…</button></div>
                {mergeStatus ? <><MergeStatusCard status={mergeStatus} /><div className="setting-action-row"><button type="button" disabled={!mergeStatus.installCommand} onClick={() => void runOperation(async () => { await navigator.clipboard.writeText(mergeStatus.installCommand); setOperationMessage("Merge driver installation command copied. Review and run it in this repository."); })}>Copy install command</button></div>{mergeStatus.conflictReports.map((report) => <div className="settings-status-card" key={report}><strong>{report}</strong><span>Semantic merge conflicts require explicit review.</span><div className="setting-action-row"><button type="button" onClick={() => void runOperation(async () => setConflictReport({ path: report, contents: await platform.readGitConflictReport(source.git.repositoryPath, report) }))}>Review report</button><button type="button" className="danger-setting-action" onClick={() => void runOperation(async () => { if (!window.confirm(`Delete ${report} only after resolving every listed semantic field?`)) return; await platform.deleteGitConflictReport(source.git.repositoryPath, report); setConflictReport(undefined); if (activeSourceId) setMergeStatus(await platform.checkMergeDriver(activeSourceId, source.git.repositoryPath)); })}>Confirm resolved & delete…</button></div></div>)}{conflictReport ? <div className="data-boundary"><h3>{conflictReport.path}</h3><pre>{conflictReport.contents}</pre></div> : null}</> : null}
                <DataBoundary />
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "ai" ? (
            <SettingsSection title="AI" description="Explanations are optional and always require confirmation before becoming semantics.">
              {runtime?.kind === "desktop" ? <ModelConnectionsSettings platform={platform} /> : null}
              <StatusCard status={app.privacy.offlineMode ? "Offline" : source?.ai.enabled ? "Configured" : "Off"} label="No database credentials or row data are sent." />
              {source && ai ? <>
                <ToggleRow label="Enable AI explanations" checked={source.ai.enabled} managed={isManaged("ai.enabled")} onChange={(enabled) => void saveSource({ ...source, ai: { ...source.ai, enabled } })} />
                <SelectRow label="Provider" value={ai.provider} onChange={(provider) => setAiDraft({ ...ai, provider: provider as DataSourceSettings["ai"]["provider"] })} options={[['offline','Offline provider'],['openAiCompatible','OpenAI-compatible']]} />
                {ai.provider === "openAiCompatible" ? <><TextRow label="Endpoint" value={ai.endpoint} placeholder="https://…" onChange={(endpoint) => setAiDraft({ ...ai, endpoint })} /><TextRow label="Model" value={ai.model} onChange={(model) => setAiDraft({ ...ai, model })} /><SecretRow label="API key" value={aiSecret} configured={source.ai.credentialConfigured} onChange={setAiSecret} onSave={() => void runOperation(async () => { if (!activeSourceId) return; await platform.saveAiCredential(activeSourceId, aiSecret); setAiSecret(""); await onReload(); })} /></> : null}
                <SelectRow label="Context scope" value={ai.contextScope} onChange={(contextScope) => setAiDraft({ ...ai, contextScope: contextScope as DataSourceSettings["ai"]["contextScope"] })} options={[['currentTable','Current table'],['oneHop','One relationship hop'],['domain','Current business domain']]} />
                <ToggleRow label="Include comments" checked={ai.includeComments} onChange={(includeComments) => setAiDraft({ ...ai, includeComments })} />
                <ToggleRow label="Include confirmed semantics" checked={ai.includeConfirmedSemantics} onChange={(includeConfirmedSemantics) => setAiDraft({ ...ai, includeConfirmedSemantics })} />
                <NumberRow label="Request timeout" value={ai.timeoutSeconds} min={1} max={300} unit="seconds" onChange={(timeoutSeconds) => setAiDraft({ ...ai, timeoutSeconds })} />
                <NumberRow label="Maximum retries" value={ai.maxRetries} min={0} max={5} onChange={(maxRetries) => setAiDraft({ ...ai, maxRetries })} />
                <NumberRow label="Maximum concurrency" value={ai.maxConcurrency} min={1} max={8} onChange={(maxConcurrency) => setAiDraft({ ...ai, maxConcurrency })} />
                <AiRequestBoundary ai={ai} />
                <div className="setting-action-row"><button type="button" onClick={() => void saveSource({ ...source, ai: { ...ai, enabled: source.ai.enabled, credentialConfigured: source.ai.credentialConfigured } })}>Save AI configuration</button><button type="button" onClick={() => setAiDraft(source.ai)}>Cancel draft</button></div>
                <div className="setting-action-row"><button type="button" disabled={!activeSourceId || !source.ai.enabled || (app.privacy.offlineMode && source.ai.provider !== "offline")} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setAiTestResult(await platform.testAiProvider(activeSourceId)); })}>Test provider</button></div>
                {aiTestResult ? <p className="setting-inline-note">Connected to {aiTestResult.provider}{aiTestResult.model ? ` · ${aiTestResult.model}` : ""} at {formatSettingsDate(aiTestResult.testedAt, app.general.dateTimeFormat)}{aiTestResult.networkUsed ? "" : " · no network used"}.</p> : null}
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "cloud" ? (
            <SettingsSection title="Cloud Sync" description="Optional metadata collaboration with an explicit sync allowlist.">
              <StatusCard status={app.privacy.offlineMode ? "Offline" : source?.cloud.enabled ? "Configured" : "Off"} label="Cloud sync is disabled by default." />
              {source && cloud ? <>
                <ToggleRow label="Enable Cloud Sync" checked={source.cloud.enabled} managed={isManaged("cloud.enabled")} onChange={(enabled) => void saveSource({ ...source, cloud: { ...source.cloud, enabled } })} />
                <TextRow label="Cloud endpoint" value={cloud.endpoint} placeholder="https://…" onChange={(endpoint) => setCloudDraft({ ...cloud, endpoint })} />
                <TextRow label="Web Viewer URL" value={cloud.viewerUrl} placeholder="https://viewer.example/" onChange={(viewerUrl) => setCloudDraft({ ...cloud, viewerUrl })} />
                {!source.cloud.credentialConfigured ? <div className="project-policy"><h3>Create Cloud account and Team</h3><p>Production bootstrap is disabled unless the server operator supplies a one-time installation secret. Access and refresh tokens are stored only in system Keychain.</p><TextRow label="Email" value={cloudEmail} onChange={setCloudEmail} /><TextRow label="Display name" value={cloudDisplayName} onChange={setCloudDisplayName} /><TextRow label="New Team name" value={cloudTeamName} onChange={setCloudTeamName} /><SecretRow label="Bootstrap secret" value={cloudBootstrapSecret} configured={false} onChange={setCloudBootstrapSecret} onSave={() => undefined} showSave={false} /><button type="button" disabled={!activeSourceId || !source.cloud.endpoint || cloud.endpoint !== source.cloud.endpoint || !cloudEmail || !cloudDisplayName || !cloudTeamName || cloudBootstrapSecret.length < 24 || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm("Create this Cloud account and Team on the configured endpoint?")) return; const account = await platform.bootstrapCloudAccount(activeSourceId, cloudEmail, cloudDisplayName, cloudTeamName, cloudBootstrapSecret); setCloudBootstrapSecret(""); await onReload(); setOperationMessage(`Cloud account ${account.accountLabel} connected; access expires ${formatSettingsDate(account.accessExpiresAt, app.general.dateTimeFormat)}.`); })}>Create account & Team…</button></div> : null}
                <TextRow label="Account" value={cloud.accountLabel} onChange={(accountLabel) => setCloudDraft({ ...cloud, accountLabel })} />
                <TextRow label="Team ID" value={cloud.teamId} onChange={(teamId) => setCloudDraft({ ...cloud, teamId })} />
                <TextRow label="Project ID" value={cloud.projectId} onChange={(projectId) => setCloudDraft({ ...cloud, projectId })} />
                {source.cloud.credentialConfigured ? <div className="setting-action-row"><button type="button" disabled={!activeSourceId || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const account = await platform.refreshCloudSession(activeSourceId); await onReload(); setOperationMessage(`Cloud session refreshed until ${formatSettingsDate(account.accessExpiresAt, app.general.dateTimeFormat)}.`); })}>Refresh session</button><TextRow label="New project name" value={cloudProjectName} onChange={setCloudProjectName} /><button type="button" disabled={!activeSourceId || !source.cloud.teamId || !cloudProjectName || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm(`Create Cloud project “${cloudProjectName}” for this Team?`)) return; const project = await platform.createCloudProject(activeSourceId, cloudProjectName); setCloudProjectName(""); await onReload(); setOperationMessage(`Created project ${project}.`); })}>Create project…</button></div> : null}
                <SecretRow label="Cloud access token" value={cloudSecret} configured={source.cloud.credentialConfigured} onChange={setCloudSecret} onSave={() => void runOperation(async () => { if (!activeSourceId) return; await platform.saveCloudCredential(activeSourceId, cloudSecret); setCloudSecret(""); await onReload(); })} />
                <ToggleRow label="Sync semantics" checked={cloud.syncSemantics} onChange={(syncSemantics) => setCloudDraft({ ...cloud, syncSemantics })} />
                <ToggleRow label="Sync business domains" checked={cloud.syncDomains} onChange={(syncDomains) => setCloudDraft({ ...cloud, syncDomains })} />
                <ToggleRow label="Sync saved views" checked={cloud.syncSavedViews} onChange={(syncSavedViews) => setCloudDraft({ ...cloud, syncSavedViews })} />
                <ToggleRow label="Sync ChangeSets" checked={cloud.syncChangeSets} onChange={(syncChangeSets) => setCloudDraft({ ...cloud, syncChangeSets })} />
                <ToggleRow label="Sync snapshots" description="Off by default; personal layouts remain local." checked={cloud.syncSnapshots} managed={isManaged("cloud.syncSnapshots")} onChange={(syncSnapshots) => setCloudDraft({ ...cloud, syncSnapshots })} />
                <ToggleRow label="Sync shared layouts" checked={cloud.syncSharedLayouts} onChange={(syncSharedLayouts) => setCloudDraft({ ...cloud, syncSharedLayouts })} />
                <ToggleRow label="Sync personal layouts" description="Personal coordinates are excluded unless explicitly enabled." checked={cloud.syncPersonalLayouts} onChange={(syncPersonalLayouts) => setCloudDraft({ ...cloud, syncPersonalLayouts })} />
                <SelectRow label="Conflict strategy" value={cloud.conflictStrategy} onChange={(conflictStrategy) => setCloudDraft({ ...cloud, conflictStrategy: conflictStrategy as DataSourceSettings["cloud"]["conflictStrategy"] })} options={[['ask','Always ask'],['keepLocal','Keep local'],['keepRemote','Keep remote']]} />
                <div className="setting-action-row"><button type="button" onClick={() => void saveSource({ ...source, cloud: { ...cloud, enabled: source.cloud.enabled, credentialConfigured: source.cloud.credentialConfigured, baseVersion: source.cloud.baseVersion, lastSuccessAt: source.cloud.lastSuccessAt } })}>Save Cloud configuration</button><button type="button" onClick={() => setCloudDraft(source.cloud)}>Cancel draft</button></div>
                <div className="setting-action-row"><button type="button" onClick={() => void runOperation(async () => { if (!activeSourceId) return; setSyncDiagnostics(await platform.listSyncDiagnostics(activeSourceId)); })}>Inspect offline queue</button><button type="button" disabled={!activeSourceId || !source.cloud.enabled || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; await platform.syncProject({ sourceId: activeSourceId, projectId: source.cloud.projectId, apiUrl: source.cloud.endpoint, accessToken: "", baseVersion: source.cloud.baseVersion }); await onReload(); setSyncDiagnostics(await platform.listSyncDiagnostics(activeSourceId)); setOperationMessage("Queued metadata synchronized."); })}>Retry queue</button><button type="button" disabled={syncDiagnostics.length === 0} onClick={() => void runOperation(async () => { await navigator.clipboard.writeText(JSON.stringify(syncDiagnostics, null, 2)); setOperationMessage("Redacted queue diagnostics copied."); })}>Copy diagnostics</button><button type="button" disabled={!activeSourceId || !source.cloud.projectId || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setCloudAudit(await platform.listCloudAudit(activeSourceId)); })}>View audit</button></div>
                {source.cloud.lastSuccessAt ? <p className="setting-inline-note">Last successful sync: {formatSettingsDate(source.cloud.lastSuccessAt, app.general.dateTimeFormat)}</p> : null}
                {syncDiagnostics.length ? <div className="sync-diagnostics">{syncDiagnostics.map((item) => <div key={item.id}><span>{item.eventKind}</span><b>{item.state} · {item.attempts} attempts</b></div>)}</div> : null}
                {cloudAudit.length ? <div className="sync-diagnostics" aria-label="Cloud audit events">{cloudAudit.map((item, index) => <div key={`${item.createdAt}:${index}`}><span>{humanize(item.action.replaceAll(".", " "))}</span><b>{formatSettingsDate(item.createdAt, app.general.dateTimeFormat)}</b></div>)}</div> : null}
                {source.cloud.projectId ? <CloudShareManager platform={platform} sourceId={activeSourceId} viewerUrl={source.cloud.viewerUrl} offline={app.privacy.offlineMode} dateTimeFormat={app.general.dateTimeFormat} onMessage={setOperationMessage} onError={setOperationError} /> : null}
                <div className="setting-action-row"><button type="button" disabled={!activeSourceId} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm("Disconnect Cloud for this source and remove its Keychain token?")) return; await platform.clearCredentials(activeSourceId, { database: false, ai: false, cloud: true }); await saveSource({ ...source, cloud: { ...source.cloud, enabled: false, credentialConfigured: false } }); })}>Disconnect</button><button type="button" className="danger-setting-action" onClick={() => void runOperation(async () => { if (!window.confirm("Leave the configured Cloud project locally? This does not delete remote data.")) return; await saveSource({ ...source, cloud: { ...source.cloud, enabled: false, projectId: "", baseVersion: 0 } }); })}>Leave project…</button></div>
                <div className="setting-action-row"><button type="button" disabled={!activeSourceId || !source.cloud.teamId || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; await platform.refreshOrganizationPolicy(activeSourceId); await onReload(); setOperationMessage("Organization policy refreshed and cached locally."); })}>Refresh organization policy</button></div>
                {source.cloud.projectId ? <ProjectPolicyCard project={settings.project} projectId={source.cloud.projectId} onSave={(project) => void runOperation(async () => { await platform.updateProjectSettings(project); await onReload(); setOperationMessage("Project policy updated."); })} /> : null}
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "privacy" ? (
            <SettingsSection title="Privacy & Security" description="A single view of every external capability and stored credential class.">
              <ToggleRow label="Completely offline" description="Blocks AI, Cloud, update checks, and diagnostics. Database connections remain available." checked={app.privacy.offlineMode} managed={isManaged("privacy.offlineMode")} onChange={(offlineMode) => void saveApp({ ...app, privacy: { ...app.privacy, offlineMode } })} />
              <ToggleRow label="Anonymous diagnostics" description="Version, runtime, duration bucket, outcome class, and redacted error code only." checked={app.privacy.diagnosticsEnabled} managed={isManaged("privacy.diagnosticsEnabled")} onChange={(diagnosticsEnabled) => void updateDiagnostics(diagnosticsEnabled)} />
              <ToggleRow label="Crash reports" checked={app.privacy.crashReportsEnabled} onChange={(crashReportsEnabled) => void saveApp({ ...app, privacy: { ...app.privacy, crashReportsEnabled } })} />
              <SelectRow label="Log level" value={app.privacy.logLevel} onChange={(logLevel) => void saveApp({ ...app, privacy: { ...app.privacy, logLevel: logLevel as AppSettings["privacy"]["logLevel"] } })} options={[['error','Error'],['warn','Warning'],['info','Info'],['debug','Debug']]} />
              <NumberRow label="Log retention" value={app.privacy.logRetentionDays} min={1} max={365} unit="days" onChange={(logRetentionDays) => void saveApp({ ...app, privacy: { ...app.privacy, logRetentionDays } })} />
              <ExternalCapabilities app={app} source={source} access={externalAccess} dateTimeFormat={app.general.dateTimeFormat} />
              <div className="setting-action-row"><button type="button" onClick={() => void runOperation(async () => { setSecurityStatus(await platform.getSecurityStatus(activeSourceId)); setExternalAccess(await platform.listExternalAccess()); })}>Run local security audit</button></div>
              {securityStatus ? <SecurityStatusCard status={securityStatus} /> : null}
              <button type="button" className="danger-setting-action" disabled={!activeSourceId || runtime?.kind === "web"} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm("Remove database, AI, and Cloud credentials for the active source? The model, history, and settings remain local.")) return; await platform.clearCredentials(activeSourceId, { database: true, ai: true, cloud: true }); await onReload(); setSecurityStatus(await platform.getSecurityStatus(activeSourceId)); })}>Remove all saved credentials…</button>
            </SettingsSection>
          ) : null}

          {visibleCategory === "notifications" ? (
            <SettingsSection title="Notifications" description="Choose which model and collaboration events need attention.">
              <SelectRow label="Schema changes" value={app.notifications.schemaChanges} onChange={(schemaChanges) => void saveApp({ ...app, notifications: { ...app.notifications, schemaChanges: schemaChanges as AppSettings["notifications"]["schemaChanges"] } })} options={[['all','All changes'],['highRisk','High-risk only'],['off','Off']]} />
              <ToggleRow label="Git fingerprint and conflicts" checked={app.notifications.gitConflicts} onChange={(gitConflicts) => void saveApp({ ...app, notifications: { ...app.notifications, gitConflicts } })} />
              <ToggleRow label="Cloud sync failures" checked={app.notifications.cloudFailures} onChange={(cloudFailures) => void saveApp({ ...app, notifications: { ...app.notifications, cloudFailures } })} />
              <ToggleRow label="Storage warnings" checked={app.notifications.storageWarnings} onChange={(storageWarnings) => void saveApp({ ...app, notifications: { ...app.notifications, storageWarnings } })} />
              <ToggleRow label="Update available" checked={app.notifications.updateAvailable} onChange={(updateAvailable) => void saveApp({ ...app, notifications: { ...app.notifications, updateAvailable } })} />
              <ToggleRow label="System notifications" checked={app.notifications.systemNotifications} onChange={(systemNotifications) => void updateSystemNotifications(systemNotifications)} />
              <ToggleRow label="Quiet hours" checked={app.notifications.quietHoursEnabled} onChange={(quietHoursEnabled) => void saveApp({ ...app, notifications: { ...app.notifications, quietHoursEnabled } })} />
              {app.notifications.quietHoursEnabled ? <><TextRow label="Quiet hours start" value={app.notifications.quietHoursStart} placeholder="22:00" onChange={(quietHoursStart) => void saveApp({ ...app, notifications: { ...app.notifications, quietHoursStart } })} /><TextRow label="Quiet hours end" value={app.notifications.quietHoursEnd} placeholder="08:00" onChange={(quietHoursEnd) => void saveApp({ ...app, notifications: { ...app.notifications, quietHoursEnd } })} /></> : null}
            </SettingsSection>
          ) : null}

          {visibleCategory === "shortcuts" ? (
            <SettingsSection title="Keyboard Shortcuts" description="Searchable commands with conflict-safe bindings.">
              <TextRow label="Filter commands" value={shortcutQuery} placeholder="Search commands…" onChange={setShortcutQuery} />
              <div className="shortcut-list">{Object.entries(app.shortcuts.bindings).filter(([command]) => humanize(command).toLowerCase().includes(shortcutQuery.trim().toLowerCase())).map(([command, binding]) => { const conflict = shortcutConflicts.get(binding.trim().toLowerCase()); return <label key={command}><span>{humanize(command)}{conflict ? <small>Conflicts with {conflict.filter((item) => item !== command).map(humanize).join(", ")}</small> : null}</span><input aria-invalid={Boolean(conflict)} value={binding} onChange={(event) => updateShortcut(command, event.target.value)} /></label>; })}</div>
              <button type="button" className="secondary-setting-action" onClick={() => void saveApp({ ...app, shortcuts: defaultAppSettings().shortcuts })}>Reset shortcuts</button>
            </SettingsSection>
          ) : null}

          {visibleCategory === "updates" ? (
            <SettingsSection title="Updates & About" description="Application version, update channel, licenses, and diagnostic paths.">
              <StatusCard status={`v${runtime?.version ?? "0.1.0"}`} label={`${runtime?.label ?? "Nodal Studio"} · Tauri/Rust desktop and independent Web Viewer`} />
              <ToggleRow label="Automatically check for updates" checked={app.updates.automaticChecks} managed={isManaged("updates.automaticChecks")} onChange={(automaticChecks) => void saveApp({ ...app, updates: { ...app.updates, automaticChecks } })} />
              <StatusCard status={app.updates.channel === "beta" ? "Beta channel" : "Stable channel"} label="Beta updates are an advanced opt-in." />
              <TextRow label="Update feed" value={app.updates.customFeedUrl ?? ""} placeholder="https://updates.example/manifest.json" onChange={(customFeedUrl) => void saveApp({ ...app, updates: { ...app.updates, customFeedUrl: customFeedUrl || null } })} />
              <div className="setting-action-row"><button type="button" disabled={runtime?.kind === "web" || app.privacy.offlineMode} onClick={() => void runOperation(async () => setUpdateResult(await platform.checkForUpdates()))}>Check for updates</button><button type="button" onClick={() => setAboutDocument("releaseNotes")}>Release notes</button><button type="button" onClick={() => setAboutDocument("license")}>License</button><button type="button" onClick={() => setAboutDocument("notices")}>Third-party notices</button></div>
              {updateResult ? <div className="settings-status-card"><strong>{updateResult.availableVersion ? `Version ${updateResult.availableVersion} available` : "Nodal Studio is up to date"}</strong><span>{updateResult.notes ?? `Current version ${updateResult.currentVersion}`}</span></div> : null}
              <div className="setting-action-row"><button type="button" onClick={() => void runOperation(async () => setDiagnosticInfo(await platform.getDiagnosticInfo()))}>Show runtime & paths</button><button type="button" disabled={runtime?.kind === "web"} onClick={() => void runOperation(() => platform.revealAppDirectory("logs"))}>Open logs directory</button><button type="button" disabled={runtime?.kind === "web"} onClick={() => void runOperation(() => platform.revealAppDirectory("data"))}>Open data directory</button><button type="button" onClick={() => void runOperation(async () => { const info = diagnosticInfo ?? await platform.getDiagnosticInfo(); setDiagnosticInfo(info); await navigator.clipboard.writeText(redactedDiagnosticSummary(info, app)); setOperationMessage("Redacted diagnostic summary copied."); })}>Copy diagnostic summary</button></div>
              {diagnosticInfo ? <div className="external-capabilities"><h3>Runtime</h3><div><span>Application</span><b>{diagnosticInfo.appVersion}</b></div><div><span>Rust requirement</span><b>{diagnosticInfo.rustVersion}</b></div><div><span>Target</span><b>{diagnosticInfo.target}</b></div><div><span>Data directory</span><b>{diagnosticInfo.dataDirectory}</b></div><div><span>Log directory</span><b>{diagnosticInfo.logDirectory}</b></div></div> : null}
              {aboutDocument ? <AboutDocument kind={aboutDocument} onClose={() => setAboutDocument(undefined)} /> : null}
            </SettingsSection>
          ) : null}

          {visibleCategory === "advanced" ? (
            <SettingsSection title="Advanced" description="Performance thresholds, experiments, and recovery actions.">
              <ToggleRow label="Performance metrics" checked={app.advanced.performanceMetrics} onChange={(performanceMetrics) => void saveApp({ ...app, advanced: { ...app.advanced, performanceMetrics } })} />
              <div className="setting-action-row"><button type="button" disabled={!app.advanced.performanceMetrics} onClick={() => setPerformanceSnapshot(capturePerformanceSnapshot())}>Capture performance snapshot</button></div>
              {performanceSnapshot ? <div className="external-capabilities"><h3>Session performance</h3><div><span>Uptime</span><b>{(performanceSnapshot.uptimeMs / 1000).toFixed(1)} s</b></div><div><span>DOM nodes</span><b>{performanceSnapshot.domNodes}</b></div><div><span>Resource entries</span><b>{performanceSnapshot.resourceEntries}</b></div><div><span>JavaScript heap</span><b>{performanceSnapshot.heapBytes === null ? "Unavailable" : formatBytes(performanceSnapshot.heapBytes)}</b></div></div> : null}
              <NumberRow label="Layout worker timeout" value={app.advanced.layoutWorkerTimeoutMs} min={1000} max={120000} unit="ms" onChange={(layoutWorkerTimeoutMs) => void saveApp({ ...app, advanced: { ...app.advanced, layoutWorkerTimeoutMs } })} />
              <NumberRow label="Render degradation threshold" value={app.advanced.renderDegradeThreshold} min={100} max={5000} unit="tables" onChange={(renderDegradeThreshold) => void saveApp({ ...app, advanced: { ...app.advanced, renderDegradeThreshold } })} />
              <ToggleRow label="Beta features" checked={app.advanced.betaFeatures} onChange={(betaFeatures) => void saveApp({ ...app, advanced: { ...app.advanced, betaFeatures } })} />
              <SelectRow label="Application update channel" value={app.updates.channel} onChange={(channel) => void saveApp({ ...app, updates: { ...app.updates, channel: channel as AppSettings["updates"]["channel"] } })} options={[['stable','Stable'],['beta','Beta (pre-release)']]} />
              {app.advanced.betaFeatures ? <div className="project-policy"><h3>Experimental features</h3>{Object.entries(app.advanced.experimentalFeatures).map(([feature, enabled]) => <ToggleRow key={feature} label={humanize(feature)} description="Experimental; behavior and stored representation may change." checked={enabled} onChange={(value) => void saveApp({ ...app, advanced: { ...app.advanced, experimentalFeatures: { ...app.advanced.experimentalFeatures, [feature]: value } } })} />)}</div> : null}
              <div className="project-policy"><h3>Built-in extensions</h3><p>Only signed, bundled capabilities are listed. Nodal Studio does not execute arbitrary third-party scripts.</p>{Object.entries(app.advanced.extensions).map(([extension, enabled]) => <ToggleRow key={extension} label={humanize(extension)} checked={enabled} onChange={(value) => void saveApp({ ...app, advanced: { ...app.advanced, extensions: { ...app.advanced.extensions, [extension]: value } } })} />)}</div>
              {settings.managed.length > 0 ? <div className="external-capabilities"><h3>Managed by project or organization</h3>{settings.managed.map((item) => <div key={`${item.source}:${item.path}`}><span>{item.path}</span><b title={item.reason}>{item.source}</b></div>)}</div> : null}
              <TextRow label="Settings JSON path" value={settingsFilePath} placeholder="/absolute/path/settings.json" onChange={setSettingsFilePath} />
              <div className="setting-action-row"><button type="button" disabled={!settingsFilePath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { const receipt = await platform.exportSettingsFile(settingsFilePath); setOperationMessage(`Exported non-sensitive settings for ${receipt.sourceSettings} sources.`); })}>Export settings</button><button type="button" disabled={!settingsFilePath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { const preview = await platform.previewSettingsFile(settingsFilePath); if (!window.confirm(`Import Settings format v${preview.formatVersion}, exported ${new Date(preview.exportedAt).toLocaleString()}?\n\nThe app settings document and ${preview.sourceSettings} source settings documents will be inserted or replaced. Credentials, snapshots, semantics, and layouts are not included or changed.`)) return; const receipt = await platform.importSettingsFile(settingsFilePath); await onReload(); setOperationMessage(`Imported settings for ${receipt.sourceSettings} sources.`); })}>Preview & import…</button></div>
              <div className="settings-danger-zone"><h3>Danger zone</h3><p>Resetting settings does not delete snapshots, semantics, or credentials.</p><button type="button" onClick={() => void onResetApp()}>Reset all settings</button>{source ? <button type="button" onClick={() => void onResetSource()}>Reset active source settings</button> : null}<button type="button" className="danger-setting-action" disabled={runtime?.kind === "web"} onClick={() => void runOperation(async () => { const confirmation = window.prompt("Factory reset deletes all local connections, snapshots, semantics, settings, and Keychain credentials. Type DELETE LOCAL DATA to continue."); if (confirmation !== "DELETE LOCAL DATA") return; await platform.factoryReset(confirmation); await onFactoryReset(); })}>Factory reset…</button></div>
            </SettingsSection>
          ) : null}
        </main>
      </div>
    </section>
  );
}

function SettingsSection({ title, description, children, managed }: { title: string; description: string; children: ReactNode; managed?: { source: string; reason: string } }) {
  return <section className="settings-section"><header><h2>{title}</h2><p>{description}</p>{managed ? <em className="managed-section" title={managed.reason}>Managed · {managed.source}</em> : null}</header><fieldset className="settings-card" disabled={Boolean(managed)}>{children}</fieldset></section>;
}

function ToggleRow({ label, description, checked, managed, onChange }: { label: string; description?: string; checked: boolean; managed?: { source: string; reason: string }; onChange: (value: boolean) => void }) {
  return <label className="setting-row setting-toggle"><span><strong>{label}</strong>{description ? <small>{description}</small> : null}{managed ? <em title={managed.reason}>Managed · {managed.source}</em> : null}</span><input type="checkbox" checked={checked} disabled={Boolean(managed)} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong></span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>;
}

function RangeRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  return <label className="setting-row setting-range"><span><strong>{label}</strong><small>{value}{unit}</small></span><input type="range" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function NumberRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong>{unit ? <small>{unit}</small> : null}</span><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function TextRow({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong></span><input type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SecretRow({ label, value, configured, onChange, onSave, showSave = true }: { label: string; value: string; configured: boolean; onChange: (value: string) => void; onSave: () => void; showSave?: boolean }) { return <div className="setting-row"><span><strong>{label}</strong><small>{configured ? "Stored in system Keychain" : "Not configured"}</small></span><div className="secret-setting"><input aria-label={label} type="password" value={value} placeholder="••••••••" onChange={(event) => onChange(event.target.value)} />{showSave ? <button type="button" disabled={!value.trim()} onClick={onSave}>Save</button> : null}</div></div>; }

function StatusCard({ status, label }: { status: string; label: string }) { return <div className="settings-status-card"><strong>{status}</strong><span>{label}</span></div>; }
function CategoryReset({ onReset }: { onReset: () => void }) { return <button type="button" className="secondary-setting-action" onClick={onReset}>Restore category defaults</button>; }
function Unavailable({ runtime }: { runtime?: RuntimeInfo }) { return <div className="settings-empty"><strong>No active data source</strong><span>{runtime?.kind === "web" ? "This capability is read-only in Web Viewer." : "Connect or select a data source to configure it."}</span></div>; }
function DataBoundary() { return <div className="data-boundary"><h3>Git data boundary</h3><p><b>Included:</b> confirmed semantics, domains, saved relationship views, provenance, and code lineage.</p><p><b>Excluded:</b> credentials, tokens, snapshots, canvas positions, row data, and unconfirmed AI candidates.</p></div>; }
function AiRequestBoundary({ ai }: { ai: DataSourceSettings["ai"] }) { return <div className="data-boundary"><h3>Request preview policy</h3><p><b>Selected:</b> {ai.contextScope === "currentTable" ? "current table only" : ai.contextScope === "oneHop" ? "current table and one relationship hop" : "current business domain"}; column names and types{ai.includeComments ? ", database comments" : ""}{ai.includeConfirmedSemantics ? ", confirmed semantics" : ""}.</p><p><b>Never sent:</b> passwords, connection strings, business row data, unrelated schemas, personal layouts, or unconfirmed AI candidates.</p><p>Every generated explanation records the provider, model, generation time, and remains an unconfirmed candidate until a person accepts it.</p></div>; }
function ExternalCapabilities({ app, source, access, dateTimeFormat }: { app: AppSettings; source: DataSourceSettings | null; access: ExternalAccessRecord[]; dateTimeFormat: AppSettings["general"]["dateTimeFormat"] }) { const items = [["AI", "ai", source?.ai.enabled], ["Cloud Sync", "cloud", source?.cloud.enabled], ["Update checks", "updates", app.updates.automaticChecks], ["Diagnostics", "diagnostics", app.privacy.diagnosticsEnabled]] as const; return <div className="external-capabilities"><h3>External capabilities</h3>{items.map(([name, capability, enabled]) => { const last = access.find((item) => item.capability === capability); return <div key={name}><span>{name}{last ? <small>Last access {formatSettingsDate(last.lastAccessAt, dateTimeFormat)}</small> : <small>Never accessed by this installation</small>}</span><b>{app.privacy.offlineMode ? "Blocked by offline mode" : enabled ? "Enabled" : "Off"}</b></div>; })}</div>; }
function StorageUsageCard({ usage }: { usage: StorageUsage }) { const rows = [["Snapshots", usage.snapshotBytes], ["Semantics", usage.semanticBytes], ["Layouts", usage.layoutBytes], ["Sync queue", usage.syncQueueBytes], ["Settings", usage.settingsBytes]] as const; return <div className="external-capabilities"><h3>Local storage · {usage.snapshotCount} snapshots</h3>{rows.map(([name, bytes]) => <div key={name}><span>{name}</span><b>{formatBytes(bytes)}</b></div>)}</div>; }
function SecurityStatusCard({ status }: { status: SecurityStatus }) { return <div className="external-capabilities"><h3>Local security audit</h3><div><span>Database credential</span><b>{status.databaseCredentialConfigured ? "Keychain" : "Missing"}</b></div><div><span>AI credential</span><b>{status.aiCredentialConfigured ? "Keychain" : "Not configured"}</b></div><div><span>Cloud credential</span><b>{status.cloudCredentialConfigured ? "Keychain" : "Not configured"}</b></div><div><span>Weak SSL sources</span><b>{status.weakSslSources}</b></div><div><span>Models not refreshed for 30 days</span><b>{status.staleModelSources}</b></div><div><span>Unresolved Git conflict reports</span><b>{status.unresolvedGitConflictReports}</b></div><div><span>Failed/conflicted sync items</span><b>{status.failedOrConflictedSyncItems}</b></div></div>; }
function CloudShareManager({ platform, sourceId, viewerUrl, offline, dateTimeFormat, onMessage, onError }: { platform: NodalStudioPlatform; sourceId?: string; viewerUrl: string; offline: boolean; dateTimeFormat: AppSettings["general"]["dateTimeFormat"]; onMessage: (message: string) => void; onError: (message: string) => void }) {
  const [shares, setShares] = useState<CloudShareSummary[]>([]);
  const [latestUrl, setLatestUrl] = useState("");
  async function run(operation: () => Promise<void>) {
    onError("");
    try { await operation(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  function shareUrl(token: string) { const url = new URL(viewerUrl); url.searchParams.set("share", token); return url.toString(); }
  async function copyShare(token: string, message: string) { const url = shareUrl(token); setLatestUrl(url); await navigator.clipboard.writeText(url); onMessage(message); }
  return <div className="project-policy"><h3>Read-only share links</h3><p>Links expire after seven days by default. Rotate immediately invalidates the old token; revoke stops access without deleting project data.</p><div className="setting-action-row"><button type="button" disabled={!sourceId || !viewerUrl || offline} onClick={() => void run(async () => { if (!sourceId) return; const share = await platform.createCloudShare(sourceId); await copyShare(share.token, "A seven-day read-only link was created and copied."); setShares(await platform.listCloudShares(sourceId)); })}>Create 7-day link</button><button type="button" disabled={!sourceId || offline} onClick={() => void run(async () => { if (sourceId) setShares(await platform.listCloudShares(sourceId)); })}>Refresh links</button></div>{!viewerUrl ? <p className="setting-inline-note">Configure and save the Web Viewer URL before creating links.</p> : null}{latestUrl ? <p className="setting-inline-note">Latest link: <code>{latestUrl}</code></p> : null}{shares.length ? <div className="sync-diagnostics" aria-label="Cloud share links">{shares.map((share) => <div key={share.id}><span>{share.revokedAt ? "Revoked" : new Date(share.expiresAt) <= new Date() ? "Expired" : "Active"} · expires {formatSettingsDate(share.expiresAt, dateTimeFormat)}{share.lastAccessAt ? ` · last opened ${formatSettingsDate(share.lastAccessAt, dateTimeFormat)}` : ""}</span><b><button type="button" disabled={Boolean(share.revokedAt)} onClick={() => void run(async () => { if (!sourceId || !window.confirm("Revoke this share link now?")) return; await platform.revokeCloudShare(sourceId, share.id); setShares(await platform.listCloudShares(sourceId)); })}>Revoke</button><button type="button" disabled={Boolean(share.revokedAt) || !viewerUrl} onClick={() => void run(async () => { if (!sourceId || !window.confirm("Rotate this link and invalidate the old token?")) return; const replacement = await platform.rotateCloudShare(sourceId, share.id); await copyShare(replacement.token, "Share link rotated; the replacement was copied."); setShares(await platform.listCloudShares(sourceId)); })}>Rotate</button></b></div>)}</div> : null}</div>;
}
function MergeStatusCard({ status }: { status: MergeDriverStatus }) { const versionMatches = status.driverVersion === status.expectedVersion; return <div className="external-capabilities"><h3>Git readiness</h3><div><span>Git repository</span><b>{status.repositoryIsGit ? "Ready" : "Not detected"}</b></div><div><span>Workspace manifest</span><b>{status.manifestPresent ? "Present" : "Missing"}</b></div><div><span>Merge driver</span><b>{!status.driverVersion ? "Not installed" : !versionMatches ? `Version mismatch (${status.driverVersion} / ${status.expectedVersion})` : status.driverConfigured && status.attributesConfigured ? "Installed & configured" : "Installed; setup required"}</b></div><div><span>.gitattributes</span><b>{status.attributesConfigured ? "Configured" : "Missing"}</b></div><div><span>Schema fingerprint</span><b>{status.fingerprintMatches === null ? "Unknown" : status.fingerprintMatches ? "Matches" : "Different"}</b></div></div>; }
function ProjectPolicyCard({ project, projectId, onSave }: { project: EffectiveSettings["project"]; projectId: string; onSave: (project: NonNullable<EffectiveSettings["project"]>) => void }) { const value = project ?? defaultProjectSettings(projectId); return <div className="project-policy"><h3>Team project policy</h3><p>Shared rules override personal and source preferences. Organization policy remains highest priority.</p><ToggleRow label="Allow Snapshot sync" checked={value.allowSnapshotSync} onChange={(allowSnapshotSync) => onSave({ ...value, allowSnapshotSync, updatedAt: new Date().toISOString() })} /><ToggleRow label="Allow shared layouts" checked={value.allowSharedLayouts} onChange={(allowSharedLayouts) => onSave({ ...value, allowSharedLayouts, updatedAt: new Date().toISOString() })} /><ToggleRow label="Allow remote AI" checked={value.allowRemoteAi} onChange={(allowRemoteAi) => onSave({ ...value, allowRemoteAi, updatedAt: new Date().toISOString() })} /><button type="button" className="secondary-setting-action" onClick={() => onSave({ ...value, sharedCanvas: value.sharedCanvas ? null : defaultAppSettings().canvas, updatedAt: new Date().toISOString() })}>{value.sharedCanvas ? "Stop sharing ER display rules" : "Share default ER display rules"}</button></div>; }
function AboutDocument({ kind, onClose }: { kind: "releaseNotes" | "license" | "notices"; onClose: () => void }) { const content = kind === "releaseNotes" ? { title: "Release notes · 0.1.0", body: "Initial local-first release: PostgreSQL and MySQL schema introspection, field-level ER relationships, Snapshot history, split-file Git semantics, offline and OpenAI-compatible explanations, opt-in metadata Cloud sync, and the unified Settings control center." } : kind === "license" ? { title: "License", body: "Nodal Studio source code is distributed under the MIT license. Copyright (c) 2026 ClayCosmos. The license permits use, copying, modification, distribution, sublicensing, and sale subject to preserving the copyright and permission notice; the software is provided without warranty." } : { title: "Third-party notices", body: "This application uses Rust, Tauri, React, TypeScript, Vite, TanStack Query, React Flow, ELK.js, SQLx, Axum, Tokio, Reqwest, Serde and their transitive dependencies. Distribution builds must include the license texts generated from Cargo.lock and pnpm-lock.yaml." }; return <div className="data-boundary" role="dialog" aria-modal="true" aria-label={content.title}><h3>{content.title}</h3><p>{content.body}</p><button type="button" onClick={onClose}>Close</button></div>; }
function redactedDiagnosticSummary(info: DiagnosticInfo, app: AppSettings) { return JSON.stringify({ application: "Nodal Studio", version: info.appVersion, rustVersion: info.rustVersion, target: info.target, offlineMode: app.privacy.offlineMode, diagnosticsEnabled: app.privacy.diagnosticsEnabled, updateChannel: app.updates.channel, logLevel: app.privacy.logLevel }, null, 2); }
function capturePerformanceSnapshot() { const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory; return { uptimeMs: performance.now(), domNodes: document.querySelectorAll("*").length, resourceEntries: performance.getEntriesByType("resource").length, heapBytes: memory?.usedJSHeapSize ?? null }; }
function formatSettingsDate(value: string, format: AppSettings["general"]["dateTimeFormat"]) { const date = new Date(value); return format === "iso8601" ? date.toISOString() : date.toLocaleString(); }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function humanize(value: string) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
