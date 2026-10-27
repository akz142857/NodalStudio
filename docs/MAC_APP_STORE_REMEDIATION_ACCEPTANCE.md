# Mac App Store 送审阻断项整改与验收

日期：2026-10-25。对应 `MAC_APP_STORE_SUBMISSION_AUDIT.md`。本轮只修改工作区并做本机验证，没有提交、推送、上传或发布，没有替换 `/Applications` 中的正式安装。

## 产品范围

用户确认：首版 Mac App Store 移除云账号创建及云协作入口，社区版保留原状。没有新增独立账号或许可证服务器。

## 已实施

| 审查项 | 实施结果 |
| --- | --- |
| A1 隐私政策 | 设置 → 隐私与安全新增中英文离线政策正文。源文件在 `docs/legal/PRIVACY.*.txt`，覆盖本地数据、AI 接收方、社区云服务、Apple 授权、保留/删除及联系渠道。公开 HTTPS 政策网址尚未发布。 |
| A2 云账号 | MAS 不显示云设置、云失败通知开关、云功能支持项或隐私页云状态；旧 cloud 设置深链不能打开云功能。原生命令在已验证购买状态下也拒绝云操作，云 HTTP 客户端另有渠道限制。社区版不受这些限制。 |
| A3 文件授权 | 备份、设置文件、Git 目录增加系统选择器，MAS 路径只读；目录、证书和密钥使用 app-scoped bookmark。访问以 Rust RAII 持有 Swift security scope，操作结束释放；失效/移动时要求重新选择，书签不参与模型和设置导出。 |
| A3 扩展排查 | HTML 报告、离线 Viewer、ER SVG/PNG 的 MAS 导出改为显式选择目录；查询结果 MAS 导出也选择目录，避免只获得单个文件权限后写相邻临时文件。新文件独占创建、冲突递增文件名，不覆盖已有文件；查询生成文件仍保留 128 MiB 限制。社区版导出路径行为保留。 |
| A4 购买环境 | 删除 `sandboxReceipt` 文件名假设；仍仅接受 Apple 已验证交易中的 Production/Sandbox，继续核对 bundle、设备 SHA-384 证明，拒绝 Xcode/未知环境。没有测试解锁入口。真实购买仍待验。 |
| A5 AI 发送 | 变化集解释先预览服务地址、模型、数据范围、问题与注释开关，再明确发送；取消不发送；问题、目标、范围或设置变化会使预览失效。Rust 端拒绝缺失或不匹配当前端点/模型/注释设置的确认。表级原有流程保留。 |
| A7 关于页 | 发行说明更新为 0.2.4；按仓库既有 MIT 声明补许可证原文；第三方声明展示实际依赖许可证，按需加载。上游文本清点仍有缺口，见下文。 |
| A8 准确文案 | 移除没有上传服务的诊断/崩溃开关，明确当前无开发者遥测上传；MAS 更新状态显示 App Store，高级设置不显示更新通道；“完全离线”改为“限制应用外部请求”，解释 Apple 校验通信例外；AI 文案不再保证用户输入绝无敏感内容。 |

## 自动化验证

日志位于忽略目录 `target/mas-submission-acceptance/`，不纳入 Git。

- 前端完整回归：143 文件、931 测试通过（`frontend-all.log`）。随后导出说明文案更新另跑针对性回归。
- 针对性回归：3 文件、15 测试通过，覆盖设置、AI 发送确认、功能支持矩阵，见 `frontend-focused.log`。
- Rust MAS 全量：89 项通过、6 项既有忽略，见 `rust-mas.log`；包括原生云命令隔离、AI 确认一致性、未选择路径拒绝、导出路径穿越/覆盖/大小边界。6 项既有真实集成测试仍忽略。
- Rust 社区版购买策略：4 项通过（`rust-community-purchase.log`）。
- Swift 购买策略：11 项合成验证通过；覆盖 Production/Sandbox/Xcode、身份与设备错误。不是 Apple 购买证明。
- TypeScript、ESLint、Rust clippy（`-D warnings`）、rustfmt、`git diff --check`。
- 最初 Rust 网络模拟测试因执行沙盒禁止回环监听失败；允许本机测试端口后重跑。没有将环境失败当作通过。

## 原生界面验收

独立应用：`target/debug/bundle/macos/Nodal Submission Acceptance.app`；标识 `com.claycosmos.nodalstudio.submission-acceptance`。它没有真实购买证明，付费操作保持关闭。

已实测：

1. 英文和简体中文设置导航均无云入口。
2. 隐私政策点击展开、离线正文可读；中文深色主题、110% 缩放下布局正常。证据：`privacy-en.*`、`privacy-zh-final.*`。
3. MAS 外部功能显示 App Store 更新；高级设置不再提供应用更新通道，证据：`advanced-zh-final.ax.txt`。
4. 系统保存对话框选择隔离目录、回填设置路径并导出成功；文件 `nodal-settings.json`。它来自空验收配置，没有生产数据。
5. 取消导入文件选择后路径保持为空，导入/导出仍禁用，没有写入或误导成功状态。
6. 关于页显示 0.2.4 发行说明；第三方声明异步加载实际许可证文本；购买仍显示待验证，没有自动解锁。

上述设置/导出验收是独立 Tauri debug 应用的真实界面操作，不是完整 Apple 分发签名包验收。受购买门禁保护的 AI/连接/模型导入等完整流程未在这个未授权应用中绕过执行；AI 确认交互由 React 测试和 Rust 策略测试覆盖，正式商店包的对应原生流程需继续验收。

## App Sandbox 文件书签原生实测

另有 `crates/storekit-bridge/native/FileAccessProbe.swift`，只用于验收，未编入产品。它直接编译产品使用的同一份 `FileAccess.swift`，使用隔离标识 `com.claycosmos.nodalstudio.bookmark-probe`，ad hoc 签名启用：

- `com.apple.security.app-sandbox`
- `com.apple.security.files.user-selected.read-write`
- `com.apple.security.files.bookmarks.app-scope`

已通过：未选择时拒绝；系统选择器授权仅含 `probe.txt` 的测试目录并保存书签；终止进程后重新启动仍成功读取；将测试目录移走后拒绝旧路径并要求重新选择。证据：`bookmark-restart.*`、`bookmark-moved.*`、`probe-entitlements.plist`。编译示例：

```sh
xcrun swiftc -parse-as-library -module-cache-path target/mas-submission-acceptance/swift-cache \
  crates/storekit-bridge/native/FileAccess.swift \
  crates/storekit-bridge/native/FileAccessProbe.swift -framework AppKit \
  -o 'target/mas-submission-acceptance/Nodal Bookmark Probe.app/Contents/MacOS/probe'
```

重跑需要为该测试应用建立独立 Info.plist 并用上述权限签名，然后通过其原生选择器选择一次临时目录。这证明了共享书签实现的真实沙盒行为，不能代替 Tauri 正式签名包中 TLS/SSH/Git 的完整链路，也不能证明购买成功。

## 单独列出的真实购买环境验收

以下没有用模拟授权代替，也未执行上传：

- [ ] 正式 bundle ID、应用记录、付费配置、分发签名与 provisioning profile 一致。
- [ ] Apple 分发取得真实购买证明，首次启动解锁；Sandbox/TestFlight 环境不会被错误拒绝。
- [ ] 正版购买后断网退出、重开应用以及重启 Mac，仍可使用受保护功能。
- [ ] 恢复购买成功、取消、网络失败；同一用户另一台 Mac 正常恢复。
- [ ] 无购买资格另一台 Mac 复制应用/可复制缓存后仍不能解锁。
- [ ] 适用家庭共享、退款/撤销等真实环境情形。
- [ ] 在真实商店包中完成连接、AI 预览/取消/发送、备份恢复、目录与证书跨重启复用、Git 文件交换和更新验收。

## 其他仍需发行前收口的事项（不属于真实购买测试）

1. **公开隐私政策**：正文已入库并内置，但用户要求不发布，因此未部署 HTTPS 页面，也未填写 App Store Connect 的 Privacy URL。发布前需确认政策运营主体/联系渠道并上线。
2. **第三方授权清点**：2026-10-25 已补齐原有 48 处文本缺口，603 包的保守清单当前为 0 缺口；补充文本记录来源、版本和 SHA-256，并在 MAS 构建前检查。详见 `legal/README.md`。这仍不是完整法律审计。
3. **Git/SSH 分发兼容性（A6）**：已用 Developer ID 签名的真实 App Sandbox 应用验证生产文件访问、Git 文件交换及 SSH 私钥/密码链路。MAS 就绪检查改为直接读取授权目录，不再调用被沙盒拒绝的系统 Git；系统 Agent 不在首版 MAS 支持范围。最终商店包和干净 Mac 仍需复验，见 [兼容性收口记录](MAC_APP_STORE_SANDBOX_COMPATIBILITY_ACCEPTANCE.md)。
4. **商店材料与其他平台**：App Privacy、required-reason API/第三方 SDK 隐私清单、截图/分级/出口声明、最低 macOS 和 Intel 完整实机回归，未因本轮代码检查而自动通过。

结论：应用内主要送审阻断项已实施整改并有分层测试证据；仍不能据此宣称“可以发布”或“所有 App Store 条件已经满足”。

## 2026-10-25 最终原生复验补记

锁屏阻塞已解除。最终 Developer ID 签名的 App Sandbox 验收包中，Git 就绪检查/文件交换、SSH 私钥/密码、错误主机密钥拒绝、Agent 范围拒绝及完整退出后的书签复用均已通过；截图、两轮 JSON 和二进制校验和见 [兼容性收口记录](MAC_APP_STORE_SANDBOX_COMPATIBILITY_ACCEPTANCE.md)。这不替代上述真实购买及最终商店分发包验收。未提交或发布。
