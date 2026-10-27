# 加密出口问卷填写草稿

首次 MAS 送审版本：**1.0.0（Build 1）**。后续重复上传须递增 Build；社区版与内部 Cargo/npm 包仍为 0.2.4。详见 [版本一致性记录](MAC_APP_STORE_VERSION_ACCEPTANCE.md)。

日期：2026-10-25。状态：技术事实已核查、经营范围与分类待确认；未填写 App Store Connect，未提交或发布。对应 [送审清单](MAC_APP_STORE_SUBMISSION_CHECKLIST.md) 与 [代码核查记录](MAC_APP_STORE_PRIVACY_EXPORT_AUDIT.md)。

本草稿提供可填写的技术答案，不作法律分类结论。下面是题意映射，未声称当前账户一定逐字显示这些问题；仅回答后台实际出现的题目。签名和真实购买材料不是准备本草稿的前提。

## 问卷答案表

| 题意/字段 | 草稿答案 | 依据与状态 | 最终确认 |
| --- | --- | --- | --- |
| 应用是否使用、包含或访问加密 | **Yes** | **代码确认**：HTTPS、数据库 TLS、系统 SSH、Keychain、StoreKit 验证 | `确认：__` |
| 是否仅使用 Apple 操作系统提供的加密 | **No** | **代码确认**：reqwest/SQLx 链接 Rustls/ring；系统根证书不使 TLS 实现变成系统实现 | `确认：__` |
| 加密类型：非系统提供的行业标准算法/协议 | **选择此类**（若后台出现） | **代码确认**：Rustls/ring 的标准 TLS 实现，加上系统 SSH；依赖实现见下表 | `确认：__` |
| 是否存在专有或未获标准组织认可/未公开的算法或协议 | **当前建议 No** | **代码核查范围内未发现**自定义加密算法/协议；自研购买校验流程不是自创密码算法。最终包新增依赖需重审 | `确认未另加组件：__` |
| 是否属于“不使用上述任何加密” | **不采用** | 与非系统标准加密事实冲突；不能因为只用来连接数据库而选“无” | `确认：__` |
| 应用用途/主要功能 | 数据库结构理解、只读查询、变化复核、语义整理与导出；加密保护连接与凭据、核验购买 | **代码确认**，英文说明见下文 | `确认商店描述一致：__` |
| 是否在法国提供 | **待你确认** | 销售地区不是代码事实；此项影响法国声明材料 | `是 / 否 / 尚未决定：__` |
| 是否享有特定豁免、是否需出口文档 | **待实际问卷与主体条件确认** | 不由“标准算法”“开源”“没有自建服务器”单独推出 | `分类依据/结果：__` |
| CCATS、法国声明、Apple 批准码等 | **未提供，不能虚填** | 不是目前代码缺陷；需要何种材料由实际分支决定 | `不适用及依据 / 文件引用 / 待办理：__` |
| ITSAppUsesNonExemptEncryption | **继续缺省，暂不填 true/false** | 当前已移除未经确认的 false。后续依结果设置，不把“使用加密 Yes”直接等同此键 true | `最终值和依据：__` |

“使用加密”与“使用非豁免加密”不是同一道题。Apple 提供问卷来确定材料需求；如需材料，应在送 App Review 或 TestFlight App Review 前处理。[Apple 问卷流程](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/)

## 实现清点：可以交给填写人使用

| 功能 | 当前实现/证据 | 对问卷的含义 |
| --- | --- | --- |
| AI HTTPS | 根 `Cargo.toml`：reqwest default-features=false，rustls-tls-native-roots；`lib.rs` 的 `remote_ai_explanation` 构建 reqwest 客户端 | 非系统标准加密实现；用户可配置端点，不表示每个请求都一定使用 HTTPS |
| PostgreSQL/MySQL TLS | 根 `Cargo.toml`：SQLx 的 tls-rustls-ring-native-roots | 同样有非系统加密代码；具体连接是否启用 TLS 由连接配置决定 |
| 密码学依赖 | 锁定 Rustls 0.23.41 / ring 0.17.14；版本与依赖证据见核查记录 | 含标准密码学实现；不把 hash 或编译进来的全部原语都说成实际协商算法。具体算法/位数如被问到，再按最终构建配置及库证据补充 |
| SSH | `connection_security.rs` 调用 `/usr/bin/ssh`，开启严格主机校验 | 使用系统提供的 SSH；本应用不是另行编写 SSH 算法 |
| 凭据 | `keyring` apple-native → Keychain/Security.framework | 系统凭据保护，不代表数据库快照/导出文件已经加密 |
| 购买校验、摘要 | `Purchase.swift` 使用 StoreKit/CryptoKit；本地结构指纹等使用哈希 | 身份/完整性用途；无独立许可证服务器 |

产品中没有通用加密服务、加密货币功能或用户可替换密码算法的配置，这是当前实现核查结论；不等于已获得某一出口分类。若未来改变 TLS/SSH/依赖或增加加密导出，必须重新核查。

## 法国与材料分支

Apple 当前参考表将“非操作系统提供的行业标准算法”关联到法国加密声明，并注明该声明仅在法国 App Store 分发时要求。由于本项目含 Rustls/ring，应将“法国是否首发”作为显式决策，不能按“只用系统加密”的分支处理。[Apple 加密材料参考表](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)

| 你确认的范围 | 草稿下一步 |
| --- | --- |
| 包含法国 | 按 Apple 问卷准备对应法国声明/所需证明；核实有无适用例外及材料有效范围，记录实际后台要求，不直接选无材料 |
| 不含法国 | 记录正式销售地区并在后台保持一致；不因法国材料不适用就推断所有出口义务都免除 |
| 尚未决定/全球 | 保持该项未完成；“全球”通常包含法国，不能留下模糊口径 |

本轮不自动排除法国，也不替运营主体申请材料。美国分类、自分类报告等义务需按主体、实现和适用规定确认；不预填 ECCN/CCATS 编号。Apple 的材料流程与全部出口义务不应混为一谈。[Apple 出口合规总览](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)

## 技术描述英文草稿

以下仅供 App Description/加密用途说明等适用字段使用，并非承诺后台一定有同名文本框：

> Nodal Studio is a macOS developer tool for understanding database schemas, running read-only queries, reviewing schema changes, and maintaining local annotations. It uses standard TLS through Rustls/ring, via reqwest and SQLx, for supported HTTPS and database connections. SSH connections use the macOS system SSH client. Credentials are stored using the macOS Keychain, and purchase authorization uses Apple StoreKit. Cryptography supports connection security, credential protection, and authorization verification. The reviewed application code does not implement a proprietary cryptographic algorithm or protocol. The app includes non-OS cryptographic implementations; it is not limited to cryptography supplied by the Apple operating system.

避免补写“全部数据均加密”“从不出设备”“无需任何出口材料”等代码/分类不支持的说法。

## 你需要填写的最小材料表

| 项目 | 你的填写 |
| --- | --- |
| 法定主体、注册国家/地区；出口材料联系人 | `待填` |
| 首发销售地区；是否包含法国 | `待填` |
| 应用名、Bundle ID、版本/build | `Nodal Studio；com.claycosmos.nodalstudio；1.0.0 / 1（正式包待核）` |
| 现有适用加密分类/声明/批准记录 | `无 / 有，填写本机文档引用和适用范围，不粘贴私密材料` |
| 实际后台问题和选项、问卷结果 | `后续获准填写时记录` |
| 所需文档、办理人、状态 | `待填或不适用及依据` |
| 最终确认人、日期 | `待填` |

确认分类后才同步 `Info.appstore.plist`、`Scripts/check_mas_compliance.py` 的规则与回归、核查记录及最终包。不要删除校验来绕过待确认项；Apple 批准码只填实际取得的值。本轮没有更改声明键、签名设置、地区或后台状态。
