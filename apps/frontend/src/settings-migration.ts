import type { EffectiveSettings, NodalStudioPlatform } from "./platform";

const LEGACY_MIGRATION_VERSION = 2;

function readObject(key: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readBoolean(key: string): boolean | undefined {
  const value = localStorage.getItem(key);
  return value === null ? undefined : value === "true";
}

function readNumber(key: string): number | undefined {
  const value = localStorage.getItem(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function migrateLegacySettings(
  platform: NodalStudioPlatform,
  current: EffectiveSettings,
  sourceId?: string,
): Promise<EffectiveSettings> {
  let effective = current;
  if (current.app.legacyStorageMigrationVersion < LEGACY_MIGRATION_VERSION) {
    const app = structuredClone(current.app);
    const left = readObject("sqlaieditor.workspace.leftPanel");
    const right = readObject("sqlaieditor.workspace.rightPanel");
    if (typeof left?.expanded === "boolean") app.appearance.leftSidebarExpanded = left.expanded;
    if (typeof left?.width === "number") app.appearance.leftSidebarWidth = left.width;
    if (typeof right?.expanded === "boolean") app.appearance.rightSidebarExpanded = right.expanded;
    if (typeof right?.width === "number") app.appearance.rightSidebarWidth = right.width;
    app.legacyStorageMigrationVersion = LEGACY_MIGRATION_VERSION;
    await platform.updateAppSettings(app);
    localStorage.removeItem("sqlaieditor.workspace.leftPanel");
    localStorage.removeItem("sqlaieditor.workspace.rightPanel");
    effective = await platform.getSettings(sourceId);
  }

  if (
    sourceId &&
    effective.source &&
    effective.source.legacyStorageMigrationVersion < LEGACY_MIGRATION_VERSION
  ) {
    const source = structuredClone(effective.source);
    const aiEnabled = readBoolean("sqlaieditor.ai.enabled");
    const cloudEnabled = readBoolean("sqlaieditor.cloud.enabled");
    if (aiEnabled !== undefined) source.ai.enabled = aiEnabled;
    if (cloudEnabled !== undefined) source.cloud.enabled = cloudEnabled;
    source.cloud.endpoint = localStorage.getItem("sqlaieditor.cloud.apiUrl") ?? source.cloud.endpoint;
    source.cloud.projectId = localStorage.getItem("sqlaieditor.cloud.projectId") ?? source.cloud.projectId;
    source.cloud.baseVersion = readNumber("sqlaieditor.cloud.version") ?? source.cloud.baseVersion;
    source.git.repositoryPath =
      localStorage.getItem(`sqlaieditor.git.repository.${sourceId}`) ??
      source.git.repositoryPath;
    source.legacyStorageMigrationVersion = LEGACY_MIGRATION_VERSION;
    effective = await platform.updateDataSourceSettings(source);
    for (const key of [
      "sqlaieditor.ai.enabled",
      "sqlaieditor.cloud.enabled",
      "sqlaieditor.cloud.apiUrl",
      "sqlaieditor.cloud.projectId",
      "sqlaieditor.cloud.version",
      `sqlaieditor.git.repository.${sourceId}`,
    ]) {
      localStorage.removeItem(key);
    }
  }
  return effective;
}
