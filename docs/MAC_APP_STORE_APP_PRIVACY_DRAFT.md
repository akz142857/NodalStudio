# App Privacy 填写草稿

首次 MAS 送审版本：**1.0.0（Build 1）**。后续重复上传须递增 Build；社区版与内部 Cargo/npm 包仍为 0.2.4。详见 [版本一致性记录](MAC_APP_STORE_VERSION_ACCEPTANCE.md)。

日期：2026-10-25。状态：供负责人填写确认，未进入 App Store Connect，未提交或发布。范围：首版付费下载的纯 macOS MAS 版本；社区版的云功能和 GitHub 更新不在本草稿范围。对应 [送审清单](MAC_APP_STORE_SUBMISSION_CHECKLIST.md) 与 [代码核查记录](MAC_APP_STORE_PRIVACY_EXPORT_AUDIT.md)。

## 填写方式与证据等级

- **代码确认**：当前实现能证明的行为，不代表远端服务运营事实或 Apple 审核结论。
- **条件建议**：只有列出的前提成立才可采用；不能直接当最终答案提交。
- **用户确认**：运营主体、服务商合同/设置、留存及商店范围等代码无法证明的内容。
- **后台核对**：本草稿按官方概念组织，并非当前账户逐屏截图；实际题目、选项和语言以填写时后台为准。

负责人：`待填`；对应版本/build：`1.0.0 / 1`；确认日期：`待填`；最终决策记录：`待填`。

## 先确认这六项

| 编号 | 需要你填写的内容 | 当前建议/影响 | 你的答案或证据 |
| --- | --- | --- | --- |
| P1 | 法定运营主体、公开联系邮箱 | 当前政策写 ClayCosmos 和 GitHub Issues，不能据此推断法定主体；建议提供非公开敏感资料的联系渠道 | `待填` |
| P2 | 正式隐私政策 HTTPS URL；可选隐私选择 URL | 仓库正文不是线上 URL；本次不部署 | `待填` |
| P3 | 首版正式支持/推荐的 AI 服务、API 产品及地区；是否有自营代理 | 支持任意 OpenAI-compatible endpoint；没有固定服务商合同可从代码推断 | `待填；无自营代理也请明确写无` |
| P4 | 各服务是否保留请求、响应、认证/访问日志；期限、用途、账户关联、删除方式 | 按下面服务商表分别填写；不要发送 API Key | `待填` |
| P5 | 开发者/合作方是否另有广告、数据共享、统计、支持工单或后台日志处理 | 客户端未发现开发者遥测上传；仍需确认运营侧实践 | `待填` |
| P6 | 是否用收集的数据训练模型、分析行为、个性化或广告/广告归因 | 代码只能证明请求用途；服务商二次使用取决于实际产品条款/设置 | `待填` |

### 服务商核实表（每个正式支持的服务复制一行）

| 服务/运营方、API 产品/地区 | 官方条款 URL、版本/核对日期 | 请求/响应留存及期限 | 安全/滥用日志、IP、请求 ID、用量记录 | API Key 是否关联账户 | 训练/统计/广告/转交 | 删除途径及零留存配置证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `待填` | `待填` | `待填` | `待填` | `待填` | `待填` | `待填` |

仅证明某个测试账户零留存，不能覆盖所有终端用户的 API 账户。用户自建数据库/本地模型与开发者选择的服务合作方应区分；任意自定义 endpoint 的披露边界若仍无法确定，应在正式填写前向 Apple 明确，而不是把未知全部写成“不收集”。本次未替用户选择或限制服务商。

## 已由代码确认的数据流

| 数据/路径 | 当前确认事实 | 本地证据 |
| --- | --- | --- |
| 模型、语义、快照、查询历史 | 本地存储；用户明确选择导入/导出。查询会联系用户选定的数据库，结果在客户端展示 | `crates/snapshot-store/src/`；`apps/desktop/src-tauri/src/query_export.rs` |
| 远程 AI 内容 | 发送问题和所选结构上下文；可含注释/已确认语义。请求构造不自动提取业务行；用户文本仍可能包含敏感内容 | `apps/desktop/src-tauri/src/lib.rs` 的 `remote_ai_explanation`；`crates/ai-context/src/` |
| AI 认证和元数据 | 从钥匙串取 Key，以 Bearer 认证发送；body 包含 model/messages。网络端点可观察 IP 等连接信息，但代码不能证明其留存方式 | `remote_ai_explanation`；`apps/desktop/src-tauri/src/ai_chat.rs` |
| AI 连通性测试 | 同样调用远端，发送固定测试提示和空结构；仍有认证及网络元数据 | `lib.rs` 的 `test_ai_provider` 路径附近 `provider-connectivity-test` |
| 显式发送 | 远程解释有预览/发送步骤；离线解释无需远端 | `apps/frontend/src/components/AiAssistant.tsx`；`crates/ai-context/src/lib.rs` |
| 数据库/SSH | 连接用户配置的服务器；服务器可能记录 SQL、登录或连接信息，不经开发者转发 | `apps/desktop/src-tauri/src/connection_security.rs`；数据库适配器 |
| 购买 | StoreKit 获取/恢复 AppTransaction，本机核验设备证明；无独立许可证服务器 | `crates/storekit-bridge/native/Purchase.swift`；`apps/desktop/src-tauri/src/purchase.rs` |
| 云账号、GitHub 更新 | MAS 后端禁止相应命令；updater 插件不注册 | `purchase.rs` 的 `unavailable_in_mas`/`command_allowed`；`lib.rs` 的条件注册 |
| 诊断/支持 | 当前政策允许用户手动分享诊断，未提供开发者自动上传服务；公开支持入口为 GitHub | `docs/legal/PRIVACY.en.txt`、`PRIVACY.zh-CN.txt`；需 P5 确认运营侧 |

## 首题：是否收集数据

**当前最终答案：待 P3–P6 确认，不预填 No。**

Apple 的标签“收集”关注离开设备后超出实时处理所需时间的数据访问；本地处理、发出请求、远端留存是不同事实。AI 默认关闭、用户点同意、BYOK，都不能单独推出无需披露。[Apple 数据收集说明](https://developer.apple.com/app-store/app-privacy-details/)

| 分支 | 采用条件 | 草稿答案 |
| --- | --- | --- |
| A：无须申报的收集 | 完成所有适用数据流/合作方核实，确认无符合定义的收集；不能只看应用没有自己的服务器 | No，前提和证据：`待填` |
| B：存在应披露收集 | 适用服务商或开发者保留内容、账户关联记录等，且不满足可选披露条件 | Yes；继续逐数据类型填写下表 |
| C：未知 | 缺服务商实践、日志或关联证据 | 保持草稿，先补证据，不用猜测的 Yes/No 代替核查 |

不要以“可选 AI”直接套可选披露例外：该例外需要多项条件同时成立，显式同意只是其中一部分；频繁使用的核心 AI 功能不应默认依赖它。[Apple 可选披露规则](https://developer.apple.com/app-store/app-privacy-details/)

## 若首题为 Yes：数据类型与后续答案

下面是按当前产品数据流整理的候选，而非全选列表。每行最终填写：是否收集、目的、是否关联用户、是否用于追踪。类别按后台英文标签核对。

| 数据类型 | 代码事实/初步建议 | 条件下的用途建议 | 关联用户/追踪判断 | 最终填写 |
| --- | --- | --- | --- | --- |
| Other User Content | AI 问题、结构、注释/语义；若适用服务商留存则优先检查此项 | App Functionality；额外用途按 P6 补齐 | 若请求与 API 账户关联，不能填未关联；追踪待服务方确认 | `收集：__；用途：__；关联：__；追踪：__` |
| User ID | 认证 Key 可能识别服务账户；应用无 Nodal 云账号，不代表提供方无法识别用户 | App Functionality（认证/计费/安全） | 需核实账户标识的收集范围；不把 Key 原文写入材料 | `待填或不适用，附依据` |
| Other Usage Data / Product Interaction | 本地访问记录不等于上传；提供方请求次数、token 用量等要按实际日志分类 | 依实际用途，不能自动全填 Analytics | 是否与账户/IP 关联待确认 | `待填或不适用，附依据` |
| Other Data Types / Diagnostics / Location | IP、错误/滥用日志按实际处理目的分类；不能仅因服务器看见 IP 就勾选所有类别，亦不能忽略 IP 定位/长期留存 | 安全运行可能是 App Functionality；行为统计另核 | 需查提供方是否定位、关联或另用 | `待填或不适用，附依据` |
| Customer Support / Email Address | 应用无自动工单上传；手工支持是否纳入及是否符合例外由实际渠道/流程决定 | App Functionality | 支持邮件通常可关联联系人；P1/P5 确认 | `待填或不适用，附依据` |
| Purchase History / Device ID | 当前购买证明在本机/Apple 验证，不上传开发者；不能仅因 StoreKit 存在就勾选开发者收集 | 当前代码无开发者收集用途 | Apple 自身处理与开发者处理分开 | `初步不选；确认无其他上传：__` |
| Payment Info | 应用不获取支付卡/银行资料，付费下载由 Apple 处理 | 当前代码无此用途 | 核实无其他支付服务 | `初步不选；确认：__` |
| 其他类别 | 当前无专门采集姓名、通讯录、健康、精确定位、照片/音频等的功能；自由文本不等于自动采集所有敏感类别 | 依实际新增收集填写 | 不因纯粹假设的用户粘贴内容而全选；实际定向收集必须另审 | `核对后台剩余类别：__` |

表中类别名称依据 [Apple 数据类型与用途说明](https://developer.apple.com/app-store/app-privacy-details/)。SQL 查询历史本地保存，不自动等同上传 Search History；自由文本问题也不能不加分析就归为该类别。

用途不能只看客户端：即便客户端为解释数据库发请求，服务商另作训练、分析或营销时仍需分别判断。没有 Nodal 登录并不能证明数据未关联用户；目前代码未证明远端认证前已匿名化。

“追踪”与“账户关联”分别回答。当前未发现广告/广告归因实现；最终 No 还需 P5/P6 的合作方证据。单纯账户关联或模型训练不自动等同 Apple 定义的广告追踪。[Apple Tracking 说明](https://developer.apple.com/app-store/user-privacy-and-data-use/)

## 可填写的最终汇总

```text
Privacy Policy URL: 待填
User Privacy Choices URL（可选）: 待填或明确不提供
Do you or your third-party partners collect data from this app?: 待填
如 Yes，每种数据类型一行：
Data Type | Purpose(s) | Linked to User | Used for Tracking | 依据
待填
服务商实践核对记录/日期: 待填
运营主体与政策一致性确认: 待填
确认人/日期/适用版本: 待填
```

本草稿不修改现有 manifest 的 collection 声明。填完后再核对商店标签、内置中英文政策、公开政策、AI 预览及适用 manifest 是否一致。Privacy Manifest 不代替 App Privacy 表单。本轮只准备材料，不发布政策或填写后台。[后台填写流程](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
