# Mac App Store 审核备注与演示步骤草稿

首次 MAS 送审版本：**1.0.0（Build 1）**。后续重复上传须递增 Build；社区版与内部 Cargo/npm 包仍为 0.2.4。详见 [版本一致性记录](MAC_APP_STORE_VERSION_ACCEPTANCE.md)。

日期：2026-10-25。状态：材料草稿；未提交、未发布。本轮未制作新的演示附件或重新进行原生验收。范围为 MAS 版本，不以社区版或开发 fixture 代替商店包。

## 审核备注：英文主稿

以下可作为 Notes 草稿；提交前补齐附件、端点及联系人，并在最终包上验证。不要把待填占位符直接提交。

```text
Nodal Studio is a developer tool for understanding PostgreSQL/MySQL schemas and reviewing saved explanations when schema evidence changes. It reads database metadata and supports bounded, read-only SQL queries. It does not edit database table structures or execute migrations.

The main workflow is: inspect a schema, save a description, establish a review starting point, refresh metadata after an external schema change, review structural changes and affected descriptions, and explicitly complete the round. Deferred items remain pending. Restoring archived text does not restore its previous confirmation.

No separate Nodal Studio account is required. This is a paid-download app using Apple StoreKit app purchase verification, not an in-app subscription or a separate license server. Purchase recovery is available in Settings through “Reverify App Store purchase”. No production purchase credentials are included in these notes.

The Mac App Store edition has no cloud account creation or cloud collaboration. App updates are managed by the Mac App Store. Git integration exchanges files in a user-selected directory; it does not automatically commit or push. File access uses system pickers. SSH requires an explicitly configured private key or password and a trusted known_hosts file; SSH agent mode is unavailable in this edition.

Core schema and review features do not require an AI account. Optional remote AI uses a user-configured compatible endpoint and API credentials. The user previews the content before sending. Provider fees may apply. Metadata capture does not automatically send business rows to AI; explicit SQL queries do read rows from the selected database.

Review resources: [FILL: tested attachment names and access instructions].
Read-only demo database: [FILL: endpoint and secure credential delivery instructions].
Optional AI test access: [FILL: reviewer-ready access instructions, or document the remaining review limitation].
Walkthrough/recording: [FILL: accessible attachment or URL and the exact build shown].
Review contact: [FILL: name, email, phone and availability].
```

## 审核备注：中文对照稿

```text
Nodal Studio 用于理解 PostgreSQL/MySQL 数据库结构，并在结构依据变化后复核已保存的说明。应用读取结构元数据，支持有结果数量限制的只读 SQL 查询，不编辑数据库表结构，也不执行迁移。

主要流程：查看结构、保存说明、建立比较起点；数据库在应用外变化后，刷新元数据，分别复核结构变化与相关说明，最后明确完成本轮。暂缓事项仍属待办；恢复归档原文不会恢复旧确认资格。

无需单独注册 Nodal Studio 账号。应用采用付费下载及 Apple StoreKit 购买校验，不使用应用内订阅或独立许可证服务器。设置中提供“重新验证 App Store 购买”入口（英文为 Reverify App Store purchase）。不提供生产购买账号凭据。

MAS 版本无云账号创建或云协作，软件更新由 Mac App Store 管理。Git 功能在用户选定的目录交换文件，不自动提交或推送。文件访问使用系统选择器。SSH 使用显式配置的私钥或密码与可信 known_hosts；本版本不支持 SSH agent 模式。

结构浏览与变化复核无需 AI 账号。可选远程 AI 需配置兼容服务与 API 凭据，用户先预览再发送；服务商可能另行收费。结构采集不会自动向 AI 发送业务数据行；用户主动执行 SQL 时会读取所选数据库的数据行。

审核资料、只读演示数据库、可选 AI 测试访问、演示录像及联系人：提交前填写，并使用正式候选包复验。
```

## 审核前准备（开发方执行，不要求审核员修改生产数据库）

| 材料 | 建议内容 | 当前状态 |
| --- | --- | --- |
| 脱敏示例 | `customers`、`orders`、`order_items` 三张表及少量虚构记录；orders 说明“记录订单及其客户归属” | 示例设计，本次未生成可下载附件 |
| A/B 两阶段结构 | A 为初始结构；B 给 orders 新增 `review_note` 字段，保留原表/字段/关系，便于观察说明依据变化 | 已有类似本地验收案例；尚非审核资料 |
| 只读测试连接 | 独立库、最小权限、审核期间可达；不暴露公网管理权限 | 待准备并复验 |
| 变化触发方式 | 开发方在受控测试环境应用 B；若审核员独立复现，必须另备可重复、明确授权的演示流程 | 目前没有产品内一键切换结构或内置演示服务，不能声称已有 |
| 录像 | 同一正式候选包连续展示 A → 保存/确认 → B → 刷新 → 复核 → 完成 | 待录制；不是可交互功能的替代品 |
| 可选 AI 访问 | 提供可用于审核的有限测试访问及发送范围；不要求审核员购买第三方服务才能测试 | 待准备；核心流程无需 AI 不等于该功能可免审 |
| 截图/附件 | 标明版本、语言、数据库环境；真实字段与说明可读 | 待最终包采集 |

不要使用历史独立 debug app 的数据库或 opt-in fixture 假装商店内置数据。普通备份/Git 导入不携带可移植的本机确认资格，不能声称“导入后立即得到同一已确认复核轮次”。准备离线附件时必须实测导入路径与最终呈现；本稿不假设可通过现有导入功能移植完整复核状态。

## 中文演示步骤（与下方英文逐项对应）

这是一份可执行流程设计。第 5 步需开发方在隔离演示库制造结构变化；在触发方式与附件交付前，不标记为审核员可独立完成的最终教程。演示不依赖远程 AI。

| 步骤 | 操作 | 应看到的结果 |
| --- | --- | --- |
| 1 | 启动实际送审候选包，完成正常 Apple 授权；如需恢复，在设置中使用重新验证入口 | 正常进入工作区；不使用开发绕过开关；失败时记录并先修复 |
| 2 | 使用提供的只读连接添加 PostgreSQL 或 MySQL 演示来源，采集 A 结构 | 表/字段/关系可浏览；连接权限与采集范围可核对 |
| 3 | 在关系图定位 orders，在对象说明入口保存上述业务说明 | 说明保存在本机；数据库表结构不变 |
| 4 | 打开“变更”中的“本轮变化复核”，选择“建立比较起点”；如说明无有效确认，先确认说明、处理待办并“完成本轮复核” | 获得当前结构上的有效本机确认与比较起点；建立起点本身不自动确认旧说明 |
| 5 | 开发方通过外部管理工具在隔离演示库应用 B；应用中点击“刷新数据库” | 捕获新增字段；结构变化与理解影响分开展示；应用自身没有执行 ALTER |
| 6 | 进入说明待办，填写“需要核对 review_note 的用途”，选择“暂缓处理”，在预览后确认 | 暂缓理由进入记录；全局待办仍存在，“完成本轮复核”不能绕过待办 |
| 7 | 重新检查该说明，改为“记录订单、客户归属及复核备注”，选择“确认这条说明”，预览并确认 | 新说明与本轮依据建立确认；不自动处理其他待办 |
| 8 | 在结构变化视图选择事项，使用“批量标为已查看”，核对预览并提交；处理其他实际待办后完成本轮 | 待办清零才可完成；比较起点推进。搜索/分页不会改变全局待办规则 |
| 9 | 可选第二遍：在一个待复核说明上选择“归档本条理解”，填写理由并确认；到处理记录选择“恢复归档说明”，预览提交 | 原文恢复但需要重新确认；已有新文本时不能用旧归档覆盖；恢复不是恢复旧资格 |
| 10 | 正常退出并重开；查看保存的说明及处理记录，再导出一张 SVG/PNG 到用户选择目录 | 已提交的文本/记录持久化，导出文件可打开；未提交草稿不承诺跨重启保留 |
| 11 | 可选 SQL：执行 `SELECT 1 AS review_check`；右键检查执行、复制/剪切/粘贴、全选和格式化入口 | 显示只读结果；编辑菜单按选区/剪贴板状态启用；无需写入数据库 |

分页检查如需演示，应另准备足够多的真实可识别变化；三张表示例不承诺必然分页。归档恢复第 9 步宜在独立第二遍进行，不破坏第 8 步的主线完成记录。

## English walkthrough

Use the submitted build and the supplied isolated review database. The schema transition in step 5 must be prepared by the developer outside the app. There is currently no built-in demo switch. This draft is not yet a self-contained reviewer setup package.

1. Launch the submitted build with normal Apple purchase authorization. If needed, use Settings → Reverify App Store purchase. Do not use a development bypass.
2. Add the supplied read-only PostgreSQL or MySQL connection and capture schema A. Browse its tables, columns, and relationships.
3. Locate orders in the diagram and save a description: “Stores orders and their customer association.” This changes local knowledge, not the database structure.
4. Open Changes → Current change review → Establish starting point. If the description lacks valid local confirmation, confirm it, resolve pending items, and complete the round. Establishing a starting point alone does not confirm existing text.
5. The developer applies schema B to the isolated database outside Nodal Studio by adding orders.review_note. Click Refresh database. Inspect structural changes separately from affected understanding.
6. Defer the affected description with the reason “Check the purpose of review_note”, then confirm the preview. The item remains pending and prevents completion.
7. Revise the description to “Stores orders, their customer association, and review notes.” Choose Confirm this description and confirm the preview.
8. In the structural view, select the change, choose Mark selected structure reviewed, inspect the preview, and submit. Resolve any other pending items, then Complete this round. Filters and pages do not bypass the global pending count.
9. Optional second run: archive a pending statement with a reason, then use Restore archived statement in the activity record. The restored text needs fresh confirmation. Existing replacement text must not be overwritten.
10. Quit normally and reopen. Check the saved description and activity record, then export a diagram as SVG or PNG to a chosen folder. Unsaved drafts are not promised to survive a restart.
11. Optional SQL check: run SELECT 1 AS review_check and inspect the editor context menu for execution, clipboard actions, Select all, and Format SQL. No database write is needed.

## 交付前核对

- [ ] 填完 Notes 占位符；联系方式、附件、端点可用，测试账号不含生产权限。
- [ ] 审核员无需自行安装开发工具、运行仓库 fixture 或访问生产数据；变化复现材料实际可用。
- [ ] A/B 示例、录像、最终包中的文案与步骤一致；确认真实界面入口名称。
- [ ] Apple 购买授权与恢复另按购买验收记录验证；本教程不证明已通过。
- [ ] 远程 AI 如保留，提供可审查路径；未配置的功能不能用文字声称已经演示。
- [ ] 公开商店文案没有把演示设计或待准备的附件写成内置能力。

App Review 联系信息、功能访问和测试资源按 [Apple 完整审核准备说明](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review) 核对。以上只整理材料，不代表已经交付审核环境。
