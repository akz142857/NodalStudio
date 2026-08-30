# UI 重构方案（讨论稿）

> 状态：**已实现**（阶段 1–6 全部完成）。下方保留原始分析作为决策记录。
> 目标：左栏只承载数据库管理，右侧改为 Numbers 式分段控件。

---

## 1. 现状与问题

### 1.1 当前布局

```
┌─ topbar ─────────────────────────────────────────────────────────┐
│ Nodal Studio │ Database Query Changes History │ 搜索 │ ⚙ ⌘ ● │
├──────────┬────────────────────────────────────┬──────────────────┤
│ 左栏     │ 主区                               │ 右栏 Inspector   │
│ 272px    │ SchemaCanvas / QueryPage           │ 300px            │
│          │                                    │                  │
│ 连接     │                                    │ TableInspector   │
│ 结构树   │                                    │ ProvenancePanel  │
│ 语义模型 │                                    │ AiAssistant      │
│ Git      │                                    │                  │
│ 云同步   │                                    │                  │
│ 变更历史 │                                    │                  │
└──────────┴────────────────────────────────────┴──────────────────┘
```

左栏自上而下依次是 `ConnectionPanel` → `SchemaTree` → `KnowledgePanel` → `GitWorkspacePanel` → `CloudSyncPanel` → `HistoryPanel`。

### 1.2 问题不是主观感受，是可测的

本次会话中我用探针量过一组真实数据（73 张表的快照）：

| 观测 | 数值 |
|---|---|
| 左栏内容总高 | **> 2200px**（Knowledge 的输入框在 y=2213） |
| 视口高度 | ~900px |
| 需要滚动才能触达的面板 | Knowledge / Git / Cloud / History |

也就是说，**左栏有 2/3 的内容在首屏之外**。要给一张表建业务分组，得先在 272px 宽的窄栏里向下滚过整棵结构树。

### 1.3 根因：左栏承担了五种互不相关的职责

| 面板 | 实际职责 | 属于「数据库管理」吗 |
|---|---|---|
| `ConnectionPanel` (440 行) | 连接的增删改、测试、采集快照 | ✅ |
| `SchemaTree` (47 行) | 浏览 schema / 表 | ✅ |
| `KnowledgePanel` (192 行) | 业务分组、保存视图（语义创作） | ❌ 内容创作 |
| `GitWorkspacePanel` (116 行) | 语义层导入导出 | ❌ 协作 |
| `CloudSyncPanel` (60 行) | 元数据发布 | ❌ 协作 |
| `HistoryPanel` (151 行) | 快照时间线、diff 选择 | ❌ 时间维度 |

这三类的**交互节奏完全不同**：导航是高频、瞥一眼就走；创作是低频、需要空间和专注；协作是极低频、通常一次性配置。把它们叠在同一根 272px 的柱子里，等于让最高频的导航去和最低频的配置抢首屏。

### 1.4 一个佐证：顶栏的 mode 与左栏语义重叠

顶栏已经有 `Database / Query / Changes / History` 四个模式，而左栏又同时挂着 `HistoryPanel`。用户想看历史时，**两个地方都对**，但行为不一样：顶栏切主区，左栏切快照。这种重叠本身就说明当前的职责划分没有收敛。

---

## 2. 左栏方案：只留数据库

### 2.1 你给的两种参考母题

**母题 A（图 7/8/10/11 — Projects 列表）**

- 分区标题是**弱化的小字**（`Projects` 灰、小号），右侧配 `···`（分区级操作）和 `+`（新建）
- 行高舒展，图标 + 文本，**没有分隔线、没有边框**
- 选中态 = 一块低对比度的圆角填充，不是高饱和色块
- 支持一层从属信息（`opsique-mono-infra` 下的 `Locate Halro private TLS deployment`），以缩进 + 更弱的字重表达，右侧可挂一个状态图标

**母题 B（图 9/12 — 连接树）**

- `My Connections` → 连接 → 数据库 → **对象类型文件夹**（Tables / Views / Functions / Events / Queries / Backups）
- 每级有 disclosure triangle，类型有专属图标
- 同级并列展示其它数据库（`information_schema`、`mysql`、`sys`）和其它连接
- 选中态是**整行高饱和填充**（经典 DB 客户端做法）

### 2.2 建议：结构取 B，视觉取 A

两者不冲突。B 解决的是「信息如何组织」，A 解决的是「看起来多吵」。

Nodal Studio 是 read-only 的模型工具，不是 SQL 管理器，所以选中态用 A 的低对比度填充更合适——它不需要 B 那种「我正在这张表上执行操作」的强提示。而且 A 的克制风格和当前画布的浅色节点更协调。

### 2.3 目标结构

```
┌────────────────────────────────┐
│ Connections            ···  +  │   ← 母题 A 的分区头
├────────────────────────────────┤
│ ▾ 🐘 Local development         │   ← 连接（引擎图标）
│    ▾ nodalstudio               │   ← 数据库
│       ▸ Tables            73   │   ← 对象类型 + 计数
│       ▸ Views              0   │
│       ▸ Enums              0   │
│    ▸ 其它 schema…              │
│ ▸ 🐬 MySQL fixture             │   ← 折叠的其它连接
├────────────────────────────────┤
│ Snapshot                       │   ← 当前快照的元信息，只读
│ Aug 30 · 73 tables · a1b2c3d4  │
│ ⟳ Refresh    ⧉ Compare…        │
└────────────────────────────────┘
```

关键决定：

1. **`Tables` 是一个可展开的类型节点**，不是把 73 张表直接摊平。当前 `SchemaTree` 用 `<details>` 直接列表，73 行一次铺开就是 2200px 的主要来源。
2. **计数常驻**（`73`）。这是当前 `SchemaTree` 已有的好设计，保留。
3. **Snapshot 区块只读**，把「当前看的是哪一份、什么时候采的」这个高频问题固定在首屏，而**不是**把整个 `HistoryPanel` 放进来。完整的时间线去右侧 History 分段。
4. **搜索**：顶栏已有全局搜索。左栏不再重复放过滤框，避免两个搜索框语义打架。

### 2.4 从左栏移出的四块，去向

| 面板 | 去向 | 理由 |
|---|---|---|
| `KnowledgePanel` | **拆开**：对象级注解 → 右侧 Semantics 分段；全局分组/视图管理 → 无选中时的 Semantics 分段（见 3.2） | 创作行为，且需区分「这张表」与「全部」 |
| `HistoryPanel` | 右侧 History 分段 | 与顶栏 History 模式合并，消除重叠 |
| `GitWorkspacePanel` | **Settings → Git** | 一次性配置，不是日常操作 |
| `CloudSyncPanel` | **Settings → Cloud** | 同上 |

Git 和 Cloud 不进分段而进 Settings：它们的日常触点其实只有「出问题时看一眼」，而这个已经由通知系统和 Settings 里的 **Local security audit** 覆盖了（那里已经显示未解决冲突数）。日常把两个配置表单挂在主界面上是错配。

---

## 3. 右侧方案：分段控件（Numbers 样式）

参考图是 macOS Numbers 的检查器分段控件：深色圆角容器内四个等分段，激活段是**主色填充的胶囊**，未激活段透明、浅灰文字，段间有细竖线分隔。

这确定了几件重要的事：

- **不是 IDE 式 Tab** —— 不可关闭、不可拖拽、不可多开、数量固定
- 位于面板**顶部**，横向等分
- 段之间是**同一对象的不同侧面**（Numbers 的 Table/Cell/Text/Arrange 都在描述当前选中物）

最后一点决定了分段该怎么切：**按"看这个对象的哪一面"切，而不是按"打开哪个功能"切**。

### 3.1 好消息：这个母题你已经有了

顶栏的 `.mode-switcher` 就是同一个东西：

```css
.mode-switcher            { display:flex; padding:3px; border:1px solid #333945;
                            border-radius:7px; background:#111318; }
.mode-switcher button     { padding:6px 10px; border:0; border-radius:5px;
                            color:#808a99; background:transparent; font-size:11px; }
.mode-switcher button.active { color:#e8ebf0; background:#2b313b; }
```

差别只在激活态：现在是中性灰 `#2b313b`，Numbers 用的是主色。你的主色绿 `#77e08a` 已在多处使用（`.semantic-create button` 的底色、聚焦边框 `#66cf7d`）。

**建议**：抽出一个共用的 `.segmented` 组件，顶栏和右栏都用它；激活态改为主色填充。这样两处的交互语言统一，也少一套样式。是否把顶栏也一并改成绿色激活态，需要你定——绿色在画布上还承担着「新增的表」的含义（`data-change="added"` 用 `#38a85b`），大面积用绿可能稀释这个信号。

### 3.2 分段划分

```
┌──────────────────────────────────────────┐
│ ( Table )  Semantics │ History │ AI      │  ← .segmented
├──────────────────────────────────────────┤
│                                          │
│  （当前分段内容）                          │
│                                          │
└──────────────────────────────────────────┘
```

| 分段 | 内容 | 现有组件 |
|---|---|---|
| **Table** | 结构详情：字段、类型、键、索引、约束、注释 | `TableInspector` 的结构部分 |
| **Semantics** | 注解（描述/标签/负责人/核心表）、所属业务分组、Provenance | `TableInspector` 的表单 + `ProvenancePanel` + `KnowledgePanel` |
| **History** | 该对象的变更时间线、Before/After | `HistoryPanel`（聚焦到选中对象） |
| **AI** | 解释、候选注解确认 | `AiAssistant` |

**注意这和第 2.4 节的初稿不同。** 参考图表明分段是「同一对象的不同侧面」，所以不能把 Knowledge 当成一个独立功能页塞进来——它得拆开：

- 「给**这张表**打注解、归入哪个分组」→ **Semantics** 分段（跟随选中对象）
- 「管理**所有**业务分组和保存视图」→ 这是全局操作，不属于对象检查器，应该去**左栏底部**或命令面板

同理 History：分段里放的是**这张表的**变更史，全局时间线仍归顶栏的 History 模式。

### 3.3 无选中对象时

Numbers 的做法是分段仍在、内容变成该分段的全局/文档级设置，而不是禁用。建议照做：

| 分段 | 无选中时显示 |
|---|---|
| Table | 快照概览：schema 数、表数、指纹、采集时间 |
| Semantics | 分组与保存视图的**总览列表**（正好安置 3.2 中拆出的全局部分） |
| History | 完整快照时间线 |
| AI | 「选择一张表以获取解释」引导 |

这样分段永不消失，位置记忆有效，而且顺带给全局语义管理找到了归宿。

---

## 4. 实施路径

分阶段，每步都能独立验证、独立回滚。

| 阶段 | 内容 | 风险 |
|---|---|---|
| **1** | 抽出共用 `.segmented`，顶栏 `.mode-switcher` 改用它 | 低，纯样式重构，可独立验证 |
| **2** | 右侧分段容器 + 现有三面板拆入 Table / Semantics / AI | 低—中，`TableInspector` 要按结构/注解拆成两段 |
| **3** | `HistoryPanel` 从左栏迁入 History 分段 | 低，组件不改 |
| **4** | `GitWorkspacePanel`、`CloudSyncPanel` 迁入 Settings | 低 |
| **5** | 左栏重写为连接树（母题 B 结构 + A 视觉） | **中**，`SchemaTree` 需重写为按类型分组的懒展开树 |
| **6** | 顶栏 mode 收敛（若确认清单第 1 条） | 中，涉及路由与快捷键 |

阶段 5 是唯一需要新写组件的，阶段 2 需要拆分现有组件，其余基本是搬运。

### 4.1 会牵动的既有实现

- **`--left-sidebar-width` / `--right-sidebar-width`**：`.workspace` 的网格轨道。上一轮刚把它们改成 `minmax(0, …)` 以修窗口溢出，分段头有自身最小宽度（四段横向等分），右栏的最小可用宽度需要重新评估。
- **`SidebarRail`** 的折叠/拖拽逻辑对两侧对称，右栏分段化后「折叠」的含义需要定义（收成一条图标化的分段？完全隐藏？）。
- **`nodalstudio:*` 自定义事件**（`fit-canvas`、`relayout-canvas`、`locate-table` 等）目前由命令面板派发到画布，分段切换需要接入同一套机制，否则命令面板无法定位到被折叠右栏里的某一段。
- **`settings.app.appearance.restoreSidebarState`** 记录了左右栏的展开态与宽度，需要增加「上次激活的分段」，这是 `settings-model` 的字段变更，要同步 Rust 侧和 `SETTINGS_SCHEMA_VERSION`。

---

## 5. 实施记录与已定决策

清单中的问题在实施时逐条落定：

| 问题 | 结论 | 依据 |
|---|---|---|
| 顶栏 mode 是否收敛 | **收敛为 `Database / Query / Changes`**，删掉 History | `mode === "history"` 在主区**没有任何分支**（grep 计数 0）——它是死 UI，只等价于「用 explore 看旧快照」。`Changes` 保留，因为它真的驱动画布叠加与变更摘要 |
| 激活态是否用主色绿 | **不用**，激活保持中性，绿色给 hover / focus-visible | 绿色在画布上表示「新增的表」，常驻绿色会稀释该信号 |
| 顶栏是否抽共用 `.segmented` | **是**，两处同源 | 阶段 1 已落地，纯重构、逐值验证过 |
| Git / Cloud 移入 Settings | **是，且无能力损失** | Settings→Git 本就有更完整的 `Preview & export…` / `Preview & import…`；Settings→Cloud 已在调 `syncProject`。唯一风险是主动发布的可发现性，已将 `Retry queue` 改名为 `Publish now` |
| 全局分组/视图管理的归宿 | **无选中时的 Semantics 分段** | 分段是「同一对象的不同侧面」，无选中时退回文档级 |
| 左栏跨连接展开 | 按 schema / 类型分别记忆展开态，互不干扰 | `SchemaTree` 内部 `OpenState` |

### 实测效果

在一个 **499 张表**的真实快照上（`flow` 库）：

| | 重构前 | 重构后 |
|---|---|---|
| 左栏内容高度 | **12825px** | **812px** |
| 视口高度 | ~900px | ~900px |
| 是否需要滚动才能看全 | 需要滚 14 屏 | 一屏装下 |

主因是 `SchemaTree` 不再把所有表摊平：schema 与对象类型都是懒展开，类型节点默认折叠。

### 与初稿的偏离

初稿把 `KnowledgePanel` 整体当作一个功能页塞进分段。看到 Numbers 参考图后改为拆开——分段描述的是「同一对象的不同侧面」，所以对象级注解进 Semantics 分段，全局分组/视图管理退到无选中时的同一分段。

### 左栏最终形态

连接列表与结构树合并成一棵树，`ConnectionPanel` 通过 `children` 把 `SchemaTree` 渲染在激活连接之下：

```
Data sources                 + Create
▾ Local development            ← 激活连接（低对比度填充）
   ▾ public              502
      ▸ Tables           499   ← 默认折叠
      ▸ Views              3
      ▸ Enums              0   ← 无内容则禁用
  MySQL fixture                ← 其它连接，折叠
─────────────────────────────
Snapshot        Aug 31 12:46
73 tables            1bab60fc
[ Refresh ]      [ Compare… ]
```

`ConnectionPanel` 的对话框、CRUD 与连接测试完全没动——只改了列表那一段的渲染。

`Compare…` 不自带面板，而是派发 `nodalstudio:inspect-history`，由右栏切到 History 分段。沿用了命令面板驱动画布的同一套 `nodalstudio:*` 事件惯例。

### 仍未做的

- 母题 B 里 `Tables / Views / Functions / Events / Queries / Backups` 那种完整对象类型集合。Nodal Studio 的快照模型只有 tables / views / enums 三类（`schema-model` 的 `SchemaDefinition`），其余类型没有数据支撑，凭空加节点是假 UI。
