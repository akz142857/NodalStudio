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

## 业务问题复测（2026-10-24）

用户确认以下三条关系后，已通过原生应用保存为本地、有效的多对一逻辑关系；未向 MySQL 添加外键或写入业务数据：

- `mail_task_relation.task_id → mail_send_task.id`
- `mail_task_relation.mail_id → mail_list.id`
- `mail_send_task.template_id → mail_template.id`

AI 范围经用户确认改为 OneHop。仍只发送选定的 1–3 张表的结构、注释及确认关系，模型不接收查询结果或业务行。

复测发现自动上下文曾把问题中的 `state` 筛选条件模糊匹配为独立的 `states` 表，导致无关的关系澄清。修复将“显式提及表名”与模糊匹配得分分开；自动选择三表上下文时，可用同一表集内的桥接表作为 OneHop 根，仍执行原有范围和关系校验。CurrentTable 不扩大范围、无确认关系仍澄清。新增两项回归，前端全量 123 个文件、770 项通过；TypeScript、ESLint 与 macOS debug 构建通过。

真实模型/数据库结果和截图保存在本机忽略目录 `target/mysql-ai-business-review/`；该目录包含聚合业务结果，不随代码提交。

| 用例 | 真实模型 SQL / 澄清 | 数据库执行与独立核对 |
| --- | --- | --- |
| 每月新增邮件地址 | `DATE_FORMAT(create_at, '%Y-%m')`、排除空日期、`COUNT(*)`、月份倒序 | 2 个月，19 ms；用 `YEAR/MONTH + COUNT(id)` 独立核对，数量一致 |
| 每个任务的关联收件人数，保留零关联任务 | `LEFT JOIN` 已确认关系，`COUNT(关联表.id)` 而非 `COUNT(*)` | 10 行，24 ms；用相关计数子查询核对，数量与排序一致。当前最小计数为 2，没有实际零关联样本，不能声称已覆盖该数据边界 |
| 每月已发送且状态正常的去重收件人数 | 三表沿两条确认关系 INNER JOIN；任务日期分组；关联 `state=20`、列表 `state=10`；`COUNT(DISTINCT mail_list.id)` | 2 个月，118 ms；另用 `EXISTS` 检查列表状态、按年月/收件人先去重再计数，结果一致 |
| 每月每个模板的已完成任务数 | 两表 INNER JOIN 第三条确认关系；任务 `state=40`；年月及模板分组 | 0 行，15 ms；独立条件计数确认当前已完成任务中没有同时满足日期非空与匹配模板的记录。验证空结果合理，非空模板分组仍缺真实数据覆盖 |
| 每月实际送达成功率（口径缺失） | 模型指出只有“未发送/已发送”，没有送达/失败依据；追问分子、分母、月份和时区 | 未生成 SQL、未执行查询，正确保留澄清状态 |

所有 SQL 都先审阅、替换编辑器后再手动运行，没有数据库写操作。上述月份是数据中最近有记录的月份，不代表当前日期以前的连续 12 个自然月。日期未转换时区，也未补齐无记录月份。

额外观察：新版启动后一次后台结构刷新显示 `storage-pool-timeout`，并使首条查询的等待时间明显长于数据库报告的执行时间；三表查询最终成功。已区分此本地存储问题与 SQL 执行结果，未凭单次现象修改存储配置，也未宣称问题已修复。

## 对话式 Draft query 与 json-render

- 输入框固定在查询区域底部，上方独立滚动展示本次对话；支持 Enter 发送、Shift+Enter 换行，中文输入法组合输入不会误发送。发送后清空输入框，继续编辑不抹去已有回答；New conversation 清空本次对话。
- 追问沿用已审阅的表范围，携带此前的问题及待回答的澄清项；完整请求仍可审阅，仍由 Generate SQL 发给模型。沿用后端 2,000 字符限制，超过时要求整理完整问题开启新对话，不静默截断。查询结果和 SQL 执行历史不会拼进 AI 请求。
- 使用 `@json-render/core` / `@json-render/react` 0.21.3，将后端已校验的 `SqlDraft` 映射到应用限定的说明、澄清、SQL、口径与本地结果组件。当前不是让模型任意生成整页界面；无模型可调用的执行 action，保留编辑器确认、手动执行和撤销替换。
- 执行成功后，只有 SQL 文本、来源及快照匹配的结果才能显示到回答中；预览最多 12 行、8 列，完整结果仍在 SQL editor。结果仅在本机渲染。
- 下一条消息取代仍在生成的请求时取消旧请求，迟到结果不能写入新回答。来源、快照或 AI 策略变化会重置本次对话；确认关系变化会使旧回答的应用操作失效。对话记录仅保留在当前页面会话，不新增远端或持久化聊天存储。

### 本轮验证

- 前端全量 123 个文件、773 项测试通过；TypeScript、ESLint、diff 空白检查和 macOS debug 应用构建通过。新增覆盖连续追问、保留澄清项、输入法/换行、过长上下文、关系变化后的旧回答失效，以及执行结果回显。
- 已在新构建的原生应用用真实 DeepSeek 完成两轮对话：先生成三表按月去重统计，再追问保持筛选条件、改按人数升序并限制 5 行。第二轮正确保留关联、状态与去重口径，修改排序与行数限制；两轮问题及首轮回答均保留。
- 生成并替换到编辑器时 History 保持 14，主动点击 Run 后增至 15。数据库返回 2 行、64 ms，与前述独立核对结果一致；结果按人数升序，仅显示在匹配的第二轮 SQL 下方。滚动回答时底部输入框固定，Adjust context 弹层位于输入框上方。
- 本机截图与核对记录：`target/query-chat-review/empty.png`、`target/query-chat-review/conversation-result.png`、`target/query-chat-review/verification.json`。原生应用保持运行，停留在对话与结果页面。这些包含本机聚合结果的产物不随代码提交。

## json-render 结果卡片设计（2026-10-24）

- 对话回答由说明、结果卡片、SQL 与口径/澄清组件组合。执行成功后结果卡片优先于 SQL 展示，采用“上方可视预览、下方标题与范围”的圆角布局，单个强调色标记当前数据点。可切换 Chart / Data、折线 / 柱状，并展开卡片；没有无实际行为的固定/分享按钮。
- `Result` 注册为 json-render catalog 中的受控组件。`presentResult` 根据真实执行结果生成本地展示方案，catalog 验证后由 registry 渲染；结果值、图表点和指标不由模型生成，不加入模型请求。模型仍负责生成经校验的 SQL；本轮没有开放任意模型 UI spec 或执行 action。组件目录设计参考 [json-render 官方文档](https://github.com/vercel-labs/json-render#quick-start)。
- 单个完整数值显示指标卡；一列标签加一列数值显示图表。月/日格式且日期有效时按时间排序，默认折线，可切换柱状；其他分类保留 SQL 顺序，使用柱状图。标题使用返回列名，不自动猜测币种、百分比、业务口径或增长结论。
- 图表最多 60 个时间点或 24 个类别。缺失月份不补零，折线在缺失期间断开；不合并重复标签，不把每月去重人数相加。数值从零基线绘制，保留负数；提示与 Data 表格保留原始数值。空值、截断单元格、不安全数值精度、多指标或过多类别均回退表格。
- 表格预览最多 12 行、8 列并注明截取范围，完整结果仍在 SQL editor。数据库行数限制产生的部分结果会同时标注 Partial result 与说明，不伪装成完整统计。图表仅重新排列呈现顺序，不改变查询、原始行顺序或数据库内容。
- 验证：前端全量 125 个文件、791 项通过；随后补充极小非零数值坐标标签回归，图表/展示规则定向 19 项通过。TypeScript、ESLint 与 macOS debug 构建通过。锁屏解除后已完成下述真实 MySQL 原生图表验收。
- 浏览器使用同一实际组件完成深/浅主题、折线/柱状、Chart/Data 及展开检查；控制台无 warning/error。独立预览明确标注为示例数据，未请求 AI 或数据库；截图为 `target/query-chart-review/dark-cards.jpg`、`light-cards.jpg`、`reference-style-card.jpg`，不能作为真实数据库图表验收证据。临时预览入口已清理。

### 原生图表验收完成

- 最终构建中，真实 DeepSeek 生成两表任务收件计数草稿，经审阅后手动运行返回 10 行、26 ms。原生柱状图、Chart/Data 切换、展开/收起、悬停读数均正常；数据与之前相关子查询独立核对结果一致。History 只在 Run 后从 15 增至 16。
- 三表按月去重查询返回 2 行、57 ms，数值与之前独立核对结果一致。默认折线按时间正序展示；Data 保留 SQL 的月份倒序，切换柱状图没有改变数据。History 在手动 Run 后从 16 增至 17；本次未复现 storage-pool-timeout，但不能据此认定先前存储问题已修复。
- 图表验收时，原生应用展示真实月度柱状图，卡片与底部输入框同时可见。本机真实数据截图及记录：`target/query-chart-review/native-task-bars.jpg`、`native-monthly-bars.jpg`、`native-verification.json`。这些聚合业务结果保留在忽略目录，不随代码提交。

### 输入框自适应（2026-10-24）

- 移除原生拖拽手柄；输入框随内容增高或收缩，达到高度上限后内部滚动。窗口或可用宽度变化时重新适配，发送按钮保留在底部。
- 原生应用实测五行输入自动增高、二十行输入达到上限并内部滚动、清空后恢复紧凑高度，未发送测试文字或执行 SQL。相关 12 项测试、ESLint、TypeScript 与 macOS debug 构建通过。
