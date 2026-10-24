# 多语言与统一 UI 系统方案

日期：2026-10-24。状态：以下保留最初设计及审查依据；第一阶段现已实现统一语言基础、设置页和主导航，详见 [第一阶段验收记录](LOCALIZATION_STAGE1_ACCEPTANCE.md)。第二阶段已接入主要业务界面并继续统一共享组件，详见 [第二阶段验收记录](LOCALIZATION_STAGE2_ACCEPTANCE.md)。原生界面、后端动态诊断与独立导出文档的完整国际化仍属后续工作。

## 1. 实施前结论

Language 设置已经存在，但不等于界面已完成国际化：

- `platform/settings-types.ts` 和 Rust `crates/settings-model` 已保存 `system | zhCn | en`。
- `App.tsx` 按偏好修改 `document.documentElement.lang`；这只设置文档语言，不翻译组件。
- `SettingsPage.tsx` 提供简体中文选项，但分类、说明和操作反馈仍主要硬编码英文。
- `TableAiAssistant.tsx`、`KnowledgeReview.tsx` 有局部双语函数，尚未形成共享词典。
- 多处日期直接调用不带 locale 的 `toLocaleString()`，会跟随运行环境而非应用选择。

设计系统已经存在，入口是 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)。`design-system/tokens.css` 管理颜色、字体、间距、圆角、密度与动效；`controls.css` 管理 `.ds-surface` 控件；`SettingsControls.tsx` 提供表单组合；主题和配色有测试。全局样式也已使用大量语义 token，但页面布局、阴影、尺寸和组件写法仍分散。应在现有基础上完善，而不是再建立一套竞争的样式体系。

以下前端路径均相对 `apps/frontend/src/`。

## 2. 多语言系统

### 语言偏好与生效语言分离

首期支持 English、简体中文、跟随系统。保留已有持久化枚举，避免破坏旧设置文件和 Rust 接口；在展示层映射为 `en`、`zh-CN`。

统一 `resolveLocale(preference, navigator.languages)`：显式选择优先；system 按系统语言优先级匹配支持的语言；`zh-CN`、`zh-SG`、`zh-Hans` 及未带区域的 `zh` 匹配简体中文，英语变体匹配英文。繁体中文尚未提供，不能标称已支持；未匹配项继续查找后续语言，最终回退英文。显式 script 优先于 region，避免把 `zh-Hant-CN` 误判为简体。

所有消费者使用同一个 resolved locale，包括 HTML `lang`、日期数字、设置搜索与 AI 请求语言。system 模式监听 `languagechange`。启动时先使用系统解析值，设置加载完成后采用已保存偏好；偏好保存失败必须显示错误并恢复已保存状态。

### 目录与接口

建议增加：

```text
i18n/
  locale.ts             # 偏好解析、可用语言定义
  I18nProvider.tsx       # 共享 locale 与响应式切换
  messages/en.ts         # 基准词典与 key 类型
  messages/zh-CN.ts      # 同结构中文词典
  format.ts             # 日期、时间、数字和数量
  errors.ts             # 错误码到翻译 key 的映射
  i18n.test.ts
```

组件通过 `useI18n()` 读取 `t(key, params)`、`locale` 和格式化方法。以稳定语义 key 组织模块：`common`、`navigation`、`settings`、`sources`、`schema`、`canvas`、`relationships`、`query`、`history`、`ai`、`updates`、`errors`。例如 `settings.general.language.label`，不要以完整英文句子或数组序号作为 key。

首期采用类型化 TypeScript 词典、React Context 与内置 Intl，不新增依赖。将消息实现封装在接口后；需要更多语言或复杂语法时再评估消息库，不让业务组件依赖具体引擎。

规则：

- 中英文 key 与插值参数在类型检查及 CI 中保持一致；数量消息使用 `Intl.PluralRules`，英文覆盖 one/other，中文覆盖 other。
- 完整句子翻译，禁止拼接词序；例如 `query.result.rowCount` 带 `count`，不能拼接数量和英文 `rows`。
- 翻译值作为 React 文本渲染；富文本通过组件插槽，不执行词典中的 HTML。
- 生产环境缺失 key 回退英文；开发环境报告缺失，CI 阻止不完整词典进入正式支持的语言。
- 按钮、提示、占位符、aria-label、title、空态、确认框、加载状态和操作反馈都属于翻译范围。
- 设置搜索同时索引当前语言标签、英文标签及领域别名，例如“语言 / Language”“关系 / Relationship”。
- 日期显示显式传入 resolved locale，保留现有 local/ISO 格式偏好；locale 不改变时区，存储和接口仍保留原始 ISO 时间。

### 数据、错误与 AI 边界

SQL、表名、字段名、数据库注释、用户描述、连接名、路径、API 枚举和标识符保留原文。术语只用于产品界面，不能改变数据库事实。导出给程序使用的结构与枚举保持稳定；面向人阅读的报告标题可随语言变化，并标注报告语言。

后端逐步返回稳定 `code + params + details`，前端翻译可识别的错误码。未知数据库或供应商错误显示本地化概述及可展开的原始详情，不通过匹配英文错误字符串进行翻译；凭据继续按现有脱敏规则处理。

AI 界面语言与内容语言明确区分：默认让新请求按当前界面语言回答，保留用户主动指定语言的能力；已有回答和手工草稿不自动翻译。切换语言不应清空 SQL、连接表单、AI 输入、知识草稿或重新执行请求。当前 TableAiAssistant 的会话 key 包含语言，迁移时需解除这种重建耦合；进行中的请求继续使用发起时的语言，切换后仅更新界面标签。

### 术语基线

| English | 简体中文 | 含义 |
| --- | --- | --- |
| Data source | 数据源 | 连接及其本地元数据上下文 |
| Schema | 模式（Schema） | 数据库命名空间，首次出现保留英文 |
| Snapshot | 快照 | 某时点采集的数据库结构 |
| Physical relationship | 物理关系 | 数据库外键关系 |
| Logical relationship | 逻辑关系 | 模型中维护的关系 |
| Inferred relationship | 推断关系 | 待核对的候选关系 |
| Inspector | 详情面板 | 当前对象的详情与操作 |
| Business domain | 业务域 | 业务对象的分组 |
| Knowledge draft | 知识草稿 | 尚未确认保存的描述 |
| Saved view | 已保存视图 | 保存的展示配置，不等同于数据库视图 |

## 3. 设计系统补全

沿用现有紧凑桌面数据库工具的视觉基础，兼顾 macOS 与 Windows。先统一规则和覆盖面，再通过 token 调整风格。

| 层级 | 职责 | 调整入口 |
| --- | --- | --- |
| 基础 | 字体栈、字号、间距、圆角、动效、密度 | `design-system/tokens.css` |
| 语义主题 | 窗口、面板、输入、边框、文字、选中、成功/警告/危险 | 现有 `--ds-*` token |
| 控件 | Button、IconButton、Input、Select、Switch、Tabs、Badge、Tooltip | `controls.css`，逐步增加共享 React 控件 |
| 交互组合 | FormRow、Section、Dialog、Popover、Toolbar、EmptyState、Notice | 从现有 settings 组合提取，保留兼容导出 |
| 业务页面 | 数据源、对象树、画布、查询、AI、历史 | 页面仅负责布局与业务状态 |

建议补充 elevation/shadow、focus-ring、overlay、z-index、控件尺寸 token，替换散落阴影与层级数值。现有 token 名称优先复用，不同时保留另一套表示同一含义的变量。主题、代码编辑器、关系边、迷你地图和导出图像需共用语义配色；用户自定义颜色另行保留。

共享组件先抽取真实重复行为，不一次替换所有原生控件。按钮统一 primary/secondary/ghost/danger 与尺寸；IconButton 必须有翻译后的可访问名称。Dialog 统一焦点约束、Escape、恢复焦点、pending/error 和危险操作默认聚焦取消。业务确认逻辑留在调用方。

多语言布局规则：

- UI 字体栈补充适用的中文系统字体，如 PingFang SC、Microsoft YaHei、Noto Sans CJK SC；SQL 与标识符继续使用等宽栈。
- 正文和表单说明可换行，控件以 min-height 为主；按钮宽度由内容决定。
- 工具栏空间不足时采用已有溢出/折叠菜单模式，不无限缩小字体。
- 标识符可省略但提供完整查看方式；错误、确认说明和关键操作名称不能仅靠截断呈现。
- 密度与 UI 缩放沿用现有偏好，验证中文、较大字号和长英文同时可用。
- 继续保持文字/图标伴随状态颜色，保留 focus-visible、减少动效与键盘导航。

建设开发专用 `/design-system-preview.html`，并沿用现有 settings/inspector/relationship/theme preview。目录页展示所有控件及默认、hover、focus、disabled、loading、error、empty 状态；语言、主题、密度和字号可切换。它是后续整体样式调整的验证入口，不进入正式产品导航。

## 4. 实施顺序与完成标准

| 阶段 | 交付 | 通过条件 |
| --- | --- | --- |
| A：基础与设置 | 统一 locale/词典/格式化；完整设置页、导航及共用反馈双语 | 切换即时生效，重启保留，system 解析正确；词典完整；设置搜索双语可用 |
| B：主要工作流 | 数据源、对象树、详情、画布、关系、查询、历史和 AI 全面迁移 | 核心操作从入口到成功/失败反馈均无遗漏；语言切换不丢草稿、不重发请求 |
| C：系统边界 | 后端错误、通知、导出标题、原生菜单（如有）、离线及失败状态 | 未知错误保留详情；机器数据稳定；各运行环境人工核对 |
| D：组件收敛 | 共享控件和预览目录，逐页替换遗留样式 | 调整 token 可一致影响已迁移页面，新增业务页面不再复制通用样式 |

A 开始时同步整理 token 和表单组合；B 逐页迁移时完成对应组件收敛，D 做全局验收，避免最后再重做一次 UI。

验证包含：locale 解析及 fallback、词典 key/参数/复数一致性、日期格式、偏好持久化失败、system 变化、切换语言保留草稿及请求生命周期。对新增硬编码可见文案和无理由原始颜色建立增量检查，允许数据库内容、测试样例、用户颜色和诊断详情的明确例外。

视觉验收覆盖中英文 × 明暗主题，辅以系统主题变化、compact 密度、放大字号、窄窗口、长表名和键盘操作；必须在真实桌面 WebView 中验证关键工作流，自动化测试与构建通过不能替代视觉验收。首期全中文支持应在 B、C 范围核对完成后宣告；只翻译设置页应明确标注覆盖范围。

## 5. 整体调整时如何使用

- 改品牌色或明暗主题：修改语义颜色 token，并查看控件目录、SQL 编辑器和画布。
- 改紧凑程度：修改密度、间距及控件尺寸 token，避免逐页修改 padding。
- 改字体或中文排版：修改字体栈、字号和行高，检查图节点尺寸及关系端点定位。
- 改按钮/表单风格：修改共享控件；页面布局单独负责其空间安排。
- 新增语言：新增词典、locale 匹配与格式化测试，不在业务页面添加语言分支。
