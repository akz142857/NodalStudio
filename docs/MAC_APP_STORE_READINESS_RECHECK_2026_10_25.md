# Mac App Store 送审前复核 — 2026-10-25

## Build 2 修复进展

用户已授权重新打包。两项复现问题已修复：自动发送许可只消费一次，语言/语义变化可使请求失效但不重放发送；变更解释按输入/策略隔离会话，切换快照清理旧结果并隔离迟到回调，同时保留用户问题草稿。新增回归覆盖语言切换、语义变化、显式重试/追问、旧结果清除及迟到响应。

前端全量 144 文件 / 951 项通过；定向 4 文件 / 41 项通过；测试 lint 风格修正后定向 2 文件 / 20 项通过。ESLint、类型检查、12 项 Python 发布测试及第三方许可清单检查通过。MAS 构建号已递增为 2，正式 Universal 签名包已生成：`dist/app-store/Nodal-Studio-1.0.0-2.pkg`。版本、双架构、应用/安装包签名、沙盒权限、profile、隐私资源检查通过。详见 [Build 2 版本一致性记录](MAC_APP_STORE_VERSION_ACCEPTANCE.md)。未上传或送审；最终 Apple 分发体验与后台申报待验收项保留。

## Business 资料提交后的项目复核（修复前审查记录）

本轮只读检查 App Store Connect、公开支持/隐私页，审查 AI、购买、文件权限、查询及变更复核相关实现，运行全量自动化与两项临时复现测试。未修改产品代码、后台配置，未签约、上传、提交审核或发布。现有工作区改动保留。本节取代下方与当前事实冲突的状态；不代表所有真实环境均已验收。

### 新确认的代码问题

1. **P1：切换界面语言会自动重发已完成的 AI SQL 问题。** `QueryDraftPanel.tsx:134,152` 在提交后持续保留 `autoPrepare: true`；`DiscoveryAssistant.tsx:27` 的组件 key 包含带 `uiLocale` 的 input，语言变化使请求组件重新挂载，随后 `87–92` 的 effect 再次 prepare，`74–76` 的 directSend 再次运行。模拟测试：输入 `Show public.orders IDs`，生成完成后从英文切换中文，不再点击发送，`runDiscovery` 调用数仍从 1 变为 2。会导致额外外发、费用及结果替换。应将自动发送绑定为一次性提交动作；显示语言或语义更新只使旧任务失效，不自动重发。语义 binding 变化也存在相同重挂载机制，但本轮直接复现的是语言切换。
2. **P2：切换快照后旧的变更 AI 解释仍显示。** `AiAssistant.tsx:25–26,36–47` 的 result 未绑定输入版本，`InspectorPanel.tsx:262` 的旧 changeSet 助手也没有上下文 key。临时组件测试已确认：旧 snapshot 生成答案后，rerender 为新 snapshot，旧标题/解释依然可见；异步回调同样没有版本保护。应在快照/变更集/策略改变时清理答案并丢弃旧任务回调。

复现仅使用模拟服务，无真实 AI 请求或数据库访问。证据和测试源保存于 `target/full-audit-2026-10-25/`，临时测试已从正式测试目录移除；这两项是缺陷复现成功，不是修复后回归通过。

### Apple 后台最新事实与剩余事项

| 项目 | 本轮实际页面 |
| --- | --- |
| Business | Free Apps Agreement **Active**；两份美国税表均 **Active**。Paid Apps Agreement **Processing**，银行 **Processing**；提示银行更新约 24 小时内处理，此前 Pending User Info / Missing Tax Info 已过时。等待处理结束后检查协议 Active，不重复提交税表。 |
| 版本 | **1.0.0 (1)**，Ready for Review，1 个 Draft Submission，手动发布。尚非 Waiting for Review。本轮未点击最终提交。 |
| 构建一致性 | 后台仍选 Build 1；下方记录的 MAS 专用内置政策为后续源码修改，没有新上传证据。若要纳入这些修改及后续修复，应递增构建并重新选择，不能把当前源码测试视为上传包验证。 |
| 地区 | 价格表覆盖 175 个地区；实际发行设置为 **174 Available、1 Not Available（France）**。详情显示法国 Not Available，未显示原因；不能推断是 Apple 加密封锁或用户主动排除。本轮未更改地区。旧记录“包含法国、175 地区全部可售”不再适用。 |
| 隐私 | Published / Data Not Collected，政策 URL 已保存；公开英文政策正文正常加载，与当前 MAS 专用政策一致。仓库申报草稿仍缺最终适用性/数据流依据；尤其应记录用户自配 AI 服务与 Apple third-party partners 定义的适用判断，不能仅因 BYOK 或有远端调用就直接断定答案正确或错误。 |
| 加密 | App Information 未列已上传材料；当前代码使用 Rustls/ring。法国当前不在可售范围会改变法国材料的适用条件，但不自动解决其余出口分类问题。需保留最终问卷/分类依据；本轮未修改布尔声明或上传材料。 |
| 审核可体验性 | 备注和联系人齐全，无内置演示数据库，未给出可用测试资源，附件为空。仍需明确的测试环境/脱敏样例与逐步预期结果；录像可辅助。 |
| 商店截图 | 仍为 Archive v1 五张。本轮重新打开第 4 张，确认含 midigi_db、订单编号、user_id、金额等业务数据。无数据虚构/公开授权证明，建议以明确虚构数据重拍；不能据此断言已泄露真实个人数据。第 3 张素材版本与之前核对的本地最终素材不同，仍需统一。 |
| 其他 | 名称、分类、版本、关键词、版权、支持/营销网址已填写；教育批量购买优惠仍勾选。中文商店本地化、截图文字优化属于可改善项，不能直接判为送审硬阻塞。 |

### 自动化结果与边界

- 前端全量 **144 文件 / 948 测试通过**；ESLint、TypeScript、生产构建、`cargo fmt --all -- --check`、`git diff --check` 通过。
- Rust `cargo test --workspace --locked` **249 通过、6 忽略**。最初 17 项因沙盒禁止本地监听出现 PermissionDenied；允许本地回环模拟测试后全部通过。日志 `target/full-audit-2026-10-25/nodalstudio-full-audit-rust.log`。
- MAS feature：`cargo test -p nodalstudio-desktop --features mac-app-store --lib --locked` **99 通过、6 忽略**。包括当前主机 Swift 桥接编译；不是正式 Universal 分发包或 StoreKit 真购买验收。日志同目录 `nodalstudio-full-audit-mas.log`。
- 发布脚本 **12 测试通过**，MAS 隐私源资源检查通过；该脚本有意保留出口分类/申报待核实提示，不能把这个固定提示当作后台仍未发布隐私的证据。
- Vite 仍提示 IIFE 名称与大 chunk 警告，未导致构建失败；第三方许可 chunk 约 5 MB，属于可后续优化项。
- `/Applications/Nodal Studio.app` 当前不存在。本轮未运行 Apple 分发的最终候选包，未进行真实 DB/SSH/AI、恢复购买、离线重开、跨 Mac、Intel 实机及文件书签跨重启验收，也未发送支持邮箱测试邮件。不能用自动化通过替代这些证据。

建议顺序：修复两项已复现问题 → 准备可审核演示与明确虚构截图 → 闭环隐私/加密依据 → 整理可追溯候选源码并递增 Build → Apple 测试分发验收 → 等 Paid Apps Active 后复核送审条件。Production 首次购买/退款与后续更新验收仍在实际分发阶段进行。

官方依据：[协议状态](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements/)、[隐私收集与合作方定义](https://developer.apple.com/app-store/app-privacy-details/)、[完整审核材料](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review/)。本轮官方加密参考页抓取超时，加密结论限于后台字段、代码事实和待确认事项，未作法律分类结论。

---

## 晚间最新复核（本节取代下方早期状态结论）

结论：**页面资料大部分齐全，已有审核草稿，但尚不具备“全面确认后可送审”的证据条件。未点击 Submit for Review，未提交税表，也未发布新构建。**

本次依据实际 App Store Connect 页面、逐张打开的五张商店截图、公开官网及当前本地源码检查。用户要求仅检查；随后单独授权清理用户可见的 GitHub 信息。没有修改价格、销售范围、税务选择或加密声明。

### 当前后台事实

| 项目 | 最新核查 |
| --- | --- |
| 版本和审核 | 1.0.0 / Build 1；Ready for Review；一个 Draft Submission。前一轮点击 Add for Review 仅加入草稿，不是正式送审；最终 Submit for Review 未点击。Ready for Review 不是审核通过，也不证明商业协议或实机体验全部完成。 |
| 构建身份 | Build Metadata = Validated；com.claycosmos.nodalstudio；Team V49J3X8K3S；macOS 13.0；x86_64 / arm64；上传时间 2026-10-25 19:11（GMT+8）。 |
| 构建权限 | App Sandbox、network.client、用户选择文件读写、app-scope bookmarks 均存在；未看到 network.server 或宽泛文件访问例外。 |
| 隐私 | 已 Published，Data Not Collected；政策 URL 已保存。此项不再是“未发布草稿”。回答仍须与最终包的数据流一致。 |
| 分类与基础字段 | Nodal Studio；副标题 Visualize your app’s database；Developer Tools；主语言 English (U.S.)；4+（地区例外）；标准 EULA；SKU nodal-studio。 |
| 价格与发行 | 美国 US$19.99、175 个可售地区（包含中国大陆和法国）；公开分发；App Store software 税类；手动发布。教育批量购买优惠已开启，属于需运营确认的选择，不是缺失字段。 |
| 协议与收款 | Free Apps Active；Paid Apps Pending User Info；银行 Processing；第一份外国受益所有人声明 Active；W-8BEN-E Missing Tax Info。税表依用户要求未提交。 |
| 官网 | 浏览器实际打开英文首页、支持页、完整隐私政策，支持页中英文切换正常；未出现 TLS 警告。官网主价、最低系统、外部 AI 费用及 Apple 购买恢复说明与送审文案一致。站点此前已移除公开仓库链接。搜索工具不能访问该站点，不能将其抓取失败误报为官网不可用。 |

### 尚需处理：按影响排序

1. **商业协议条件未完成。** Apple 文档要求 Paid Apps Agreement 为 Active 才能提交或更新付费应用；当前页面仍为 Pending User Info。加入审核草稿成功不推翻这一条件。本轮没有点击最终按钮去试探是否拒绝，更没有把草稿当成已经送审。账户问题与下面的 App 内容检查分开处理。
2. **加密依据未闭环。** 上传 Build 1 的 App Uses Non-Exempt Encryption = No；App Information 没有已列出的加密材料，只有 Upload 入口。当前源码使用 Rustls/ring，Info.appstore.plist 为空。需要核实最终包的适用分类/豁免及法国分发要求并记录依据；不能把使用标准 TLS 直接等同“没有加密”，也不能仅凭源码就断言 No 一定错误。不要虚填材料或擅自移除法国。
3. **审核体验材料不足。** 备注没有逐步点击路径、可用脱敏测试环境/样例或操作录像，附件为空；目前主要要求审核员自行准备 PostgreSQL/MySQL 和可选 AI。无自有登录不要求凭空创建 Nodal 账号；但核心功能依赖外部数据库，需让审核员能够实际复现，并说明选用什么权限、预期看到什么。录像可辅助，不能当然替代访问完整功能。
4. **截图需完成素材与数据核对。** 五张均为应用运行界面，可以附文字装饰；未见订阅、自动执行 SQL、站外购买等误导。实际上传仍是 Screenshot Archive v1：第三张展示历史模型整窗，与本地最新两块放大视图不同。旧图本身不自动违规，但应选定最终素材并核对 Build 1/下一构建能真实呈现。第四张显示 midigi_db 的订单编号、user_id 和金额，尚无证据证明全部为虚构或已获公开授权；建议用明确虚构的演示数据重拍。不要将“未证明脱敏”直接定性为已泄露真实个人信息。
5. **最终 Apple 分发包验证仍缺证据。** 本轮 /Applications/Nodal Studio.app 不存在，没有运行最终 TestFlight 1.0.0(1) 完整流程。历史原生沙盒、SSH/Git 与本地购买策略测试各自有价值，但不能替代此包的首次授权、恢复、离线重开、连接、AI 同意/取消/发送和文件书签复用验收。Production 首次付费与退款等只能在实际分发阶段验证，不将其错误列成首次送审前必然能完成的测试。

### 文案与内容逐项结论

| 内容 | 结论与建议 |
| --- | --- |
| 名称、副标题、分类 | 字段完整、长度通过；副标题能准确表达数据库可视化。保留即可。 |
| Promotional Text | 清晰列出 PostgreSQL/MySQL、模型、变更复核和可选 AI；无“完全离线”“无限制”等无依据承诺。可保留。 |
| 描述开头 | “AI helps you build your app”过于泛化，且官网已采用直接的数据库定位。这是编辑建议，不是明确审核违规。建议改为下面的产品直述开头。 |
| 描述正文 | 对只读查询、不会编辑结构/执行迁移、AI 草稿不会自动执行、用户自备连接/Key、第三方费用和上下文发送均作了说明。未发现明显的订阅/永久免费/替代付费通道承诺。 |
| 描述细节 | Current change review、explicitly complete the round、confirmed semantics 对普通购买者过于内部化；建议将操作状态压缩为可理解的收益，将精确流程留在审核备注。 |
| 关键词 | 92 字符，界面剩余 8；与功能相关。未发现竞争产品名、价格或无关热词。 |
| 第一张截图 | “AI-built app”容易使人误以为只适合 AI 生成项目；与“手工及 AI 项目均支持”的描述有定位差异。建议改为 “Explore your database structure.”，不是强制改文案。 |
| 第二张截图 | “1 structural changes”为应用内英文单复数瑕疵，建议下一构建修正后重拍；属于质量问题，不凭此宣判拒审。 |
| 第三张截图 | 当前整窗字段细节偏小，建议采用本地最新放大图；没有编造新功能的必要。 |
| 第四、五张截图 | 第四张明确要求自配 AI；第五张确有查询图表。应保持数据为可公开的虚构示例，并避免将选中分类的数值当成订单总数。 |
| 审核备注 | 产品范围说明基本准确；Git 文件交换与 GitHub 平台不同，Git 功能名保留。应补真实的体验步骤和资源位置。 |
| 运营主体/版权 | 后台展示及官网仍为 Clay & Cosmos (Tianjin) Technology Co., Ltd.，税表实体已为 Tianjin Clay and Cosmos Technology Co., Ltd.；应核实 Apple 法人名称更新是否生效后统一对外口径，不能仅凭展示名不同就推断主体不同。 |
| Content Rights | 当前为“不包含、显示或访问第三方内容”，这是用户此前确认的答案。本轮未擅改；数据库及 AI 外部服务按用户授权使用的范围应与该声明及 Apple 实际定义共同核实，不把通用数据库客户端自动等同内容聚合服务。 |
| 英文/中文 | 商店仅英文不是自动送审阻塞；中文官网存在，中文商店本地化可作为后续完善。Build 元数据仅列 English，不以此断言应用 UI 不支持中文。 |

### 可供审核的文案修改草稿（未写入后台）

建议描述开头：

> Nodal Studio is a PostgreSQL and MySQL client for macOS. Explore tables and relationships, compare schema snapshots, keep notes alongside your model, and run read-only SQL queries. Optional AI assistance helps turn questions into SQL drafts that you review before execution.

建议用来替换内部状态长段的简明变更说明：

> Compare schema snapshots to see which tables, columns, and relationships changed. Review affected notes, update descriptions, and keep a record of your decisions.

审核步骤应按实际最终包验证后补齐：打开 Add → 连接明确的脱敏 PostgreSQL/MySQL → 浏览关系和字段 → 保存说明 → 刷新并比较两次结构快照 → 生成并检查 SQL 草稿 → 手动运行只读查询 → 查看结果/图表 → 使用系统选择器导出。不能把尚未提供的测试连接或录像写成已经附上。

### 用户要求的 GitHub 信息清理

- App Store Connect 审核备注已保存：“does not use a GitHub updater”替换为“App updates are managed by the Mac App Store.”。描述、推广语、关键词和已查截图未发现 GitHub 链接；没有提交审核。
- 新增 `docs/legal/PRIVACY.mas.en.txt` 与 `PRIVACY.mas.zh-CN.txt`，与官网现行 MAS 政策一致。`PrivacyPolicy.tsx` 按发行渠道选择正文，MAS 用户不再看到社区发行/更新平台文案。
- 支持和隐私联系统一为 support@nodalos.com；社区版政策中的公开 Issues 联系方式也已移除。社区版真实更新服务的数据流披露仍保留，避免对现有社区行为作不实隐私声明。
- 官网 `nodalos/apps/studio-web` 的公开源码及实际页面本来就没有 GitHub 入口，本轮无需改站点或触发部署。
- Git 功能、Git 仓库/CI 配置、内部证据与第三方许可证必要来源信息保留，不删除合规归属信息。
- **已上传 Build 1 不会随源码更新。** 要让内置政策修改进入送审包，应上传递增构建（例如 1.0.0 / Build 2），重新选择构建并验证；本轮没有打包或上传。

### 本轮验证与限制

- 前端完整回归：144 文件、948 测试通过（包含双语 MAS 隐私正文无社区链接、社区政策仍披露真实服务的渠道回归）。
- TypeScript、定向 ESLint、前端生产构建、diff 空白检查通过。构建仍提示既有 IIFE 名称及大 chunk 警告，没有将这些警告称为测试失败。
- 当前工作区存在大量既有实现改动。本轮只修改上述政策、选择组件、专项回归和审核指南；没有提交/推送或清理其他文件。
- 本轮未运行最终 TestFlight 构建、未验证支持邮箱实际收件、未证明截图业务行来源。不会把网页可点击、自动测试或 Apple Validated 当作运行和法律合规的完整证明。
- 网站路径按用户后续要求统一为 `/Users/ziy/Code/ClayCosmos/nodalos/apps/studio-web`。同级旧目录曾在首轮查询存在，但执行重命名前已消失，重命名未执行；没有重建/覆盖目录或推断其被移动到哪里。发布文档已移除旧名称和“保留副本”的过时断言；CI 路径原本已为 apps/studio-web。未提交、推送或部署。

### 本次官方依据

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)：完整可审核体验、准确截图与文案、虚构账户信息、隐私政策及外部 AI 数据发送同意。
- [Encryption documentation](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption/)：按算法来源与法国分发核实材料。
- [Sign and update agreements](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements/)：付费协议 Active 条件。

---

## 以下为当日较早检查存档，部分状态已经变化

结论：**目前不建议直接提交，不能标记为全部满足提交条件。** 本次只读核查后台及源码、验证公开链接；未发布隐私申报、未提交审核、未接受协议、未更改销售范围、未替换截图或修改应用代码。

## 已确认

| 项目 | 实际证据与状态 |
| --- | --- |
| 应用身份 | Apple ID 6791674692；Bundle ID com.claycosmos.nodalstudio；SKU nodal-studio；Developer Tools；年龄分级 4+（含地区差异） |
| 版本页 | 1.0.0，Prepare for Submission；选择 Build 1；英文描述、推广语、关键词、版权、审核联系人及备注均已填写；手动发布 |
| 构建 | Apple Build Metadata 为 Validated；1.0.0 / 1；macOS 13.0；x86_64、arm64；沙盒、网络客户端、用户选定文件读写、书签权限存在 |
| 官网链接 | 官网、英文支持页、英文隐私页及中文政策文本重新请求全部 200；正常 TLS 校验成功，证书覆盖 studio.nodalos.com，有效至 2027-01-23 |
| 商店网址 | Support URL 和 Marketing URL 已保存；Privacy Policy URL 已保存为 https://studio.nodalos.com/privacy/?lang=en |
| 价格与地区 | 最近后台核查为美国区 US$19.99，175 个地区；不是订阅。当地价格由商店价格表决定 |
| 身份合规 | Business 中 DSA 与 Chinese Law 状态 Active；App Information 标示 trader；不等于所有地区的全部产品要求已审结 |
| 隐私草稿 | Data Not Collected 已保存，Publish 仍可用；依用户明确要求保持未发布。用户确认没有自营/合作后台接收数据，数据库和 AI 均用户自选直连 |
| 截图 | 后台 5 张截图逐张查看，均包含原生应用界面；与本地最新导出存在版本差异，见下文 |

## 必须处理或核实的事项

### 1. 明确阻断：Apple Developer Program 协议更新未接受

Business 页面直接显示：Apple Developer Program License Agreement 已更新，Account Holder 必须先登录账户接受更新，才能更新现有应用或提交新应用。Free Apps Agreement 显示 Active (New Agreement Available)。本次没有代为接受。

### 2. 付费销售准备尚不能确认

Business 的 Agreements 表目前只看到 Free Apps Agreement，未列出 Paid Apps Agreement。没有取得银行/税务资料完成且有效的证据。不能由 US$19.99 价格已保存推导付费协议已生效，也不能把“未显示”直接写成“确认从未签署”。应在账户持有人处理协议更新后，复核付费协议及适用税务/银行资料。

### 3. 隐私申报有草稿，尚未发布

用户要求先保留草稿，因此这是有意保留的送审前步骤。发布前应最终确认回答与实际版本及适用合作方一致；用户自行配置的外部服务不等于开发者接收数据，也不等于这些服务完全没有留存。本轮没有点击最终 Publish。

### 4. 加密声明及法国分发依据未闭环

上传 Build 1 的 Apple 元数据显示 App Uses Non-Exempt Encryption = No。当前 Cargo.toml 中 reqwest 使用 rustls-tls-native-roots，SQLx 使用 tls-rustls-ring-native-roots，不能说所有加密均由 Apple 操作系统提供。仓库现有出口问卷草稿仍将分类、材料及法国问题列为待确认；当前源码 Info.appstore.plist 为空字典。

No 是“非豁免加密”字段，不能据此断言应用完全不使用加密，也不能单凭这条就断言申报错误。需要记录适用分类/豁免依据，并核对法国分发对应文件要求。当前全球销售范围包含法国。不得为绕过问题擅自排除法国、虚填材料或改变构建声明。

## 送审风险与一致性问题

- **截图版本不一致**：后台文件名为 Screenshot Archive v1；实际第 3 张仍为绿色底、历史模型整窗。本地 artifacts/app-store-product-page/en-US/03-field-context.png 已是浅色底、同一检查器的两块放大视图。至少该图可明确证明后台不是当前最终素材。应统一选定素材，并与提交的 Build 1 能力对照。第 4 张含 midigi_db 订单结果及用户标识列，须确认展示数据均可公开/已脱敏；本轮未取得其数据来源证明，不断言存在真实用户数据泄露。
- **内置政策与官网不一致**：PrivacyPolicy.tsx 直接导入 docs/legal/PRIVACY.en.txt 和 PRIVACY.zh-CN.txt；这些正文仍使用 ClayCosmos / GitHub Issues 联系方式。官网已使用法定公司全称及 support@nodalos.com，且明确限定 MAS 版。建议同步内置政策。源码修改不会改变已上传 Build 1，如需要更新二进制，应递增 Build 重新构建上传。
- **审核体验资料不足**：审核备注说明数据库/AI 用户自配、无内置演示库，附件为空；尚无证据表明审核员可依据当前材料独立体验结构比较、变化复核及 AI 全流程。应用无自有账号，不能因此强行要求 Nodal 登录账号；但仍应提供足够的配置/复现说明，可用测试连接、脱敏样例或适当录像辅助。具体材料依功能需要决定。
- **地区及其他业务选择**：ICP 字段未设置，是否适用于本款 macOS 工具应按实际分发及 Apple 要求确认，不能仅凭字段存在就判定强制；当前后台没有显示 ICP 错误。教育批量购买优惠开关最近核查为开启，应确认是否符合首发定价意图。中文商店本地化尚未新增，不等于无法提交英文主语言版本。

## 本次核查边界

没有重新运行最终 TestFlight 构建的数据库、SSH、AI、购买恢复、离线和 Intel 实机回归。当前工作区有大量既存改动，源码状态与 Apple 上传 Build 1 的一一对应尚未重新建立；保留了这些改动。Apple 的 Validated 只证明构建处理状态，不代表 App Review 接受或全部运行场景已验证。支持邮箱在页面存在，但本轮未发送测试邮件验证收件。

## 建议完成顺序

1. Account Holder 处理 Developer Program 协议更新，然后核实 Paid Apps Agreement、银行和税务状态。
2. 核对加密分类与法国分发材料；明确选定最终构建和截图版本。
3. 同步内置/官网政策和联系方式；必要时递增 Build、补做最终候选包回归。
4. 完善审核复现说明，确认截图中的数据可公开。
5. 所有证据闭环后，由用户授权发布隐私申报，再单独授权提交审核。

## 官方依据

- [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)：申报数据收集与合作方范围。
- [Export compliance documentation for encryption](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption/)：非系统标准加密及法国文件要求。
- [Provide information for a complete review](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review)：审核所需信息、账号适用条件和外部服务说明。
- [Overview of receiving payments](https://developer.apple.com/help/app-store-connect/getting-paid/overview-of-receiving-payments/)：付费协议及收款条件。
- [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/)：地区资料及 ICP 的适用范围。
