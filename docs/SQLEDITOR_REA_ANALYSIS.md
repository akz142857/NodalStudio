# SQLEditor 4.0.3：REA 功能分析与 Nodal Studio 借鉴建议

分析日期：2026-10-13（Asia/Shanghai）。Nodal Studio 对照版本：`e5551c0`。

适配性复核：同日按产品方案和当前源码重新评估。**第 8 节为吸收裁定，第 4 节保留为初步候选方案，不等同于已批准的开发计划。**

## 结论

最值得借鉴的是：完整可读的变更比较、图表与结构报告导出、多对象精确排版、离线 SQL DDL 导入、可解释的结构预检，以及清晰的操作结果反馈。

SQLEditor 的核心是可编辑的数据库设计文档；Nodal Studio 的核心是从真实数据库采集不可变快照，再叠加语义、逻辑关系和历史。建议先补齐分析、排版和交付能力。物理结构编辑、迁移 SQL 生成和执行属于产品范围扩展，需要另外设计草稿模型、方言能力和变更审核。

## 1. 目标与证据范围

- 应用：`/Applications/SQLEditor.app`，版本 **4.0.3**，build **11118**，bundle ID `com.malcolmhardie.sqleditor.cocoa`。[E1]
- 主程序：`Contents/MacOS/SQLEditor`，SHA-256 `f5bb35480f91c078ff22e23e7ef91676c9c3a6d9f367f0aac68395b1907fc6a0`。Universal Mach-O 包含 x86_64 和 arm64；REA 打开的是 arm64 目标。[E1/E5]
- 方法：REA 安装包清单、plist 解析、Interface Builder 编译资源解析、Mach-O 元数据；通过 Computer Use 在新建的 `Untitled 2` 文档中核对菜单并进行合成 SQL 测试。
- 未连接真实数据库、未执行迁移或 DDL、未读取已有用户模型。导出面板只检查了配置，未保存导出成品。测试文档仍打开，保存提示已取消。
- 当前 Ghidra/Hopper/IDA provider 均未配置，**没有反编译函数实现或还原布局算法**。资源中的 selector 只能证明静态连接声明，不能单独证明实现和运行成功。
- Interface Builder 默认范围解析了 **64 个文档**，另有 **45 个文档因数量上限未解析**；层级、私有字段等覆盖也有明确限制。返回超过 MCP 传输预算后，使用导出的完整 Evidence bundle 读取已保留记录，没有把截断预览当作完整结果。[E2]
- 随包帮助 `introduction.html` 明确写的是 SQLEditor **3.0**，用于解释设计意图；涉及 4.0.3 的实际行为必须结合当前菜单、编译资源或运行输出。[H]

证据类型：**运行观察**表示本次确实看到的结果；**静态观察**表示安装包声明/资源；**文档描述**表示随包旧帮助；**建议**是面向 Nodal Studio 的设计判断。

## 2. 已确认的能力

| 能力 | 证据与实际范围 | 借鉴点 |
|---|---|---|
| 独立模型文档 | `.sqs` Editor、`.sql` Viewer 的文件关联；新建文档和按方言新建入口。[E1/U1] | 导入的离线模型应有独立身份，不能伪装成活数据库连接 |
| SQL → 结构图 → SQL | 本次粘贴两张表及一条 FK，画布出现两表，Source View 输出规范化 CREATE TABLE 和 ALTER TABLE FK；日志出现 `Import complete from clipboard`。[U2] | 文件/剪贴板导入应给解析结果、对象计数和不支持语法的定位信息 |
| 物理对象设计 | 当前 Object 菜单有 Table、Field、Index、Constraint、Foreign Key、View；多表选中后检查器显示 `Multiple Tables`。[U1/U2] | 检查器随选择对象和数量变化；Nodal 优先用于阅读和语义编辑 |
| 多对象排版 | 当前菜单有 Arrange Objects、六种边缘/中心对齐；检查器有 Position Locked；编译资源有 `alignObjects:`、`arrangeObjects:`、`setSnapToGrid:`。[E2/U1/U2] | 多选、对齐、固定节点。未测试这些排版算法的具体结果 |
| 语义分组与画布区域 | 当前菜单有 Label/New Label with selection、Add Canvas Area；资源有 label 显示/隐藏/选择的 action；旧帮助描述背景区域和标签。[E2/U1/H] | Nodal 已有按业务域过滤和节点配色；可增强批量成员管理、分组边界/说明，无须重复实现过滤 |
| 文档比较与 SQL Diff | 当前 File 有 Export Diff，侧栏有 Diff View；资源有 `exportDiff:`、`diffModeMenuChanged:`；旧帮助描述 start/end 方向、打开文档和加载时状态比较。[E2/U1/H] | 把比较对象、方向、前后值和输出放在同一流程。未实际生成迁移 SQL |
| 图表导出 | 实际 Export as Image 面板列出 **png/pdf/jpg/tiff/svg**，默认 Light theme (like paper)，有 Transparent Background。[U4] | 导出主题独立于应用主题，输出适合文档和评审的图形 |
| 结构报告 | 实际 Save Report 面板有 **HTML Report**，默认 `.html` 文件名。[E2/U5] | 导出可阅读的数据字典/结构报告；未验证该 HTML 是否自包含或交互式 |
| 结构预检 | 实际 Pre-flight 输出表名无空格、所有表有主键、FK 类型匹配；另有 `MySQL Foreign Key Preflight - Not MySQL Document`。[U3] | 方言感知、可解释、能定位对象的诊断。只验证了合成有效模型的成功/跳过输出 |
| 操作日志 | 预检结果作为可展开的操作记录；剪贴板导入也有单独记录。[U3] | 导入、刷新、导出、校验均应有状态、摘要、详情和对象/文件入口 |
| 数据库与方言扩展 | ExporterList 声明八组 exporter，DriverList 有 JDBC 模板；Mach-O 引用 SQLModel、SQLAntlrParser、SQLJavascriptSupport、PGSQLKit、MHPostgresDB、MHSQLiteDB、libdrizzle 等。[E3/E4/E5] | 采集、解析、生成、检查各有自己的能力表。声明和链接不能证明每个数据库在本机可用 |

### 合成 SQL 测试

```sql
CREATE TABLE rea_authors (
  id INTEGER PRIMARY KEY,
  name VARCHAR(80) NOT NULL
);
CREATE TABLE rea_books (
  id INTEGER PRIMARY KEY,
  author_id INTEGER,
  title VARCHAR(120),
  CONSTRAINT fk_rea_author FOREIGN KEY (author_id) REFERENCES rea_authors(id)
);
```

运行结果：两表及字段出现在 Canvas 的 accessibility 树；生成 SQL 将 PK 规范化为命名约束，FK 单独输出为 `ALTER TABLE ... ADD CONSTRAINT`。这说明此次测试的表/字段/键语法可被解析并重新生成，**不代表任意 PostgreSQL dump 都能无损往返**。[U2]

## 3. 与 Nodal Studio 的源码对照

| 方向 | 当前实现 | 明确缺口或增强方向 |
|---|---|---|
| 布局 | [SchemaCanvas.tsx](../apps/frontend/src/components/SchemaCanvas.tsx#L397)、[layout.worker.ts](../apps/frontend/src/graph/layout.worker.ts#L36)：ELK、连通分量布局、紧凑打包、布局持久化；已有 MiniMap | 不需要重做自动布局或缩略图；补多选、局部布局、对齐和固定节点 |
| 选择 | [SchemaCanvas.tsx](../apps/frontend/src/components/SchemaCanvas.tsx#L244)：节点 selected 由唯一 selectedTable 派生 | 未见产品级多选集合/对齐命令。React Flow 依赖的默认行为不等于完整多选产品能力 |
| Diff 引擎 | [schema-diff](../crates/schema-diff/src/lib.rs#L24)：before/after 摘要、风险和多种结构变化 | 应先完善展示；摘要不是完整字段差异，默认值/注释等详情需回查两份快照 |
| Diff UI | [InspectorPanel.tsx](../apps/frontend/src/components/InspectorPanel.tsx#L182)：操作列表只取前 30 条并显示类型/对象名；[HistoryPanel.tsx](../apps/frontend/src/components/HistoryPanel.tsx#L75)：展示 after snapshot | 完整列表、筛选/分页、前后值、显式比较方向；当前节点基于 after snapshot，需要另取 before 对象才能显示被删表 |
| 图表导出 | [SchemaCanvas.tsx](../apps/frontend/src/components/SchemaCanvas.tsx#L761)：工具栏为查看全部、自动布局、关系管理 | 在 apps/crates 范围未见 PNG/SVG/PDF/打印导出实现 |
| SQL 导入 | [query guard](../crates/query-engine/src/guard.rs#L9) 使用 sqlparser 验证单条只读查询，拒绝 DDL | 不能把 sqlparser 依赖当作已有 DDL 导入；需独立解析流程 |
| 结构检查 | [桌面逻辑关系校验](../apps/desktop/src-tauri/src/lib.rs#L3561)：端点、列数、类型、重复关系等 | 没有通用结构诊断规则注册机制；getDiagnosticInfo 是运行环境诊断 |
| 数据库能力 | [schema-model](../crates/schema-model/src/lib.rs#L74) 和采集分派支持 PostgreSQL/MySQL；[Query](../apps/desktop/src-tauri/src/lib.rs#L1150) 仅支持 PostgreSQL | 采集支持、查询支持、DDL 导入/生成支持应分别暴露，不能只用一个数据库枚举推断 |
| 离线模型 | [portable backup](../apps/desktop/src-tauri/src/lib.rs#L3087) 已有 `.nodalmodel`，含快照、变更、语义、布局、关系等；[Storage UI](../apps/frontend/src/components/SettingsPage.tsx#L352) 有入口 | **不是缺模型文件格式**；缺方便交付的图表/报告和免安装阅读入口 |
| Web 阅读 | [WebPlatform](../apps/frontend/src/platform/web-platform.ts#L240) 使用 share token 请求云 API | 现有 viewer 未见本地 `.nodalmodel`/自包含 HTML 打开流程；这是可选增强，SQLEditor 的交互式离线 HTML 未证实 |
| Git 协作 | [git-workspace](../crates/git-workspace/src/lib.rs#L175) 导出团队知识，明确排除快照和画布布局 | Git 工作区与 portable backup 用途不同，不应合并为一个格式 |

上述“未见”仅限这次检查的 apps/crates 源码边界，未做功能运行测试或穷尽依赖包的默认能力。

## 4. 初步候选实施方案与验收

### 第一批：完整 Diff 与图表/报告导出

**Diff 可读性（优先级最高，复用现有引擎）**

- 将变更列表从 Inspector 的摘要中抽为可搜索、可筛选的完整视图；检查器保留对象相关摘要。
- 展示 before → after、时间/快照身份、变化类型和风险；30 条以上仍可全部访问。
- 删除对象使用 before snapshot 的只读图形表示，避免在 after 画布中消失得无法审阅。
- 验收：含新增/修改/删除和超过 30 条操作的比较，列表完整；字段前后值能查看；被删表可定位。

**图表导出与 HTML 结构报告**

- 首先 SVG/PNG，再补 PDF；可选全图、当前视图、所选对象。主题和背景独立于当前界面。
- 用快照、语义和布局生成专用导出表示，不依赖屏幕截图；与 React Flow 的交互 DOM 解耦。
- 报告包括表/字段/键/索引、业务注解、关系、模型指纹及生成日期。只输出明确选中的结构信息。
- 验收：导出结果无 UI 控件、无裁切；字段文字与关系线可读；暗色应用可输出浅色图；查看器受限字段不会因导出泄漏；含恶意注释的 HTML 正确转义。
- 建议增加一键复制图和导出后的打开文件入口。

### 第二批：多选排版与结构诊断

**多选与精确排版**

- 将 `primarySelectedTable`（检查器焦点）与 `selectedNodeIds`（图形操作集合）分离。
- Shift 多选、框选、整体移动、六种对齐；均分是额外设计建议，未在 SQLEditor 当前菜单中确认。
- 增加位置固定、选区布局与撤销；固定是布局属性，不改变物理快照。
- 验收：移动多表后布局正确保存/恢复；局部布局不影响固定或未选节点；对齐可撤销。

**Snapshot 结构检查**

- 独立纯 Rust 诊断模块输出 `ruleId/severity/objectKey/message/evidence`，前端负责筛选和定位。
- 首批做缺主键、FK 列类型兼容、对象引用完整性；名称含空格作为可配置风格提示，避免把合法 quoted identifier 当作数据库错误。
- FK 索引覆盖检查作为后续建议，需理解复合索引顺序及 PostgreSQL/MySQL 差异；不应直接套用统一规则。
- 验收：规则按方言运行/跳过；每条结果解释依据并定位对象；忽略理由可保存；不查询业务行、不执行修复 SQL。
- 所有刷新/导入/导出/诊断复用统一任务结果面板：成功/失败/部分成功、计数、耗时、详情、重试。

### 第三批：离线 DDL 导入与能力矩阵

- 新建 `schema-import`，支持文件和剪贴板；解析输出快照候选、诊断、源文件行列、未支持语句。
- 先支持明确的 PostgreSQL/MySQL CREATE TABLE、PK/FK、索引子集，再扩展 ALTER/VIEW/ENUM；不执行输入 SQL。
- 文件模型使用明确的来源身份，如 `SqlFile`，不要仅给 DataSourceProfile 填假 host/user。引入来源类型会影响存储、设置、AI 和云端边界，应先设计兼容迁移。
- 保留方言、解析能力和来源内容哈希；限制大文件、注释/嵌套大小；INSERT 数据不得进入结构快照。
- 验收：同一 SQL 输入生成稳定结构指纹；不支持语句可定位，部分结果不冒充完整导入；误混入数据行不被保存；无需数据库连接。
- 单独建能力表：`introspect/query/importDdl/exportDdl/checkRules`，区分 supported/partial/unsupported。

**免安装离线 HTML viewer** 是在上述交付能力之后的可选增强：复用快照和语义格式，使用独立脱敏 allowlist，并明确过滤本地连接地址、代码路径、令牌等。不要直接把整个 `.nodalmodel` 嵌入网页，也不要将 SQLEditor 的 HTML Report 推断成已经验证的交互式 viewer。

## 5. 架构上可借鉴的分层

安装包中的 framework 链接和 exporter 配置表支持“UI/模型/解析/数据库/生成分离”的观察，但未反编译内部接口，以下是 **Nodal Studio 的建议设计**：[E3/E4/E5]

```text
数据库采集 ─┐
DDL 文件 ───┼─> 统一结构快照 ─> 差异 / 诊断 / AI 上下文
离线备份 ───┘          │
                    语义与逻辑关系
                       │
                 图形/数据字典表示
                       │
              UI / SVG / PNG / PDF / HTML
```

新后端能力经 `NodalStudioPlatform` 暴露，桌面与 Web 实现分别声明能力和限制；组件不直接调用 Tauri invoke。设置类型变更同步 Rust 与 TypeScript；布局/来源持久化变更需要 SQLite 迁移。导入或诊断无须改变“结构采集只读、逻辑关系不创建数据库约束”的现有保证。

## 6. 暂不直接移植的能力

- **执行 DDL/Export to Database**：会改变 Nodal Studio 的工作范围；需要独立草稿模型、生成器和执行授权流程。
- **跨方言类型自动转换/迁移生成**：配置中的 exporter 名称不能证明语义等价。精度、默认表达式、索引、枚举、自增与约束都需要显式损失报告。
- **JDBC/Java 整套兼容层**：多数据库适配值得借鉴；是否复用 Java 不由安装包决定。优先保持现有 Rust 领域层与适配器结构。
- **直接复用现有二进制、资源或私有算法**：本报告提取产品行为和设计建议，后续采用项目自己的实现。

## 7. 证据索引与未解问题

精选证据保存在 [sqleditor-selected-evidence.json](./research/sqleditor-selected-evidence.json)。这是从 REA 完整记录中筛选的分析索引，**不是可重放的完整 canonical Evidence bundle**。完整 REA bundle 在本机 `/private/tmp/sqleditor-rea-evidence-20261013.json`，临时目录可能被系统清理；需要保留全部记录时应另行归档该文件。

| 标记 | 来源 |
|---|---|
| E1 | inspect_plist / Info.plist：`ev_24b0f439a54abf3c9cd1bdc1795b8c7d9132a2264822f6ba1f88c86e70f083ca` |
| E2 | decode_interface_builder：`ev_63733ed6be1a9d799ca296bddc7ad63793693425745a7862dbd882d03f9553df` |
| E3 | inspect_plist / ExporterList：`ev_d10f43a948ce4bb346a97b64e6349fb54b6b13d3b334a6c52567b5e5449964e6` |
| E4 | inspect_plist / DriverList：`ev_4b96772d9326299174feeeaa2a6e1df89fade5242b919d0260d21aa84221a01b` |
| E5 | inspect_macho：`ev_d1f6201ac134e485851e8343327ef9c69eaf2c11c65d197d233ea381b30218db` |
| E6 | inspect_artifact：`ev_96b29772590d6133dc47b64cd02a4206bd843a89b8e09f7cfd55e612fbcd068a`；嵌套 inventory：`ev_b8fb6c6c7cf911f21d7551bb55d8d6d47f3a7a3da4b444cfe079bff3b503af1c` |
| U1–U5 | 本次 Computer Use accessibility 观察，精选索引中记录了步骤与结果；**不是 REA runtime Evidence ID** |
| H | `/Applications/SQLEditor.app/Contents/Resources/en.lproj/help/`，索引保存对应文件路径与 SHA-256；其中 introduction 标注 3.0 |

原始问题检查：功能范围、当前项目差距、优先级与实现入口已回答；算法内部实现、广泛方言兼容性、实际迁移输出、图像/HTML 成品质量仍未验证。若后续需要实现特定功能，可围绕该功能进一步测试有效/无效输入和导出成品，而无需重复整包分析。

## 8. 当前项目适配性评估与吸收裁定

### 8.1 总体裁定

**适合选择性吸收。报告能作为功能候选和证据索引，尚不足以直接作为整份开发计划。**

评估依据是 [产品定位与边界](../DEVELOPMENT_PLAN.md#L24)、[成功指标](../DEVELOPMENT_PLAN.md#L653) 和当前代码，而非 SQLEditor 是否具备某项功能。优先吸收能改善“理解当前结构、看清演进、共享认知”的能力；先完成小闭环，再决定是否引入新的来源类型、输出框架或模型实体。

`DEVELOPMENT_PLAN.md` 仍是 Draft，部分 MVP 非目标已被当前 Query/MySQL 实现超越，不能机械地按旧条目否定已有功能。但数据库作为物理事实来源、不可变快照和语义分层仍由当前代码支撑。本次没有用户需求证据或可用性实验，因此优先级属于基于源码缺口和产品定位的判断，不代表市场需求已验证。

### 8.2 吸收矩阵

| 候选能力 | 适配程度 | 当前裁定 | 首次实施边界 / 成本判断 |
|---|---|---|---|
| 完整变更列表、筛选和快照身份 | 高：直接对应时间机器 | **P0，先做** | 解除 30 条上限，保留风险/对象上下文；展示已有摘要。主要是前端展示改造 |
| 完整对象前后属性 | 高：直接改善变化解释 | **P0/P1，紧随列表** | 桌面回查两份快照，补默认值/注释等；Web 先显示已有摘要并说明详情覆盖。成本高于单纯列表 |
| 删除表/字段的历史图形 | 高，但依赖较多 | **P1，单独任务** | 先支持桌面比较；历史节点不混入当前语义编辑或布局持久化。不能当作“加红色样式” |
| SVG/PNG 导出 | 高：支持结构评审和文档交付 | **P1，吸收** | 单一明确范围（当前模型视图）、主题、图例；先验证输出质量，再加范围/格式 |
| 静态 HTML 数据字典 | 高：支持新人理解和离线交付 | **P1/P2，吸收** | 单快照、已确认语义、关系分类和搜索/目录可选；无需先做完整交互 viewer |
| 多选及批量业务域成员管理 | 高：加强现有语义创作 | **P1，优先于复杂排版** | 分离焦点与选中集合，批量添加到已有域；复用 DomainGroup，不新增第二套 Label 模型 |
| 六种对齐、均分、位置固定 | 中高：改善手工整理 | **P2，分步吸收** | 基础多选/对齐先行；固定、撤销、选区布局需另定持久化和交互规则 |
| 结构预检 | 中高：帮助理解，存在误报风险 | **P2，调整后吸收** | 少量可解释、方言感知的规则；不输出“数据库合法性已保证”结论 |
| 统一操作反馈 | 高：横跨现有工作流 | **P1 起逐步统一** | 先统一任务状态、摘要和详情入口，复用现有通知/错误反馈；暂不增加完整持久审计子系统 |
| 能力矩阵 | 中高：避免 PG/MySQL/Web 功能误导 | **随相关任务补充** | 小型能力声明即可，当前不需要通用插件注册框架 |
| 离线 DDL 文件/剪贴板导入 | 有条件适合：扩大模型入口 | **P3，先验证需求与来源设计** | 先以临时只读导入预览验证价值；确认需要持久模型后再扩展来源、存储、设置、云同步 |
| 交互式离线 HTML viewer | 有条件适合，但新增分发渠道 | **P3，暂缓** | 先观察静态报告是否满足需求；复用适合阅读的 DTO，不嵌入整个备份 |
| 物理编辑、跨方言迁移生成/执行 | 低：偏离当前核心闭环 | **不纳入此次吸收** | 需要独立产品决策和草稿/方言/执行设计，不能按竞品菜单逐项添加 |

P0 表示核心体验缺口，P1 表示下一批适配增强，P2/P3 表示有依赖或需求待验证；这些标记不是错误严重级别，也不是时间承诺。

### 8.3 原报告必须修正的判断

**1. “Diff 只需展示现有 before/after”不够。**

[column_summary](../crates/schema-diff/src/lib.rs#L554) 只含类型和 nullable；[diff_columns](../crates/schema-diff/src/lib.rs#L310) 按整个 ColumnDefinition 判断变化。例如默认值由 `0` 改为 `1`，可产生 AlterColumn，但两侧摘要都可能显示同样的 `integer not null`。展示摘要只是第一步；完整解释要根据 operation 的 ObjectKey 回查原始对象，或显式扩展差异投影。避免仅加两个文本框却仍无法解释变化。

同时列重命名使用结构匹配启发式，[diff_columns](../crates/schema-diff/src/lib.rs#L335) 无法从快照证明实际执行过 RENAME。界面应标识为结构推断，避免当作已观测 DDL 操作，更不能直接用于迁移执行。

**2. 桌面与 Web 的 Diff 能力不能统一承诺。**

[WebPlatform](../apps/frontend/src/platform/web-platform.ts#L143) 不提供历史列表，getSnapshot 仅返回分享中的当前快照，compareSnapshots 不支持；[cloud bundle](../apps/desktop/src-tauri/src/lib.rs#L4457) 发送最新快照和可选 changeSet，并不包含完整 before 快照。桌面可直接取历史对象，Web 的完整前后属性/删除节点需扩展分享数据契约并限定可见范围。因此应先做桌面详情和两端通用摘要，再决定云端契约升级。

**3. 业务域过滤不是新增缺口，多选最好服务现有语义。**

[KnowledgePanel](../apps/frontend/src/components/KnowledgePanel.tsx#L82) 已把业务域转换为零跳视图；[tableSemantics](../apps/frontend/src/graph/schema-graph.ts#L598) 已赋予节点域颜色。可借鉴的是批量维护成员、清晰的分组表达，而非重新引入 Label/CanvasArea 两套独立概念。优先“选多表 → 加入业务域/保存关系视图”，比一开始补齐所有绘图软件操作更贴近项目。

**4. 多选/固定/撤销并非纯 UI 增量。**

[SchemaCanvas](../apps/frontend/src/components/SchemaCanvas.tsx#L244) 用单一表焦点重新派生 selected；[拖动结束](../apps/frontend/src/components/SchemaCanvas.tsx#L620) 的布局保存跳过搜索、聚焦和 savedView 模式；[CanvasPosition](../crates/semantic-model/src/lib.rs#L74) 只有坐标/尺寸，没有固定状态。引入批量移动后必须定义全图与局部视图的位置如何合并，避免只保存当前可见节点而覆盖全图。撤销管理的是布局/语义动作，不是回滚物理快照。选区布局还要处理跨选区边和固定节点，不能直接调用全图 ELK 后覆盖所有坐标。

**5. 结构预检应显示覆盖和不确定性。**

缺主键可作为设计提示；视图等不应套用表规则，合法的引号标识符也不应因空格被判错。[当前逻辑关系校验](../apps/desktop/src-tauri/src/lib.rs#L3521) 只取 type_schema/type_name 精确比较，不是通用数据库外键兼容判定。[MySQL 列采集](../crates/mysql-adapter/src/lib.rs#L172) 没有字符集/排序规则等字段，不能凭现有模型声称 FK 兼容性检查完整。规则输出应区分提示、疑似问题、不适用和信息不足；数据库已接受的物理约束不能因字符串类型不同被误报成非法。

首版让计算逻辑与 UI 分离即可，是否新建 crate 由规则数量和复用需求决定，不必预先设计规则插件系统。

**6. 导出方案要缩小，不必预先建设统一输出框架。**

最小闭环是一种范围的 SVG/PNG + 一份可阅读的静态报告。需要统一图形语义、复用现有 graph/布局；是否使用独立 renderer 应在验证文字、字段端口和边线输出后决定。PDF、多格式、多范围和交互 viewer 不应一起成为首版前置条件。导出中物理 FK、已确认逻辑关系和推断候选要分开标识，候选不能因图片导出成为“确认关系”；历史删除节点也需要独立图例。性能沿用项目 500 表/5,000 字段目标，避免导出时强制重新布局或阻塞主线程。

**7. DDL 导入要先定义事实来源。**

[DataSourceProfile](../crates/schema-model/src/lib.rs#L82) 的连接信息、[DatabaseSnapshot](../crates/schema-model/src/lib.rs#L108) 的 sourceId 以及按来源保存的设置/历史都围绕数据库构建。SQL 文件适合作为“文件描述的只读模型”，不能悄悄变成“数据库当前结构”，也不能把不完整解析当作真实 DropTable 变化。正式落地前要确定解析覆盖、方言、来源身份、比较资格及刷新行为。源文件行列定位不能从 sqlparser 依赖存在直接推断，应验证解析器输出并补充映射设计。此项应后于核心 Diff 和交付增强。

### 8.4 修订后的最小实施路线

1. **变化解释闭环**：完整变更列表、筛选、快照方向/时间、摘要；桌面回查属性详情和重命名推断说明。重点场景：超过 30 条变更、默认值变化、同名跨 schema 对象。
2. **认知交付闭环**：当前视图的 SVG/PNG 和单快照静态 HTML 结构报告，验证图例、长字段、布局边界和大图输出；复用现有模型，不新建备份格式。
3. **语义创作闭环**：多选、批量业务域成员操作与少量对齐命令；全图/局部布局持久化规则明确后再补固定、撤销与选区布局。
4. **有界结构提示**：少量规则与统一结果详情，明确适用范围和信息不足；反馈足够后再扩充。
5. **需求驱动的扩展**：DDL 导入、交互离线 viewer 和更多数据库能力另列提案，不作为前四项前置依赖。

本次评估只修正文档、优先级和吸收边界，未修改产品代码、未新增功能，也未运行应用测试。后续实现仍需各自的小型设计和相应验证；本评估不授权自动开始这些功能。

### 8.5 后续实施进度（2026-10-13）

以下为评估后按用户指令推进的实现状态，区别于上面的原始评估结论：

- 已完成完整 Diff、前后属性和比较方向，以及包含删除对象的比较图。
- 已完成当前 Diagram SVG/PNG 导出和单快照静态 HTML 数据字典。
- 已完成多选表、批量加入已有业务域、六种对齐、均分及全图/临时视图的保存规则。
- 已完成布局撤销/重做：覆盖排版、拖动、尺寸调整和手动自动布局；历史仅作用于当前图的坐标与尺寸，完整图恢复后自动保存，临时视图不覆盖全图。规则与验证见 [DIAGRAM_LAYOUT.md](DIAGRAM_LAYOUT.md)。
- 此时语义创作/排版路线剩余位置固定与选区布局（后续已完成，见 §8.6）；之后进入少量可解释、方言感知的结构预检。DDL 导入和交互式离线 viewer 仍按 P3 暂缓。

### 8.6 固定位置与选中表自动布局实施（2026-10-13）

已吸收表位置固定/解除固定和仅选中表自动布局。固定表位置与尺寸不可编辑，所有排版跳过固定表；ELK 只计算目标表的内部可见关系，并沿当前布局方向避让静止表。完整图持久化 `pinned`（旧格式默认 false），临时视图只在当前范围生效，固定与布局均支持会话撤销重做。新增前端算法/真实 React Flow 测试及 Rust 格式兼容和 SQLite 回读验证。完整规则见 `DIAGRAM_LAYOUT.md`。

布局操作优先项已完成；此时下一项为小而可解释、区分数据库方言的结构预检（后续已完成，见 §8.7）。DDL 与离线交互 Viewer 仍保持 P3。

### 8.7 有界结构预检实施（2026-10-13）

已完成桌面/Web 共用的快照结构预检：缺主键设计建议、PK/FK 引用一致性、PostgreSQL/MySQL 分别解释的逐字段类型观察，以及默认关闭的名称空白提示。每项展示对象、规则、依据和建议，支持定位源/目标表、筛选和分批展示；规则覆盖明确区分已检查元数据、部分覆盖和不适用，缺失目录信息不推断为约束非法。

检查整个当前已采集快照，不受 Diagram 过滤或历史删除节点影响，不查询数据库或执行修复。忽略理由只在本机按来源/指纹/依据保存，支持恢复与保存失败重试。按 §8.3 修订采用独立纯 TypeScript 计算模块与 UI 分离，避免提前建设 crate 或插件框架。新增 50 项算法、存储、组件与 App 集成测试。规则、方言限制和保存边界见 [SCHEMA_PREFLIGHT.md](SCHEMA_PREFLIGHT.md)。

前四项最小闭环已实现；FK 索引覆盖、更完整目录采集仍需需求反馈后扩充，DDL 导入和交互离线 Viewer 继续暂缓。

### 8.8 统一操作反馈实施（2026-10-13）

已统一本轮吸收功能中的导出、批量域操作、布局、结构预检和本地理由，以及刷新和比较详情加载的反馈。共用运行/完成/失败/信息状态，展示实际摘要、错误详情和明确重试；重复提交和过期响应有范围保护，保留现有布局串行保存与临时视图边界。布局计算失败、报告/图形导出、业务域与预检均有对应重试入口。

新增 18 项测试，完整前端共 296 项。统一的是当前实施路线的反馈组件和规则，Query/AI/Cloud/Git/Settings 保留现有专用流程；不新增完整审计系统。说明见 [OPERATION_FEEDBACK.md](OPERATION_FEEDBACK.md)。

此时剩余横向收尾为能力矩阵（后续已完成，见 §8.9）；离线 DDL 导入和交互式离线 Viewer 仍是暂缓的 P3 项。

### 8.9 能力矩阵实施（2026-10-14）

已汇总 22 项当前能力，按 Desktop/PostgreSQL、Desktop/MySQL、Web/PostgreSQL、Web/MySQL 展示支持、部分支持、不可用及具体边界。Settings 与命令面板可打开，支持筛选、当前上下文高亮和详情；未知运行端/方言不默认视为支持。明确 MySQL 采集范围、Web 单快照分享、临时布局、预检不确定性和扩展配置要求。

Query 入口和执行守卫共用声明，MySQL 与 Web 阻止执行，避免把 MySQL 元数据支持当作 SQL 执行支持；切换到不支持的来源不会展示旧查询历史。新增 27 项测试，完整前端共 323 项，未增加插件框架或数据库探测。详见 [CAPABILITIES.md](CAPABILITIES.md)。

本轮核心路线及两项横向收尾已完成。此时 DDL 导入、交互式离线 Viewer 仍暂缓；DDL 临时预览后续按用户要求完成，见 §8.10。更多预检规则、目录采集和数据库能力作为需求驱动增强，不自动纳入当前范围。

### 8.10 DDL 文件/剪贴板临时只读预览（2026-10-14）

按 §8.3 的来源设计边界，新增独立 Import DDL 页面，Desktop/Web 共用 Worker 子集解析器。支持 PostgreSQL/MySQL 普通 CREATE TABLE、声明字段、PK/FK、UNIQUE 和简单索引，提供结构列表、声明外键 Diagram、源位置导航及运行/结果/失败重试/取消反馈。未覆盖或无效语句原子省略，部分结果明确标识；MySQL 存储选项、PG serial/identity 选项等未投影信息有覆盖警告。

来源使用独立 `ddl-preview:` 会话身份、解码文本 SHA-256 和 `ddl-preview-v1:` 模型摘要，不伪造数据库连接或采集时间。预览不执行 SQL、不进入在线快照/SQLite/History/Diff，不保存语义或布局，不发布/导出或发送 AI。关闭丢弃，保留原工作区。文件限 UTF-8 1 MiB，另外限制 tokens、语句、嵌套、表和字段；Worker 超时/取消终止，剪贴板权限失败可重试或手动粘贴。

新增 43 项测试，覆盖方言声明、原子省略、源位置、数据/routine 区域隔离、资源上限、摘要、Worker、输入失败重试/过期结果及 App/Diagram 写入隔离。浏览器实测合成 MySQL SQL 文件和 PostgreSQL 文本，验证真实 Worker、部分覆盖提示与 ELK 图。能力矩阵四组合更新为部分支持。详见 [DDL 导入预览](DDL_IMPORT_PREVIEW.md)。持久 DDL 模型、更完整语法、迁移执行及交互离线 Viewer 仍未纳入本轮。

### 8.11 交互式离线 HTML Viewer（2026-10-14）

按用户要求完成原 P3 暂缓候选的首次实施：整个已加载单快照及当前已加载语义导出为单 HTML，独立于 App Diagram 的过滤范围。复用静态字典并增加小型允许清单 DTO 和独立原生 SVG 脚本，支持元数据搜索、schema/域筛选、表详情与关系导航、一跳查看、缩放/平移及键盘操作。图采用确定性概览布局，物理 FK 与 active 已保存逻辑关系区分，缺失端点和 inactive 状态不伪造节点或数据库约束。

文件无 React/Tauri/外部资产/网络请求，不连接数据库、不执行查询、不编辑或写回、不保存浏览器状态。限制 500 表/5,000 字段/5,000 物理或 active 逻辑关系/32 MiB，超限拒绝，保持静态字典回退。分享内容之外与 Before 历史不会补入；文件不继承 token 到期/撤销。能力矩阵新增第 23 项，Desktop/Web 均在限定范围内支持。

新增 18 项测试，完整前端 384 项，另通过生产压缩模块生成 HTML，在本机静态 HTTP 页面验证独立交互及显示；浏览器工具禁止 file://，未实测双击打开。详情见 [离线 Viewer](OFFLINE_VIEWER.md)。评估清单按首次实施边界已无剩余待实施候选；完整 DDL/持久来源、更丰富预检与采集、PDF 等仍属需求驱动增强，物理编辑及迁移生成/执行仍明确不纳入本次吸收。
