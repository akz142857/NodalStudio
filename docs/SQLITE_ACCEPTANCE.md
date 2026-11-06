# SQLite 查看支持：实现与验收

日期：2026-11-06。对应 [实施方案](SQLITE_SUPPORT_PLAN.md)。这是本地源码交付记录，不代表已发布、云端已部署或通过 App Store 审核。后续多角色审查发现的问题、修复与最新回归见 [审查记录](SQLITE_REVIEW_FIXES.md)；下方原生验收保留当时的证据范围。

## 已实现的首版范围

- Desktop 新增 SQLite 文件数据源，提供文件选择、只读测试、验证后保存、重新选择文件和可选 WAL 目录授权。不使用网络凭据、SSH 或 TLS；缺失文件不自动创建。
- 独立 `sqlite-adapter` 采集 `main` 的表、列、PK/FK、索引、视图、触发器与原始 DDL。保留 STRICT、WITHOUT ROWID、隐藏/生成列、affinity、表达式索引及部分索引信息。STRICT ANY 显示无 affinity；普通可空 PK 与 INTEGER PRIMARY KEY DESC 均有 fixture 覆盖。
- 采集在同一个只读事务中进行，有目录大小、对象数、列数及执行期限限制。缺少虚拟表模块时保留定义并标明字段不可用；快照比较与图投影不会把采集缺口误判为字段或关系删除。
- Query 支持 SQLite SELECT / 只读 WITH，独立解析与编辑器方言，禁止多语句、写入、ATTACH、PRAGMA、扩展加载及文件函数。连接以只读方式打开，并启用 `query_only` / 关闭 `trusted_schema`。
- 使用引擎 progress handler 执行取消与超时。文件授权覆盖 worker 清理与连接关闭。流式读取沿用行数、文本显示和结果字节限制；整数保留精确文本，BLOB 显示长度，混合类型按单元格实际 storage class 解码。
- 复用 ER 图、语义标注、快照历史、比较、查询历史/导出、HTML 字典、离线 Viewer 和元数据备份。表详情及 HTML 字典显示原始 DDL 和采集诊断；普通 PG/MySQL JSON 默认省略新增 SQLite 字段。
- 便携备份导出及导入均移除本机 SQLite 文件绑定。恢复后可查看模型，重新连接必须选择本机文件。来源身份变更会使旧知识依据失效。删除数据源不会删除源数据库。
- Desktop/Web 能力矩阵扩展为六列。Web 仅查看快照。AI 结构解释/业务发现注明 SQLite affinity 与连接级 FK enforcement；AI SQL 草稿在前后端均明确不可用。SQLite DDL 文本导入、写入、建库、ATTACH、SQLCipher 属于首版范围外。
- Cloud API 增加 `/v1/capabilities`。SQLite 主动发布前要求服务端声明支持；旧服务端会被明确阻止。本次未部署云端或发布网站。

## 架构选择与兼容

旧 `DataSourceProfile` 网络字段保留，SQLite 使用可选 `sqlite: { path, accessDirectory? }`；网络数据源夹带 SQLite 文件目标会被拒绝；SQLite 保存时清空网络连接字段。旧 `testPostgresConnection` / `capturePostgresSnapshot` IPC 名称暂时保留兼容，内部按引擎分流。PG/MySQL 的来源身份算法不变。

文件选择与 security-scoped bookmark 复用生产 `file_access` / Swift bridge。目录授权只覆盖经过 canonicalize 验证的直接父目录，不把单文件授权推断成目录授权。授权撤销会检查其他来源、Git 和凭据路径是否仍在使用同一授权。

SQLx 0.9 的 `describe()` 对无声明类型的 SQLite 列在本机测试中触发过原生崩溃。实现改用 `prepare()` 获取列信息，避开其 nullable 推断路径；无声明类型、混合值及空结果有回归测试。未引入第二套驱动或放宽工作区 unsafe 限制。

## 本地原生沙箱证据

独立示例：`apps/desktop/src-tauri/examples/sqlite_sandbox.rs`；复现步骤见 [fixture 说明](../Scripts/fixtures/sqlite/README.md)。使用生产文件选择/bookmark、适配器与执行器；无购买绕过，不进入产品。

本次在 macOS、ad-hoc 签名、App Sandbox + production-equivalent network-client/user-selected-file/bookmark 权限下运行，没有添加文件系统例外。外部 writer 全程保持打开，提交数据留在 WAL。选择一次目录后执行，退出应用并重新启动，再直接执行保存的 fixture：

| 检查 | 结果 |
| --- | --- |
| 实际 SQLite 运行库 | 3.51.3 |
| WAL 内提交值 | `committed in WAL` 与精确 `9223372036854775807` 可读 |
| 写入尝试 | 拒绝 |
| 长递归查询取消 | 首次 53 ms；重启后 52 ms，返回 Cancelled |
| 主数据库文件字节 | 保持不变 |
| 活跃 WAL | 存在 |
| 重启后目录 bookmark | 无需重新选择即可读取 |

保存的 [重启验收结果](evidence/sqlite/sandbox-restart.json) 仅含合成 fixture 数据。此项证明本地沙箱行为，不能代替正式 Developer ID / App Store 签名发行包验证；本机未配置有效代码签名身份。

## 自动化验证

| 验证 | 结果 |
| --- | --- |
| Frontend 全量 Vitest（`--maxWorkers=2`） | 144 文件 / 962 测试通过 |
| Rust `cargo test --workspace --offline` | 260 passed、0 failed、6 ignored；未配置的 live fixture 按原有逻辑跳过 |
| workspace Clippy / MAS Clippy / updater-smoke-test Clippy | 分别运行，均 `-D warnings` 通过 |
| TypeScript / ESLint / Web build | 通过；Vite 保留现有大 chunk 提示 |
| MAS compliance tests | 9 通过 |
| 原生检查后的文案与动态列类型修正 | 相关前端 65 测试、SQLite query 3 测试、Web build 及默认 Clippy 复验通过 |

Rust 网络 fixture 需要本机临时端口；此机器有系统代理，执行时使用明确的 `NO_PROXY=127.0.0.1,localhost,::1`。锁定的 HTTP 依赖对 IP 地址的 `NO_PROXY=*` 未生效，曾使 fixture 请求进入代理；使用明确列表后 MySQL AI 回归已通过。该环境问题未通过改写生产代理行为绕过。

## 完整 Desktop 界面验收

从当前源码与重新构建的 Web 资源生成独立 `com.claycosmos.nodalstudio.sqliteacceptance` 社区版测试实例，使用隔离配置，不读取原有用户工作区。通过真实界面完成：选择 SQLite → 选择活动 WAL 文件 → 测试成功 → 保存并采集 → 展示 `main.fixture` 结构图 → 从表节点打开预览 SQL → 用户显式执行 → 显示两行结果及精确大整数。SQLite 表单不显示 TLS/SSH，Query 不显示 AI 草稿。

退出并重启后，来源、模型和查询历史恢复；刷新结构并再次执行同一 SQL 成功，历史从 1 增至 2。另修正原生检查发现的连接位置/未知方言文案，以及无声明类型结果列的 `DYNAMIC` 标签。最终构建已在界面复验该标签与两行结果。整数结果字节预算按精确文本长度计入，有边界回归。

## 已知边界与发布前检查

- 尚未验证 Windows/Linux 原生文件访问，以及正式签名的两个 macOS 发布渠道。未运行依赖真实 PG/MySQL、真实模型或外部 Cloud 环境的 opt-in 用例；这些验收与离线单元回归分别记录。
- 不保证网络共享、云盘占位文件、加密库或任意第三方虚拟表模块可用。文件移动/权限失效时需重新选择；历史模型保留。
- 大单元格显示截断及结果预算不能限制 SQLx/SQLite 为单个值或表达式所做的全部底层内存分配。busy timeout 为 250 ms，锁等待可能比用户指定的极短查询期限多出一个有界等待周期。
- 原始 DDL 保留且参与表定义比较；不宣称等价 SQL 的格式变化能被完美归一化。无法唯一匹配的外键名称/延期属性会提示以原始定义为准；缺少模块的 shadow 分类也不作完备保证。
- S5 的 AI SQL 草稿、SQLite DDL 文本导入及更多虚拟表支持仍按原方案留待独立范围与验收。
