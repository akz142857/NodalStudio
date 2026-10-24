# MySQL Query 与 Changes 空状态

日期：2026-10-24。此记录描述实现范围与本机验证，不代表已发布版本。

后续变更：MySQL AI SQL 草稿已实现，当前能力与验收状态见 [MySQL AI SQL 草稿验证记录](MYSQL_AI_SQL_DRAFT_ACCEPTANCE.md)。下文保留此前 Query/Changes 批次的验收边界。

## 行为

- Desktop MySQL 的 Query 页、运行按钮及表格预览入口可用。编辑器按 MySQL 方言提供反引号标识符补全、语法高亮、选区执行和光标所在语句执行；PostgreSQL 继续使用原方言。普通查询支持结果网格、导出、本机历史及停止。AI 自动 SQL 草稿仍仅支持 PostgreSQL，MySQL 不显示不可用的草稿入口。
- MySQL 后端复用来源凭据、TLS/SSH 和连接超时配置，独立连接启动 `START TRANSACTION READ ONLY`。单条 SELECT/WITH 的解析检查拒绝 DML/DDL、多语句、INTO、锁、变量赋值、服务器文件函数及可执行注释/优化器提示；还递归检查标量和派生子查询。
- 默认 100 行、最多 5,000 行，界面超时 30 秒。保留单元格与总结果大小上限；BIGINT/DECIMAL 用精确文本，JSON 保留原始文本，时间保留服务器精度，二进制仅显示长度。空结果仍保留列定义。文本协议避免 MySQL TIME 大于 24 小时或负值的精度/转换问题。
- 每次查询的临时会话只移除 `ANSI_QUOTES`、`NO_BACKSLASH_ESCAPES`，使服务器和编辑器/解析器的引号规则一致；保留其余 SQL mode。设置服务端执行时间上限；客户端截止时间覆盖连接池获取、准备和读取。取消、失败或截断时通过同一账号的另一个连接尝试 `KILL QUERY`（至多等待 2 秒），随后丢弃专用连接，避免残留查询和协议数据回到连接池。生产连接建立阶段也接入取消信号。
- 切换数据源或离开查询页取消当前请求；来源生命周期编号隔离迟到结果/历史，包括 A → B → A 切换。
- Changes 一直可点击。没有比较结果时区分未选择来源、首份快照、两份以上快照、历史加载错误和 Web 未分享比较。桌面提供 Open history / Refresh schema；说明比较的是结构而非业务行数据。已有比较继续展示原有 Diff。

## 自动验证

- 前端全量：123 文件、764 项通过。默认并发第一次运行中，大型 SchemaPreflightPanel 测试触发原有 5 秒超时；限制 4 workers 后全量通过，未修改该测试或延长超时。更新了 Settings 对旧 MySQL 不可用文案的断言。
- 最后一处来源切换生命周期调整后：QueryPage 相关 2 文件、10 项再次通过；ESLint 和最终 TypeScript/Vite 构建通过。
- query-engine：10 项单元测试通过；Clippy `--all-targets -- -D warnings`、全仓 Rust 格式检查通过。
- 实际 MySQL 8.4.10 临时 fixture：类型/精度、空列、CTE、行限、UTF-8 单元格限、总结果限、拒绝写入、超时与取消通过；processlist 验证取消/超时语句已结束，之后 SELECT 正常。测试没有执行 DML/DDL。
- 实际 PostgreSQL 17 临时 fixture：原只读查询类型、行限、超时和取消回归通过。
- Desktop Rust：80 项通过，6 项原有需专门环境的测试 ignored。首轮本机 HTTP 模拟测试等待；为测试进程设置 `NO_PROXY=127.0.0.1,localhost` 后全量在 2.58 秒通过，未改变系统代理配置。
- CI 中 MySQL/PostgreSQL fixture job 均增加对应 query-engine 集成测试。
- macOS debug `.app` 构建成功；保留已有 IIFE 命名及 chunk 大小提示。路径：`target/debug/bundle/macos/Nodal Studio.app`。

## 原生界面验收

用户手动解锁后，已用打包后的原生应用完成验收：

- 从 PostgreSQL 来源切换到 Flow（MySQL，499 表、3 视图），Query 与 Changes 均可点击。
- Query 执行 `DATABASE()`、`VERSION()`、无符号 BIGINT 常量和状态文本组成的只读 SELECT，返回 1 行，查询结果报告 8 ms；真实服务器版本为 MySQL 8.0.40，数据库名 flow，`18446744073709551615` 精确保留。History 计数更新为 1。该演示没有读取业务表行或修改数据库。
- Changes 显示“Your first snapshot is the starting point.”，提供 Open history / Refresh schema。点击 Open history 后正确展开右侧 History，展示 1 份快照、499 张表；主区域仍停留在 Changes 空状态。
- 已检查截图中的文字、按钮和三个区域布局。应用保持运行，当前停在 Changes 与历史面板。截图：`target/mysql-query-review/query.png`、`target/mysql-query-review/changes-history.png`。
- 本次没有额外创建快照、修改连接或凭据，也没有执行数据库写入。MySQL 8.4.10 完整执行边界由隔离 fixture 验证，8.0.40 原生验收仅覆盖上述查询与页面交互。
