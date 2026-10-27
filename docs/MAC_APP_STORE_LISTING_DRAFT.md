# Mac App Store 中英文商店文案草稿

首次 MAS 送审版本：**1.0.0（Build 1）**。后续重复上传须递增 Build；社区版与内部 Cargo/npm 包仍为 0.2.4。详见 [版本一致性记录](MAC_APP_STORE_VERSION_ACCEPTANCE.md)。

日期：2026-10-25。适用首版 MAS；未提交、未发布。以下代码块是对应字段的正文，不包括标题。名称沿用应用现有的 Nodal Studio；商店名称可用性尚未核实。审核材料另见 [审核备注与演示步骤](MAC_APP_STORE_REVIEW_GUIDE_DRAFT.md)。

## 简体中文（zh-Hans）

### 名称

```text
Nodal Studio
```

### 副标题

```text
AI 开发时代的数据库模型可视化
```

### 描述

```text
AI 帮你构建应用，Nodal Studio 帮你看懂背后的数据库。

把 PostgreSQL 和 MySQL 中的表、字段与关系变成可探索的数据模型。在接手陌生项目、检查 AI 辅助开发的系统，或持续维护应用时，看清结构、检查变化，并用查询验证你的理解。无论应用由人工还是 AI 辅助开发，都可以使用。

看清应用背后的数据模型
通过关系图探索表之间的连接，查看字段、键与约束。从整体结构进入对象详情，理解应用的数据如何组织。Nodal Studio 专注于结构理解，不提供表结构编辑或迁移执行。

跟上不断演进的结构
比较已采集的结构快照，查看变化前后的详情。刷新结构后，在“本轮变化复核”中检查结构变化及其对已有说明的影响；保留或修订说明，明确确认，或填写理由暂缓。支持批量标记结构变化已查看，以及恢复归档说明后重新复核。业务含义是否仍然适用，由你判断。

结合上下文理解字段
查看字段类型、约束和已有数据库注释。为对象整理业务说明与标签，组织业务域和保存视图，让探索过程留下可复用的项目资料。

基于结构上下文提问
用自然语言提出问题，借助可选 AI 生成 SQL 草稿，检查解释、假设和需要澄清的事项。先在编辑器检查，再由你执行只读查询；生成草稿不会自动执行 SQL。核心结构浏览与变化复核无需 AI。

用数据和图表验证理解
查看查询结果，对支持的结果使用图表或数据视图进行探索。只读 SQL 编辑器支持右键执行、格式化与常用编辑操作，并提供受行数限制的结果和本地查询历史。

本地保存，持续复用
模型、说明和复核记录保存在本机。关系图可导出为 SVG 或 PNG；可通过本地备份和 Git 工作区文件交换项目资料。文件导出与导入由你发起，不会自动提交或推送。

使用条件
连接数据库需要可访问的 PostgreSQL 或 MySQL 服务及相应权限。远程 AI 需要自行配置兼容服务和 API 凭据，服务商可能另行收费。AI 请求会将问题及所选结构上下文发送给配置的服务商，其处理和留存规则由该服务商规定。应用不会自动提取业务数据行发送给 AI；请留意你主动输入的问题或说明中的敏感信息。

Mac App Store 版本无需另建 Nodal Studio 账号，不包含云协作。数据库和远程 AI 连接会联系你配置的服务，购买授权由 Apple 处理。
```

### 关键词

```text
数据库,模型,可视化,关系图,结构,变更,复核,SQL,ER图,PostgreSQL,MySQL
```

## English（en-US）

### Name

```text
Nodal Studio
```

### Subtitle

```text
Visualize your app’s database
```

### Description

```text
AI helps you build your app. Nodal Studio helps you understand the database behind it.

Explore PostgreSQL and MySQL tables, columns, and relationships as a visual data model. Whether you are taking over an unfamiliar project, inspecting an AI-built application, or maintaining a growing system, see its structure, inspect changes, and use queries to check your understanding. Built for both human-written and AI-assisted applications.

SEE THE DATABASE BEHIND YOUR APP
Explore how tables connect in a relationship diagram. Inspect columns, keys, and constraints, and move from the overall model to individual objects. Nodal Studio focuses on understanding database structure; it does not edit table structures or execute migrations.

KEEP UP AS YOUR SCHEMA EVOLVES
Compare captured schema snapshots with before-and-after details. After refreshing metadata, use Current change review to inspect structural changes and their impact on saved descriptions. Keep or revise a description, explicitly confirm it, or defer it with a reason. Mark structural changes reviewed in a batch, and restore archived descriptions for another review. You decide whether the business meaning still applies.

UNDERSTAND FIELDS IN CONTEXT
Inspect field types, constraints, and existing database comments. Organize your own descriptions, tags, business domains, and saved views so that exploration becomes reusable project knowledge.

ASK QUESTIONS WITH SCHEMA CONTEXT
Use optional AI assistance to turn natural-language questions into SQL drafts. Inspect explanations, assumptions, and clarification questions. Review the SQL in the editor before choosing to run a read-only query. Generating a draft does not execute SQL. Core schema exploration and change review do not require AI.

EXPLORE YOUR RESULTS VISUALLY
Inspect query results as data or supported charts. The read-only SQL editor includes context-menu execution, formatting, and common editing actions, with bounded results and local query history.

KEEP KNOWLEDGE LOCAL AND REUSABLE
Models, descriptions, and review records are stored on your Mac. Export relationship diagrams as SVG or PNG, and exchange project materials through local backups and Git workspace files. You initiate file export and import; the app does not automatically commit or push.

REQUIREMENTS
Database connections require an accessible PostgreSQL or MySQL service and appropriate permissions. Remote AI requires a compatible provider and your own API credentials. Provider charges may apply. AI requests send your question and selected schema context to your configured provider, whose processing and retention policies apply. The app does not automatically extract business rows for AI; take care with sensitive information you include in questions or descriptions.

The Mac App Store edition requires no separate Nodal Studio account and does not include cloud collaboration. Database connections and remote AI contact your configured services; Apple handles purchase authorization.
```

### Keywords

```text
schema,model,visualization,ERD,PostgreSQL,MySQL,SQL,diagram,diff,query,developer,ai-assisted
```

## 文案定位与五张图对应关系

统一定位：**AI 帮你构建应用，Nodal Studio 帮你看懂背后的数据库，并在结构变化后持续掌握它。** AI 是开发场景，不是数据库来源限制；不承诺自动建模、修改结构、同步代码或自动判断业务语义。

| 图序 | 英文截图标题 | 描述对应内容 |
| --- | --- | --- |
| 01 | See the database behind your AI-built app. | 数据模型可视化、表与关系 |
| 02 | Keep up as your schema evolves. | 结构快照比较与变化复核 |
| 03 | Understand what each field means. | 字段类型、约束与已有注释 |
| 04 | Ask questions with schema context. | 可选 AI SQL 草稿、检查后执行 |
| 05 | Explore your results visually. | 查询结果与支持的图表 |

截图与导出检查记录见 [五张英文商店图](../artifacts/app-store-product-page/README.md)。本轮保留已验证的功能边界：没有承诺全自动业务判断、自动发现后台变化、自动修复结构、云同步、永久离线授权或真实购买验收已通过。移除了旧稿“预览待发送内容后再发送”的强制二次确认表述，避免与直接发送的查询草稿流程冲突。

## 字段长度核对

名称/副标题不超过 30 字符，描述不超过 4,000 字符；关键词额外保守校验不超过 100 UTF-8 字节。关键词使用英文逗号分隔，不含竞品、价格或排名词。2026-10-25 复核 Apple 官方 [版本字段说明](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information) 与 [名称及副标题说明](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)。

| 字段 | zh-Hans | en-US |
| --- | ---: | ---: |
| 名称（字符） | 12 | 12 |
| 副标题（字符） | 16 | 29 |
| 描述（字符） | 985 | 3000 |
| 关键词（UTF-8 字节） | 84 | 92 |

## 送审前待确认

- 名称沿用 Nodal Studio，商店名称可用性尚未确认。
- 分类建议 Developer Tools；版权主体、支持 URL、隐私政策 URL、年龄分级、售价和销售地区仍需确认。
- 首版版本为 1.0.0（Build 1）；再次上传须递增 Build，不能把草稿版本号视为已上传。
- 依据包括 [P0 验收](CHANGE_REVIEW_P0_ACCEPTANCE.md)、[分页/批量/恢复验收](CHANGE_REVIEW_P0_EXTENSION_ACCEPTANCE.md)、[SQL 编辑器验收](SQL_EDITOR_CONTEXT_MENU_ACCEPTANCE.md) 与截图检查记录。这些本地证据不替代最终签名候选包验收。
- 文案、截图、隐私政策和审核备注须与最终送审包一致；真实购买验收继续单列，不因素材完成而视为通过。
- 本轮仅更新本地送审 Markdown，未修改商店后台，未提交 Git、送审或发布。
