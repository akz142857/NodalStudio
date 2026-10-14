# PostgreSQL / MySQL DDL 只读导入预览

实现与核对日期：2026-10-14。通过主界面 **Import DDL** 或命令面板 **Open read-only DDL preview** 打开；没有数据库连接时也可使用。Desktop 和 Web 共用前端解析器，当前能力为「部分支持」。

## 输入与来源

选择 PostgreSQL 或 MySQL 方言，并指定默认 namespace。可选择本机 UTF-8 `.sql` / `.ddl` 文件、点击 **Read clipboard**，或直接在编辑区粘贴文本。剪贴板只在点击时读取；运行端或浏览器拒绝时显示错误与重试，仍可手动粘贴。文件读取拒绝无效 UTF-8，不读取目录、连接或远程地址。此版本需要 Web Worker 和 Web Crypto SHA-256；缺失能力时报告失败。

文件与编辑区来源明确区分。手动修改文件文本后标注 `edited buffer`，预览针对当前缓冲区，不声称等同磁盘原文件。文件名只保留 basename，原路径不进入预览 DTO。每次载入或清空输入生成新的会话来源身份，前缀为 `ddl-preview:`；它不代表数据库连接、服务器或历史快照。

- **Content hash**：对解码后的当前文本计算 SHA-256，包括注释、空白和未解析语句。UTF-8 文件 BOM 在解码时移除，因此不是原文件字节摘要。
- **Model fingerprint**：`ddl-preview-v1:` 加独立的 SHA-256，输入包含版本、方言、默认 namespace 及排序后的已解析结构。与文件名、会话 ID、非结构注释和 DML 无关；声明字段及属性变化会改变摘要。
- 此摘要规则与 Rust 的数据库快照 fingerprint 不同，不能证明与在线结构等价，不能参与当前 History/Diff 或恢复连接。
- 诊断和表/字段支持跳回编辑区。行号从 1 开始，LF/CRLF 均可；offset、列号及选择范围按 JavaScript UTF-16 code unit 计数，不是 UTF-8 字节位置。

## 解析覆盖

这是有界的声明识别器，不是完整 SQL 语法引擎或服务器校验器。字段类型、类型参数和默认表达式保留为规范化声明文本；未知类型不会被解析成真实目录类型，不校验类型存在性、默认表达式语义、数据库版本、权限或服务器配置。显示 `accepted` 仅表示能投影到本版本模型。

| 对象/属性 | 覆盖与限制 |
|---|---|
| 普通 `CREATE TABLE` | 支持限定名、列列表、`IF NOT EXISTS`；不模拟条件执行，重复声明报告并省略。TEMP、UNLOGGED、LIKE、AS、分区等不覆盖。 |
| 字段 | 名称、声明类型、NULL/NOT NULL、DEFAULT 文本、内联 PK/UNIQUE。PG 支持双引号及未引用名称折叠；MySQL 支持反引号，不假设 ANSI_QUOTES。 |
| 主键 | 内联/表级主键、复合列，主键列投影为 not null；检查来源列存在和重复列。 |
| 外键 | 表级复合 FK、显式目标列、ON UPDATE/DELETE；PG 还覆盖内联 REFERENCES、MATCH SIMPLE/FULL、DEFERRABLE/INITIALLY。MySQL 内联 REFERENCES 不视为受执行的 FK，整表语句省略并说明。 |
| 唯一与简单索引 | UNIQUE 投影为唯一索引；MySQL 表内 KEY/INDEX；独立 `CREATE [UNIQUE] INDEX … ON … [USING …] (列列表)`。不覆盖表达式、前缀长度、排序、谓词、CONCURRENTLY 等。不会补出服务器隐式 PK/FK 索引。 |
| 方言属性 | PG `GENERATED … AS IDENTITY`；MySQL AUTO_INCREMENT 与字段/表 COMMENT。Identity sequence options 省略并警告；serial 保留声明类型，警告未展开 sequence/default。 |
| MySQL 表选项 | 常见 ENGINE、CHARSET/CHARACTER SET、COLLATE、AUTO_INCREMENT、ROW_FORMAT 可以识别，但不进入模型，明确警告无法据此确认 FK 执行或字符串兼容性。未知后缀省略整条表语句。 |

未引用表名使用设置的默认 namespace。PG 未引用 FK 目标同样使用该设置，不模拟 `search_path`；MySQL 未引用 FK 目标使用声明表自身的 namespace。SET、USE、CREATE SCHEMA 等不更改解析环境。MySQL 列引用不区分大小写，并解析回声明列名；表名大小写保留，不猜测服务器 `lower_case_table_names`。

表、FK、索引按独立声明建模，支持前向引用；这不模拟 SQL 执行顺序。缺少 FK 目标时保留声明并报告覆盖缺口，不判定服务器损坏。未命名键使用明确的预览名称，无法恢复真实服务器分配名称。

## 部分结果与资源限制

不支持的字段属性、CHECK、生成表达式、列 collation 或表语法使整条 `CREATE TABLE` 原子省略，避免把截断定义显示为完整表。其他已成功解析的声明保留。ALTER、DROP、视图、独立 TYPE/ENUM、COMMENT ON 等不进入结构；DROP 不会删除预览表。含省略、错误或覆盖警告时结果明确标注 **Partial preview**；无警告也只表示支持子集的预览，不是完整结构验证。

非 DDL / INSERT 不进入模型。COPY FROM STDIN 的数据区跳过至 `\.` 或 EOF。遇到 routine / DELIMITER 区域保守停止解析后续区域，避免函数体里的 CREATE 被当作表。MySQL 可执行注释 `/*! … */` 不执行并警告，不能据此还原完整 mysqldump。诊断不附带被拒语句或行数据片段；原文本只保留在当前内存编辑区，未发送到后端或第三方。

限制为：输入 UTF-8 文本最多 **1 MiB**，**100,000 tokens**、**5,000 statements**、**64 层嵌套**、**500 表**、**5,000 字段**。输入超限直接拒绝；扫描或结构超限报告覆盖错误，保留之前完整声明。解析 Worker 最长 10 秒，支持取消；完成、失败、取消、超时和卸载均终止 Worker，晚到结果不会覆盖新输入。结构与诊断每批显示 50 项，可继续展开。

结构列表完整保留 `(namespace, name)` 身份。如果包含点的引用名称导致现有 Diagram 字符串 ID 冲突，禁用 Diagram 并显示提示，仍可查看结构，不会合并导入对象。

## 临时工作流

预览展示结构列表和 Diagram，图例明确为 **declared FKs**，不生成推断关系。可临时移动、多选、排版或固定表；不读取/保存数据库布局。DDL 页面不提供查询、语义/业务域/逻辑关系写入或导出。关闭或重载页面丢弃预览，返回之前工作区。

解析模型不替换 App 的在线快照，不创建伪连接，不写 SQLite、History、语义、Git、云或 AI，不执行任何 DDL/查询，也不能作为迁移脚本。已有工作区的后台任务可以继续，但导入本身不触发刷新或数据库访问。持久文件模型、完整 DDL 编辑、迁移生成/执行和交互离线 Viewer 仍需后续独立需求设计。

## 实现及验证

[评估 §8.3](SQLEDITOR_REA_ANALYSIS.md) 明确先做临时只读预览。为复用 Desktop/Web 的本地入口，本轮使用独立 TypeScript 子集解析器及 Worker，而不是 Query 的只读 SQL 执行解析流程；不增加 Rust/IPC 命令、数据库依赖或服务端 API。

实现包括 [lexer/parser](../apps/frontend/src/ddl/ddl-parser.ts)、[身份与摘要](../apps/frontend/src/ddl/ddl-preview.ts)、[Worker 生命周期](../apps/frontend/src/ddl/ddl-worker-client.ts)、[导入页面](../apps/frontend/src/components/DdlImportPanel.tsx) 和 [只读 Diagram](../apps/frontend/src/components/SchemaCanvas.tsx)。方言边界核对了官方 [PostgreSQL lexical syntax](https://www.postgresql.org/docs/current/sql-syntax-lexical.html)、[PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html) 和 [MySQL 8.4 CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html)；支持范围以本页及实现为准，不因数据库支持某语法而自动扩展。

新增 43 项解析、摘要、Worker、导入页面、App 和真实 React Flow 边界测试，覆盖两种方言、引用/注释/字符串、源位置、原子省略、前向引用、数据区和 routine 隔离、资源上限、文件 UTF-8、剪贴板拒绝与重试、取消/过期响应、临时来源及写入隔离。完整前端 63 个测试文件、366 项测试通过，TypeScript、ESLint 和生产构建通过。浏览器另使用合成 MySQL 本地 SQL 文件和 PostgreSQL 编辑区文本验证真实 Worker、结果/诊断及 ELK Diagram，关闭后恢复原工作区；没有控制台错误。没有在数据库执行这些 DDL，也不宣称已经验证原生剪贴板权限或所有服务器版本。
