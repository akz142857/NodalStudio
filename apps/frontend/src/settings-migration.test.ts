import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEffectiveSettings, type NodalStudioPlatform } from "./platform";
import { migrateLegacySettings } from "./settings-migration";

describe("legacy settings migration", () => {
  beforeEach(() => localStorage.clear());

  it("moves panel, AI, Cloud, and Git preferences through the platform once", async () => {
    const sourceId = "source";
    const initial = defaultEffectiveSettings(sourceId);
    localStorage.setItem(
      "sqlaieditor.workspace.leftPanel",
      JSON.stringify({ expanded: false, width: 340 }),
    );
    localStorage.setItem("sqlaieditor.ai.enabled", "true");
    localStorage.setItem("sqlaieditor.cloud.apiUrl", "https://cloud.example");
    localStorage.setItem("sqlaieditor.cloud.version", "7");
    localStorage.setItem(`sqlaieditor.git.repository.${sourceId}`, "/repo");
    let stored = initial;
    const updateAppSettings: NodalStudioPlatform["updateAppSettings"] = (app) => {
      stored = { ...stored, app };
      return Promise.resolve(stored);
    };
    const updateDataSourceSettings: NodalStudioPlatform["updateDataSourceSettings"] = (source) => {
      stored = { ...stored, source };
      return Promise.resolve(stored);
    };
    const getSettings: NodalStudioPlatform["getSettings"] = () => Promise.resolve(stored);
    const platform = {
      updateAppSettings: vi.fn(updateAppSettings),
      updateDataSourceSettings: vi.fn(updateDataSourceSettings),
      getSettings: vi.fn(getSettings),
    } as unknown as NodalStudioPlatform;

    const migrated = await migrateLegacySettings(platform, initial, sourceId);

    expect(migrated.app.appearance.leftSidebarExpanded).toBe(false);
    expect(migrated.app.appearance.leftSidebarWidth).toBe(340);
    expect(migrated.source?.ai.enabled).toBe(true);
    expect(migrated.source?.cloud.endpoint).toBe("https://cloud.example");
    expect(migrated.source?.cloud.baseVersion).toBe(7);
    expect(migrated.source?.git.repositoryPath).toBe("/repo");
    expect(localStorage.getItem("sqlaieditor.ai.enabled")).toBeNull();
  });
});
