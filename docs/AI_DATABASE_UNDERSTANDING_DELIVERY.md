# AI 数据库理解：实现、修复与验收交付汇总

日期：2026-10-19。首期 F1–F4、阶段一至三已实现，已发现的 review 问题已修复；真实用户、真实双设备和正式环境验收继续待完成。本次按用户授权整理、验证并提交相关改动，验收边界不因 Git 或 CI 状态改变。

## 提交范围

基线为 `4415a3f`，已包含阶段一 `4246933` 及后续 dense canvas 测试/导出帧预算修复。本次增量只包括：

| 范围 | 实现与修复 | 主要记录 |
|---|---|---|
| 阶段二 F1/F3 | 业务语言本地检索、独立扩词、允许范围内候选排序、程序验证的物理/逻辑关联路径与解释、一/两跳临时局部图及完整画布恢复 | [阶段二](AI_DATABASE_UNDERSTANDING_STAGE_TWO.md) |
| 阶段三 F4 | 逐条可编辑草稿、显式确认、并发版本校验、依据失效、连接身份绑定、Git/云接收后本机复核、有效知识复用 | [阶段三](AI_DATABASE_UNDERSTANDING_STAGE_THREE.md) |
| 关联修复 | 旧入口团队说明发送限制、异步刷新/旧响应隔离、已提交写入的最终刷新、字段归属歧义、原子连接采集与回滚、A→B→A 快照历史和同步事件 | 阶段三 R1–R6、N1–N3 |
| 验收发现与工具 | 精确表名优先排序；只读真实目录检查、独立服务验收、批准清单限定的模型评测；禁止复用非空评测目录，答案必须匹配本次完成事件；22 项离线回归及 CI job | [验收记录 E1–E3](AI_DATABASE_UNDERSTANDING_ACCEPTANCE.md) |
| 文档与预览 | 设计文档状态清理、阶段记录、验收边界、合成 UI 预览、README 和实现状态入口 | [设计 §9](AI_DATABASE_UNDERSTANDING_DESIGN.md#9-当前完成状态与剩余验收) |

阶段二、三的历史记录保留各轮测试数量与当时“未提交/未验收”的事实；后续验收和本次复验单独记录。此处汇总既有 review 结论，不声称本次另做了一轮多角色 review。

## Review 问题关闭情况

- 阶段二两项 P2：全局搜索或 Schema 树定位先退出探索层，避免遮挡目标；局部图选择与显式 AI 根表分离，Focus selected 聚焦实际选择。
- 阶段三首轮 1 项 P1、5 项 P2：发送范围、异步语义刷新、失效传播、历史删除/恢复、连接身份与失败回滚、对象真实归属均有永久回归。
- 阶段三第二轮 3 项 P2：卸载或切换后已提交写入的刷新、点分名称歧义、返回持久化快照及历史回归已修复。SQLite schema 5 迁移、备份与兼容性边界见阶段三记录。
- 验收 review 的 1 项 P2：执行器拒绝非空目录及并发占用，当前事件与答案一致才记成功；空回答、失败、超时、重跑保留原始记录的回归已补齐。原有 20 题未出现混批，原始证据未改写。

## 提交前复验

本次日志独立保存在本地忽略目录 `target/ai-delivery/2026-10-19/`，不覆盖历史验收证据。

| 检查 | 本次结果 |
|---|---|
| `python3 -B -m unittest discover -s Scripts/tests -v` | 22 项通过；不调用模型、数据库或网络 |
| `pnpm test` | 104 个文件、603 项通过，包括 dense canvas 完整性和慢帧/再次拖动回归 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build:web` | 通过；构建保留既有大 chunk 提示 |
| `cargo fmt --check` / `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test --workspace --all-features` | 通过；137 项报告通过，4 项外部验收默认忽略，doc-tests 通过 |
| Desktop debug `.app` 构建 | 通过；只构建，未启动用户工作区或执行其本机 SQLite 迁移 |
| 独立 PostgreSQL/MySQL/Cloud 服务验收 | `run_ai_service_acceptance.py` 的 6 项显式测试全部通过，无条件跳过；临时容器与卷已清理 |
| Python 语法、CI YAML、文档链接、暂存范围与 `git diff --cached --check` | 通过；72 个文件与限定清单逐项核对 |
| 原始验收证据 | 81 个文件 SHA-256 与修复前记录一致，20 题原始请求、回答、事件和结果保留 |

Rust 首次测试因沙箱禁止绑定回环端口而失败；允许本机端口后重跑通过，日志分别保留。工作区全量测试不配置业务数据库；有环境变量门控的集成测试不能因此计作真实服务通过，真实服务以独立脚本的显式执行结果为准。本次没有再次调用真实模型，也没有重新采集或写入业务数据库。

## Git 与 CI 核对规则

提交限定为 72 个文件：前端 36 个、后端及依赖 23 个、验收工具与 CI 6 个、文档 7 个。包括上述产品代码、永久测试、合成预览、通用验收工具和文档。真实结构快照、批准清单、模型原始输入/输出、凭据、运行日志、数据库与构建产物保留在本地忽略目录，不提交；未扩大共享协议字段。

推送后核对 `main` 远程 SHA 与本地提交一致，并检查该 SHA 对应的 [CI workflow](https://github.com/akz142857/NodalStudio/actions/workflows/ci.yml)。必须确认 `acceptance-runner`、`frontend`、`rust`、`postgres-integration`、`mysql-integration`、`cloud-integration`、`desktop-build` 全部成功，不能把排队或运行中记作通过。具体提交 SHA 和运行链接以本次交付回复及 GitHub 对应提交记录为准。

## 仍待完成的验收

| 项目 | 已有证据 | 尚缺的验收 |
|---|---|---|
| 真实用户与业务效果 | 20 题真实模型返回、应用校验、Codex 对照元数据复核及调用指标 | 业务负责人独立核对、陌生开发者普通浏览/AI 对照、草稿采纳质量和效率改善；不把 20/20 应用校验称为业务准确率 |
| 真实双设备 | 本机隔离 A/B 存储、实际 Git/云接收路径和 Cloud HTTP 往返 | 两台实体设备各自运行 Desktop，Git 与 Cloud 双向复核、断网恢复和 Keychain 验证；见 E4 |
| 正式环境 | 两个真实库的只读采集、独立 fixture、本机 Cloud HTTP 与临时 CLI 模型通路 | 线上 Cloud 部署、应用内真实 API 提供方配置、正式环境延迟/失败率/费用；见 E5 |

执行条件、步骤及原始证据入口见 [验收记录](AI_DATABASE_UNDERSTANDING_ACCEPTANCE.md)。提交、推送和 CI 只完成代码交付，不关闭以上三类验收。
