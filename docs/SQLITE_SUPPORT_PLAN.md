# SQLite 查看支持：分析与实施方案

日期：2026-11-06。分析基线：`50f07da`。状态：首版功能已实现，验收与限制见 [SQLITE_ACCEPTANCE.md](SQLITE_ACCEPTANCE.md)。本文保留最初的设计依据与阶段划分。

## 1. 建议与首版范围

将 SQLite 接入为 Desktop 的第三种正式数据源，使用“选择本地文件 → 只读打开 → 采集结构 → 查看模型/运行只读查询”的流程。沿用现有快照、ER 图、语义标注、历史比较与导出能力；用户数据库与应用自己的本地 SQLite 存储严格分开。

本方案把“查看”解释为结构查看与用户主动触发的数据预览，不含编辑数据库。结构采集不扫描业务行，不自动计数、不自动抽样；数据预览通过现有 Query 页面显式执行。

| 能力 | 首版建议 |
| --- | --- |
| 打开 `.db` / `.sqlite` / `.sqlite3` 等文件 | 支持；扩展名只是选择器提示，最终由 SQLite 打开和读取目录验证，允许其他扩展名 |
| 保存数据源、重启后重新打开 | 支持；MAS 需持久文件授权，权限失效时可重新选择 |
| 表、列、PK/FK、索引、视图、触发器、原始 DDL | 支持；复杂对象保留定义并明确采集缺口 |
| ER 图、搜索、语义标注、布局、快照和比较 | 复用，补齐 SQLite 特性与回归测试 |
| 表数据预览、SELECT / 只读 WITH、查询历史、结果导出 | 支持，沿用现有行数/字节/超时限制 |
| 图像、HTML 字典、离线 Viewer、元数据备份 | 支持；导出不携带文件访问授权与业务行 |
| Web Viewer | 可展示发布的 SQLite 快照，不在浏览器打开本机数据库 |
| AI 结构解释、业务发现 | 接入方言和类型语义后开放；沿用已有发送范围审阅 |
| AI SQL 草稿 | 第二阶段；首版明确不可用，不能回退到 PG/MySQL |
| Cloud / Git | 核查类型兼容和本地路径隔离后复用，Cloud 仍需用户主动发布 |
| SQLite DDL 文件导入 | 后续单独扩展；打开数据库文件与解析 `.sql` 是两项能力 |
| 写数据、DDL 执行、创建数据库、迁移、SQLCipher、ATTACH 多库、远程文件 | 不在首版支持范围 |
| FTS/RTree/自定义虚拟表 | 首版识别和展示可获取定义；仅对实际内置模块验证后的对象提供查询，不自动加载模块 |

## 2. 现状与影响范围

### 2.1 可复用基础

- `Cargo.toml` 已启用 SQLx 0.9.0 的 SQLite feature；`snapshot-store` 用 SQLite 保存应用数据。已有驱动不等于已有 SQLite 数据源。
- PG/MySQL 分别通过 `postgres-adapter` / `mysql-adapter` 生成统一 `DatabaseSnapshot`。新增 `sqlite-adapter` 可以复用后续图谱和存储链路。
- `schema-model` 已包含表、列、键、索引、视图、程序对象；`schema-diff`、语义模型与布局不直接连接用户数据库。
- `query-engine` 已有只读校验、结果上限、取消、错误类型、单元格编码，可新增 SQLite 分支。
- `file_access.rs` 与 `storekit-bridge/native/FileAccess.swift` 已实现文件选择及 MAS security-scoped bookmark。需要扩展用途和生命周期，不能只保存字符串路径。

### 2.2 当前硬编码

| 位置 | 当前行为 | 需要的改动 |
| --- | --- | --- |
| `crates/schema-model/src/lib.rs` | DatabaseType 只有 PG/MySQL，Profile 必须带 host/port/username/TLS | 新增 SQLite；区分网络连接与本地文件目标 |
| `crates/settings-model/src/lib.rs` | 默认引擎枚举只有两种 | SQLite 默认项与旧设置兼容 |
| `apps/desktop/src-tauri/src/lib.rs` | 保存、测试、验证保存、采集、Query 提前访问密码和 SSH/TLS | 按目标类型先分流；SQLite 不触发 Keychain 或网络连接 |
| 同上及 `platform/types.ts` | `testPostgresConnection` / `capturePostgresSnapshot` 实际也处理 MySQL | 采用通用命名；旧入口可短期保留转发以降低一次性改动 |
| `ConnectionPanel.tsx` 等 | 引擎切换仅改变端口，表单与状态是网络连接模型 | SQLite 文件表单、文件诊断、重授权、重新定位 |
| `query-engine`、编辑器、formatter | PG/MySQL 两种 parser、执行器和编辑器方言 | SQLite AST 校验、执行器、动态值解码、编辑器/格式化映射 |
| `ai-context/src/sql_draft*`、`discovery.rs` | 两种方言匹配与函数限制 | 显式分支与能力控制，禁止隐式降级 |
| `semantic-model/src/knowledge.rs` | 来源身份哈希基于 engine/host/port/database/username | SQLite 文件目标身份；重绑定触发知识重新校验 |
| `capabilities.ts` | Desktop/Web × 两种数据库四列 | 增加 SQLite 两种运行环境的真实能力 |
| `SettingsPage`、`DataSourcePicker`、`QueryPage`、`schema-report`、`ObjectDocument` | 多处“非 MySQL 就是 PG”或反向默认 | 集中引擎标签与方言描述，消除错误展示 |
| `snapshot-store`、Cloud、备份/离线 Viewer | JSON 序列化和统一快照 | 新类型兼容、旧指纹稳定、本地路径与权限隔离 |

另一个 workspace `nodalos/apps/studio-web` 是产品网站；本次核心功能在 NodalStudio 的 `apps/frontend` 与 Desktop。网站文案在功能验收后同步。

## 3. 数据源与文件访问设计

### 3.1 连接目标与兼容策略

运行时采用有类型的连接目标：Network（PG/MySQL 的地址和凭据参数）与 SqliteFile（本地路径/本地文件引用，只读）。SQLite 不使用虚构 host、port、username，也不把路径冒充 database 名称。

为控制迁移风险，旧 PG/MySQL JSON 继续可读，由兼容反序列化转换为内部目标；旧字段可在过渡版本保留。SQLite 使用专门的 `sqlite` 配置字段或带标签的目标变体。落地时统一选定一种序列化形式，避免两份配置同时生效。`data_sources` 当前主要使用 `payload_json`，重点是数据兼容而非新增大量 SQL 列。

路径和 bookmark 只属于本机连接配置。`DatabaseInfo.name` 用非路径显示名称，`version` 明确表示本应用实际 SQLite 运行库版本，不声称是文件的创建版本。文件位置单独展示，不进入快照身份或远程 AI 上下文。

### 3.2 交互

1. 新建数据源选择 SQLite，只显示名称、文件选择与“只读”状态。
2. 测试阶段显示“检查文件 → 获取权限 → 打开数据库 → 读取结构”。不显示 SSH/TLS 成功或失败。
3. 首次成功采集后，原子保存数据源与快照，保持现有验证后保存的语义。
4. 文件失效时保留历史模型；提供重新选择/重新授权。打开另一个数据库默认创建新来源；用户明确重绑定现有来源时重新验证语义依据。
5. 删除数据源只删除 Nodal Studio 的记录和不再使用的本地授权，不删除用户数据库文件。

### 3.3 读模式与沙盒

- 使用结构化 `.filename(path).read_only(true).create_if_missing(false)`，不把用户路径拼成可注入 URI 的连接串；拒绝 `:memory:`、目录和非预期 URI。
- 不复用应用内部存储的建库、迁移或 WAL 设置，不切换用户库 journal_mode、不 checkpoint、不修复数据库。
- 默认不设置 `immutable=true`。它会跳过锁和变化检测，对仍有其他程序写入的文件不适用。[SQLite URI 文档](https://www.sqlite.org/uri.html)
- WAL 的读取可能依赖相邻 `-wal`、`-shm`。先用已授权文件访问；必要时解释原因并请求用户选择所在目录，持久保存对应授权。不得将单文件授权直接视为整个目录授权。[SQLite WAL 文档](https://www.sqlite.org/wal.html)
- 现有 Swift bridge 按精确路径查 bookmark，并拒绝解析到另一位置；目录授权需要显式、安全的子路径覆盖规则，不能只调用现有 `access(file)` 假定可用。
- 授权 Access guard 必须覆盖 SQLite worker 的真实工作周期，包含取消清理和连接关闭，而非仅覆盖打开连接。
- “只读”保证不改变业务数据/结构；WAL 辅助文件的访问或运行时维护不能等同于“目录内所有文件字节绝不改变”。验收需区分两者。
- 不直接复制正在使用的主 `.db` 文件绕过 WAL 权限问题。若未来增加副本模式，应使用 SQLite 一致性备份机制。
- 首版只承诺已验证的本机普通文件系统；网络共享和云盘占位文件不宣称兼容。

## 4. SQLite 元数据适配

新增 `crates/sqlite-adapter`，提供打开/检查/采集接口。首版一个文件一个 source，统一映射到 `main` schema，不支持 ATTACH 或持久 temp 对象。

| 元数据 | 读取方式与处理 |
| --- | --- |
| 表、视图、触发器、DDL | `main.sqlite_schema`，结合 `table_list` 分类；默认隐藏内部及 shadow 表 |
| 列 | `table_xinfo`，捕获生成列和隐藏列，不只用 `table_info` |
| 表选项 | `table_list` 的 STRICT、WITHOUT ROWID、virtual/shadow 标记 |
| PK | 按列的 PK 序号组装，区分 INTEGER PRIMARY KEY、复合 PK 与隐含 rowid |
| FK | `foreign_key_list` 按 id/seq 分组；省略目标列时解析被引用主键，失败则明确缺失 |
| 索引 | `index_list` + `index_xinfo` + 原始 SQL；保留唯一性、来源、排序/排序规则和表达式信息 |
| CHECK、生成表达式、部分索引条件、延期属性 | 对原始 CREATE SQL 做 SQLite AST 解析；无法确定时保留定义与诊断 |
| 视图/触发器依赖 | 有证据再写入依赖，不用字符串包含关系猜测 |

这些 PRAGMA 的字段和版本边界以官方文档及实际 bundled engine 为准；参数尽量使用可绑定参数的表值 PRAGMA，标识符使用专门转义。[SQLite PRAGMA 文档](https://www.sqlite.org/pragma.html)

必要的模型补充建议采用可选 SQLite 元数据对象，包含表选项、原始定义、列 affinity、生成方式/表达式、隐藏状态，以及采集诊断。PG/MySQL 默认省略这些字段，避免改变旧快照 canonical JSON 和指纹；相应差异比较与 UI 同步扩展，不能只写入 JSON 而不参与比较。

以下语义必须处理准确：

- SQLite 常规列是动态类型；保留声明类型与 affinity，不按 PG 固定类型约束理解，也不扫描数据反推类型。[SQLite 类型文档](https://www.sqlite.org/datatype3.html)
- PK 不一律代表 NOT NULL。普通 rowid 表中部分 PK 可为空；需要结合声明、INTEGER PRIMARY KEY、STRICT、WITHOUT ROWID 判定。INTEGER PRIMARY KEY 的特殊语法例外也需用 fixture 覆盖。[CREATE TABLE 文档](https://www.sqlite.org/lang_createtable.html)
- rowid 不是自动声明的业务主键；AUTOINCREMENT 不映射成 PostgreSQL identity。
- SQLite 经常没有显式约束名。采用明确标注为派生的稳定 ID，避免每次刷新随机命名或把顺序调整全部当成删建。
- `foreign_key_list` 不能证明其他应用连接的 FK enforcement 状态；不把本应用连接设置显示成整个数据库的执行保证。
- 现有 `deferrable: bool` 等字段不能表达未知，必须增加可见的可靠性/采集缺口信息或扩展可选表示，不能默默把未知当 false。
- 不支持的虚拟表模块应局部降级为“定义可见，字段/查询不可用”，不因单个对象使整个库完全不可查看。核心目录损坏/失败则不发布完整成功快照。

采集使用同一连接、短只读事务保证结构一致性，遵守超时、取消与对象/元数据大小预算；不运行全库 COUNT、integrity_check 或业务抽样。诊断应区分“对象删除”与“此次读取不完整”，避免部分采集产生虚假删除差异。

## 5. 只读查询与结果语义

新增 `query-engine/src/sqlite.rs`、`sqlite_value.rs` 和 `validate_read_only_sqlite`。优先继续使用现有 SQLx；本机锁定版本提供 `lock_handle()` / 安全的 `set_progress_handler()`，没有必要仅为取消功能立即引入第二套 SQLite 驱动。

安全策略分层：只读文件打开 + 连接初始化 `query_only=ON` + 单语句 SQLite AST 校验。用户 SQL 首版仅 SELECT/只读 WITH；递归遍历子查询，阻止写语句、事务控制、ATTACH/DETACH、VACUUM、写 PRAGMA、扩展加载。元数据 PRAGMA 通过内部固定接口执行，不向用户开放任意 PRAGMA。关闭扩展加载且不注册文件访问 UDF，审查可调用虚拟表模块和 pragma 表值函数。

`query_only` 单独不是完整只读保证；它不能替代文件打开标志和语句控制。[SQLite query_only](https://www.sqlite.org/pragma.html#pragma_query_only) 如后续需要 authorizer，应通过可审计封装实现，不为本次接入放松工作区 `unsafe_code = forbid`。

- 取消与超时：执行前在专用连接安装 progress handler，检查 CancellationToken 和单调时钟 deadline；释放 locked handle 后再执行查询。锁等待使用短、有界 busy timeout，并纳入总时限。仅 Tokio timeout 返回不足以证明 worker 已停止。
- 读到上限、失败或取消时停止迭代、完成底层清理，再释放文件授权；验证下一条查询仍可正常执行。
- 保持默认 100 行、最多 5,000 行；现有默认 30 秒/最大 120 秒、单元格与总结果字节预算继续生效。流式读取，避免 fetch_all。
- 按每个值的实际 storage class 解码；同列可以混合整数、文本、NULL、BLOB，不以第一行决定整列类型。
- 64 位整数沿用精确文本表达，防止 JavaScript 数值精度损失；不强制把 0/1 转 boolean，也不把任意 TEXT 猜成日期或 JSON。
- BLOB 首版沿用长度摘要，明确结果导出不包含完整二进制；大单元格底层分配仍需结合驱动能力验证，不能把显示截断宣称为严格内存上限。
- SQLite Editor、语句选择、补全、格式化采用独立方言映射。表预览使用转义后的 `"main"."table"`；无 ORDER BY 时不承诺固定顺序。

## 6. 快照、身份、备份和扩展能力

- 来源 ID 与本机文件绑定分开；重新定位明确的同一来源可保留 ID，但失效知识必须重新审核。路径/文件标识变化用于提示，不把 mtime 或整个文件内容哈希作为每次身份变化依据。
- 普通 PG/MySQL 来源身份算法保持稳定；SQLite 专用分支不可把所有文件算成同一来源。
- 新可选字段使用默认值兼容旧数据，缺省序列化省略；验证旧快照 fingerprint 与已确认知识不会仅因升级而失效。
- 便携备份不携带 bookmark，不自动信任导入的路径。恢复后默认可看离线模型，连接本机文件需重新选择。评估格式版本/能力声明，旧版本对 SQLite bundle 给明确不兼容提示。
- 云端快照、AI、Git 及 HTML 导出不得意外携带绝对路径或授权；数据库文件名如需作为显示名称发送，仍纳入现有发送范围预览。
- schema-diff 需要比较 STRICT、WITHOUT ROWID、生成表达式等新增字段；原始 DDL 的纯格式变化与结构变化应区分显示，不承诺语义等价 SQL 的完美归一化。
- 逻辑关系验证和结构预检：只复用对象存在性等通用规则；SQLite 类型兼容规则独立设计，不能套用 PG/MySQL 的字符或整数匹配结论。
- AI 结构解释可以复用元数据上下文，但 prompt、类型描述、草稿入口和后端必须都显式识别 SQLite；未支持的 SQL 生成路径返回 unavailable。
- Cloud API 与 Web Viewer 都需更新 DatabaseType；服务端尚不支持 SQLite 时阻止发布并解释兼容要求。

## 7. 实施顺序与验收

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| S0 可行性验证 | 用仓库实际 SQLx/bundled SQLite 验证只读、活跃 WAL、真实取消、MAS 重启授权 | 明确目录授权路径；取消后 worker 停止；不触发源库写入；确定构建运行库与模块 |
| S1 类型与连接 | 新目标、兼容读写、文件选择、身份、通用命令、错误状态 | PG/MySQL 无回归；SQLite 保存/重启/重定位；导入不能授予文件权限 |
| S2 结构查看 | sqlite-adapter、元数据扩展、DDL/诊断、图/快照/diff | fixtures 正确；重复采集指纹稳定；部分对象缺失不产生假删除 |
| S3 Query | guard、执行器、值解码、取消与 UI 方言 | 混合类型和大整数正确；禁写；超时/取消真实生效；限制和导出一致 |
| S4 产品整合 | 能力矩阵、AI 能力控制、预检、备份、Web/Cloud、i18n | 端到端闭环；无 PG/MySQL 回退；路径/权限隔离；两个发行渠道验收 |
| S5 后续增强 | AI SQL、SQLite DDL 导入、更多虚拟表与诊断 | 分别定义范围与验收，不阻塞首版查看 |

建议 S0 单独完成再确定最终排期。单人串行粗估：S0 1–2 人日，S1 2–3 人日，S2 3–4 人日，S3 2–3 人日，S4 2–4 人日；共约 10–16 人日。此为规划估算，不含商店审核及额外驱动/沙盒问题处理。

最低验收矩阵：

1. 普通库、空库、中文/空格/引号/无扩展名路径、缺失文件、权限撤销、只读目录、损坏/非 SQLite/加密文件；错误不得把后两者武断认定为某一种。
2. INTEGER PK、复合/可空 PK、WITHOUT ROWID、STRICT、无声明类型、生成列、复合 FK/省略目标列、延期 FK、CHECK、UNIQUE、表达式/部分索引、视图、触发器、FTS/shadow、缺失模块。
3. 活跃外部 writer + WAL、锁竞争、结构并发变化、取消后关闭、重启后 bookmark、移动/替换文件；MAS 签名沙盒实际验收，普通单测不能替代。
4. 混合类型、64 位边界、BLOB、大文本、空结果重复列名、复杂/递归查询、结果上限、多语句与写语句拒绝、引号和注释绕过。
5. 旧 PG/MySQL 设置/快照/知识/备份、来源重绑定、Snapshot Diff、离线 Viewer、Cloud 序列化、跨设备导入、删除来源不删原文件。
6. 前端 typecheck/lint/相关 Vitest；Rust 相关 crate tests、workspace 编译/Clippy；最后按仓库要求运行完整回归。无需为本次纯方案提交运行构建。

发布门槛：社区 Desktop 与 Mac App Store 版分别通过实际文件访问验收；Web 只宣称快照查看；未验证功能在 capability 中明确 partial/unavailable。当前实现与逐项验证以 [验收记录](SQLITE_ACCEPTANCE.md) 为准；正式签名发行包与跨平台验收仍属发布门槛。

## 8. 主要代码依据

- `Cargo.toml`、`Cargo.lock`：现有 SQLx SQLite 依赖。
- `crates/schema-model/src/lib.rs`：DatabaseType、DataSourceProfile、SchemaDefinition 等。
- `crates/snapshot-store/src/lib.rs`：payload_json、原子 verified-source 保存、快照去重与备份。
- `apps/desktop/src-tauri/src/lib.rs`：连接输入、验证、测试、采集、只读执行、凭据读取。
- `apps/desktop/src-tauri/src/file_access.rs`、`crates/storekit-bridge/native/FileAccess.swift`：选择器、授权与 bookmark。
- `crates/query-engine/src/{lib,guard,mysql,value}.rs`：限制、校验、取消和值编码。
- `crates/semantic-model/src/knowledge.rs`：source_identity。
- `crates/schema-diff/src/lib.rs`：字段比较与对象差异。
- `apps/frontend/src/platform/{types,settings-types,capabilities}.ts`：前端协议与能力。
- `apps/frontend/src/components/ConnectionPanel.tsx`、`components/query/{SqlEditor.tsx,sql-validation.ts}`：连接和查询 UI。
- `crates/ai-context/src/sql_draft.rs`、`sql_draft/dialect.rs`、`apps/desktop/src-tauri/src/discovery.rs`：方言与 AI SQL 验证。

本机依赖源码检查：`sqlx-sqlite-0.9.0/src/connection/mod.rs` 提供安全 progress handler；`options/mod.rs` 支持 read_only/create_if_missing 且默认不修改 journal_mode。最终发行包仍应在 S0 记录实际运行库版本与编译选项。
