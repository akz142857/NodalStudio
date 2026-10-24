# UI design system

For the localization architecture and application-wide migration plan, see [多语言与统一 UI 系统方案](LOCALIZATION_AND_UI_SYSTEM.md). The first implementation covers the Settings interface and main navigation; [Stage 1 acceptance](LOCALIZATION_STAGE1_ACCEPTANCE.md) records its scope and verification limits. Component coverage across the rest of the application is still partial.

Settings, the inspector and relationship detail/edit/delete surfaces share an opt-in design system. The implementation follows macOS conventions for compact controls, restrained color, grouped preferences, readable hierarchy, keyboard focus, and adaptive layouts. It remains a React/WebView interface, not a native AppKit settings window.

References: [Apple Settings](https://developer.apple.com/design/human-interface-guidelines/settings), [Typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Color](https://developer.apple.com/design/human-interface-guidelines/color), and [Layout](https://developer.apple.com/design/human-interface-guidelines/layout).

## Change the shared foundation

- `apps/frontend/src/design-system/tokens.css`: semantic colors, system font stacks, type scale, spacing, radii, density and motion. Light, dark and system themes are defined here. Prefer semantic names such as `--ds-secondary` and `--ds-danger` over raw colors in components.
- `apps/frontend/src/design-system/controls.css`: opt-in `.ds-surface` controls, keyboard focus, disabled/pressed/hover states, primary buttons and checkbox switches. Native input semantics and keyboard behavior remain intact.
- `apps/frontend/src/design-system/forms.tsx` and `forms.css`: reusable section, group, toggle, selection, range, number, text and secret-field compositions. Labels and descriptions are programmatically associated with controls. `components/settings/SettingsControls.tsx` retains compatibility exports.
- `apps/frontend/src/design-system/Button.tsx`: native button wrapper with primary, secondary, ghost and danger variants, normal/small sizes and a disabled pending state. Use within `.ds-surface`; supply the translated visible label. Existing `components/IconButton.tsx` remains the shared named icon action with keyboard/pointer tooltips.
- `apps/frontend/src/components/settings/settings.css`: Settings layout and component composition, including the capability matrix.
- `apps/frontend/src/components/inspector.css`: inspector composition, using the same shared tokens.

`styles.css` imports the shared foundation. Existing surfaces outside Settings and the inspector retain their current styles; migrate them deliberately by adding `.ds-surface` and replacing their local values with semantic tokens. Do not introduce new global tag overrides.

The type scale uses the existing root `--ui-font-size` preference: at the default 13px, body text is 13px, controls 12px, supporting text at least 11px, section headings 14px, and page titles 20px. Changing the preference scales these sizes. Density changes row height; long labels can still expand. Focus uses an explicit outline, and status colors always accompany text. Motion respects both the application preference and the operating system preference. Increased contrast strengthens separators and borders.

UI fonts include PingFang SC, Microsoft YaHei and Noto Sans CJK SC fallbacks. Use `--ds-control-padding-*`, `--ds-control-height-small`, `--ds-focus-ring`, `--ds-shadow-popover`, `--ds-shadow-dialog`, `--ds-overlay` and `--ds-layer-*` when extending controls/overlays. These additions establish shared values; legacy overlays outside the migrated surfaces still require deliberate migration. Shared form rows use minimum heights and responsive columns, and button labels may wrap instead of reducing their font size.

## Settings composition

All fourteen categories use the same shell and control primitives:

| Category | Content grouping |
| --- | --- |
| General | Display, startup, date and time |
| Appearance | Text and density, accessibility, workspace panels |
| Canvas & ER | Table contents, relationships, layout |
| Data Sources | Connection defaults, saved connections, refresh, connection behavior |
| History & Storage | Capture and retention, storage and backup |
| Git | Repository, readiness, shared description review and data boundary |
| AI | Provider, context, request limits and explicit configuration save |
| Cloud Sync | Connection, account and project, sync scope, sharing and policy |
| Privacy & Security | Network and diagnostics, external access, credentials and audit |
| Notifications | Events, delivery and quiet hours |
| Keyboard Shortcuts | Command filtering and conflict-aware bindings |
| Updates & About | Updates, diagnostics, paths and inline release/license documents |
| Capabilities | Context, filters, scrollable comparison and feature details |
| Advanced | Performance, experiments, extensions, settings transfer and recovery |

The sidebar has Workspace, Services and Application groups. Current category uses `aria-current`; Up/Down/Home/End move focus and Enter/Space activate the native button. Below 660px it becomes a native category selector. Below a content width of 500px, form rows stack while switches remain aligned with their labels. The capability comparison deliberately retains its own keyboard-accessible horizontal scroll region.

Category changes reset the content scroll. Search with no matches displays an empty state. Ordinary settings retain immediate saving; AI and Cloud configuration retain explicit Save/Cancel. Credential actions, managed policy restrictions and destructive-action confirmations are preserved. Informational release/license documents are inline regions rather than falsely marked modal dialogs.

`components/settings/UpdatePanel.tsx` composes the update flow with `SettingsGroup`, `ToggleRow`, `TextRow` and `.ds-surface` controls. `updates.css` uses the shared typography, spacing and semantic colors for status, progress and errors. Its native HTML installation dialog traps focus, defaults to Not now, restores focus on cancellation and prevents duplicate installation. Release notes are plain text; status is announced with a polite live region. Change shared tokens to restyle this flow together with the other Settings pages.

## Visual verification

Run `pnpm dev:desktop` or the frontend development server, then visit `/settings-preview.html`. This development-only fixture uses synthetic settings and does not persist preferences or send external requests. It is not an entry in the production build.

Fixture query parameters: `theme=light|dark|system`, `font=18`, `density=compact`, `source=none`, `runtime=web`, `managed=1`, and `bootstrap=1` (shows account creation fields). Use the page controls for normal navigation and theme/font interactions. `/inspector-preview.html` remains available to check the other consumer of the shared tokens.

Settings also accepts `language=en|zh-CN`; omission follows the system. `/design-system-preview.html` is a development-only catalog of shared forms, button variants, disabled/pending states, feedback and an empty state. It supports `language`, `theme`, `font` and `density`, with interactive controls and an editable mixed Chinese/English identifier. It neither persists settings nor calls the platform. Use keyboard focus and pointer hover to inspect interaction states. Both fixtures remain outside the production entry point.

Check all categories in light and dark themes, narrow and desktop windows, larger fonts, managed/disabled states, and both populated and empty source contexts. Confirm form labels, visible focus, keyboard navigation, local save feedback and explicit draft saving. Run the frontend tests, lint and production build after implementation changes.


### Model relationships

Canvas scrolling pans the viewport freely on both axes at the input's native speed, including trackpad gestures and horizontal mouse wheels. Pinch and Command/Control + wheel zoom; Space + drag continues to pan. Scrolling changes the viewport only and never saves table positions. React Flow normalizes pixel and line wheel input through its shared pan/zoom implementation.

`components/relationships/relationships.css` uses the same semantic tokens for relationship details, editing and deletion confirmation. `--ds-logical` identifies model-only dashed links. Endpoints show table identity separately from columns; cardinality and status use readable labels. The deletion confirmation is an HTML modal dialog, independent of `window.confirm` support in the desktop WebView. It defaults focus to Cancel, blocks duplicate submissions, retains errors for retry, and leaves database foreign keys unchanged. Details, manager and keyboard entry points share this confirmation. `/relationship-preview.html` exercises the real canvas with an in-memory model and a simulated failure option.

Entire visible field rows initiate and receive model connections. A 6 CSS-pixel drag threshold preserves clicks; table headers move tables, and Space retains canvas panning. `use-field-row-connection.ts` separates DOM row hit testing from edge anchors and feeds the existing React Flow connection preview. Sources use `--ds-logical`, compatible targets use `--ds-positive`, and type warnings use `--ds-warning`; the confirmation form remains authoritative for duplicate and type validation. Escape, window blur, scope changes, blank drops and self-field drops cancel without saving. Fixed table positions still allow relationships, while read-only/export/comparison surfaces do not. Row gestures avoid mounting extra ports on every column and retain the right-click target picker as an alternative.

## Business surfaces and localization (stage 2)

Business pages now share the application i18n context. Keep translations at the presentation boundary: database identifiers, SQL, user-authored content, enum values and DOM selectors must remain stable. Async effects use `useEventTranslator` when they need feedback without restarting work on a locale change. CodeMirror changes its language compartment without recreating editor state.

`design-system/EmptyState.tsx` provides a localized-by-caller title, description, icon and optional actions, styled by `surfaces.css`. Connection lists, query results and query history use this shared empty-state surface. `Button` accepts native button refs and is reused by connection management, relationship deletion and result export. Dialog padding/radius, empty-state spacing, overlays, shadows and control typography are shared tokens. Avoid applying generic control sizing to React Flow handles or table geometry.

Open `/business-preview.html?language=zh-CN&theme=light` to review synthetic model, connection, relationship, query and history screens. The fixture also accepts `language=en`, `theme=dark` and `font=18`. It performs no database or network operations. Scope and verification boundaries are documented in [stage 2 acceptance](LOCALIZATION_STAGE2_ACCEPTANCE.md).

### 原生 WebView 下拉控件

`select.ds-select` 保留原生选择器语义，但显式设置 `appearance: none`、共享控件高度、圆角、字号、焦点和箭头。适用于历史版本、变更筛选及关系类型；修复 macOS WebKit 原生外观忽略 padding 导致的高度不一致。强制颜色模式恢复原生外观。

### 应用缩放与视口

应用通过 `--ui-scale` 与 CSS zoom 调整界面；布局和弹窗使用 `--ds-viewport-width` / `--ds-viewport-height`，避免原始 viewport 单位在放大后超出窗口。React Flow 的几何坐标取消外层 CSS zoom，图表大小由自身视口控制，保持字段端点和鼠标坐标一致。

### 导航与可点击反馈

分段导航的当前项统一使用 selection 背景、文字色和 accent 内描边，不依赖 hover 或浏览器焦点。所有原生按钮、链接、下拉框、checkbox/radio、summary 及 button/tab/menuitem/switch 语义控件共享 pointer 指针；禁用控件使用 default。文本输入、画布拖动和尺寸调整保留各自的光标。画布不再用通配选择器覆盖子按钮的指针。

懒加载页面必须在自己的内容区或覆盖层设置 Suspense 边界。加载查询、设置或 DDL 不能替换整个应用外壳；DDL 期间背景工作区保持挂载并设为 inert。

### 函数、过程、触发器与依赖详情

对象树复用既有分组、选中态、搜索和对象操作菜单。函数与过程按对象类型区分，PG 重载函数以数据库提供的标识参数区分；对象名称、参数、SQL 和定义者不翻译。`SchemaProgramDetails` 复用 `ds-surface`、`snapshot-summary`、`inspector-list` 与共享颜色、间距和焦点规则。

`SchemaIndexDetails` 由表详情和物化视图详情共用，展示方法、字段/表达式、主键/唯一标识、完整定义和筛选条件。不要把索引表达式中的原始数据库名称转换为 UI 文案。

依赖区域分别显示“依赖对象”和“被引用”，只将数据库目录确认的关系呈现为已知事实；权限、字符串函数体和动态 SQL 导致的缺失必须保留覆盖范围提示。可定位目标使用共享可点击样式，快照外的目标保留名称。表详情提供所属触发器的只读入口。
