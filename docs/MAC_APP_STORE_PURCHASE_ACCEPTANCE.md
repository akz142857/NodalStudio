# Mac App Store 购买授权实现与验收

日期：2026-10-25。**代码已实现；本机无购买凭据的原生流程已检查；真实购买、离线重启和跨设备验收尚未完成。未提交、未上传、未发布。**

设计依据：[购买授权与版本方案](plans/MAC_APP_STORE_PURCHASE_AND_EDITION_PLAN.md)。本轮实现的是付费下载 MAS 应用的购买授权，不是免费应用内购 Pro。未变更许可证、仓库可见性、GitHub 免费版能力或已有发布资产。

## 实现范围

- MAS 构建配置和脚本启用 `mac-app-store` feature，最低 macOS 13；Community 不启用此 feature。
- `crates/storekit-bridge` 为独立的 Swift／Rust 进程内桥接。桌面和原有 workspace crate 仍禁止 unsafe；桥接 crate 只在 C ABI 字符串分配／复制／释放边界使用有说明的 unsafe，不启动外部授权 helper。
- `AppTransaction.shared` 负责日常读取 Apple 验证结果；只由购买面板的明确点击调用 `AppTransaction.refresh()`。无自建账号、许可证服务、序列号或激活文件。
- 核对编译进应用的 bundle identity、实际 Bundle 身份、Apple 已验证交易身份、环境与官方设备 SHA-384 验证值。Xcode／未知环境不授予权限；Apple Sandbox 使用 Apple 已验证交易中的环境信息，并在界面标明仅测试。2026-10-25 整改已移除收据文件名判断，仍核对应用身份及设备证明。
- 对已验证 payload 中的 `appRevocationDate` 拒绝授权。这是本机新 SDK 可见的 Apple 字段；此前方案中“不直接套用 IAP revocationDate”仍成立，不能将 IAP 属性与 AppTransaction 混为一谈。
- 原生命令入口统一控制 MAS 权限。新命令默认需要购买，已有数据查看、备份／导出、取消操作、设置与购买恢复明确保留；没有购买时不删除业务数据。当前付费构建保护操作的范围不等于已决定未来 Community／Pro 的商业能力划分。
- 恢复请求串行去重；Swift 在后台执行，普通读取 20 秒、交互恢复 120 秒超时；后台检查按单调时钟限频至五分钟，显式恢复不受此间隔限制。超时后的 Swift 任务取消且不回写原生状态，内存所有权不依赖 Rust 栈。
- 网络／认证取消／超时不覆盖当前进程中已有的有效凭据；明确验证失败撤销权限。界面轮询只读取状态，不调用 Apple 认证；过时的轮询不能覆盖恢复结果。
- MAS 不注册 updater 插件，删除继承 feed 配置，屏蔽启动自动检查、GitHub 按钮、自动检查开关和自定义源；原生入口也拒绝检查／下载／安装／打开 GitHub 更新。`get_update_status` 返回 App Store 管理且所有站外更新能力关闭。
- 提供“打开 App Store”固定系统链接；前端不能传入任意 URL。

## 离线使用的实际边界

没有应用自行定义的联网续期、七天／三十天倒计时或持久化 `isPro` 开关。每次进程启动由 StoreKit 取得并验证 Apple 本地材料；本机合法材料可用时，网络失败不制造人为过期。

**没有实现独立 receipt/JWS 本地验签备用引擎。** 当前选用方案的第一路线，即 StoreKit 管理的本地凭据。Apple API 在缺少材料或认证状态不满足时可能要求联网，因此“购买后断网并重启”必须使用真实分发包实测，不能从状态机测试推定通过。若该实测失败，必须补充经过完整签名、身份与设备验证的 Apple 本地凭据路线，或调整承诺；禁止用历史成功布尔值兜底。

纯离线不能实时获得退款／撤销结果。新设备或系统购买材料丢失时需要 Apple 联网恢复。应用不保存 Apple 密码、原始 JWS、receipt 或设备标识到项目数据和界面，不上传数据库信息用于授权。

## 测试与本机证据

构建日志、截图及可执行测试位于忽略目录 `target/mas-purchase-acceptance/`，不进入 Git。

| 层级 | 结果与证据 |
| --- | --- |
| 全量前端 | 142 个文件、927 项通过：`frontend-all.log` |
| 购买与更新界面专项 | 23 项通过：`frontend-focused.log`；覆盖显式恢复、取消、并发点击、卸载、旧轮询结果、测试环境标识及 MAS 不调用 GitHub 更新接口 |
| Rust MAS 桌面回归 | 84 项通过、6 项既有忽略：`rust-mas-all.log`；最初沙盒限制回环监听导致失败，在允许本机测试端口的环境重跑通过 |
| Rust Community 授权回归 | 3 项通过：`rust-community.log`；免费构建不受 MAS 命令权限限制 |
| Swift 原生策略测试 | 11 项通过：`swift-tests.log`；覆盖身份、设备、摘要格式、Production／Sandbox／Xcode 环境。使用合成输入，不是 Apple 购买证明 |
| 静态检查 | TypeScript、ESLint、Rust clippy、rustfmt 和 diff whitespace 检查；日志分别保存 |
| 原生构建 | 独立 `com.claycosmos.nodalstudio.purchase-acceptance` debug 应用，未替换 `/Applications` 正式安装：`native-build.log` |
| Intel Swift 编译 | macOS 13 x86_64 静态桥接编译：`swift-intel.log`；不代表完整 Intel 应用或 Intel 实机验收 |

修复过的实际问题：Swift 静态依赖的 rpath 不会自动传递到 Rust 最终可执行文件，已在桌面 build.rs 为 MAS 设置系统 Swift runtime 路径；恢复前启动的界面轮询可能晚到覆盖恢复结果，已加请求代次防护。

原生界面验收使用没有 Apple 商店购买材料的独立本地应用，验证：

1. 正常进入空工作区，无启动激活墙；设置显示版本与购买状态，无站外更新设置。
2. 点击重新验证后仍正确处于待恢复状态，没有自动解锁、崩溃或反复弹出恢复。
3. 尝试测试连接时，在原生命令入口显示需要购买验证，数据库状态为“未测试”，保存按钮不可用。
4. 最终构建简体中文、深色主题、110% 缩放下购买面板布局与恢复按钮可用，未显示 GitHub 更新设置。最终中文证据：`native-recovery-zh.png`、`native-recovery-zh.ax.txt`。英文及命令拦截证据：`native-recovery.png`、`native-recovery.ax.txt`、`native-command-denied.png`、`native-command-denied.ax.txt`。

这不是签名商店包或 App Sandbox 完整验收，也没有用 mock provider 将界面伪装成已购买。

## 必须继续的真实验收

用户表示已有签名等条件，将稍后在本机配置。最初沙盒内查询未看到身份；随后在获准的只读查询中确认本机存在目标团队的 Mac App Store 应用签名证书，不能将初次结果解释为证书未安装。项目 `config/macos-appstore.env` 仍不存在，标准 Xcode profile 目录未找到匹配 NodalStudio 的 profile；这不代表用户其他位置没有 profile。本次未导入私钥，也未使用 App Store Connect 上传接口。

- [ ] 正确付费应用身份、分发签名、profile 与 App Store Connect 记录一致。
- [ ] 有资格用户通过 Apple 分发取得购买凭据，自动进入已验证状态。
- [ ] 购买后断网，退出／重开应用及重启 Mac，仍可执行受保护操作。
- [ ] 无资格 Mac B 复制应用，以及复制应用与可复制缓存／业务数据，均不能取得权限。
- [ ] 同一有资格用户在另一台 Mac 从商店下载并正常恢复，避免误伤正版换机。
- [ ] 取消 Apple 认证、系统凭据丢失、恢复成功、适用家庭共享、退款／撤销处理。
- [ ] 实际 App Sandbox 中的连接、文件访问、备份／导出，以及商店更新流程。
- [ ] 完整 Universal 包与 Intel 实机；当前 Intel 证据仅为桥接编译。

以上未完成前，不能把本轮结果表述为“正版离线／防复制已全部验收”或“可以发布”。恢复购买的成功分支必须来自 Apple 的有效交易，不能增加生产可用的假授权开关来完成验收。
