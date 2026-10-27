# 首次 MAS 版本与打包一致性

## 1.0.0 / Build 2 候选包

用户于 2026-10-25 授权修复后重新打包。当前 MAS overlay 与本机私有构建配置已递增为 Build 2；社区版本仍为 0.2.4。使用现有正式应用/安装包分发证书和 profile 构建 Universal 包，不上传或送审。打包证据位于 `target/mas-build2/`。

由于现有工作区包含大量用户既有改动，本轮不擅自提交或 stash。构建使用独立、忽略且权限 0600 的配置，仅对本次打包设 REQUIRE_CLEAN_GIT=false；标准配置仍为 true。构建前记录 HEAD、工作区 patch、状态和 761 个非忽略源码/资源文件的 SHA-256。

包含两项 AI 会话修复及最新 MAS 内置政策。前端 951 项、定向 41 项及后续 20 项、ESLint/TypeScript、12 项发布脚本测试通过。正式包已完成并核验：

- `dist/app-store/Nodal-Studio-1.0.0-2.pkg`，28,634,485 字节（约 28.6 MB）。
- 应用版本 **1.0.0 / 2**，Bundle ID `com.claycosmos.nodalstudio`，最低 macOS **13.0**，实际二进制包含 **x86_64 + arm64**。
- 应用与安装包使用现有 V49J3X8K3S 分发身份签名；应用 `codesign --verify --deep --strict`、安装包签名验证、嵌入 profile、图标与 payload 权限检查通过。
- App Sandbox、network.client、用户选定文件读写、app-scope bookmarks 权限通过；没有 network.server。
- 最终包 MAS 隐私资源与源码一致性检查通过。
- PKG SHA-256：`7e07909e45e5d5ecece128e0211aae3ea1cd6acf9d81786d27fce1d5cb7de0c1`。
- `target/mas-build2/verification.json`、`build.log`、`pkg-signature.txt` 保存最终证据。构建启动后的文件变化仅为测试 lint 修正与验收文档，见 `changes-after-build-start.json`，产品实现无变化。
- 临时私有打包配置已删除；标准私有配置保留 Build 2 和 REQUIRE_CLEAN_GIT=true。未提交 Git、上传、安装到 /Applications、提交审核或发布。

本地签名/构建检查不代表 Apple 服务端验证、StoreKit 真购买、TestFlight 或 Intel 实机验收。加密出口与隐私申报依据仍须按复核清单闭环。

## 初始 Build 1 历史记录

日期：2026-10-25。用户确定首个 Mac App Store 版本为 **1.0.0，Build 1**。未提交、上传或发布。

## 配置来源

| 层级 | 值与来源 |
| --- | --- |
| MAS Version | `apps/desktop/src-tauri/tauri.appstore.conf.json` 的 `version = 1.0.0` |
| MAS 初始 Build | 同文件 `bundle.macOS.bundleVersion = 1`；`config/macos-appstore.env.example` 的 `APP_BUILD_NUMBER=1` |
| 正式脚本 | 使用 MAS overlay；仅通过私有配置的 APP_BUILD_NUMBER 覆盖 Build，后续上传递增，不覆盖 Version |
| 产物 | 须为 CFBundleShortVersionString=1.0.0、CFBundleVersion=1；正式脚本的包名应为 `Nodal-Studio-1.0.0-1.pkg` |
| 运行时版本 | `lib.rs` 的 runtime/diagnostics 读取 `app.package_info().version`；Tauri 优先使用合并后的 config.version，而非 Cargo 包版本 |
| 社区/内部包 | 基础 Tauri、Cargo/npm 保持 0.2.4；MAS 独立版本不是全仓库升版，内部 merge-driver 协议版本不变 |

发行说明移除写死的 0.2.4；设置/购买面板继续使用运行时版本。MAS 面板测试使用 1.0.0 并断言显示；没有把内部库版本伪装成应用版本。

## 校验与证据

- Python 增加最终包版本检查：拒绝回退到社区版、错 Build、缺 Build；显式允许下一次上传使用 Build 2，且检查实际包匹配。
- 正式打包脚本在签名包上调用该检查，期望 Build 来自本次 APP_BUILD_NUMBER；不是读取产物后把自身版本当成预期值。
- 已同步送审清单、App Privacy、出口问卷、中英文文案与审核演示文档。历史验收记录不追改成 1.0.0。
- Python 合规与版本回归：7 项通过；设置与购买面板前端回归：2 个文件、20 项通过。
- TypeScript/Vite、MAS Rust 调试构建和 Tauri app 打包通过。实际 `Nodal Version Acceptance.app/Contents/Info.plist` 为 **1.0.0 / 1**；应用隐私资源与打包内容一致性检查通过。
- `bash -n`、`git diff --check`、文档链接检查通过。构建仍有现有前端 chunk 大小/IIFE 提示，不影响本次构建成功。
- 忽略的证据目录 `target/mas-version/`：`build.log`、`frontend-tests.log`、`version-check.json`、`binary-report.json`、独立验收配置 `tauri.acceptance.conf.json`。

本机没有默认私有签名配置；本轮使用独立应用标识、无 profile、`--no-sign` 的调试打包验证，不等同正式 Universal 签名包或 Apple 购买验收，也不替换已安装应用。
