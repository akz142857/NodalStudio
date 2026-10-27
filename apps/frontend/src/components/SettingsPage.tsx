import { AiReplyPreferences } from "./settings/AiReplyPreferences";
import { Button } from "../design-system/Button";
import { I18nProvider, useI18n, type Locale, formatDate } from "../i18n";
import applicationLicense from "../../../../LICENSE?raw";
import { PrivacyPolicy } from "./settings/PrivacyPolicy";
import { UpdatePanel } from "./settings/UpdatePanel";
import { useUpdateBlocker } from "../platform/update-guard";
import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ActionIcon, type ActionIconName } from "./ActionIcon";
import { SettingsSection, SettingsGroup, ToggleRow, SelectRow, RangeRow, NumberRow, TextRow, SecretRow } from "./settings/SettingsControls";
import "./settings/settings.css";
import { CapabilitiesMatrix } from "./CapabilitiesMatrix";
import {
  defaultAppSettings,
  defaultProjectSettings,
  type AppSettings,
  type DataSourceProfile,
  type DataSourceSettings,
  type DatabaseInfo,
  type EffectiveSettings,
  type RuntimeInfo,
  type NodalStudioPlatform,
  type StorageUsage,
  type SecurityStatus,
  type MergeDriverStatus,
  type SyncDiagnostic,
  type AiProviderTestResult,
  type DiagnosticInfo,
  type CloudAuditEntry,
  type CloudShareSummary,
  type ExternalAccessRecord,
} from "../platform";

const ThirdPartyNotices = lazy(() => import("./settings/ThirdPartyNotices"));

const categories = [
  ["general", "General", "language theme startup date time"],
  ["appearance", "Appearance", "density font sidebar inspector motion contrast"],
  ["canvas", "Canvas & ER", "field foreign key index relation layout comment"],
  ["data-sources", "Data Sources", "database refresh timeout ssl connection"],
  ["history", "History & Storage", "snapshot retention backup cache disk"],
  ["git", "Git", "repository merge driver conflict fingerprint"],
  ["ai", "AI", "provider model context privacy explanation reply preferences instructions language detail terminology"],
  ["cloud", "Cloud Sync", "team project sync offline queue conflict"],
  ["privacy", "Privacy & Security", "offline diagnostics token keychain log"],
  ["notifications", "Notifications", "schema change conflict warning quiet"],
  ["shortcuts", "Keyboard Shortcuts", "keyboard command focus refresh sidebar"],
  ["updates", "Updates & About", "version update channel license logs"],
  ["capabilities", "Capabilities", "support scope matrix PostgreSQL MySQL Desktop Web query diagram export preflight limitations"],
  ["advanced", "Advanced", "performance worker beta reset factory"],
] as const;

export type SettingsCategory = (typeof categories)[number][0];

const categoryIcons: Record<SettingsCategory, ActionIconName> = {
  general: "settings", appearance: "appearance", canvas: "canvas", "data-sources": "database",
  history: "history", git: "git", ai: "ai", cloud: "cloud", privacy: "shield",
  notifications: "bell", shortcuts: "command", updates: "info", capabilities: "grid", advanced: "sliders",
};
const categoryMessages = {"general":"settings.category.general","appearance":"settings.category.appearance","canvas":"settings.category.canvas","data-sources":"settings.category.data-sources","history":"settings.category.history","git":"settings.category.git","ai":"settings.category.ai","cloud":"settings.category.cloud","privacy":"settings.category.privacy","notifications":"settings.category.notifications","shortcuts":"settings.category.shortcuts","updates":"settings.category.updates","capabilities":"settings.category.capabilities","advanced":"settings.category.advanced"} as const;
const categoryAliases: Record<SettingsCategory, string> = {"general":"语言 主题 启动 日期 时间 language theme startup date time","appearance":"密度 字体 侧栏 详情 动效 对比度","canvas":"字段 外键 索引 关系 布局 注释","data-sources":"数据库 刷新 超时 连接","history":"快照 保留 备份 缓存 磁盘","git":"仓库 合并 冲突 指纹","ai":"提供方 模型 上下文 隐私 解释 回复 偏好 附加 指令 语言 详略 术语","cloud":"团队 项目 同步 离线 队列 冲突","privacy":"诊断 令牌 密钥 凭据 日志 安全","notifications":"结构 变更 冲突 警告 免打扰","shortcuts":"键盘 命令 聚焦 刷新 侧栏","updates":"版本 更新 通道 许可证 日志","capabilities":"支持 范围 矩阵 查询 图 导出 预检 限制","advanced":"性能 实验 重置 恢复"};
const navigationGroups = [
  { title: "settings.group.workspace", items: categories.slice(0, 5) },
  { title: "settings.group.services", items: categories.slice(5, 8) },
  { title: "settings.group.application", items: categories.slice(8) },
] as const;

type SettingsPageProps = {
  settings: EffectiveSettings;
  runtime?: RuntimeInfo;
  dataSources: DataSourceProfile[];
  activeSourceId?: string;
  activeDatabase?: DatabaseInfo;
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

export function SettingsPage(props: SettingsPageProps) {
  const i18n = useI18n(props.settings.app.general.language);
  return <I18nProvider value={i18n}><SettingsContent {...props} /></I18nProvider>;
}

function SettingsContent({
  settings,
  runtime,
  dataSources,
  activeSourceId,
  activeDatabase,
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
  const { t, locale, plural } = useI18n();

  const isMas = runtime?.distribution === "macAppStore";
  const commandLabels: Record<string, string> = { openSettings: t("settings.command.openSettings"), focusSearch: t("settings.command.focusSearch"), refreshSchema: t("settings.command.refreshSchema"), toggleLeftSidebar: t("settings.command.toggleLeftSidebar"), toggleRightInspector: t("settings.command.toggleRightInspector"), fitCanvas: t("settings.command.fitCanvas"), focusSelectedTable: t("settings.command.focusSelectedTable"), relayoutCanvas: t("settings.command.relayoutCanvas"), largeModelVirtualization: t("settings.command.largeModelVirtualization"), relationshipInferenceV2: t("settings.command.relationshipInferenceV2"), environmentDrift: t("settings.command.environmentDrift"), migrationProvenance: t("settings.command.migrationProvenance"), codeLineage: t("settings.command.codeLineage") };
  const commandLabel = (key: string) => commandLabels[key] ?? humanize(key);
  const contentRef = useRef<HTMLElement>(null);
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string>();
  const [storageUsage, setStorageUsage] = useState<StorageUsage>();
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus>();
  const [mergeStatus, setMergeStatus] = useState<MergeDriverStatus>();
  const [conflictReport, setConflictReport] = useState<{ path: string; contents: string }>();
  const aiSavePending = useRef(false);
  const [aiSecret, setAiSecret] = useState("");
  const [cloudSecret, setCloudSecret] = useState("");
  const [operationError, setOperationError] = useState("");
  const [settingsFilePath, setSettingsFilePath] = useState("");
  const [operationMessage, setOperationMessage] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [syncDiagnostics, setSyncDiagnostics] = useState<SyncDiagnostic[]>([]);
  const [cloudAudit, setCloudAudit] = useState<CloudAuditEntry[]>([]);
  const [externalAccess, setExternalAccess] = useState<ExternalAccessRecord[]>([]);
  const [aiTestResult, setAiTestResult] = useState<AiProviderTestResult>();
  const [diagnosticInfo, setDiagnosticInfo] = useState<DiagnosticInfo>();
  const [privacyOpen, setPrivacyOpen] = useState(false);
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
    const available = categories.filter(([id]) => !isMas || id !== "cloud");
    return normalized
      ? available.filter((item) => `${item[1]} ${item[2]} ${t(categoryMessages[item[0]])} ${categoryAliases[item[0]]}`.toLowerCase().includes(normalized))
      : available;
  }, [query, t, isMas]);
  const visibleCategory = filteredCategories.some(([id]) => id === category)
    ? category
    : filteredCategories[0]?.[0];
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [visibleCategory]);
  useUpdateBlocker(t("settings.saveOrDiscardAISettingsEdits"), JSON.stringify(aiDraft) !== JSON.stringify(settings.source?.ai) || Boolean(aiSecret));
  useUpdateBlocker(t("settings.saveOrDiscardCloudSettingsEdits"), JSON.stringify(cloudDraft) !== JSON.stringify(settings.source?.cloud) || Boolean(cloudSecret));
  useUpdateBlocker(t("settings.waitForSettingsToFinishSaving"), saveState === "saving");
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
    setSaveError(undefined);
    setSaveState("saving");
    try {
      await onUpdateApp(next);
      setSaveState("saved");
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      setSaveState("error");
    }
  }

  async function saveSource(next: DataSourceSettings) {
    setSaveError(undefined);
    setSaveState("saving");
    try {
      await onUpdateSource(next);
      setSaveState("saved");
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
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
  const aiDirty = JSON.stringify(ai) !== JSON.stringify(source?.ai) || Boolean(aiSecret);
  async function saveAiConfiguration() {
    if (!source || !ai || aiSavePending.current) return;
    aiSavePending.current = true;
    setSaveError(undefined);
    setSaveState("saving");
    try {
      await onUpdateSource({ ...source, ai: { ...ai, credentialConfigured: source.ai.credentialConfigured } });
      if (aiSecret.trim()) {
        await platform.saveAiCredential(source.sourceId, aiSecret);
        setAiSecret("");
        await onReload();
      }
      setSaveState("saved");
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      setSaveState("error");
    } finally {
      aiSavePending.current = false;
    }
  }
  const cloud = cloudDraft ?? source?.cloud;
  const historySettings = source?.storage ?? app.history;
  const isManaged = (path: string) => settings.managed.find((item) => item.path === path || path.startsWith(`${item.path}.`));

  // Reloading app preferences can return a new source object with unchanged settings.
  // Only actual source/configuration changes may replace unsaved provider drafts.
  const savedAi = JSON.stringify(settings.source?.ai);
  const savedCloud = JSON.stringify(settings.source?.cloud);
  const syncProviderDrafts = useEffectEvent(() => {
    setAiDraft(settings.source?.ai);
    setCloudDraft(settings.source?.cloud);
  });
  useEffect(() => {
    const timer = window.setTimeout(() => syncProviderDrafts(), 0);
    return () => window.clearTimeout(timer);
  }, [settings.source?.sourceId, savedAi, savedCloud]);

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
      setOperationError(error instanceof Error ? error.message : t("settings.operationFailed"));
    }
  }

  async function confirmSourceDeletion(profile: DataSourceProfile, kind: "history" | "semantics" | "connection") {
    const impact = await platform.previewSourceDataDeletion(profile.id);
    const detail = kind === "history"
      ? t("settings.snapshotRecordsApproximately", { value0: impact.snapshotRecords, value1: formatBytes(impact.snapshotBytes) })
      : kind === "semantics"
        ? t("settings.semanticLayoutRecordsAndPendingSyncItemsApproximately", { value0: impact.semanticRecords, value1: impact.pendingSyncRecords, value2: formatBytes(impact.semanticBytes + impact.syncQueueBytes) })
        : t("settings.connectionRecordAndItsDatabaseSystemCredentialStore", { value0: impact.connectionRecords, value1: impact.snapshotRecords, value2: impact.semanticRecords });
    return window.confirm(t("settings.forAffectedCloudProjectDataIsNotDeleted", { value0: kind === "connection" ? t("settings.delete.connection") : kind === "history" ? t("settings.delete.history") : t("settings.delete.semantics"), value1: profile.displayName, value2: detail }));
  }

  async function updateSystemNotifications(enabled: boolean) {
    if (enabled && "Notification" in window) {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setOperationError(t("settings.systemNotificationPermissionWasNotGranted"));
        return;
      }
    }
    await saveApp({ ...app, notifications: { ...app.notifications, systemNotifications: enabled } });
  }



  function updateShortcut(command: string, binding: string) {
    const normalized = binding.trim().toLowerCase();
    const duplicate = Object.entries(app.shortcuts.bindings).find(
      ([otherCommand, otherBinding]) =>
        otherCommand !== command && normalized && otherBinding.trim().toLowerCase() === normalized,
    );
    if (duplicate) {
      setOperationError(t("settings.isAlreadyAssignedTo", { value0: binding, value1: commandLabel(duplicate[0]) }));
      return;
    }
    setOperationError("");
    void saveApp({ ...app, shortcuts: { bindings: { ...app.shortcuts.bindings, [command]: binding } } });
  }

  return (
    <section className="ds-surface settings-page" aria-label={t("settings.settings")}>
      <header className="settings-header">
        <Button variant="ghost" className="settings-back" onClick={onClose}>{t("settings.back")}</Button>
        <h1>{t("settings.settings")}</h1>
        <label className="settings-search">
          <span className="settings-visually-hidden">{t("settings.searchSettings")}</span>
          <ActionIcon name="search" />
          <input
            autoFocus
            type="search"
            placeholder={t("settings.searchSettingsDetail")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="settings-save-state" data-state={saveState} role={saveState === "error" ? "alert" : "status"} aria-live="polite">
          {saveState === "saving" ? t("settings.saving") : saveState === "saved" ? t("settings.savedLocally") : saveState === "error" ? `${t("settings.saveFailed")}${saveError ? ` · ${saveError}` : ""}` : runtime?.label}
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-navigation" aria-label={t("settings.settingsCategories")}>
          <label className="settings-category-picker">{t("settings.category")}<select value={visibleCategory ?? ""} onChange={(event) => chooseCategory(event.target.value as SettingsCategory)} disabled={!filteredCategories.length}>
              {!filteredCategories.length ? <option value="">{t("settings.noResults")}</option> : null}
              {filteredCategories.map(([id]) => <option key={id} value={id}>{t(categoryMessages[id])}</option>)}
            </select>
          </label>
          <div className="settings-navigation-list" onKeyDown={(event) => {
            if (!(event.target instanceof HTMLButtonElement)) return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const index = buttons.indexOf(event.target);
            const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault();
            buttons[next]?.focus();
          }}>
            {navigationGroups.map((group) => {
              const items = group.items.filter(([id]) => filteredCategories.some(([visible]) => id === visible));
              return items.length ? <div className="settings-navigation-group" key={group.title}>
                <p>{t(group.title)}</p>
                {items.map(([id]) => <Button type="button" key={id} aria-current={visibleCategory === id ? "page" : undefined} onClick={() => chooseCategory(id)}>
                  <ActionIcon name={categoryIcons[id]} /><span>{t(categoryMessages[id])}</span>
                </Button>)}
              </div> : null;
            })}
          </div>
          <footer>
            <span>{runtime?.kind === "web" ? t("settings.webViewer") : t("settings.desktop")}</span>
            <small>v{runtime?.version ?? "0.1.0"}</small>
          </footer>
        </nav>

        <div className="settings-detail-pane">
        <main className="settings-content" ref={contentRef} tabIndex={-1}>
          {!filteredCategories.length ? <div className="settings-no-results"><ActionIcon name="search" /><h2>{t("settings.noSettingsFound")}</h2><p>{t("settings.tryAnotherSearchTerm")}</p><Button type="button" onClick={() => setQuery("")}>{t("settings.clearSearch")}</Button></div> : null}
          {operationError ? <p className="settings-operation-error" role="alert">{t("settings.operationFailed")} <span>{operationError}</span></p> : null}
          {operationMessage ? <p className="settings-operation-message" role="status">{operationMessage}</p> : null}
          {visibleCategory === "general" ? (
            <SettingsSection title={t("settings.general")} description={t("settings.languageThemeStartupAndDatePreferences")}>
              <SettingsGroup title={t("settings.display")}>
              <SelectRow disabled={saveState === "saving"} label={t("settings.language")} value={app.general.language} onChange={(language) => void saveApp({ ...app, general: { ...app.general, language: language as AppSettings["general"]["language"] } })} options={[['system',t("settings.followSystem")],['zhCn','简体中文'],['en','English']]} />
              <SelectRow label={t("settings.theme")} value={app.general.theme} onChange={(theme) => void saveApp({ ...app, general: { ...app.general, theme: theme as AppSettings["general"]["theme"] } })} options={[['system',t("settings.followSystem")],['dark',t("settings.dark")],['light',t("settings.light")]]} />
              <RangeRow label={t("settings.uIScale")} value={app.general.uiScalePercent} min={90} max={125} unit="%" onChange={(uiScalePercent) => void saveApp({ ...app, general: { ...app.general, uiScalePercent } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.startup")}>
              <SelectRow label={t("settings.startPage")} value={app.general.startPage} onChange={(startPage) => void saveApp({ ...app, general: { ...app.general, startPage: startPage as AppSettings["general"]["startPage"] } })} options={[['lastDataSource',t("settings.lastDataSource")],['connection',t("settings.connectionPage")],['blank',t("settings.blankWorkspace")]]} />
              <ToggleRow label={t("settings.reopenLastWorkspace")} description={t("settings.restoreTheLastSourceAndViewModeOn")} checked={app.general.reopenLastWorkspace} onChange={(reopenLastWorkspace) => void saveApp({ ...app, general: { ...app.general, reopenLastWorkspace } })} />
              <ToggleRow label={t("settings.confirmBeforeQuit")} description={t("settings.preventQuittingWhileAnImportSyncOrWrite")} checked={app.general.confirmBeforeQuit} onChange={(confirmBeforeQuit) => void saveApp({ ...app, general: { ...app.general, confirmBeforeQuit } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.dateTime")}>
              <SelectRow label={t("settings.dateAndTimeFormat")} value={app.general.dateTimeFormat} onChange={(dateTimeFormat) => void saveApp({ ...app, general: { ...app.general, dateTimeFormat: dateTimeFormat as AppSettings["general"]["dateTimeFormat"] } })} options={[['local',t("settings.localFormat")],['iso8601','ISO 8601']]} />
              </SettingsGroup>
              <CategoryReset onReset={() => void saveApp({ ...app, general: defaultAppSettings().general })} />
            </SettingsSection>
          ) : null}

          {visibleCategory === "appearance" ? (
            <SettingsSection title={t("settings.appearance")} description={t("settings.workspaceDensityAccessibilityAndPanelDefaults")}>
              <SettingsGroup title={t("settings.textDensity")}>
              <SelectRow label={t("settings.informationDensity")} value={app.appearance.density} onChange={(density) => void saveApp({ ...app, appearance: { ...app.appearance, density: density as AppSettings["appearance"]["density"] } })} options={[['comfortable',t("settings.comfortable")],['compact',t("settings.compact")]]} />
              <RangeRow label={t("settings.uIFontSize")} value={app.appearance.uiFontSize} min={11} max={18} unit=" px" onChange={(uiFontSize) => void saveApp({ ...app, appearance: { ...app.appearance, uiFontSize } })} />
              <RangeRow label={t("settings.tableNodeFontSize")} value={app.appearance.nodeFontSize} min={9} max={18} unit=" px" onChange={(nodeFontSize) => void saveApp({ ...app, appearance: { ...app.appearance, nodeFontSize } })} />
              <RangeRow label={t("settings.monospaceFontSize")} value={app.appearance.monospaceFontSize} min={9} max={18} unit=" px" onChange={(monospaceFontSize) => void saveApp({ ...app, appearance: { ...app.appearance, monospaceFontSize } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.accessibility")}>
              <ToggleRow label={t("settings.reduceMotion")} checked={app.appearance.reduceMotion} onChange={(reduceMotion) => void saveApp({ ...app, appearance: { ...app.appearance, reduceMotion } })} />
              <ToggleRow label={t("settings.highContrastRelations")} checked={app.appearance.highContrastRelations} onChange={(highContrastRelations) => void saveApp({ ...app, appearance: { ...app.appearance, highContrastRelations } })} />
              <ToggleRow label={t("settings.colorBlindFriendlyRiskPalette")} checked={app.appearance.colorBlindPalette} onChange={(colorBlindPalette) => void saveApp({ ...app, appearance: { ...app.appearance, colorBlindPalette } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.workspacePanels")}>
              <RangeRow label={t("settings.leftSidebarDefaultWidth")} value={app.appearance.leftSidebarWidth} min={220} max={480} unit=" px" onChange={(leftSidebarWidth) => void saveApp({ ...app, appearance: { ...app.appearance, leftSidebarWidth } })} />
              <ToggleRow label={t("settings.leftSidebarExpandedByDefault")} checked={app.appearance.leftSidebarExpanded} onChange={(leftSidebarExpanded) => void saveApp({ ...app, appearance: { ...app.appearance, leftSidebarExpanded } })} />
              <RangeRow label={t("settings.rightInspectorDefaultWidth")} value={app.appearance.rightSidebarWidth} min={240} max={520} unit=" px" onChange={(rightSidebarWidth) => void saveApp({ ...app, appearance: { ...app.appearance, rightSidebarWidth } })} />
              <ToggleRow label={t("settings.rightInspectorExpandedByDefault")} checked={app.appearance.rightSidebarExpanded} onChange={(rightSidebarExpanded) => void saveApp({ ...app, appearance: { ...app.appearance, rightSidebarExpanded } })} />
              <ToggleRow label={t("settings.restoreSidebarState")} checked={app.appearance.restoreSidebarState} onChange={(restoreSidebarState) => void saveApp({ ...app, appearance: { ...app.appearance, restoreSidebarState } })} />
              </SettingsGroup>
              <Button type="button" className="secondary-setting-action" onClick={() => void saveApp({ ...app, appearance: defaultAppSettings().appearance })}>{t("settings.resetWorkspacePanels")}</Button>
            </SettingsSection>
          ) : null}

          {visibleCategory === "canvas" ? (
            <SettingsSection title={t("settings.canvasER")} description={t("settings.chooseWhatTheModelShowsAndHowRelationships")} managed={isManaged("canvas")}>
              <SettingsGroup title={t("settings.tableContents")}>
              <ToggleRow label={t("settings.showSchemaInTableHeaders")} checked={app.canvas.showSchema} onChange={(showSchema) => void saveApp({ ...app, canvas: { ...app.canvas, showSchema } })} />
              <ToggleRow label={t("settings.showTableAndFieldComments")} checked={app.canvas.showColumnComments} onChange={(showColumnComments) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnComments, showTableComments: showColumnComments } })} />
              <ToggleRow label={t("settings.showColumnTypes")} checked={app.canvas.showColumnTypes} onChange={(showColumnTypes) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnTypes } })} />
              <ToggleRow label={t("settings.showNullability")} checked={app.canvas.showColumnNullable} onChange={(showColumnNullable) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnNullable } })} />
              <ToggleRow label={t("settings.showDefaultValues")} checked={app.canvas.showColumnDefaults} onChange={(showColumnDefaults) => void saveApp({ ...app, canvas: { ...app.canvas, showColumnDefaults } })} />
              <ToggleRow label={t("settings.showKeyBadges")} checked={app.canvas.showKeyBadges} onChange={(showKeyBadges) => void saveApp({ ...app, canvas: { ...app.canvas, showKeyBadges } })} />
              <SelectRow label={t("settings.indexes")} value={app.canvas.indexes} onChange={(indexes) => void saveApp({ ...app, canvas: { ...app.canvas, indexes: indexes as AppSettings["canvas"]["indexes"] } })} options={[['expanded',t("settings.alwaysVisible")],['collapsed',t("settings.collapsed")],['hidden',t("settings.hidden")]]} />
              <RangeRow label={t("settings.columnsInitiallyVisible")} value={app.canvas.maxInitialColumns} min={10} max={200} unit={t("settings.fields")} onChange={(maxInitialColumns) => void saveApp({ ...app, canvas: { ...app.canvas, maxInitialColumns } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.relationships")}>
              <ToggleRow label={t("settings.physicalForeignKeys")} checked={app.canvas.showDeclaredRelationships} onChange={(showDeclaredRelationships) => void saveApp({ ...app, canvas: { ...app.canvas, showDeclaredRelationships } })} />
              <ToggleRow label={t("settings.inferredRelationships")} description={t("settings.suggestionsRemainVisuallyDistinctFromDatabaseConstraints")} checked={app.canvas.showInferredRelationships} onChange={(showInferredRelationships) => void saveApp({ ...app, canvas: { ...app.canvas, showInferredRelationships } })} />
              <ToggleRow label={t("settings.fieldToFieldEdges")} checked={app.canvas.fieldLevelEdges} onChange={(fieldLevelEdges) => void saveApp({ ...app, canvas: { ...app.canvas, fieldLevelEdges } })} />
              <ToggleRow label={t("settings.relationshipNames")} checked={app.canvas.showRelationNames} onChange={(showRelationNames) => void saveApp({ ...app, canvas: { ...app.canvas, showRelationNames } })} />
              <ToggleRow label={t("settings.cardinality")} checked={app.canvas.showCardinality} onChange={(showCardinality) => void saveApp({ ...app, canvas: { ...app.canvas, showCardinality } })} />
              <ToggleRow label={t("settings.referentialActions")} checked={app.canvas.showReferentialActions} onChange={(showReferentialActions) => void saveApp({ ...app, canvas: { ...app.canvas, showReferentialActions } })} />
              <RangeRow label={t("settings.relationshipHighlightDepth")} value={app.canvas.relationshipHighlightDepth} min={0} max={2} unit={t("settings.hops")} onChange={(relationshipHighlightDepth) => void saveApp({ ...app, canvas: { ...app.canvas, relationshipHighlightDepth } })} />
              <SelectRow label={t("settings.edgeStyle")} value={app.canvas.edgeStyle} onChange={(edgeStyle) => void saveApp({ ...app, canvas: { ...app.canvas, edgeStyle: edgeStyle as AppSettings["canvas"]["edgeStyle"] } })} options={[['orthogonal',t("settings.orthogonal")],['curved',t("settings.curved")]]} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.layout")}>
              <SelectRow label={t("settings.layoutDirection")} value={app.canvas.layoutDirection} onChange={(layoutDirection) => void saveApp({ ...app, canvas: { ...app.canvas, layoutDirection: layoutDirection as AppSettings["canvas"]["layoutDirection"] } })} options={[['leftToRight',t("settings.leftToRight")],['topToBottom',t("settings.topToBottom")]]} />
              <RangeRow label={t("settings.nodeSpacing")} value={app.canvas.nodeSpacing} min={30} max={180} unit=" px" onChange={(nodeSpacing) => void saveApp({ ...app, canvas: { ...app.canvas, nodeSpacing } })} />
              <RangeRow label={t("settings.layerSpacing")} value={app.canvas.layerSpacing} min={40} max={300} unit=" px" onChange={(layerSpacing) => void saveApp({ ...app, canvas: { ...app.canvas, layerSpacing } })} />
              <RangeRow label={t("settings.edgeSpacing")} value={app.canvas.edgeSpacing} min={8} max={100} unit=" px" onChange={(edgeSpacing) => void saveApp({ ...app, canvas: { ...app.canvas, edgeSpacing } })} />
              <RangeRow label={t("settings.largeModelThreshold")} value={app.canvas.largeModelThreshold} min={100} max={2000} unit={t("settings.tables")} onChange={(largeModelThreshold) => void saveApp({ ...app, canvas: { ...app.canvas, largeModelThreshold } })} />
              </SettingsGroup>
            </SettingsSection>
          ) : null}

          {visibleCategory === "data-sources" ? (
            <SettingsSection title={t("settings.dataSources")} description={t("settings.connectionBehaviorAndSchemaRefreshPolicy")}>
              <StatusCard status={activeSourceId ? t("settings.configured") : t("settings.noActiveSource")} label={t(plural(dataSources.length) === "one" ? "settings.sources.count.one" : "settings.sources.count.other", { count: dataSources.length })} />
              <SettingsGroup title={t("settings.connectionDefaults")}>
              <SelectRow label={t("settings.defaultDatabaseEngine")} value={app.connectionDefaults.databaseEngine} onChange={(databaseEngine) => void saveApp({ ...app, connectionDefaults: { ...app.connectionDefaults, databaseEngine: databaseEngine as AppSettings["connectionDefaults"]["databaseEngine"] } })} options={[['postgreSql','PostgreSQL'],['mySql','MySQL']]} />
              <SelectRow label={t("settings.defaultSSLMode")} value={app.connectionDefaults.sslMode} onChange={(sslMode) => void saveApp({ ...app, connectionDefaults: { ...app.connectionDefaults, sslMode: sslMode as AppSettings["connectionDefaults"]["sslMode"] } })} options={[['disable',t("settings.disable")],['prefer',t("settings.prefer")],['require',t("settings.require")],['verifyCa',t("settings.verifyCA")],['verifyFull',t("settings.verifyFull")]]} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.savedConnections")}>
              <div className="data-source-settings-list">{dataSources.length === 0 ? <p className="settings-empty-inline">{t("settings.noSavedConnectionsAddADataSourceFrom")}</p> : null}{dataSources.map((profile) => <article key={profile.id}><div><strong>{profile.displayName}</strong><span>{profile.databaseType === "mySql" ? "MySQL" : "PostgreSQL"} · {profile.host}:{profile.port}/{profile.database} · SSL {profile.sslMode}</span></div><div><Button type="button" onClick={() => void runOperation(async () => { const displayName = window.prompt(t("settings.renameDataSource"), profile.displayName)?.trim(); if (!displayName || displayName === profile.displayName) return; await platform.renameDataSource(profile.id, displayName); await onDataSourcesChanged(); setOperationMessage(t("settings.dataSourceRenamed")); })}>{t("settings.rename")}</Button><Button type="button" onClick={() => void runOperation(async () => { const copy = await platform.duplicateDataSource(profile.id); await onDataSourcesChanged(); setOperationMessage(t("settings.createdWithoutCredentialsSelectItInTheConnection", { value0: copy.displayName })); })}>{t("settings.duplicateParameters")}</Button><Button type="button" onClick={() => void runOperation(async () => { if (!window.confirm(t("settings.forgetTheSavedDatabaseAndSSHPasswordsFor", { value0: profile.displayName }))) return; await platform.clearCredentials(profile.id, { database: true, ai: false, cloud: false }); setOperationMessage(t("settings.databaseAndSSHCredentialsRemovedFromSystemCredential")); })}>{t("settings.forgetPassword")}</Button><Button type="button" onClick={() => void runOperation(async () => { if (!await confirmSourceDeletion(profile, "history")) return; const count = await platform.deleteSourceData(profile.id, { deleteConnection: false, deleteHistory: true, deleteSemantics: false, removeDatabaseCredential: false }); await onReload(); setOperationMessage(t("settings.deletedHistoryRecords", { value0: count })); })}>{t("settings.deleteHistory")}</Button><Button type="button" onClick={() => void runOperation(async () => { if (!await confirmSourceDeletion(profile, "semantics")) return; const count = await platform.deleteSourceData(profile.id, { deleteConnection: false, deleteHistory: false, deleteSemantics: true, removeDatabaseCredential: false }); await onReload(); setOperationMessage(t("settings.deletedSemanticRecords", { value0: count })); })}>{t("settings.deleteSemantics")}</Button><Button type="button" variant="danger" className="danger-setting-action" onClick={() => void runOperation(async () => { if (!await confirmSourceDeletion(profile, "connection")) return; await platform.deleteSourceData(profile.id, { deleteConnection: true, deleteHistory: false, deleteSemantics: false, removeDatabaseCredential: true }); await onDataSourcesChanged(); await onReload(); setOperationMessage(t("settings.dataSourceConnectionRemoved")); })}>{t("settings.removeConnection")}</Button></div></article>)}</div>
              </SettingsGroup>
              {source ? <>
              <SettingsGroup title={t("settings.refreshNotifications")}>
                <SelectRow label={t("settings.automaticRefresh")} value={String(source.refresh.intervalSeconds)} onChange={(value) => void saveSource({ ...source, refresh: { ...source.refresh, intervalSeconds: Number(value) } })} options={[["0",t("settings.off")],["30",t("settings.30Seconds")],["60",t("settings.1Minute")],["300",t("settings.5Minutes")],["900",t("settings.15Minutes")]]} />
                <NumberRow label={t("settings.customRefreshInterval")} value={source.refresh.intervalSeconds} min={0} max={86400} unit={t("settings.seconds0Disables")} onChange={(intervalSeconds) => void saveSource({ ...source, refresh: { ...source.refresh, intervalSeconds } })} />
                <ToggleRow label={t("settings.pauseRefreshInBackground")} checked={source.refresh.pauseInBackground} onChange={(pauseInBackground) => void saveSource({ ...source, refresh: { ...source.refresh, pauseInBackground } })} />
                <SelectRow label={t("settings.schemaChangeNotificationsForThisSource")} value={source.refresh.changeNotifications} onChange={(changeNotifications) => void saveSource({ ...source, refresh: { ...source.refresh, changeNotifications: changeNotifications as DataSourceSettings["refresh"]["changeNotifications"] } })} options={[['all',t("settings.allChanges")],['highRisk',t("settings.highRiskOnly")],['off',t("settings.off")]]} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.connectionBehavior")}>
                <NumberRow label={t("settings.connectionTimeout")} value={source.refresh.connectionTimeoutSeconds} min={1} max={120} unit={t("settings.seconds")} onChange={(connectionTimeoutSeconds) => void saveSource({ ...source, refresh: { ...source.refresh, connectionTimeoutSeconds } })} />
                <NumberRow label={t("settings.introspectionTimeout")} value={source.refresh.introspectionTimeoutSeconds} min={1} max={600} unit={t("settings.seconds")} onChange={(introspectionTimeoutSeconds) => void saveSource({ ...source, refresh: { ...source.refresh, introspectionTimeoutSeconds } })} />
                <ToggleRow label={t("settings.autoConnectOnLaunch")} checked={source.refresh.autoConnect} onChange={(autoConnect) => void saveSource({ ...source, refresh: { ...source.refresh, autoConnect } })} />
              </SettingsGroup>
                <div className="data-boundary"><h3>{t("settings.postgreSQLEventTriggerEnhancement")}</h3><p>{t("settings.statusNotInstalledOrInspectedNodalStudioOnly")}</p><Button type="button" disabled={!activeSourceId || dataSources.find((profile) => profile.id === activeSourceId)?.databaseType !== "postgreSql"} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setEventTriggerScript(await platform.generateEventTriggerScript(activeSourceId)); })}>{t("settings.generateReviewScript")}</Button>{eventTriggerScript ? <><pre>{eventTriggerScript}</pre><Button type="button" onClick={() => void navigator.clipboard.writeText(eventTriggerScript)}>{t("settings.copyScript")}</Button></> : null}</div>
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "history" ? (
            <SettingsSection title={t("settings.historyStorage")} description={t("settings.snapshotCaptureRetentionAndLocalDiskLimits")}>
              <SettingsGroup title={t("settings.captureRetention")}>
              <SelectRow label={t("settings.captureSnapshots")} value={historySettings.capturePolicy} onChange={(capturePolicy) => saveHistory({ capturePolicy: capturePolicy as AppSettings["history"]["capturePolicy"] })} options={[['onChange',t("settings.onStructuralChange")],['interval',t("settings.fixedInterval")],['manual',t("settings.manualOnly")]]} />
              <SelectRow label={t("settings.retention")} value={historySettings.retention} onChange={(retention) => saveHistory({ retention: retention as AppSettings["history"]["retention"] })} options={[['forever',t("settings.keepForever")],['count',t("settings.keepLatestCount")],['days',t("settings.keepRecentDays")]]} />
              {historySettings.retention !== "forever" ? <NumberRow label={historySettings.retention === "days" ? t("settings.daysToKeep") : t("settings.snapshotsToKeep")} value={historySettings.retentionValue} min={1} max={3650} onChange={(retentionValue) => saveHistory({ retentionValue })} /> : null}
              <ToggleRow label={t("settings.preserveHighRiskChanges")} checked={historySettings.preserveHighRisk} onChange={(preserveHighRisk) => saveHistory({ preserveHighRisk })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.storageBackup")}>
              <NumberRow label={t("settings.storageWarning")} value={app.history.storageWarningMegabytes} min={128} max={102400} unit="MB" onChange={(storageWarningMegabytes) => void saveApp({ ...app, history: { ...app.history, storageWarningMegabytes } })} />
              <TextRow readOnly={isMas} label={t("settings.portableBackupPath")} value={backupPath} placeholder="/absolute/path/model.nodalmodel" onChange={setBackupPath} />
              <div className="setting-action-row"><Button onClick={() => void runOperation(async () => { const path = await platform.pickWorkspacePath("saveBackup"); if (path) setBackupPath(path); })}>{t("submission.saveLocation")}</Button><Button onClick={() => void runOperation(async () => { const path = await platform.pickWorkspacePath("openBackup"); if (path) setBackupPath(path); })}>{t("submission.openFile")}</Button></div>
              <div className="setting-action-row"><Button type="button" onClick={() => void runOperation(async () => setStorageUsage(await platform.getStorageUsage()))}>{t("settings.viewStorageUsage")}</Button><Button type="button" disabled={!activeSourceId || !backupPath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const receipt = await platform.exportPortableBackup(activeSourceId, backupPath); setOperationMessage(t("settings.backedUpSnapshotsAndAnnotations", { value0: receipt.snapshots, value1: receipt.annotations })); })}>{t("settings.exportBackup")}</Button><Button type="button" disabled={!backupPath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { const preview = await platform.previewPortableBackup(backupPath); const identity = [preview.sourceLabel, preview.databaseName, preview.databaseType].filter(Boolean).join(" · "); const accepted = window.confirm(t("settings.importBackupFormatVExportedSnapshotsAnnotationsViews", { value0: identity || preview.sourceId, value1: preview.formatVersion, value2: formatDate(preview.exportedAt, locale, app.general.dateTimeFormat), value3: preview.snapshots, value4: preview.annotations, value5: preview.savedViews, value6: preview.willUpdateExistingSource ? t("settings.backup.updateSource") : t("settings.backup.createSource"), value7: preview.conflictStrategy })); if (!accepted) return; const receipt = await platform.importPortableBackup(backupPath); await onReload(); setOperationMessage(t("settings.restoredSnapshotsAndAnnotations", { value0: receipt.snapshots, value1: receipt.annotations })); })}>{t("settings.previewImport")}</Button><Button type="button" onClick={() => void runOperation(async () => { const cleared = await platform.clearRegenerableCache(); setOperationMessage(cleared ? t("settings.clearedCacheRecords", { value0: cleared }) : t("settings.noRegenerableCacheIsCurrentlyStored")); })}>{t("settings.clearCache")}</Button><Button type="button" onClick={() => void runOperation(async () => { if (!window.confirm(t("settings.clearSavedCanvasLayoutsSnapshotsAndSemanticsWill"))) return; await platform.clearLayouts(activeSourceId); setStorageUsage(await platform.getStorageUsage()); })}>{t("settings.clearLayouts")}</Button><Button type="button" onClick={() => void runOperation(async () => { const info = await platform.getDiagnosticInfo(); setDiagnosticInfo(info); setOperationMessage(t("settings.localDatabaseDirectory", { value0: info.dataDirectory })); })}>{t("settings.showLocalDatabaseLocation")}</Button></div>
              {storageUsage ? <StorageUsageCard usage={storageUsage} /> : null}
              </SettingsGroup>
            </SettingsSection>
          ) : null}

          {visibleCategory === "git" ? (
            <SettingsSection title={t("settings.gitCollaboration")} description={t("settings.reviewableSemanticsWithoutMonolithicModelConflicts")}>
              <details className="settings-disclosure"><summary>{t("settings.howSharedDescriptionsAreReviewed")}</summary><p>{t("settings.sharedDescriptionsContainTextOnlyWithoutPerObject")}</p></details>
              <StatusCard status={source?.git.repositoryPath ? t("settings.configured") : t("settings.off")} label={t("settings.manualExportAndImportNodalStudioNeverCommits")} />
              {source ? <>
              <SettingsGroup title={t("settings.repository")}>
                <TextRow readOnly={isMas} label={t("settings.repositoryPath")} value={source.git.repositoryPath} placeholder="/path/to/repository" onChange={(repositoryPath) => void saveSource({ ...source, git: { ...source.git, repositoryPath } })} />
                <Button onClick={() => void runOperation(async () => { const path = await platform.pickWorkspacePath("repository"); if (path) await saveSource({ ...source, git: { ...source.git, repositoryPath: path } }); })}>{t("submission.chooseFolder")}</Button>
                <ToggleRow label={t("settings.commitReminder")} checked={source.git.commitReminders} onChange={(commitReminders) => void saveSource({ ...source, git: { ...source.git, commitReminders } })} />
                <div className="setting-action-row"><Button type="button" disabled={!activeSourceId || !source.git.repositoryPath} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setMergeStatus(await platform.checkMergeDriver(activeSourceId, source.git.repositoryPath)); })}>{t(isMas ? "submission.checkGit" : "settings.checkRepositoryMergeDriver")}</Button><Button type="button" disabled={!activeSourceId || !source.git.repositoryPath} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const preview = await platform.previewGitExport(activeSourceId, source.git.repositoryPath); if (!window.confirm(t("settings.exportGitWorkspaceAddedModifiedRemovedUnchangedManaged", { value0: preview.addedFiles, value1: preview.modifiedFiles, value2: preview.removedFiles, value3: preview.unchangedFiles, value4: preview.schemaFingerprint }))) return; const receipt = await platform.exportGitWorkspace(activeSourceId, source.git.repositoryPath); setOperationMessage(t("settings.exportedManagedFilesRemovedStaleFiles", { value0: receipt.writtenFiles, value1: receipt.removedStaleFiles })); })}>{t("settings.previewExport")}</Button><Button type="button" disabled={!activeSourceId || !source.git.repositoryPath} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const preview = await platform.previewGitImport(activeSourceId, source.git.repositoryPath); if (!window.confirm(t("settings.importReviewedSemanticsAnnotationsDomainsViewsProvenanceRecords", { value0: preview.annotations, value1: preview.domainGroups, value2: preview.savedViews, value3: preview.provenance, value4: preview.lineageLinks, value5: preview.logicalRelationships, value6: preview.relationshipConflicts.length, value7: preview.relationshipConflicts.length ? `\n${preview.relationshipConflicts.join("\n")}` : "", value8: preview.fingerprintMatches ? t("settings.git.fingerprintMatches") : t("settings.git.fingerprintWarning"), value9: preview.workspaceFingerprint }))) return; const receipt = await platform.importGitWorkspace(activeSourceId, source.git.repositoryPath); await onReload(); setOperationMessage(t("settings.importedAnnotationsViewsAndLogicalRelationships", { value0: receipt.importedAnnotations, value1: receipt.importedSavedViews, value2: receipt.importedLogicalRelationships })); })}>{t("settings.previewImport")}</Button></div>
              </SettingsGroup>
                {mergeStatus ? <><MergeStatusCard status={mergeStatus} isMas={isMas} />{!isMas ? <div className="setting-action-row"><Button type="button" disabled={!mergeStatus.installCommand} onClick={() => void runOperation(async () => { await navigator.clipboard.writeText(mergeStatus.installCommand); setOperationMessage(t("settings.mergeDriverInstallationCommandCopiedReviewAndRun")); })}>{t("settings.copyInstallCommand")}</Button></div> : <p>{t("submission.masGit")}</p>}{mergeStatus.conflictReports.map((report) => <div className="settings-status-card" key={report}><strong>{report}</strong><span>{t("settings.semanticMergeConflictsRequireExplicitReview")}</span><div className="setting-action-row"><Button type="button" onClick={() => void runOperation(async () => setConflictReport({ path: report, contents: await platform.readGitConflictReport(source.git.repositoryPath, report) }))}>{t("settings.reviewReport")}</Button><Button type="button" variant="danger" className="danger-setting-action" onClick={() => void runOperation(async () => { if (!window.confirm(t("settings.deleteOnlyAfterResolvingEveryListedSemanticField", { value0: report }))) return; await platform.deleteGitConflictReport(source.git.repositoryPath, report); setConflictReport(undefined); if (activeSourceId) setMergeStatus(await platform.checkMergeDriver(activeSourceId, source.git.repositoryPath)); })}>{t("settings.confirmResolvedDelete")}</Button></div></div>)}{conflictReport ? <div className="data-boundary"><h3>{conflictReport.path}</h3><pre>{conflictReport.contents}</pre></div> : null}</> : null}
                <DataBoundary />
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "ai" ? (
            <SettingsSection title="AI" disabled={saveState === "saving"} description={t("settings.explanationsAreOptionalAndAlwaysRequireConfirmationBefore")}>
              <StatusCard status={app.privacy.offlineMode ? t("settings.offline") : source?.ai.enabled ? t("settings.configured") : t("settings.off")} label={t("settings.noDatabaseCredentialsOrRowDataAreSent")} />
              {source && ai ? <>
              <SettingsGroup title={t("settings.provider")}>
                <ToggleRow label={t("settings.enableAIExplanations")} checked={ai.enabled} managed={isManaged("ai.enabled")} onChange={(enabled) => setAiDraft({ ...ai, enabled })} />
                <SelectRow label={t("settings.provider")} value={ai.provider} onChange={(provider) => setAiDraft({ ...ai, provider: provider as DataSourceSettings["ai"]["provider"] })} options={[['offline',t("settings.offlineProvider")],['openAiCompatible',t("settings.provider.openAiCompatible")]]} />
                {ai.provider === "openAiCompatible" ? <><TextRow label={t("settings.endpoint")} value={ai.endpoint} placeholder="https://…" onChange={(endpoint) => setAiDraft({ ...ai, endpoint })} /><TextRow label={t("settings.model")} value={ai.model} onChange={(model) => setAiDraft({ ...ai, model })} /><SecretRow label={t("settings.aPIKey")} value={aiSecret} configured={source.ai.credentialConfigured} onChange={setAiSecret} showSave={false} onSave={() => undefined} /></> : null}
              </SettingsGroup>
              <SettingsGroup title={t("settings.context")}>
                <SelectRow label={t("settings.contextScope")} value={ai.contextScope} onChange={(contextScope) => setAiDraft({ ...ai, contextScope: contextScope as DataSourceSettings["ai"]["contextScope"] })} options={[['currentTable',t("settings.currentTable")],['oneHop',t("settings.oneRelationshipHop")],['domain',t("settings.currentBusinessDomain")]]} />
                <ToggleRow label={t("settings.includeComments")} checked={ai.includeComments} onChange={(includeComments) => setAiDraft({ ...ai, includeComments })} />
                <ToggleRow label={t("settings.includeConfirmedSemantics")} checked={ai.includeConfirmedSemantics} onChange={(includeConfirmedSemantics) => setAiDraft({ ...ai, includeConfirmedSemantics })} />
              </SettingsGroup>
              <AiReplyPreferences value={ai.replyPreferences} onChange={(replyPreferences) => setAiDraft({ ...ai, replyPreferences })} />
              <SettingsGroup title={t("settings.requestLimits")}>
                <NumberRow label={t("settings.requestTimeout")} value={ai.timeoutSeconds} min={1} max={300} unit={t("settings.seconds")} onChange={(timeoutSeconds) => setAiDraft({ ...ai, timeoutSeconds })} />
                <NumberRow label={t("settings.maximumRetries")} value={ai.maxRetries} min={0} max={5} onChange={(maxRetries) => setAiDraft({ ...ai, maxRetries })} />
                <NumberRow label={t("settings.maximumConcurrency")} value={ai.maxConcurrency} min={1} max={8} onChange={(maxConcurrency) => setAiDraft({ ...ai, maxConcurrency })} />
              </SettingsGroup>
                <AiRequestBoundary ai={ai} />

                <div className="setting-action-row"><Button type="button" disabled={aiDirty || !activeSourceId || !source.ai.enabled || (app.privacy.offlineMode && source.ai.provider !== "offline")} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setAiTestResult(await platform.testAiProvider(activeSourceId)); })}>{t("settings.testProvider")}</Button></div>
                {aiTestResult ? <p className="setting-inline-note">{t("settings.ai.testResult", { provider: aiTestResult.provider, model: aiTestResult.model ? ` · ${aiTestResult.model}` : "", date: formatSettingsDate(aiTestResult.testedAt, app.general.dateTimeFormat, locale), network: aiTestResult.networkUsed ? "" : t("settings.noNetworkUsed") })}</p> : null}
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "cloud" && !isMas ? (
            <SettingsSection title={t("settings.cloudSync")} description={t("settings.optionalMetadataCollaborationWithAnExplicitSyncAllowlist")}>
              <details className="settings-disclosure"><summary>{t("settings.howSharedDescriptionsAreReviewed")}</summary><p>{t("settings.sharedDescriptionsContainTextOnlyWithoutPerObject")}</p></details>
              <StatusCard status={app.privacy.offlineMode ? t("settings.offline") : source?.cloud.enabled ? t("settings.configured") : t("settings.off")} label={t("settings.cloudSyncIsDisabledByDefault")} />
              {source && cloud ? <>
              <SettingsGroup title={t("settings.connection")}>
                <ToggleRow label={t("settings.enableCloudSync")} checked={source.cloud.enabled} managed={isManaged("cloud.enabled")} onChange={(enabled) => void saveSource({ ...source, cloud: { ...source.cloud, enabled } })} />
                <TextRow label={t("settings.cloudEndpoint")} value={cloud.endpoint} placeholder="https://…" onChange={(endpoint) => setCloudDraft({ ...cloud, endpoint })} />
                <TextRow label={t("settings.webViewerURL")} value={cloud.viewerUrl} placeholder="https://viewer.example/" onChange={(viewerUrl) => setCloudDraft({ ...cloud, viewerUrl })} />
              </SettingsGroup>
                {!source.cloud.credentialConfigured ? <div className="project-policy"><h3>{t("settings.createCloudAccountAndTeam")}</h3><p>{t("settings.productionBootstrapIsDisabledUnlessTheServerOperator")}</p><TextRow label={t("settings.email")} value={cloudEmail} onChange={setCloudEmail} /><TextRow label={t("settings.displayName")} value={cloudDisplayName} onChange={setCloudDisplayName} /><TextRow label={t("settings.newTeamName")} value={cloudTeamName} onChange={setCloudTeamName} /><SecretRow label={t("settings.bootstrapSecret")} value={cloudBootstrapSecret} configured={false} onChange={setCloudBootstrapSecret} onSave={() => undefined} showSave={false} /><Button type="button" disabled={!activeSourceId || !source.cloud.endpoint || cloud.endpoint !== source.cloud.endpoint || !cloudEmail || !cloudDisplayName || !cloudTeamName || cloudBootstrapSecret.length < 24 || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm(t("settings.createThisCloudAccountAndTeamOnThe"))) return; const account = await platform.bootstrapCloudAccount(activeSourceId, cloudEmail, cloudDisplayName, cloudTeamName, cloudBootstrapSecret); setCloudBootstrapSecret(""); await onReload(); setOperationMessage(t("settings.cloudAccountConnectedAccessExpires", { value0: account.accountLabel, value1: formatSettingsDate(account.accessExpiresAt, app.general.dateTimeFormat, locale) })); })}>{t("settings.createAccountTeam")}</Button></div> : null}
              <SettingsGroup title={t("settings.accountProject")}>
                <TextRow label={t("settings.account")} value={cloud.accountLabel} onChange={(accountLabel) => setCloudDraft({ ...cloud, accountLabel })} />
                <TextRow label={t("settings.teamID")} value={cloud.teamId} onChange={(teamId) => setCloudDraft({ ...cloud, teamId })} />
                <TextRow label={t("settings.projectID")} value={cloud.projectId} onChange={(projectId) => setCloudDraft({ ...cloud, projectId })} />
                {source.cloud.credentialConfigured ? <><div className="setting-action-row"><Button type="button" disabled={!activeSourceId || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; const account = await platform.refreshCloudSession(activeSourceId); await onReload(); setOperationMessage(t("settings.cloudSessionRefreshedUntil", { value0: formatSettingsDate(account.accessExpiresAt, app.general.dateTimeFormat, locale) })); })}>{t("settings.refreshSession")}</Button></div><TextRow label={t("settings.newProjectName")} value={cloudProjectName} onChange={setCloudProjectName} /><div className="setting-action-row"><Button type="button" disabled={!activeSourceId || !source.cloud.teamId || !cloudProjectName || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm(t("settings.createCloudProjectForThisTeam", { value0: cloudProjectName }))) return; const project = await platform.createCloudProject(activeSourceId, cloudProjectName); setCloudProjectName(""); await onReload(); setOperationMessage(t("settings.createdProject", { value0: project })); })}>{t("settings.createProject")}</Button></div></> : null}
                <SecretRow label={t("settings.cloudAccessToken")} value={cloudSecret} configured={source.cloud.credentialConfigured} onChange={setCloudSecret} onSave={() => void runOperation(async () => { if (!activeSourceId) return; await platform.saveCloudCredential(activeSourceId, cloudSecret); setCloudSecret(""); await onReload(); })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.syncContentConflicts")}>
                <ToggleRow label={t("settings.syncSemantics")} checked={cloud.syncSemantics} onChange={(syncSemantics) => setCloudDraft({ ...cloud, syncSemantics })} />
                <ToggleRow label={t("settings.syncBusinessDomains")} checked={cloud.syncDomains} onChange={(syncDomains) => setCloudDraft({ ...cloud, syncDomains })} />
                <ToggleRow label={t("settings.syncSavedViews")} checked={cloud.syncSavedViews} onChange={(syncSavedViews) => setCloudDraft({ ...cloud, syncSavedViews })} />
                <ToggleRow label={t("settings.syncChangeSets")} checked={cloud.syncChangeSets} onChange={(syncChangeSets) => setCloudDraft({ ...cloud, syncChangeSets })} />
                <ToggleRow label={t("settings.syncSnapshots")} description={t("settings.offByDefaultPersonalLayoutsRemainLocal")} checked={cloud.syncSnapshots} managed={isManaged("cloud.syncSnapshots")} onChange={(syncSnapshots) => setCloudDraft({ ...cloud, syncSnapshots })} />
                <ToggleRow label={t("settings.syncSharedLayouts")} checked={cloud.syncSharedLayouts} onChange={(syncSharedLayouts) => setCloudDraft({ ...cloud, syncSharedLayouts })} />
                <ToggleRow label={t("settings.syncPersonalLayouts")} description={t("settings.personalCoordinatesAreExcludedUnlessExplicitlyEnabled")} checked={cloud.syncPersonalLayouts} onChange={(syncPersonalLayouts) => setCloudDraft({ ...cloud, syncPersonalLayouts })} />
                <SelectRow label={t("settings.conflictStrategy")} value={cloud.conflictStrategy} onChange={(conflictStrategy) => setCloudDraft({ ...cloud, conflictStrategy: conflictStrategy as DataSourceSettings["cloud"]["conflictStrategy"] })} options={[['ask',t("settings.alwaysAsk")],['keepLocal',t("settings.keepLocal")],['keepRemote',t("settings.keepRemote")]]} />
              </SettingsGroup>
                <div className="setting-action-row"><Button type="button" variant="primary" onClick={() => void saveSource({ ...source, cloud: { ...cloud, enabled: source.cloud.enabled, credentialConfigured: source.cloud.credentialConfigured, baseVersion: source.cloud.baseVersion, lastSuccessAt: source.cloud.lastSuccessAt } })}>{t("settings.saveCloudConfiguration")}</Button><Button type="button" onClick={() => setCloudDraft(source.cloud)}>{t("settings.cancelDraft")}</Button></div>
                <div className="setting-action-row"><Button type="button" onClick={() => void runOperation(async () => { if (!activeSourceId) return; setSyncDiagnostics(await platform.listSyncDiagnostics(activeSourceId)); })}>{t("settings.inspectOfflineQueue")}</Button><Button type="button" disabled={!activeSourceId || !source.cloud.enabled || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; await platform.syncProject({ sourceId: activeSourceId, projectId: source.cloud.projectId, apiUrl: source.cloud.endpoint, accessToken: "", baseVersion: source.cloud.baseVersion }); await onReload(); setSyncDiagnostics(await platform.listSyncDiagnostics(activeSourceId)); setOperationMessage(t("settings.metadataPublished")); })}>{t("settings.publishNow")}</Button><Button type="button" disabled={syncDiagnostics.length === 0} onClick={() => void runOperation(async () => { await navigator.clipboard.writeText(JSON.stringify(syncDiagnostics, null, 2)); setOperationMessage(t("settings.redactedQueueDiagnosticsCopied")); })}>{t("settings.copyDiagnostics")}</Button><Button type="button" disabled={!activeSourceId || !source.cloud.projectId || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; setCloudAudit(await platform.listCloudAudit(activeSourceId)); })}>{t("settings.viewAudit")}</Button></div>
                {source.cloud.lastSuccessAt ? <p className="setting-inline-note">{t("settings.lastSuccessfulSync")}{" "}{formatSettingsDate(source.cloud.lastSuccessAt, app.general.dateTimeFormat, locale)}</p> : null}
                {syncDiagnostics.length ? <div className="sync-diagnostics">{syncDiagnostics.map((item) => <div key={item.id}><span>{item.eventKind}</span><b>{item.state} · {item.attempts} {t("settings.attempts")}</b></div>)}</div> : null}
                {cloudAudit.length ? <div className="sync-diagnostics" aria-label={t("settings.cloudAuditEvents")}>{cloudAudit.map((item, index) => <div key={`${item.createdAt}:${index}`}><span>{humanize(item.action.replaceAll(".", " "))}</span><b>{formatSettingsDate(item.createdAt, app.general.dateTimeFormat, locale)}</b></div>)}</div> : null}
                {source.cloud.projectId ? <CloudShareManager platform={platform} sourceId={activeSourceId} viewerUrl={source.cloud.viewerUrl} offline={app.privacy.offlineMode} dateTimeFormat={app.general.dateTimeFormat} onMessage={setOperationMessage} onError={setOperationError} /> : null}
                <div className="setting-action-row"><Button type="button" disabled={!activeSourceId} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm(t("settings.disconnectCloudForThisSourceAndRemoveIts"))) return; await platform.clearCredentials(activeSourceId, { database: false, ai: false, cloud: true }); await saveSource({ ...source, cloud: { ...source.cloud, enabled: false, credentialConfigured: false } }); })}>{t("settings.disconnect")}</Button><Button type="button" variant="danger" className="danger-setting-action" onClick={() => void runOperation(async () => { if (!window.confirm(t("settings.leaveTheConfiguredCloudProjectLocallyThisDoes"))) return; await saveSource({ ...source, cloud: { ...source.cloud, enabled: false, projectId: "", baseVersion: 0 } }); })}>{t("settings.leaveProject")}</Button></div>
                <div className="setting-action-row"><Button type="button" disabled={!activeSourceId || !source.cloud.teamId || app.privacy.offlineMode} onClick={() => void runOperation(async () => { if (!activeSourceId) return; await platform.refreshOrganizationPolicy(activeSourceId); await onReload(); setOperationMessage(t("settings.organizationPolicyRefreshedAndCachedLocally")); })}>{t("settings.refreshOrganizationPolicy")}</Button></div>
                {source.cloud.projectId ? <ProjectPolicyCard project={settings.project} projectId={source.cloud.projectId} onSave={(project) => void runOperation(async () => { await platform.updateProjectSettings(project); await onReload(); setOperationMessage(t("settings.projectPolicyUpdated")); })} /> : null}
              </> : <Unavailable runtime={runtime} />}
            </SettingsSection>
          ) : null}

          {visibleCategory === "privacy" ? (
            <SettingsSection title={t("settings.privacySecurity")} description={t("settings.aSingleViewOfEveryExternalCapabilityAnd")}>
              <Button onClick={() => setPrivacyOpen(!privacyOpen)}>{t("submission.privacyPolicy")}</Button>
              {privacyOpen ? <PrivacyPolicy isMas={isMas} /> : null}
              <SettingsGroup title={t("settings.networkDiagnostics")}>
              <ToggleRow label={t("settings.completelyOffline")} description={t("settings.blocksAICloudUpdateChecksAndDiagnosticsDatabase")} checked={app.privacy.offlineMode} managed={isManaged("privacy.offlineMode")} onChange={(offlineMode) => void saveApp({ ...app, privacy: { ...app.privacy, offlineMode } })} />
              <p className="setting-inline-note">{t("submission.diagnosticsNote")}{isMas ? ` ${t("submission.storeNetwork")}` : ""}</p>
              <SelectRow label={t("settings.logLevel")} value={app.privacy.logLevel} onChange={(logLevel) => void saveApp({ ...app, privacy: { ...app.privacy, logLevel: logLevel as AppSettings["privacy"]["logLevel"] } })} options={[['error',t("settings.error")],['warn',t("settings.warning")],['info',t("settings.info")],['debug',t("settings.debug")]]} />
              <NumberRow label={t("settings.logRetention")} value={app.privacy.logRetentionDays} min={1} max={365} unit={t("settings.days")} onChange={(logRetentionDays) => void saveApp({ ...app, privacy: { ...app.privacy, logRetentionDays } })} />
              </SettingsGroup>
              <ExternalCapabilities isMas={isMas} app={app} source={source} access={externalAccess} dateTimeFormat={app.general.dateTimeFormat} />
              <div className="setting-action-row"><Button type="button" onClick={() => void runOperation(async () => { setSecurityStatus(await platform.getSecurityStatus(activeSourceId)); setExternalAccess(await platform.listExternalAccess()); })}>{t("settings.runLocalSecurityAudit")}</Button></div>
              {securityStatus ? <SecurityStatusCard status={securityStatus} /> : null}
              <Button type="button" variant="danger" className="danger-setting-action" disabled={!activeSourceId || runtime?.kind === "web"} onClick={() => void runOperation(async () => { if (!activeSourceId || !window.confirm(t("settings.removeDatabaseSSHAIAndCloudCredentialsFor"))) return; await platform.clearCredentials(activeSourceId, { database: true, ai: true, cloud: true }); await onReload(); setSecurityStatus(await platform.getSecurityStatus(activeSourceId)); })}>{t("settings.removeAllSavedCredentials")}</Button>
            </SettingsSection>
          ) : null}

          {visibleCategory === "notifications" ? (
            <SettingsSection title={t("settings.notifications")} description={t("settings.chooseWhichModelAndCollaborationEventsNeedAttention")}>
              <SettingsGroup title={t("settings.events")}>
              <SelectRow label={t("settings.schemaChanges")} value={app.notifications.schemaChanges} onChange={(schemaChanges) => void saveApp({ ...app, notifications: { ...app.notifications, schemaChanges: schemaChanges as AppSettings["notifications"]["schemaChanges"] } })} options={[['all',t("settings.allChanges")],['highRisk',t("settings.highRiskOnly")],['off',t("settings.off")]]} />
              <ToggleRow label={t("settings.gitFingerprintAndConflicts")} checked={app.notifications.gitConflicts} onChange={(gitConflicts) => void saveApp({ ...app, notifications: { ...app.notifications, gitConflicts } })} />
              {!isMas ? <ToggleRow label={t("settings.cloudSyncFailures")} checked={app.notifications.cloudFailures} onChange={(cloudFailures) => void saveApp({ ...app, notifications: { ...app.notifications, cloudFailures } })} /> : null}
              <ToggleRow label={t("settings.storageWarnings")} checked={app.notifications.storageWarnings} onChange={(storageWarnings) => void saveApp({ ...app, notifications: { ...app.notifications, storageWarnings } })} />
              <ToggleRow label={t("settings.updateAvailable")} checked={app.notifications.updateAvailable} onChange={(updateAvailable) => void saveApp({ ...app, notifications: { ...app.notifications, updateAvailable } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.delivery")}>
              <ToggleRow label={t("settings.systemNotifications")} checked={app.notifications.systemNotifications} onChange={(systemNotifications) => void updateSystemNotifications(systemNotifications)} />
              <ToggleRow label={t("settings.quietHours")} checked={app.notifications.quietHoursEnabled} onChange={(quietHoursEnabled) => void saveApp({ ...app, notifications: { ...app.notifications, quietHoursEnabled } })} />
              {app.notifications.quietHoursEnabled ? <><TextRow label={t("settings.quietHoursStart")} value={app.notifications.quietHoursStart} placeholder="22:00" onChange={(quietHoursStart) => void saveApp({ ...app, notifications: { ...app.notifications, quietHoursStart } })} /><TextRow label={t("settings.quietHoursEnd")} value={app.notifications.quietHoursEnd} placeholder="08:00" onChange={(quietHoursEnd) => void saveApp({ ...app, notifications: { ...app.notifications, quietHoursEnd } })} /></> : null}
              </SettingsGroup>
            </SettingsSection>
          ) : null}

          {visibleCategory === "shortcuts" ? (
            <SettingsSection title={t("settings.keyboardShortcuts")} description={t("settings.searchableCommandsWithConflictSafeBindings")}>
              <SettingsGroup title={t("settings.commandBindings")}>
              <TextRow label={t("settings.filterCommands")} value={shortcutQuery} placeholder={t("settings.searchCommands")} onChange={setShortcutQuery} />
              <div className="shortcut-list">{Object.entries(app.shortcuts.bindings).filter(([command]) => `${commandLabel(command)} ${humanize(command)}`.toLowerCase().includes(shortcutQuery.trim().toLowerCase())).map(([command, binding]) => { const conflict = shortcutConflicts.get(binding.trim().toLowerCase()); return <label key={command}><span>{commandLabel(command)}{conflict ? <small>{t("settings.shortcut.conflict", { commands: conflict.filter((item) => item !== command).map(commandLabel).join(", ") })}</small> : null}</span><input aria-invalid={Boolean(conflict)} value={binding} onChange={(event) => updateShortcut(command, event.target.value)} /></label>; })}</div>
              </SettingsGroup>
              <Button type="button" className="secondary-setting-action" onClick={() => void saveApp({ ...app, shortcuts: defaultAppSettings().shortcuts })}>{t("settings.resetShortcuts")}</Button>
            </SettingsSection>
          ) : null}

          {visibleCategory === "capabilities" ? <SettingsSection title={t("settings.capabilities")} description={t("settings.supportedFeaturesAndLimitsForPostgreSQLMySQLDesktop")}><CapabilitiesMatrix runtime={runtime} database={activeDatabase} /></SettingsSection> : null}

          {visibleCategory === "updates" ? (
            <SettingsSection title={t("settings.updatesAbout")} description={t("settings.applicationVersionUpdateChannelLicensesAndDiagnosticPaths")}>
              <StatusCard status={`v${runtime?.version ?? "0.1.0"}`} label={t("settings.tauriRustDesktopAndIndependentWebViewer", { value0: runtime?.label ?? "Nodal Studio" })} />
              <UpdatePanel platform={platform} runtime={runtime} app={app} managed={isManaged("updates.automaticChecks")} onSave={saveApp} />
              <div className="setting-action-row"><Button type="button" onClick={() => setAboutDocument("releaseNotes")}>{t("settings.releaseNotes")}</Button><Button type="button" onClick={() => setAboutDocument("license")}>{t("settings.license")}</Button><Button type="button" onClick={() => setAboutDocument("notices")}>{t("settings.thirdPartyNotices")}</Button></div>
              <SettingsGroup title={t("settings.diagnosticsFiles")}>
              <div className="setting-action-row"><Button type="button" onClick={() => void runOperation(async () => setDiagnosticInfo(await platform.getDiagnosticInfo()))}>{t("settings.showRuntimePaths")}</Button><Button type="button" disabled={runtime?.kind === "web"} onClick={() => void runOperation(() => platform.revealAppDirectory("logs"))}>{t("settings.openLogsDirectory")}</Button><Button type="button" disabled={runtime?.kind === "web"} onClick={() => void runOperation(() => platform.revealAppDirectory("data"))}>{t("settings.openDataDirectory")}</Button><Button type="button" onClick={() => void runOperation(async () => { const info = diagnosticInfo ?? await platform.getDiagnosticInfo(); setDiagnosticInfo(info); await navigator.clipboard.writeText(redactedDiagnosticSummary(info, app)); setOperationMessage(t("settings.redactedDiagnosticSummaryCopied")); })}>{t("settings.copyDiagnosticSummary")}</Button></div>
              {diagnosticInfo ? <div className="external-capabilities"><h3>{t("settings.runtime")}</h3><div><span>{t("settings.application")}</span><b>{diagnosticInfo.appVersion}</b></div><div><span>{t("settings.rustRequirement")}</span><b>{diagnosticInfo.rustVersion}</b></div><div><span>{t("settings.target")}</span><b>{diagnosticInfo.target}</b></div><div><span>{t("settings.dataDirectory")}</span><b>{diagnosticInfo.dataDirectory}</b></div><div><span>{t("settings.logDirectory")}</span><b>{diagnosticInfo.logDirectory}</b></div></div> : null}
              </SettingsGroup>
              {aboutDocument ? <AboutDocument kind={aboutDocument} onClose={() => setAboutDocument(undefined)} /> : null}
            </SettingsSection>
          ) : null}

          {visibleCategory === "advanced" ? (
            <SettingsSection title={t("settings.advanced")} description={t("settings.performanceThresholdsExperimentsAndRecoveryActions")}>
              <SettingsGroup title={t("settings.performance")}>
              <ToggleRow label={t("settings.performanceMetrics")} checked={app.advanced.performanceMetrics} onChange={(performanceMetrics) => void saveApp({ ...app, advanced: { ...app.advanced, performanceMetrics } })} />
              <div className="setting-action-row"><Button type="button" disabled={!app.advanced.performanceMetrics} onClick={() => setPerformanceSnapshot(capturePerformanceSnapshot())}>{t("settings.capturePerformanceSnapshot")}</Button></div>
              {performanceSnapshot ? <div className="external-capabilities"><h3>{t("settings.sessionPerformance")}</h3><div><span>{t("settings.uptime")}</span><b>{(performanceSnapshot.uptimeMs / 1000).toFixed(1)} {t("settings.s")}</b></div><div><span>{t("settings.dOMNodes")}</span><b>{performanceSnapshot.domNodes}</b></div><div><span>{t("settings.resourceEntries")}</span><b>{performanceSnapshot.resourceEntries}</b></div><div><span>{t("settings.javaScriptHeap")}</span><b>{performanceSnapshot.heapBytes === null ? t("settings.unavailable") : formatBytes(performanceSnapshot.heapBytes)}</b></div></div> : null}
              <NumberRow label={t("settings.layoutWorkerTimeout")} value={app.advanced.layoutWorkerTimeoutMs} min={1000} max={120000} unit="ms" onChange={(layoutWorkerTimeoutMs) => void saveApp({ ...app, advanced: { ...app.advanced, layoutWorkerTimeoutMs } })} />
              <NumberRow label={t("settings.renderDegradationThreshold")} value={app.advanced.renderDegradeThreshold} min={100} max={5000} unit={t("settings.tablesDetail")} onChange={(renderDegradeThreshold) => void saveApp({ ...app, advanced: { ...app.advanced, renderDegradeThreshold } })} />
              </SettingsGroup>
              <SettingsGroup title={t("settings.experiments")}>
              <ToggleRow label={t("settings.betaFeatures")} checked={app.advanced.betaFeatures} onChange={(betaFeatures) => void saveApp({ ...app, advanced: { ...app.advanced, betaFeatures } })} />
              {!isMas ? <SelectRow label={t("settings.applicationUpdateChannel")} value={app.updates.channel} onChange={(channel) => void saveApp({ ...app, updates: { ...app.updates, channel: channel as AppSettings["updates"]["channel"] } })} options={[['stable',t("settings.stable")],['beta',t("settings.betaPreRelease")]]} /> : null}
              {app.advanced.betaFeatures ? <div className="project-policy"><h3>{t("settings.experimentalFeatures")}</h3>{Object.entries(app.advanced.experimentalFeatures).map(([feature, enabled]) => <ToggleRow key={feature} label={commandLabel(feature)} description={t("settings.experimentalBehaviorAndStoredRepresentationMayChange")} checked={enabled} onChange={(value) => void saveApp({ ...app, advanced: { ...app.advanced, experimentalFeatures: { ...app.advanced.experimentalFeatures, [feature]: value } } })} />)}</div> : null}
              </SettingsGroup>
              <div className="project-policy"><h3>{t("settings.builtInExtensions")}</h3><p>{t("settings.onlySignedBundledCapabilitiesAreListedNodalStudio")}</p>{Object.entries(app.advanced.extensions).map(([extension, enabled]) => <ToggleRow key={extension} label={commandLabel(extension)} checked={enabled} onChange={(value) => void saveApp({ ...app, advanced: { ...app.advanced, extensions: { ...app.advanced.extensions, [extension]: value } } })} />)}</div>
              {settings.managed.length > 0 ? <div className="external-capabilities"><h3>{t("settings.managedByProjectOrOrganization")}</h3>{settings.managed.map((item) => <div key={`${item.source}:${item.path}`}><span>{item.path}</span><b title={item.reason}>{item.source}</b></div>)}</div> : null}
              <SettingsGroup title={t("settings.settingsTransfer")}>
              <TextRow label={t("settings.settingsJSONPath")} readOnly={isMas} value={settingsFilePath} placeholder="/absolute/path/settings.json" onChange={setSettingsFilePath} />
              <div className="setting-action-row"><Button onClick={() => void runOperation(async () => { const path = await platform.pickWorkspacePath("saveSettings"); if (path) setSettingsFilePath(path); })}>{t("submission.saveLocation")}</Button><Button onClick={() => void runOperation(async () => { const path = await platform.pickWorkspacePath("openSettings"); if (path) setSettingsFilePath(path); })}>{t("submission.openFile")}</Button></div>
              <div className="setting-action-row"><Button type="button" disabled={!settingsFilePath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { const receipt = await platform.exportSettingsFile(settingsFilePath); setOperationMessage(t("settings.exportedNonSensitiveSettingsForSources", { value0: receipt.sourceSettings })); })}>{t("settings.exportSettings")}</Button><Button type="button" disabled={!settingsFilePath || runtime?.kind === "web"} onClick={() => void runOperation(async () => { const preview = await platform.previewSettingsFile(settingsFilePath); if (!window.confirm(t("settings.importSettingsFormatVExportedTheAppSettings", { value0: preview.formatVersion, value1: formatDate(preview.exportedAt, locale, app.general.dateTimeFormat), value2: preview.sourceSettings }))) return; const receipt = await platform.importSettingsFile(settingsFilePath); await onReload(); setOperationMessage(t("settings.importedSettingsForSources", { value0: receipt.sourceSettings })); })}>{t("settings.previewImport")}</Button></div>
              </SettingsGroup>
              <div className="settings-danger-zone"><h3>{t("settings.dangerZone")}</h3><p>{t("settings.resettingSettingsDoesNotDeleteSnapshotsSemanticsOr")}</p><Button type="button" onClick={() => void onResetApp()}>{t("settings.resetAllSettings")}</Button>{source ? <Button type="button" onClick={() => void onResetSource()}>{t("settings.resetActiveSourceSettings")}</Button> : null}<Button type="button" variant="danger" className="danger-setting-action" disabled={runtime?.kind === "web"} onClick={() => void runOperation(async () => { const confirmation = window.prompt(t("settings.factoryResetDeletesAllLocalConnectionsSnapshotsSemantics")); if (confirmation !== "DELETE LOCAL DATA") return; await platform.factoryReset(confirmation); await onFactoryReset(); })}>{t("settings.factoryReset")}</Button></div>
            </SettingsSection>
          ) : null}
        </main>
      {source && ai && (visibleCategory === "ai" || aiDirty) ? <footer className="settings-ai-save-bar" aria-label={t("settings.saveAIConfiguration")}>
        <span aria-live="polite">{t(saveState === "saving" ? "settings.ai.savingDraft" : aiDirty ? "settings.ai.unsavedDraft" : "settings.ai.noDraft")}</span>
        <Button type="button" disabled={!aiDirty || saveState === "saving"} onClick={() => { setAiDraft(source.ai); setAiSecret(""); setSaveError(undefined); setSaveState("idle"); }}>{t("settings.cancelDraft")}</Button>
        <Button type="button" variant="primary" disabled={!aiDirty || saveState === "saving"} onClick={() => void saveAiConfiguration()}>{t("settings.saveAIConfiguration")}</Button>
      </footer> : null}
        </div>
      </div>
    </section>
  );
}

function StatusCard({ status, label }: { status: string; label: string }) { return <div className="settings-status-card"><strong>{status}</strong><span>{label}</span></div>; }
function CategoryReset({ onReset }: { onReset: () => void }) {
  const { t } = useI18n();
 return <Button type="button" className="secondary-setting-action" onClick={onReset}>{t("settings.restoreCategoryDefaults")}</Button>; }
function Unavailable({ runtime }: { runtime?: RuntimeInfo }) {
  const { t } = useI18n();
 return <div className="settings-empty"><strong>{t("settings.noActiveDataSource")}</strong><span>{runtime?.kind === "web" ? t("settings.thisCapabilityIsReadOnlyInWebViewer") : t("settings.connectOrSelectADataSourceToConfigure")}</span></div>; }
function DataBoundary() {
  const { t } = useI18n();
 return <div className="data-boundary"><h3>{t("settings.gitDataBoundary")}</h3><p><b>{t("settings.included")}</b> {t("settings.confirmedSemanticsDomainsSavedRelationshipViewsProvenanceAnd")}</p><p><b>{t("settings.excluded")}</b> {t("settings.credentialsTokensSnapshotsCanvasPositionsRowDataAnd")}</p></div>; }
function AiRequestBoundary({ ai }: { ai: DataSourceSettings["ai"] }) {
  const { t } = useI18n();
 return <div className="data-boundary"><h3>{t("settings.requestPreviewPolicy")}</h3><p><b>{t("settings.selected")}</b> {t("settings.ai.contextDescription", { scope: ai.contextScope === "currentTable" ? t("settings.currentTableOnly") : ai.contextScope === "oneHop" ? t("settings.currentTableAndOneRelationshipHop") : t("settings.currentBusinessDomainDetail"), comments: ai.includeComments ? t("settings.databaseComments") : "", semantics: ai.includeConfirmedSemantics ? t("settings.confirmedSemantics") : "" })}</p><p><b>{t("settings.neverSent")}</b> {t("settings.passwordsConnectionStringsBusinessRowDataUnrelatedSchemas")}</p><p>{t("settings.everyGeneratedExplanationRecordsTheProviderModelGeneration")}</p></div>; }
function ExternalCapabilities({ app, source, access, dateTimeFormat, isMas }: { isMas: boolean; app: AppSettings; source: DataSourceSettings | null; access: ExternalAccessRecord[]; dateTimeFormat: AppSettings["general"]["dateTimeFormat"] }) {
  const { t, locale } = useI18n();
 const items = [["AI", "ai", source?.ai.enabled], [t("settings.cloudSync"), "cloud", !isMas && source?.cloud.enabled], [t("settings.updateChecks"), "updates", !isMas && app.updates.automaticChecks], [t("settings.diagnostics"), "diagnostics", false]] as const; return <div className="external-capabilities"><h3>{t("settings.externalCapabilities")}</h3>{items.filter(([, capability]) => !isMas || capability !== "cloud").map(([name, capability, enabled]) => { const last = access.find((item) => item.capability === capability); return <div key={name}><span>{name}{last ? <small>{t("settings.lastAccess")}{" "}{formatSettingsDate(last.lastAccessAt, dateTimeFormat, locale)}</small> : <small>{t("settings.neverAccessedByThisInstallation")}</small>}</span><b>{isMas && capability === "updates" ? "App Store" : app.privacy.offlineMode ? t("settings.blockedByOfflineMode") : enabled ? t("settings.enabled") : t("settings.off")}</b></div>; })}</div>; }
function StorageUsageCard({ usage }: { usage: StorageUsage }) {
  const { t } = useI18n();
 const rows = [[t("settings.snapshots"), usage.snapshotBytes], [t("settings.semantics"), usage.semanticBytes], [t("settings.layouts"), usage.layoutBytes], [t("settings.syncQueue"), usage.syncQueueBytes], [t("settings.settings"), usage.settingsBytes]] as const; return <div className="external-capabilities"><h3>{t("settings.storage.count", { count: usage.snapshotCount })}</h3>{rows.map(([name, bytes]) => <div key={name}><span>{name}</span><b>{formatBytes(bytes)}</b></div>)}</div>; }
function SecurityStatusCard({ status }: { status: SecurityStatus }) {
  const { t } = useI18n();
 return <div className="external-capabilities"><h3>{t("settings.localSecurityAudit")}</h3><div><span>{t("settings.databaseCredential")}</span><b>{status.databaseCredentialConfigured ? t("settings.systemCredentialStore") : t("settings.missing")}</b></div><div><span>{t("settings.aICredential")}</span><b>{status.aiCredentialConfigured ? t("settings.systemCredentialStore") : t("settings.notConfigured")}</b></div><div><span>{t("settings.cloudCredential")}</span><b>{status.cloudCredentialConfigured ? t("settings.systemCredentialStore") : t("settings.notConfigured")}</b></div><div><span>{t("settings.weakSSLSources")}</span><b>{status.weakSslSources}</b></div><div><span>{t("settings.modelsNotRefreshedFor30Days")}</span><b>{status.staleModelSources}</b></div><div><span>{t("settings.unresolvedGitConflictReports")}</span><b>{status.unresolvedGitConflictReports}</b></div><div><span>{t("settings.failedConflictedSyncItems")}</span><b>{status.failedOrConflictedSyncItems}</b></div></div>; }
function CloudShareManager({ platform, sourceId, viewerUrl, offline, dateTimeFormat, onMessage, onError }: { platform: NodalStudioPlatform; sourceId?: string; viewerUrl: string; offline: boolean; dateTimeFormat: AppSettings["general"]["dateTimeFormat"]; onMessage: (message: string) => void; onError: (message: string) => void }) {
  const { t, locale } = useI18n();

  const [shares, setShares] = useState<CloudShareSummary[]>([]);
  const [latestUrl, setLatestUrl] = useState("");
  async function run(operation: () => Promise<void>) {
    onError("");
    try { await operation(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  function shareUrl(token: string) { const url = new URL(viewerUrl); url.searchParams.set("share", token); return url.toString(); }
  async function copyShare(token: string, message: string) { const url = shareUrl(token); setLatestUrl(url); await navigator.clipboard.writeText(url); onMessage(message); }
  return <div className="project-policy"><h3>{t("settings.readOnlyShareLinks")}</h3><p>{t("settings.linksExpireAfterSevenDaysByDefaultRotate")}</p><div className="setting-action-row"><Button type="button" disabled={!sourceId || !viewerUrl || offline} onClick={() => void run(async () => { if (!sourceId) return; const share = await platform.createCloudShare(sourceId); await copyShare(share.token, t("settings.aSevenDayReadOnlyLinkWasCreated")); setShares(await platform.listCloudShares(sourceId)); })}>{t("settings.create7DayLink")}</Button><Button type="button" disabled={!sourceId || offline} onClick={() => void run(async () => { if (sourceId) setShares(await platform.listCloudShares(sourceId)); })}>{t("settings.refreshLinks")}</Button></div>{!viewerUrl ? <p className="setting-inline-note">{t("settings.configureAndSaveTheWebViewerURLBefore")}</p> : null}{latestUrl ? <p className="setting-inline-note">{t("settings.latestLink")}{" "}<code>{latestUrl}</code></p> : null}{shares.length ? <div className="sync-diagnostics" aria-label={t("settings.cloudShareLinks")}>{shares.map((share) => <div key={share.id}><span>{share.revokedAt ? t("settings.revoked") : new Date(share.expiresAt) <= new Date() ? t("settings.expired") : t("settings.active")} {t("settings.expires")}{" "}{formatSettingsDate(share.expiresAt, dateTimeFormat, locale)}{share.lastAccessAt ? t("settings.lastOpened", { value0: formatSettingsDate(share.lastAccessAt, dateTimeFormat, locale) }) : ""}</span><b><Button type="button" disabled={Boolean(share.revokedAt)} onClick={() => void run(async () => { if (!sourceId || !window.confirm(t("settings.revokeThisShareLinkNow"))) return; await platform.revokeCloudShare(sourceId, share.id); setShares(await platform.listCloudShares(sourceId)); })}>{t("settings.revoke")}</Button><Button type="button" disabled={Boolean(share.revokedAt) || !viewerUrl} onClick={() => void run(async () => { if (!sourceId || !window.confirm(t("settings.rotateThisLinkAndInvalidateTheOldToken"))) return; const replacement = await platform.rotateCloudShare(sourceId, share.id); await copyShare(replacement.token, t("settings.shareLinkRotatedTheReplacementWasCopied")); setShares(await platform.listCloudShares(sourceId)); })}>{t("settings.rotate")}</Button></b></div>)}</div> : null}</div>;
}
function MergeStatusCard({ status, isMas }: { status: MergeDriverStatus; isMas: boolean }) {
  const { t } = useI18n();
 const versionMatches = status.driverVersion === status.expectedVersion; return <div className="external-capabilities"><h3>{t("settings.gitReadiness")}</h3><div><span>{t("settings.gitRepository")}</span><b>{status.repositoryIsGit ? t("settings.ready") : t("settings.notDetected")}</b></div><div><span>{t("settings.workspaceManifest")}</span><b>{status.manifestPresent ? t("settings.present") : t("settings.missing")}</b></div>{!isMas ? <div><span>{t("settings.mergeDriver")}</span><b>{!status.driverVersion ? t("settings.notInstalled") : !versionMatches ? t("settings.versionMismatch", { value0: status.driverVersion, value1: status.expectedVersion }) : status.driverConfigured && status.attributesConfigured ? t("settings.installedConfigured") : t("settings.installedSetupRequired")}</b></div> : null}<div><span>.gitattributes</span><b>{status.attributesConfigured ? t("settings.configured") : t("settings.missing")}</b></div><div><span>{t("settings.schemaFingerprint")}</span><b>{status.fingerprintMatches === null ? t("settings.unknown") : status.fingerprintMatches ? t("settings.matches") : t("settings.different")}</b></div></div>; }
function ProjectPolicyCard({ project, projectId, onSave }: { project: EffectiveSettings["project"]; projectId: string; onSave: (project: NonNullable<EffectiveSettings["project"]>) => void }) {
  const { t } = useI18n();
 const value = project ?? defaultProjectSettings(projectId); return <div className="project-policy"><h3>{t("settings.teamProjectPolicy")}</h3><p>{t("settings.sharedRulesOverridePersonalAndSourcePreferencesOrganization")}</p><ToggleRow label={t("settings.allowSnapshotSync")} checked={value.allowSnapshotSync} onChange={(allowSnapshotSync) => onSave({ ...value, allowSnapshotSync, updatedAt: new Date().toISOString() })} /><ToggleRow label={t("settings.allowSharedLayouts")} checked={value.allowSharedLayouts} onChange={(allowSharedLayouts) => onSave({ ...value, allowSharedLayouts, updatedAt: new Date().toISOString() })} /><ToggleRow label={t("settings.allowRemoteAI")} checked={value.allowRemoteAi} onChange={(allowRemoteAi) => onSave({ ...value, allowRemoteAi, updatedAt: new Date().toISOString() })} /><Button type="button" className="secondary-setting-action" onClick={() => onSave({ ...value, sharedCanvas: value.sharedCanvas ? null : defaultAppSettings().canvas, updatedAt: new Date().toISOString() })}>{value.sharedCanvas ? t("settings.stopSharingERDisplayRules") : t("settings.shareDefaultERDisplayRules")}</Button></div>; }
function AboutDocument({ kind, onClose }: { kind: "releaseNotes" | "license" | "notices"; onClose: () => void }) {
  const { t } = useI18n();
 const content = kind === "releaseNotes" ? { title: t("settings.releaseNotes010"), body: t("settings.initialLocalFirstReleasePostgreSQLAndMySQLSchema") } : kind === "license" ? { title: t("settings.license"), body: applicationLicense } : { title: t("settings.thirdPartyNotices"), body: "" }; return <div className="data-boundary" role="region" aria-label={content.title}><h3>{content.title}</h3>{kind === "notices" ? <Suspense fallback={<p>…</p>}><ThirdPartyNotices /></Suspense> : <p>{content.body}</p>}<Button type="button" onClick={onClose}>{t("settings.close")}</Button></div>; }
function redactedDiagnosticSummary(info: DiagnosticInfo, app: AppSettings) { return JSON.stringify({ application: "Nodal Studio", version: info.appVersion, rustVersion: info.rustVersion, target: info.target, offlineMode: app.privacy.offlineMode, diagnosticsEnabled: app.privacy.diagnosticsEnabled, updateChannel: app.updates.channel, logLevel: app.privacy.logLevel }, null, 2); }
function capturePerformanceSnapshot() { const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory; return { uptimeMs: performance.now(), domNodes: document.querySelectorAll("*").length, resourceEntries: performance.getEntriesByType("resource").length, heapBytes: memory?.usedJSHeapSize ?? null }; }
function formatSettingsDate(value: string, format: AppSettings["general"]["dateTimeFormat"], locale: Locale) { return formatDate(value, locale, format); }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function humanize(value: string) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
