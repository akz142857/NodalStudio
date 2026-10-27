# Mac App Store 剩余送审清单

首次 MAS 送审版本：**1.0.0（Build 1）**。后续重复上传须递增 Build；社区版与内部 Cargo/npm 包仍为 0.2.4。详见 [版本一致性记录](MAC_APP_STORE_VERSION_ACCEPTANCE.md)。

更新时间：2026-10-25。首版为付费下载，不是免费应用内购 Pro；不增加账号或许可证服务器。当前不提交 Git、不上传、不送审、不发布。

已完成的主要实现和证据见 [整改记录](MAC_APP_STORE_REMEDIATION_ACCEPTANCE.md)、[最终沙盒验收](MAC_APP_STORE_SANDBOX_COMPATIBILITY_ACCEPTANCE.md)。本清单中的后台事项为待核实，不代表账户持有人尚未准备。

## P0：身份、正式包与 Apple 测试链路

- [ ] 用户：确认 App Store Connect 应用 Apple ID、Bundle ID、Team ID、SKU 和付费下载模式。
- [ ] 用户：在本机配置匹配的 provisioning profile、应用分发证书和安装包分发证书（均含私钥），填写忽略的 `config/macos-appstore.env`。参考 `config/macos-appstore.env.example`。
- [ ] 用户：确认 Developer 会员、Paid Apps Agreement、税务及银行资料满足付费销售条件。
- [ ] 开发：生成正式身份/profile 的 Universal MAS 候选包；核对版本/build number、签名、资源、沙盒权限和最低系统。
- [ ] 双方：通过 Apple 测试分发取得有效 AppTransaction，验证授权/恢复/离线重启；不使用假购买开关。

## P1：首次送审前必须完成，可并行准备

- [ ] 用户确认运营主体、联系邮箱及政策内容；准备公开可访问的 HTTPS 隐私政策与支持 URL。本次不部署。
- [x] 开发完成当前源码/Apple Silicon 调试包的 Privacy Manifest、required-reason API 和 SDK 核查与修复，见 [核查记录](MAC_APP_STORE_PRIVACY_EXPORT_AUDIT.md)。
- [ ] 正式 Universal 包重验隐私资源；实际 Apple 校验复核 SQLite 文件系统 API 用途及 ring 衍生 SDK 元数据关联。当前本机校验不替代后台判断。
- [x] 准备 [App Privacy 可填写草稿](MAC_APP_STORE_APP_PRIVACY_DRAFT.md) 与 [加密出口问卷草稿](MAC_APP_STORE_ENCRYPTION_QUESTIONNAIRE_DRAFT.md)，区分代码事实、条件建议和用户确认项。
- [ ] 双方确认 App Privacy 申报：按草稿补齐运营主体、政策 URL、AI 服务商留存/账户关联及用途证据；不能因为本地优先就直接申报“不收集”。
- [x] 开发提供 TLS/SSH/加密库证据，移除没有分类依据的固定出口豁免声明，见核查记录。
- [ ] 用户据实际实现完成 Apple 加密出口问卷及适用材料；先确认销售地区是否包含法国。不能只凭 Info.plist 布尔值判定完成。
- [ ] 最低 macOS 13、完整 Intel/Apple Silicon、干净 Mac 和正式商店候选包全流程回归；当前独立沙盒测试不替代这些。
- [x] 整理 [中英文名称、副标题、描述与关键词草稿](MAC_APP_STORE_LISTING_DRAFT.md)，核对字段长度；未填写商店后台。
- [ ] 确认商店名称可用性、分类、年龄分级、版权、价格、销售地区和适用经营者信息，复核文案与最终包一致。
- [ ] 真实 MAS 截图；不要展示首版已移除的云协作或 GitHub 更新入口。
- [ ] 脱敏示例模型、两版结构变化样例、只读测试数据库及审核步骤；不使用生产凭据。
- [x] 整理 [中英文审核备注与演示步骤草稿](MAC_APP_STORE_REVIEW_GUIDE_DRAFT.md)，区分现有功能与待交付演示环境。
- [ ] 补齐审核联系人、备注占位符、实际附件和可独立体验的演示环境，并在最终候选包验证；当前草稿不表示环境就绪。
- [ ] 用户后续授权后冻结候选版本，整理/提交改动并执行正式打包；当前脚本默认要求干净 Git 工作区，不应为绕过要求修改用户工作。

## 购买验收材料：用户准备

| 材料 | 用途 |
| --- | --- |
| 应用 Apple ID、Bundle ID、Team ID、后台状态 | 身份一致性核对 |
| 本机 profile 文件路径、完整签名身份 | 正式 MAS 包构建 |
| 售价、地区、付费协议状态 | 付费下载设置 |
| 测试人员、TestFlight 资格及适用 Sandbox 测试账户 | Apple 测试分发与授权；Production 另用真实商店账户 |
| 两台 Mac，可断网、退出和重启 | 合法授权、同账户换机、无资格账户复制测试 |
| 脱敏 PostgreSQL/MySQL、SSH 端点和可信 known_hosts | 受保护功能的实际验证 |
| 后续上传方式：Transporter 或本机 API Key | Transporter 不要求额外提供 API Key |

不在聊天中发送 Apple 密码、验证码、私钥、证书密码或 `.p8` 内容。用户在本机完成登录和资料配置。

## 真实购买测试分阶段，不与本机沙盒混淆

首次送审前（Apple 测试环境）：

- [ ] 有效 Apple 测试凭据授权成功，身份/设备核验正常。
- [ ] 恢复成功、取消、网络失败；不覆盖已有有效状态。
- [ ] 断网后退出/重开应用及重启 Mac，仍能执行受保护操作；当前依赖 StoreKit 本地材料，失败需修复实现或调整承诺。
- [ ] 跨设备测试资格边界及正式候选包的完整沙盒集成。

首发实际分发后（Production）：

- [ ] 真实付费下载、Production 授权、同账户重新下载/换机。
- [ ] 无资格账户复制应用/可复制缓存不能解锁；保留用户业务数据。
- [ ] 适用家庭共享、退款/撤销及离线无法实时得知撤销的边界。
- [ ] 后续实际版本的 App Store 更新链路。

TestFlight/Sandbox 成功不等于真实付费成功。Production 购买和后续更新不能虚列为首次送审前全部完成。以后获准送审可选择手动发布，将审核与上线分开。

## 官方参考（2026-10-25 核对）

- [付费收款准备](https://developer.apple.com/help/app-store-connect/getting-paid/overview-of-receiving-payments)
- [App Privacy](https://developer.apple.com/app-store/app-privacy-details/)
- [加密出口](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)
- [审核材料](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review)
- [截图规格](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [手动发布](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/)
