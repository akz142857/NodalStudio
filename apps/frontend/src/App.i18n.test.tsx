import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { defaultEffectiveSettings, getPlatform } from "./platform";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it("loads the persisted language, updates navigation, and retains it across app remounts", async () => {
  const platform = getPlatform();
  let stored = defaultEffectiveSettings();
  stored.app.general.language = "zhCn";
  stored.app.general.reopenLastWorkspace = false;
  stored.app.legacyStorageMigrationVersion = 3;
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "i18n fixture", version: "test" });
  const read = vi.spyOn(platform, "getSettings").mockImplementation(() => Promise.resolve(structuredClone(stored)));
  vi.spyOn(platform, "listDataSources").mockResolvedValue([]);
  const save = vi.spyOn(platform, "updateAppSettings").mockImplementation((app) => { stored = { ...stored, app }; return Promise.resolve(stored); });
  const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  const view = mount();
  await screen.findByRole("group", { name: "视图模式" });
  expect(screen.getByRole("button", { name: "数据库" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  const settings = within(await screen.findByRole("region", { name: "设置" }));
  const before = read.mock.calls.length;
  fireEvent.change(settings.getByRole("combobox", { name: "语言" }), { target: { value: "en" } });
  await screen.findByRole("group", { name: "View mode" });
  await waitFor(() => expect(save).toHaveBeenCalled());
  // One explicit settings reload after save; language itself must not re-run startup.
  expect(read).toHaveBeenCalledTimes(before + 1);
  expect(stored.app.general.language).toBe("en");
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  expect(screen.getByRole("button", { name: "Open Settings" })).toBeVisible();
  view.unmount();
  mount();
  expect(await screen.findByRole("group", { name: "View mode" })).toBeVisible();
  expect(document.documentElement.lang).toBe("en");
});
