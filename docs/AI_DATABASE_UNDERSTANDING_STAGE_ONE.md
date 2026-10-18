# AI 数据库理解：阶段一交付与 Review 记录

日期：2026-10-18。范围：单表/字段解释、证据定位、AI 发送范围和请求生命周期控制。阶段二、三未进入。

阶段一实现和本地验证已完成，两轮修复累计关闭 **1 项 P1、6 项 P2**；第三轮多角色 review 未发现新的可复现回归。此结论限于所审查代码与本地测试，不代表真实模型效果或真实数据库验收。

## 1. 已交付的行为

| 功能 | 当前行为 |
|---|---|
| 单表/字段解释 | Desktop 当前来源最新快照中选表，可指定字段、预置问题或自定义问题；结构事实由快照生成，模型业务解释标为未确认，每条解释只能引用本次有效证据 ID |
| 发送范围 | CurrentTable 只发送目标；OneHop 包含有效物理/逻辑关系的直接入向和出向邻居；Domain 必须显式选一个包含目标的已保存域，实际集合为域内目标与直接邻居 |
| 发送内容 | 后端按白名单构建并预算约束表、字段及关系证据；范围外关系的名称、映射和端点不外发。注释受开关控制，保存的注解和逻辑关系自由文本不参与本阶段请求 |
| 预览与执行 | 准备阶段不调用模型；界面显示实际 JSON、提供方、模型、端点、表集合与覆盖缺口。再次点击才执行，后端只接受已准备请求 ID 并重新核对有效身份 |
| 证据定位 | 定位到完整限定源表及字段/外键/索引/约束；逻辑关系聚焦首个源字段并高亮复合映射其余字段；返回 AI 保留当前任务回答 |
| 取消与过期 | 5 分钟预览期限、取消、任务切换、输入变化及设置/快照/语义变化使旧任务失效；前后端阻止旧成功/失败响应干扰新任务 |
| 离线 | 离线提供方只生成确定性结构说明与未知问题，不发送网络请求 |

不包含业务找表、候选排序、多跳路径解释、多步调用、自动行采样、SQL/DDL 执行或注解确认写回。Web、临时 DDL、历史快照不接入新单表流程；旧变更集解释仍使用原流程。完整边界及预算见 [设计文档](AI_DATABASE_UNDERSTANDING_DESIGN.md) §11。

## 2. 修复与关闭依据

| 轮次/等级 | 问题 | 修复与验证依据 |
|---|---|---|
| 首轮 P1 | 旧来源设置可能把远程请求显示为离线 | 来源设置必须匹配快照，预览的提供方/模型/范围必须匹配有效设置；实际发送说明来自后端预览 |
| 首轮 P2 | 已失效但持久化状态仍为 Active 的逻辑关系扩大范围 | 同一快照重新校验关系后再构建上下文；实际 HTTP 正文测试验证排除失效邻表 |
| 首轮 P2 | 输入或域改变后旧证据 ID 被新任务复用 | 定位绑定请求 ID 和上下文；问题/字段/域/重新准备/取消时清除旧定位 |
| 首轮 P2 | 外键/索引先聚焦辅助字段 | 区分精确对象与辅助字段高亮，验证真实焦点和滚动目标；保留主键字段回退 |
| 首轮 P2 | 预览到期仍可发送 | 绝对到期时间与定时器、可见性、窗口焦点、发送、结果接收多处检查；过期清理并取消 |
| 第二轮 P2 | 任务切换后返回恢复旧定位 | 卸载同步清理父级请求身份和证据；覆盖 StrictMode 下 8 类往返、完成任务及新旧响应竞争 |
| 第二轮 P2 | 逻辑关系聚焦表注释 | 按逻辑证据种类定位源映射首字段；单字段、逆表排列顺序的复合映射及其他证据类别回归通过 |

第三轮独立角色分别复核任务生命周期、旧响应竞争、证据语义/交互，确认以上两项剩余 P2 关闭；旧响应成功、失败与 finally 不会清理或取消替代任务。详细过程保留在 [设计 §11.5–11.7](AI_DATABASE_UNDERSTANDING_DESIGN.md)。

## 3. 实现与回归入口

| 层次 | 文件 |
|---|---|
| 上下文、范围、预算与输出校验 | [understanding.rs](../crates/ai-context/src/understanding.rs)、[上下文回归](../crates/ai-context/tests/understanding.rs) |
| Desktop 请求准备、执行、取消及有效性复查 | [table_understanding.rs](../apps/desktop/src-tauri/src/table_understanding.rs)、[HTTP/生命周期回归](../apps/desktop/src-tauri/src/table_understanding_tests.rs)；`lib.rs` 注册命令及状态并拒绝旧单表入口 |
| 面板及任务隔离 | [TableAiAssistant.tsx](../apps/frontend/src/components/TableAiAssistant.tsx)、[InspectorPanel.tsx](../apps/frontend/src/components/InspectorPanel.tsx)、[面板回归](../apps/frontend/src/components/TableAiAssistant.test.tsx) |
| 证据焦点及滚动 | [TableInspector.tsx](../apps/frontend/src/components/TableInspector.tsx)、[结构定位回归](../apps/frontend/src/components/TableStructure.test.tsx) |
| 平台契约 | [table-ai-types.ts](../apps/frontend/src/platform/table-ai-types.ts)、Tauri 调用与 Web 不可用实现；HistoryPanel 测试 mock 仅补齐新增接口 |
| 开发预览 | [ai-preview.html](../apps/frontend/ai-preview.html)、[预览组件](../apps/frontend/src/test/ai-preview.tsx)、[合成 fixture](../apps/frontend/src/test/table-ai-fixture.ts)；不进入正式构建入口 |

## 4. 验证记录与复现

- 初次实现及首轮修复已通过 Rust 格式检查、工作区严格 clippy 和全部工作区测试；测试中的本机 HTTP 服务与内存 SQLite 不等于真实提供方或数据库验收。
- 第二轮修复新增 13 项仓库回归，最终前端全量 **96 文件/524 项通过**，类型检查、Lint 和桌面调试包构建通过。既有 IIFE 命名/大 chunk 构建提示仍保留。
- 第三轮 review 通过 **58 项仓库定向回归 + 24 项独立临时测试**；后者未加入仓库测试数量。浏览器合成预览确认实际源字段焦点及历史模式往返清理。
- 本次文档整理与提交前重新执行：类型检查、Lint、前端定向 **58 项**、上下文 **8 项**、Desktop 请求/生命周期 **11 项**全部通过。未改生产实现，不重复计作一次全量测试或桌面构建。
- 真实模型遵循率与业务解释效果未测；真实 PostgreSQL/MySQL/Cloud 集成环境未配置，条件跳过不能算通过验收。双机器注解复核留在阶段三。

在仓库根目录执行定向回归：

```bash
pnpm typecheck
pnpm lint
pnpm --filter @nodalstudio/frontend exec vitest run src/components/TableAiAssistant.test.tsx src/components/TableStructure.test.tsx src/components/InspectorPanel.test.tsx src/components/TableInspector.test.tsx src/components/AiAssistant.test.tsx src/components/HistoryPanel.test.tsx --maxWorkers=1
cargo test -p ai-context --test understanding
cargo test -p nodalstudio-desktop --lib table_understanding::tests
```

交互查看：`pnpm dev` 后打开 `http://127.0.0.1:1420/ai-preview.html`，准备预览，查看样例解释，点击 e1 字段/e2 索引/e3 逻辑关系，再切换历史模式并返回。该页使用固定回答，不访问真实模型或本机数据库。

## 5. 提交范围

本次交付包括阶段一 Rust/前端实现、对应测试、平台类型与接口适配、开发合成预览和上述文档入口。`Cargo.lock` 仅反映 `ai-context` 新增的既有工作区依赖 `serde_json`。不修改阶段二/三运行逻辑、数据库数据、用户配置、凭据或发布流程。

本机 `target/` 下的构建包、日志、截图和临时 review 测试不加入 Git；正式文档保留结论、命令和可移植源码链接。提交前按明确文件清单暂存并核对差异。

本次文件清单共 **28 个文件**：实现及依赖声明/锁文件 15 个、正式回归测试 5 个、开发预览/fixture 3 个、文档 5 个。工作区改动逐项对应上述范围；文档相对链接检查及常见凭据模式扫描通过。既有后续设计只作为规划保留，阶段二、三代码未实施。
