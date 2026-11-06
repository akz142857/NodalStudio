# SQLite 多角色审查与修复

日期：2026-11-06。范围为本次尚未提交的 SQLite 首版变更。三个独立角色负责数据库/Query、Desktop/文件权限、前端/产品行为；主 Agent 负责快照比较、AI 证据与合并验证。

## 确认并修复的问题

| 优先级 | 触发场景与影响 | 修复及回归 |
| --- | --- | --- |
| P1 | 普通表的外键引用缺少模块的虚拟表时，整个结构采集失败 | 对目标字段读取局部降级并保留覆盖诊断；仅处理确切的 `no such module`，不吞掉 I/O/取消。真实 SQLite fixture 复现后通过 |
| P1 | Query 调用 future 被取消/丢弃，来源的运行注册表永久残留 | 独立 owner 持有执行、关闭、清理与历史记录；spawn 前完成注册，避免立即 Stop 竞态。abort 后清理、再次查询和立即取消测试通过 |
| P2 | SQLite 外键引用的表/列大小写与声明不同，图对象无法匹配 | 按 SQLite 的大小写规则解析后保存目录真实拼写，含带引号标识符回归 |
| P2 | `INSTEAD OF` 视图触发器被标为 table 依赖 | 所属对象与依赖目标使用 View 类型 |
| P2 | 列级 `CONSTRAINT name REFERENCES ...` 的显式名称丢失 | 从列选项读取名称；保持无法唯一匹配时的诊断 |
| P2 | 元数据大小预算使用字符数，多字节 DDL 可超出字节预算 | 按实际 BLOB 字节计数并计入 NULL DDL 对象名称；18 MiB 中文目录被正确拒绝 |
| P2 | 合法的 SQLite `WITH ... VALUES` 递归锚点被拒绝 | SQLite 独立允许只读 VALUES 子表达式，保留写语句、嵌套危险函数和独立 VALUES 限制；PG/MySQL 规则不变 |
| P2 | Cloud gate 只看连接 profile，漏检导入的 SQLite 快照或新变更枚举 | 依据实际上传 snapshot 和 `AlterTable` 判断兼容性；不发送这些内容时无需额外门槛 |
| P2 | SQLite 被列入弱 TLS 警告并探测数据库 Keychain | 只对网络数据源统计 TLS 与数据库凭据状态 |
| P2 | 源文件失效或导入模型无本地绑定时，无法只修改名称 | 同一绑定仅更新本地 profile；新建/重新绑定仍验证采集并原子保存，复用 capture/cloud gate |
| P2 | PG/MySQL 之间切换会清空已有 TLS/凭据设置 | 保留网络引擎间的配置；SQLite 边界单独处理 |
| P2 | SQLite 键盘导航进入隐藏 TLS/SSH 页；异步文件选择期间可提交旧配置 | 标签导航只遍历可见页，picker pending 时阻止冲突操作/提交 |
| P2 | 仅采集诊断/覆盖变化被标为真实结构修改 | Rust diff 与前端投影忽略纯 coverage 变化；真正的 DDL/表选项变化仍可见，Before/After 展示实际比较属性 |
| P2 | 模块缺失导致字段未知，被预检报成外键字段错误 | 记录信息级“证据不足”，不推断字段不存在 |
| P2 | AI evidence 将无法读取字段的表描述为“0 字段、无主键” | 发送 null 与明确的 unknown 说明；不发送未验证字段/关系或原始 DDL，字段聚焦请求明确拒绝 |

另有一项防御性修正：QueryPage 的实际显示状态始终受当前 `canDraft` 约束，同 sourceId 方言改变时不会保留已禁用的 AI 草稿界面。当前 App 的重绑定路径会卸载该组件，因此不把它计为已复现的主流程缺陷。

## 验证

- 数据库角色：adapter 5 项、SQLite query 3 项、query-engine 单元 10 项通过；多个 fixture 在修复前明确失败，修复后通过。
- Desktop 角色：6 项 SQLite 测试通过，覆盖调用方中断/立即取消、离线重命名、TLS/Keychain 排除、实际 Cloud payload 兼容性。
- 前端角色：8 文件 / 119 个定向测试、ESLint、TypeScript 通过。
- 主 Agent：schema-diff 9 项、AI context 全部测试通过；新增未知字段证据回归。

合并后的最终验证：

| 检查 | 结果 |
| --- | --- |
| Rust workspace 测试（locked / offline） | 268 passed，0 failed，6 ignored；文档测试完成 |
| 前端全量 Vitest | 144 文件，969 测试通过 |
| Workspace all-targets Clippy，`-D warnings` | 通过 |
| Desktop `mac-app-store` / `updater-smoke-test` all-targets Clippy | 两种配置均通过 |
| 前端 ESLint / TypeScript / Web 构建 | 通过；构建保留已有大 chunk 提示 |
| MAS compliance | 9 测试通过 |
| Rust 格式与 Git diff 空白检查 | 通过 |

Rust HTTP fixture 使用本机回环地址完成；缺少外部环境的 opt-in 测试不代表真实 PG/MySQL/Cloud 验收。

## 验收边界

本轮没有连接真实业务数据库，没有发送真实 AI 请求、部署 Cloud、提交 Git 或发布安装包。修复后重新构建 Web 资源；原生 UI 与 ad-hoc 沙箱证据仍是 [上一轮验收](SQLITE_ACCEPTANCE.md) 的记录，不能替代本轮所有交互修正后的原生签名包复验。

Windows/Linux 原生验收、正式签名发行包、真实 PG/MySQL/Cloud/model 的 opt-in 环境验收仍按原有发布门槛处理。底层单值内存分配限制没有改变。重新绑定或取消文件选择后，旧 bookmark 的统一回收属于尚未实现的授权生命周期能力；本轮没有引入静默吞掉回收失败的处理，删除来源时的已有引用检查与授权回收保持有效。
