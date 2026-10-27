# MAS Privacy Manifest、API 与加密出口核查

日期：2026-10-25。范围：纯 macOS Tauri 应用、当前锁定依赖及本机 Apple Silicon 构建。未访问 App Store Connect，未上传、提交或发布；不是 Apple 审核通过证明。送审总表见 [送审清单](MAC_APP_STORE_SUBMISSION_CHECKLIST.md)。

后续填写材料已整理为 [App Privacy 草稿](MAC_APP_STORE_APP_PRIVACY_DRAFT.md) 和 [加密出口问卷草稿](MAC_APP_STORE_ENCRYPTION_QUESTIONNAIRE_DRAFT.md)。草稿完成不表示待确认的服务商实践或出口分类已经通过。

## 结论及已修复项

1. 已增加应用 `PrivacyInfo.xcprivacy`，按已核实用途记录文件元数据、应用内计时和本应用 UserDefaults；MAS 配置把它放入 `Contents/Resources/`，构建后检查实际位置与内容。
2. `ring 0.17.14` 上游 README 明确说明含 BoringSSL/OpenSSL 来源代码。不能仅凭 Cargo 包名与 Apple 清单不匹配就认定没有相关 SDK。新增独立 `RingPrivacy.bundle`，记录本应用维护者审查过的 crypto-only 实践；不是冒充上游发行的 manifest，也不是 Apple 对“重新打包 SDK”解释的确认。它由源码构建，不是下载的预编译 BoringSSL framework。
3. 删除没有完成分类依据的 `ITSAppUsesNonExemptEncryption=false`，取消打包脚本强制该值为 false 的逻辑。现在保留该键缺省，让 Apple 后台要求加密问卷；未擅自改成 true，也没有编造出口批准码。后续确定分类时，需同步修改本审查记录及校验规则。
4. 新增离线校验脚本和回归测试：阻止隐私资源漏包/旧内容、漏类别/重复类别、未经用途审查的理由、ring 版本漂移、未审查的全应用“不收集”声明及加密豁免声明。

## 平台范围：避免套用 iOS 结论

Apple 当前 required-reason API 总览正文列举 iOS/iPadOS/tvOS/visionOS/watchOS，没有在该句列纯 macOS；相应 plist 键的 API 元数据又包含 macOS 支持。此处保守携带真实用途声明，但不宣称“所有纯 macOS 应用缺该文件必定拒审”。第三方 SDK 清单要求单独评估，不能用前述平台差异一概豁免。后续若增加 Catalyst/iOS，必须重新评估，不复用本结论。[Apple API 总览](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)、[SDK 要求](https://developer.apple.com/support/third-party-SDK-requirements/)

## API 用途与证据

| 类别 | 代码/构建证据 | 本轮处理 |
| --- | --- | --- |
| FileTimestamp | Rust `std::fs::metadata`/`symlink_metadata`；备份和模型导入大小校验、Git 授权目录检查；SQLite/运行时文件访问；二进制 stat/fstat/lstat 导入 | C617.1：容器内文件；3B52.1：用户明确授权的文件/目录。不声明 DDA9.1，因为这里不是显示文件时间 |
| SystemBootTime | Rust Instant/Tokio 超时、查询耗时、购买检查限频，Swift Dispatch 计时；本机导入 clock_gettime/dispatch_time。符号名称并不全部等同 Apple 列表 | 35F9.1，按应用内计时用途保守记录；不传原始启动时间进行指纹识别 |
| UserDefaults | `crates/storekit-bridge/native/FileAccess.swift`，`NodalSecurityScopedBookmarksV1`，本应用偏好内保存目录/文件书签；二进制 NSUserDefaults | CA92.1，无 App Group、MDM 或其他应用的偏好共享 |
| DiskSpace 候选 | SQLite `unixOpen` 中 fstatfs 读取文件系统类型，locking finder 中 statfs 判断只读/锁行为；二进制确有导入 | **不机械填写 E174.1**：实际不是根据剩余容量改变行为。记录为已追溯、需保留平台/上传反馈复核的项；不为迎合表单改写 SQLite 锁实现 |
| ActiveKeyboards | 本轮应用代码及目标导入未发现相关用途 | 不添加理由；静态扫描不构成“绝无动态调用”的证明 |

理由代码以 Apple 文档对应定义为依据，未从第三方样例照抄。`E174.1` 不等于“只要看到 statfs 都能填”。MAS 禁用的 GitHub updater 中 `/bin/df` 空间检查不是本轮 MAS 可达功能，也不能用它为 SQLite 的不同用途背书。[类别与理由](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)

本机 `nm -u` 与源码交叉核对仅覆盖当前产物；未来正式 Universal 包仍要再扫，特别是新 SDK、动态库、系统版本分支。`check_mas_compliance.py --report` 输出的是“候选导入及人工审查边界”，不是自动认证。

## SDK 边界与 ring 元数据

- 当前 macOS 正常依赖中存在 Rustls 0.23.41、ring 0.17.14、SQLite、Tauri/Wry/Tao、Security.framework 等；没有直接名为 OpenSSL/BoringSSL 的运行依赖，不代表没有其衍生代码。
- ring 的当前源码未发现本表相关文件系统/NSUserDefaults/启动时间 API；其职责是密码学运算、验证与随机数获取，没有自身网络上报或用户数据持久化。因此其专用 manifest 使用空 collection/API 数组和 tracking=false。这一声明只针对 ring，不代表整个应用。
- 资源包位于 `apps/desktop/src-tauri/privacy/RingPrivacy.bundle`，版本与 Cargo.lock 绑定；版本升级导致校验失败，必须重审。
- Apple 对此类源码衍生关系、资源关联方式的最终判断仍以实际上传校验/反馈为准。不能把新增的维护者资源包称为上游签名 SDK 或上游已认证 manifest。

## 数据流与 App Privacy：没有自动填“不收集”

| 数据流 | 当前实现边界 | 尚需完成的申报工作 |
| --- | --- | --- |
| 模型、快照、标注、查询历史 | 本地 SQLite/用户明确导出文件 | 与实际政策描述一致 |
| 数据库连接 | 用户配置的数据库/SSH 端点；凭据本机钥匙串 | 不将开发者收集与用户连接自己的服务混为一谈 |
| AI 请求 | 用户预览确认后发送结构信息、问题及可选注释到用户配置的 provider；API 凭据用于该 provider 认证 | provider 是否留存、关联账户及适用披露需逐项确认；BYOK 不自动等于无需申报 |
| StoreKit | Apple 授权验证；本机设备摘要校验，不把原始证明/设备标识导出到项目 | 区分 Apple 平台处理与开发者收集 |
| 云协作/遥测/GitHub 更新 | 首版 MAS 无云账号入口、无诊断上传服务、无 GitHub updater | 与最终商店包保持一致 |

应用 manifest 有意不写 `NSPrivacyCollectedDataTypes=[]`，避免将未完成的 AI 数据流判断包装成全应用不收集声明。这个省略不是合规豁免，也不替代后台 App Privacy 填写。公开政策、主体/联系渠道及 provider 披露仍在送审清单中。[App Privacy](https://developer.apple.com/app-store/app-privacy-details/)

## 加密清点与待确认分类

| 能力 | 实现 | 核查结果 |
| --- | --- | --- |
| HTTPS / 数据库 TLS | reqwest、SQLx → Rustls/ring；Cargo.toml 启用 rustls 特性 | 标准协议的非系统实现，不能说只有 NSURLSession/系统加密 |
| SSH | 系统 `/usr/bin/ssh`，严格主机验证 | OS 提供的 SSH 客户端；不等于整个应用都只有 OS 加密 |
| 凭据存储 | Keychain / Security.framework | 系统安全存储 |
| 结构指纹/授权设备摘要 | SHA-2 等哈希；StoreKit 验证 | 哈希/授权用途需与传输加密分开列明，不自动据此分类为非豁免 |

本轮没有发现自定义未公开加密算法的应用实现，但不以此推出“无需任何出口材料”。后台问卷须如实说明标准算法/协议、第三方非系统实现、用途与销售地区；是否豁免、是否需文档及相关报告义务，仍需账户主体按实际条件确认。移除布尔值是纠正未经确认的默认声明，不是认定一定非豁免。[Apple 出口总览](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)、[Info.plist 键说明](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)

## 本机验证

- `python3 Scripts/test_mas_compliance.py`：6 项回归通过。
- `python3 Scripts/check_mas_compliance.py`：源配置/声明/锁定 SDK 版本通过；明确输出剩余申报事项。
- `bash -n Scripts/build_macos_appstore.sh`：通过。
- 现有许可证回归 `python3 Scripts/test_third_party_notices.py`：4 项通过；plist 语法检查、`git diff --check` 通过。
- 实际 Tauri 构建通过：前端 TypeScript/Vite 构建、Rust `mac-app-store` 调试构建、macOS app bundler。独立标识的 `Nodal Compliance Acceptance.app` 使用 `--no-sign`，仅移除 profile 映射，不是正式签名包；未启动或替换已安装应用。
- 对实际 `.app` 运行 `check_mas_compliance.py --app … --report …` 通过：应用 manifest、ring 资源包及说明文件位置/内容全部一致，打包后的 Info.plist 没有预设出口分类。第一次检查发现新增 README 尚未进入先前构建的包，重新由 Tauri 打包后通过，未手动补包。
- 本机证据：`target/mas-compliance/bundle-build.log`、`binary-report.json`、`tauri.acceptance.conf.json`（均为忽略的验收产物）；主二进制 SHA-256：`c46cf2a2c0f852e1e1da5ca77da0ec47c604f381091332cc1f925195b109ea58`。
- 本轮是声明、打包与静态用途核查，未重复原生交互或真实购买验收；正式 Universal/签名包与 Apple 校验仍待完成。

本轮不改变购买、查询或 SSH 实现，不需要重新模拟购买状态。签名/profile/Apple 购买材料继续由用户准备，相关验收继续单列。
