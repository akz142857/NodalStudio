import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { defaultEffectiveSettings, type AppSettings, type DataSourceSettings, type NodalStudioPlatform } from "../platform";

const noop = async () => {};
const props = {
  dataSources: [], platform: {} as NodalStudioPlatform, onClose: noop,
  onUpdateApp: noop, onUpdateSource: noop, onResetApp: noop, onResetSource: noop,
  onReload: noop, onDataSourcesChanged: noop, onFactoryReset: noop,
};
const categories = ["通用", "外观", "画布与 ER", "数据源", "历史与存储", "Git", "AI", "云同步", "隐私与安全", "通知", "键盘快捷键", "更新与关于", "功能支持", "高级"];
// Keep category rendering independent so slower CI runners do not have to render
// every settings panel within a single test's timeout budget.
it.each(categories)("opens the translated %s category", (category) => {
  const settings = defaultEffectiveSettings("source"); settings.app.general.language = "zhCn";
  render(<SettingsPage {...props} settings={settings} />);
  const button = screen.getByRole("button", { name: category });
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-current", "page");
});
it("searches Chinese aliases and English category names", () => {
  const settings = defaultEffectiveSettings("source"); settings.app.general.language = "zhCn";
  render(<SettingsPage {...props} settings={settings} />);
  const search = screen.getByRole("searchbox", { name: "搜索设置" });
  fireEvent.change(search, { target: { value: "语言" } });
  expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zhCn");
  fireEvent.change(search, { target: { value: "Keyboard" } });
  expect(screen.getByRole("heading", { name: "键盘快捷键" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "打开设置" })).toBeVisible();
});
it("switches only after a successful save and retains the previous language on failure", async () => {
  let resolveSave: (() => void) | undefined;
  let fail = false;
  const save = vi.fn(async () => { if (fail) throw new Error("disk unavailable"); await new Promise<void>((resolve) => { resolveSave = resolve; }); });
  function Harness() {
    const [settings, setSettings] = useState(() => { const s = defaultEffectiveSettings(); s.app.general.language = "en"; return s; });
    return <SettingsPage {...props} settings={settings} onUpdateApp={async (app) => { await save(); setSettings((s) => ({ ...s, app })); }} />;
  }
  render(<Harness />);
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zhCn" } });
  expect(screen.getByRole("combobox", { name: "Language" })).toBeDisabled();
  await act(async () => { resolveSave?.(); await Promise.resolve(); });
  expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zhCn");
  expect(screen.getByText("已保存到本地")).toHaveAttribute("role", "status");
  fail = true;
  fireEvent.change(screen.getByRole("combobox", { name: "语言" }), { target: { value: "en" } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存失败"));
  expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zhCn");
  expect(screen.getByRole("alert")).toHaveTextContent("disk unavailable");
});
it("preserves provider drafts and search when preference reload returns cloned source settings", async () => {
  const settings = defaultEffectiveSettings("source"); settings.app.general.language = "en";
  const save = vi.fn<(app: AppSettings) => Promise<void>>(noop);
  const view = render(<SettingsPage {...props} settings={settings} initialCategory="ai" onUpdateApp={save} />);
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openAiCompatible" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "unsaved-model" } });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "AI" } });
  const reloaded = structuredClone(settings); reloaded.app.general.language = "zhCn";
  view.rerender(<SettingsPage {...props} settings={reloaded} initialCategory="ai" onUpdateApp={save} />);
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  expect(screen.getByRole("textbox", { name: "模型" })).toHaveValue("unsaved-model");
  expect(screen.getByRole("searchbox", { name: "搜索设置" })).toHaveValue("AI");
  expect(save).not.toHaveBeenCalled();
});
it("localizes capability details, filters, and leaves dialect identifiers intact", () => {
  const settings = defaultEffectiveSettings(); settings.app.general.language = "zhCn";
  render(<SettingsPage {...props} settings={settings} initialCategory="capabilities" activeDatabase={{ name: "orders", databaseType: "mySql", version: "8.4" }} runtime={{ kind: "desktop", label: "Desktop", version: "0.2.1" }} />);
  const matrix = screen.getByRole("region", { name: "产品功能支持" });
  expect(within(matrix).getByRole("columnheader", { name: "桌面端 · MySQL 当前" })).toHaveAttribute("data-current", "true");
  fireEvent.change(within(matrix).getByRole("searchbox", { name: "搜索功能" }), { target: { value: "只读 SQL" } });
  expect(within(matrix).getByRole("button", { name: "执行只读 SQL" })).toBeVisible();
  expect(within(matrix).getByText(/桌面端 MySQL：单条只读 SELECT/)).toBeVisible();
});

it("edits bilingual reply preferences as a draft, cancels, and saves without touching credentials", async () => {
  const settings = defaultEffectiveSettings("source"); settings.app.general.language = "en";
  const onUpdateSource = vi.fn<(source: DataSourceSettings) => Promise<void>>().mockResolvedValue(undefined);
  const view = render(<SettingsPage {...props} settings={settings} initialCategory="ai" onUpdateSource={onUpdateSource} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Default reply language" }), { target: { value: "chinese" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Answer detail" }), { target: { value: "concise" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Terminology style" }), { target: { value: "plain" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Additional instructions" }), { target: { value: "Explain grain first." } });
  expect(onUpdateSource).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Additional instructions" })).toHaveAttribute("maxlength", "1000");
  const zh = structuredClone(settings); zh.app.general.language = "zhCn";
  view.rerender(<SettingsPage {...props} settings={zh} initialCategory="ai" onUpdateSource={onUpdateSource} />);
  expect(screen.getByRole("textbox", { name: "附加指令" })).toHaveValue("Explain grain first.");
  expect(screen.getByRole("combobox", { name: "默认回复语言" })).toHaveValue("chinese");
  expect(screen.getByRole("combobox", { name: "回答详略" })).toHaveValue("concise");
  fireEvent.click(screen.getByRole("button", { name: "保存 AI 配置" }));
  await waitFor(() => expect(onUpdateSource).toHaveBeenCalledTimes(1));
  expect(onUpdateSource.mock.calls[0][0].ai.replyPreferences).toEqual({ language: "chinese", detail: "concise", terminology: "plain", additionalInstructions: "Explain grain first." });
  expect(onUpdateSource.mock.calls[0][0].ai.credentialConfigured).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "附加指令" }), { target: { value: "Unwanted draft" } });
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" }));
  expect(screen.getByRole("textbox", { name: "附加指令" })).toHaveValue("");
});

it("keeps AI save actions outside the scroller and preserves failed drafts for retry", async () => {
  const settings = defaultEffectiveSettings("source"); settings.app.general.language = "en";
  let rejectSave!: (reason: Error) => void;
  const onUpdateSource = vi.fn<(source: DataSourceSettings) => Promise<void>>().mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectSave = reject; })).mockResolvedValue(undefined);
  render(<SettingsPage {...props} settings={settings} initialCategory="ai" onUpdateSource={onUpdateSource} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const save = screen.getByRole("button", { name: "Save AI configuration" });
  expect(save.closest("main")).toBeNull();
  expect(save.closest(".settings-detail-pane")).toContainElement(document.querySelector("main.settings-content"));
  expect(save.closest(".settings-detail-pane")).not.toContainElement(screen.getByRole("button", { name: "General" }));
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable AI explanations" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Additional instructions" }), { target: { value: "Keep this draft" } });
  expect(onUpdateSource).not.toHaveBeenCalled();
  expect(screen.getByText(/Unsaved AI changes/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Test provider" })).toBeDisabled();
  fireEvent.click(save); fireEvent.click(save);
  expect(onUpdateSource).toHaveBeenCalledTimes(1);
  expect(onUpdateSource.mock.calls[0][0].ai.enabled).toBe(true);
  expect(screen.getByRole("textbox", { name: "Additional instructions" })).toBeDisabled();
  await act(async () => { rejectSave(new Error("Disk unavailable")); await Promise.resolve(); });
  expect(screen.getByText(/Disk unavailable/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Additional instructions" })).toHaveValue("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "General" }));
  expect(save).toBeInTheDocument();
  fireEvent.click(save);
  await waitFor(() => expect(onUpdateSource).toHaveBeenCalledTimes(2));
});

it("saves an entered API key from the persistent bar and retains it if credential storage fails", async () => {
  const settings = defaultEffectiveSettings("source"); settings.app.general.language = "en";
  settings.source!.ai.provider = "openAiCompatible";
  const saveAiCredential = vi.fn().mockRejectedValueOnce(new Error("Credential store unavailable")).mockResolvedValue(undefined);
  const onUpdateSource = vi.fn().mockResolvedValue(undefined);
  const onReload = vi.fn().mockResolvedValue(undefined);
  render(<SettingsPage {...props} settings={settings} initialCategory="ai" onUpdateSource={onUpdateSource} onReload={onReload} platform={{ saveAiCredential } as unknown as NodalStudioPlatform} />);
  fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "test-only-credential" } });
  fireEvent.click(screen.getByRole("button", { name: "Save AI configuration" }));
  await waitFor(() => expect(screen.getByText(/Credential store unavailable/)).toBeInTheDocument());
  expect(screen.getByLabelText(/API key/i)).toHaveValue("test-only-credential");
  fireEvent.click(screen.getByRole("button", { name: "Save AI configuration" }));
  await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
  expect(saveAiCredential).toHaveBeenLastCalledWith("source", "test-only-credential");
  expect(screen.getByLabelText(/API key/i)).toHaveValue("");
});
