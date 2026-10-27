# Mac App Store 许可证与沙盒兼容性收口

日期：2026-10-25。仅本地实现、测试和验收；未提交、推送、上传或发布。

## 已实施

- 603 个依赖的保守许可证清单，原有 48 处缺文本现为 0。覆盖已安装前端生产依赖和 Cargo 解析结果，包括 Rust 构建/其他平台依赖。补充文件位于 `legal/upstream/`，记录精确版本、上游来源及 SHA-256；非标准位置 AUTHORS/COPYRIGHT 也纳入。标准许可证原文与上游版权声明明确区分。
- notices 生成器保持离线；`--check` 检查缺失、校验和错误、旧版本补充项与未重新生成的文件。MAS 打包脚本在构建前执行检查。Cargo 条目附精确版本源代码下载地址，包括 MPL 依赖。
- 沙盒 SSH 临时目录缩短为 `ns` 前缀，并在创建隧道前检查 tunnel/askpass 的 Unix socket 路径长度。macOS 的 103 字节路径限制仍存在，超长主目录明确报错，不再落入不明认证失败；未退回共享 `/tmp` 或开放 TCP 监听。
- MAS SSH 明确支持私钥或密码，要求用户授权可信 known_hosts。系统 Agent 不在首版 MAS 支持范围，前后端一致拒绝；私钥/密码连接也禁用隐式 Agent。社区版原有 Agent 和默认 known_hosts 行为不变。
- 系统 `/usr/bin/git` 在实际沙盒中返回 `xcrun: cannot be used within an App Sandbox`。MAS 仓库检查改为读取授权目录内的 Git 标记，不再启动 Git/外部 merge driver；worktree 的 gitdir 标记只识别，不越过授权目录追踪。商店界面移除驱动安装按钮和误导的未安装状态；文件交换、指纹检查和冲突报告保留。提交/合并由用户的外部 Git 工具完成。

## 原生实测及证据范围

验收目标：`apps/desktop/src-tauri/examples/sandbox_compatibility.rs`。直接链接生产 `file_access.rs`、`connection_security.rs`、`git_readiness.rs` 和 `git-workspace` crate，使用 Tauri 原生窗口及系统目录选择器。验收代码不进入产品、不模拟购买成功。

独立标识 `com.claycosmos.nodaltest`，Developer ID 签名，启用实际 App Sandbox、network.client、用户选择文件读写与 app-scope bookmarks。没有 network.server 或文件系统豁免。使用本机隔离 PostgreSQL/SSH 容器，仅端口 55482 绑定 127.0.0.1，测试凭据不含真实账户秘密。

已经实测：

| 项目 | 结果 |
| --- | --- |
| 系统选择器授权测试目录 | 通过 |
| Git 模型文件写出、读回 | 通过 |
| 未管理的 unrelated.txt 保留 | 通过 |
| SSH 私钥认证并查询 SELECT 42 | 通过 |
| SSH 密码/同一签名可执行文件 askpass 并查询 SELECT 42 | 通过 |
| 错误 SSH host key | 拒绝，未降低 StrictHostKeyChecking |
| 完整退出、重开后不再选择目录 | 文件交换和两种 SSH 认证通过 |
| 最终 MAS Git 就绪检查（不调用 Git） | 通过 |
| 系统 SSH Agent | 按首版 MAS 范围明确拒绝 |
| 系统 Git CLI 诊断 | 明确失败，已据此修复生产 MAS 检查路径 |

证据位于忽略目录 `target/mas-compatibility/`：`native-first-pass.png`、`fixture/compatibility-result.json`、签名与 entitlement 记录及测试日志。重跑步骤见 `Scripts/fixtures/sandbox-compatibility/README.md`。

**最终修改后的原生复验已完成（2026-10-25 11:48，Asia/Singapore）**：解锁后使用最后签名的 `Nodal Sandbox v2.app`，直接点击 Run saved fixture，不重新选择目录。Git readiness、模型文件写出/读回、未管理文件保留、私钥/密码查询均通过，错误 host key 和系统 Agent 按预期拒绝。随后用 Cmd+Q 完整退出，确认 PID 51399 已不存在；再次启动得到新 PID 51607，不重新授权，再次全部通过。两轮 JSON 结果一致，未发现需要追加修复的问题。

最终证据：`native-final-run.json`、`native-final-restart.json`、`native-final-run.png`、`native-final-restart.png`，以及记录时间、进程和文件 SHA-256 的 `native-final-evidence.json`，均位于 `target/mas-compatibility/`。验收可执行文件 SHA-256：`c82b3a5f435830e294918b478eacc6ba59f43595679c002faf7a3410481c094c`。本轮重新执行 `codesign --verify --strict` 通过。系统 Git CLI 仍被沙盒拒绝，这是诊断对照项；生产 MAS 的文件系统就绪检查返回 true，不依赖该 CLI。

验收后退出测试应用并停止专用容器，保留测试数据。需要复跑时执行 `docker start nodal-sandbox-compatibility-local` 后打开验收应用。本轮只更新验收证据与文档，没有提交、上传或发布。

这验证了真实 macOS App Sandbox 下的共享实现，不是 Apple 商店分发包、MAS provisioning profile 或真实购买环境的替代证明。

## 自动检查

- 许可证生成器 4 项测试通过；离线 `--check` 603 包、0 缺口。
- 桌面 Rust MAS：93 通过，6 项既有真实环境测试忽略。
- Git workspace：7 通过。
- 社区版连接安全：6 通过、1 项真实环境测试忽略。
- 前端定向：2 文件、15 测试通过；TypeScript、ESLint、前端生产构建通过。
- 全量前端：143 文件、933 测试通过。
- 最终 Clippy（MAS lib/tests，`-D warnings`）、fmt、示例编译、shell 语法及 diff 空白检查通过。

## 继续单列的真实购买/分发验收

- 正式 bundle ID、分发签名、profile、App Store Connect 记录及付费配置一致。
- Apple 实际分发和首次购买解锁；正版离线退出/重开/重启 Mac。
- 恢复购买成功、取消、网络失败；同一账户另一台 Mac 恢复。
- 无资格账户跨 Mac 复制应用/缓存仍不能解锁；退款、撤销及适用家庭共享。
- 最终商店包里的全部受保护功能与沙盒集成，以及最低 macOS/Intel/干净 Mac 验证。

其他发行材料仍独立：公开隐私政策 HTTPS 页面与运营主体/联系渠道确认（本次按要求未发布）、App Privacy、第三方 SDK 隐私清单、截图/分级/出口声明。本轮许可证文本缺口清零不等于全部法律/商店条件已通过。
