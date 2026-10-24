# MySQL AI SQL 草稿

日期：2026-10-24。本机开发验证记录，不代表已发布版本。

## 实现范围

- Desktop 的 MySQL Query 页启用 Draft query；Business question 中的 Draft query 可携带问题与所选表进入草稿页。PostgreSQL 入口保持可用。
- 提示词、SQL 解析器和只读查询校验均取自当前快照的数据库类型，模型不能自行选择方言。审阅的请求正文与实际发送正文相同。
- MySQL 草稿支持反引号、常见筛选/聚合、`DATE_FORMAT`、`DATE_ADD`/`DATE_SUB`、`IFNULL`、`CONCAT`、受限类型转换，以及两种 LIMIT/OFFSET 写法。表名和别名保留元数据大小写；列名按 MySQL 大小写规则匹配后还原为元数据名校验关联。
- 仍需配置并启用在线 AI 模型；每次审阅 1–3 张表，受当前来源的发送范围限制。JOIN 必须包含已知物理关联或已确认逻辑关联的完整列映射。只使用结构与允许的语义信息，不发送业务行、查询历史或凭据。
- 需求或关系不清楚时显示澄清问题。生成、放入编辑器、手动运行是三个独立动作；生成完成不执行 SQL，编辑器替换可撤销。
- 拒绝 PostgreSQL 专属语法、可执行注释、优化器提示、变量赋值、文件/锁函数、写操作、未知表/列和不完整 JOIN。CTE、子查询、窗口函数、UNION 等仍不属于第一版 AI 草稿范围，用户可在普通 SQL 编辑器中编写其支持的查询。
- 保留请求取消、来源/快照/策略变更检查，过期结果不能继续应用。

## 自动验证

- 前端全量：123 个文件、768 项通过（4 workers）；涵盖两种方言的生成、澄清、迟到结果取消，以及 MySQL Business question → Query 的上下文传递。
- ai-context：26 项单元/集成测试通过；包括 MySQL 日期/聚合/类型转换、分页、完整复合关联、大小写与反引号转义，以及危险或错误方言 SQL 拒绝测试。PostgreSQL 回归通过。
- 真实模型首轮验收返回列引用校验错误后，补充 MySQL `database.table.column` 解析，仍要求表已绑定且库、表、列全部匹配已审阅证据，不允许通过原表名绕过别名或访问仅在上下文里但未绑定的表。最后的定向回归通过 8 项 SQL 草稿单元测试与 3 项桌面 SQL 草稿测试；两模块 Clippy 再次通过。完整列名语法参照 [MySQL 标识符限定文档](https://dev.mysql.com/doc/refman/8.0/en/identifier-qualifiers.html)。
- Desktop Rust：81 项通过、6 项原有环境测试 ignored。新增本地 HTTP 模拟模型测试验证 MySQL 提示词、实际发送正文、上下文边界、有效 SQL/澄清接受、无效答案拒绝；模拟模型不能替代真实在线模型验收。
- TypeScript、ESLint、ai-context 与 desktop 的 Clippy（warnings 视为错误）、Rust 格式和 diff 空白检查通过。Clippy 同时发现原有 `safe_store_error` 的按值参数提示；该函数作为 `Result::map_err` 回调使用，保留按值签名并添加带说明的定点 lint 豁免。
- macOS debug `.app` 构建成功：`target/debug/bundle/macos/Nodal Studio.app`。保留原有 IIFE 命名和 chunk 大小提示。

## 原生与真实模型验收

- 已启动本次构建的原生应用，在 `flow`（MySQL、499 张表）打开 Query → Draft query。输入只选择 `flow.mail_analytics.id/create_at`、固定 `WHERE 1=0`、`LIMIT 10` 的问题，自动上下文正确匹配这一张表，进入请求审阅页。
- 审阅页显示 `deepseek-flash · 1 table · schema only`、`Preview ready; nothing sent yet.`，正文使用 `Draft a MySQL SELECT` 提示词。预览阶段没有发送请求或执行 SQL。截图：`target/mysql-ai-draft-review/context-preview.png`。
- 用户要求代填非密钥配置。已在应用保存启用 AI、OpenAI-compatible、`https://api.deepseek.com`、`deepseek-flash`、60 秒超时；保留当前表范围、重试 1 次、并发 2。用户自行保存 Key 后，设置页显示已存入系统凭据存储；验收过程没有读取或输出 Key。
- 首轮真实请求成功返回模型内容，但本地列引用校验拒绝。补充完整列名兼容性并重新打包启动后，用相同问题再次真实请求 DeepSeek；返回以下草稿并通过元数据与只读校验。页面同时展示中文解释、假设以及“Nothing has run”，截图为 `target/mysql-ai-draft-review/generated-sql.png`。

```sql
SELECT `flow`.`mail_analytics`.`id`, `flow`.`mail_analytics`.`create_at`
FROM `flow`.`mail_analytics`
WHERE 1 = 0
LIMIT 10
```

- 点击 Review in editor → Replace 后，编辑器显示 AI 草稿提示与 Undo replacement，History 仍为 5，结果区域仍为未执行状态，证明生成与替换没有自动执行。
- 主动点击 Run 后成功返回 0 行，结果列为 `id / INT UNSIGNED` 与 `create_at / DATETIME`；SQL 执行耗时显示 11 ms，History 从 5 增至 6。等待连接阶段明显长于 SQL 执行耗时，最终成功，无须修改连接或凭据。固定恒假条件没有返回业务记录，没有执行数据库写操作。
- 原生应用保持运行，停在生成 SQL 的执行结果页。截图：`target/mysql-ai-draft-review/executed-query.png`。本次真实模型验收覆盖单表零行查询；其他函数、复合关联、拒绝边界由前述本地测试覆盖，不能据此声称所有业务问题均已实测。
