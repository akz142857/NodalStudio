# AI 体验调整：阶段一实施与验收

后续状态（2026-10-23）：发布目标已改为 **v0.2.0**，原生 AI、八项真实模型契约检查和隔离的 0.1.2 → 0.2.0 升级验收已完成；正式签名分发仍待完成。结果、模型输出局限及证据见 [v0.2.0 验收记录](releases/v0.2.0-validation.md)。下文保留最初提交时的检查与阻塞记录，不代表当前仍处于锁屏阻塞。

日期：2026-10-23。范围：[体验方案](AI_EXPERIENCE_REDESIGN.md) 第一阶段。本记录随实现一同提交，尚未发布新版本；应用版本号保留 0.1.2。

## 实现

- 单表 AI 自动进行本地准备，编辑问题后等待 300ms；唯一外发入口是“发送并回答”或准备完成后的 Command/Ctrl+Enter。打开面板、选择建议、编辑问题均不发送模型请求。隐藏的未使用 AI 面板不自动准备。
- 准备完成后展示实际提供方主机、模型、表数量、注释/已确认说明是否包含，以及不发送业务行或凭据的范围摘要。详细对象清单和完整真实请求正文可展开核对。
- 成功回答置于提问框上方；继续编辑时保留上次回答，新请求提交后替换。新回答契约 `schemaVersion: 2` 包含带有效引用的 `summary`、最多 3 条相关补充和最多 3 条关键缺口。没有必要的补充或未知时允许空列表。
- 主答案必须包含影响判断的限定语。校验仍拒绝错误类型、未知引用、额外字段、错误版本和超限输出；不会截取部分文字、修补引用或用模型思考内容代替答案。
- 证据使用字段/约束名称，邻表对象保留限定名称；按需查看并定位。注释、团队说明和逻辑关系不会标成数据库约束。原始证据、覆盖限制和请求正文进入折叠详情。
- 每份回答只提供一个“整理成表说明”入口。后端以 `requestId` 加空 `interpretationIndex` 生成包含主答案、补充和全部关键缺口的独立草稿；原来的指定单条接口仍保留。用户能比较原说明、编辑、取消或确认。原有来源、快照、依据、期限与冲突校验继续生效。
- 面板及其草稿编辑流程支持应用设置的中文/英文；系统语言选项跟随浏览器环境语言。复用现有 Inspector 设计令牌。
- 本阶段没有改变默认远程范围，没有实现持续发送授权，没有自动扩大到关联表，没有新增数据库执行入口。

## 已完成检查

| 检查 | 结果 | 本地记录 |
|---|---|---|
| 完整前端回归 | 119 文件、701 项通过（2 workers） | `target/ai-redesign-all-ui-tests.log` |
| AI、设置与知识生命周期专项 | 43 项通过 | `target/ai-redesign-ui-tests.log` |
| AI 与桌面端 Rust 检查 | 95 项通过、6 项显式集成验收忽略 | `target/ai-redesign-rust-tests.log` |
| 类型检查、ESLint | 通过 | `target/ai-redesign-typecheck.log`、`target/ai-redesign-lint.log` |
| Rust clippy | AI 与桌面端 all-targets，warnings denied，通过 | `target/ai-redesign-clippy.log` |
| 八项合成请求准备 | 8/8，本地准备，无真实模型调用 | `target/ai-redesign-validation/previews.json` |
| 本机验收应用构建 | debug `.app` 构建成功 | `target/ai-redesign-validation/build.log` |

首轮完整前端测试与构建并发，出现 9 项超时/时序失败；限制到 2 workers 后整套 701 项通过。未修改无关画布测试来掩盖失败。Rust 网络单测在沙箱内不能监听回环端口，获准在沙箱外运行后还需绕过系统对 localhost 的代理；设置 `NO_PROXY=127.0.0.1,localhost` 后全部通过。这些环境问题不计作模型或原生验收成功。

## 原生验收准备与当前阻塞

- 本机构建：`target/debug/bundle/macos/Nodal Studio AI Review.app`。
- 独立 identifier：`com.claycosmos.nodalstudio.ai-review`，使用独立 Application Support 数据目录。
- 只放入一个合成来源、一个快照、七张 synthetic_shop 表；连接指向不可用的本机端口 1，不访问业务数据库。
- 复用用户此前授权的原 DeepSeek Keychain 条目，不创建、复制或输出密钥。新应用若触发系统读取授权，由用户在 macOS 系统窗口完成。
- 正式安装 `/Applications/Nodal Studio.app` 保留；未替换、升级或发布正式包。正式数据已记录逐表行摘要，验收后再次比较。

原生工具报告 Mac 被锁定、无法自动解锁，尚未完成以下步骤。用户随后要求提交推送，并在其他电脑继续；没有以浏览器模拟、固定回答或后端测试代替原生效果证明。

待完成：

1. 在验收版打开 orders → AI，检查自动本地准备、实际发送摘要和一次明确发送操作。
2. 用已有 DeepSeek key 验证记录粒度与未知状态/币种问题，查看简短主答案、关键限定与引用，不发送真实业务元数据。
3. 检查证据定位返回、草稿比较/取消/确认、窄面板与大字号、错误反馈；确认用户能直接看到答案。
4. 使用新请求正文运行完整 8 项真实模型合成验收，逐项记录接受/拒绝与输出质量；本地预览 8/8 不代表此项已通过。
5. 再次核验正式应用版本和原用户数据摘要，记录本次运行的应用路径及验收截图。

所有已完成项与待完成项分开记录。当前不能宣称第一阶段已完成本机实际验收。

## 换机继续

先拉取 `main`，阅读本记录与体验方案。下一步是完成上面的原生和真实模型验收，不需要重新实施阶段一，也不要沿用 v0.1.2 旧回答作为新契约通过的证据。

在另一台 Mac 的仓库根目录，按 README 安装开发依赖后，可构建同一隔离验收应用：

```sh
git pull --ff-only origin main
pnpm install --frozen-lockfile
mkdir -p target/ai-redesign-validation
cat > target/ai-redesign-validation/tauri-review.json <<'JSON'
{"productName":"Nodal Studio AI Review","identifier":"com.claycosmos.nodalstudio.ai-review"}
JSON
pnpm tauri build --debug --bundles app --config "$PWD/target/ai-redesign-validation/tauri-review.json"
open "target/debug/bundle/macos/Nodal Studio AI Review.app"
```

`target/` 下的日志、合成快照、八题输入、验收脚本及本机应用数据没有进入 Git；钥匙串也不会随代码同步。换机后需重新准备仅含合成结构的验收来源，并在应用设置中配置该电脑可用的 DeepSeek key。不要导入真实业务数据来替代合成用例。隔离 identifier 使用独立数据目录，不覆盖正式安装。

八题覆盖：订单记录粒度、未知状态/币种、无行数据的统计、注释指令干扰、业务问题扩词、支付候选排序、客户—订单—支付路径、支付尝试粒度。后端真实模型入口是 `apps/desktop/src-tauri/src/live_model_acceptance.rs` 中的忽略测试 `live_model_tasks_use_prepared_scope_and_validate_real_answers`。先用新代码准备实际请求，再执行真实调用并保留每题结果；现有 `scripts/run_ai_model_acceptance.py` 是 Codex CLI 评估桥，不是 DeepSeek 验收器，不能混用其结果。

必要时复跑本地检查：`pnpm --filter @nodalstudio/frontend test --maxWorkers=2`、`pnpm typecheck`、`pnpm lint`、`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost cargo test -p ai-context -p nodalstudio-desktop --lib --tests`。现有检查结果如上；这些检查不代替原生或真实模型验收。
