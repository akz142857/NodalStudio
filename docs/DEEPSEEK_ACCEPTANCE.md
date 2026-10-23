# DeepSeek 适配修复与合成验收

日期：2026-10-23（Asia/Singapore）。修复基于 v0.1.1 源码；本记录不代表已发布新版本或已替换 `/Applications/Nodal Studio.app`。

## 问题与修复

原始 8 项合成测试均返回 HTTP 200，但仅 5 项通过应用校验。DeepSeek 默认启用思考模式，推理消耗应用的 `max_tokens=2048` 预算：2 项最终文本为空，1 项 JSON 截断。先前仅在诊断桥中关闭思考模式后，失败的 3 项通过；该对照不能当作产品已修复。

本次将适配放入桌面共享请求构造器 `ai_chat.rs`：

- 仅对 HTTPS 官方主机 `api.deepseek.com` 添加 `thinking: {"type":"disabled"}`；不按模型名称、URL 子串或代理路径猜测提供方。其他 OpenAI-compatible 服务参数不变。
- 表解释、业务扩词、排序、路径解释、SQL 草稿及提供方连接测试共用适配。结构化任务仍保留 2,048 token 上限，不靠扩大预算或反复重试掩盖问题。
- 参数在准备预览时生成并参与请求绑定；实际发送与预览一致。
- 共享返回解析先检查 `finish_reason=length`，即使内容恰好是合法 JSON 也拒绝接收。界面收到明确的截断提示，建议缩短问题或缩小上下文后重新准备请求；不使用部分回答、不把推理文本当答案、不自动重试截断。

依据：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions 参数与结束原因](https://api-docs.deepseek.com/api/create-chat-completion/)。本适配针对官方接口；第三方转发地址不会自动接收 DeepSeek 专用参数。

## 修复后的实际模型测试

模型：`deepseek-flash`。同一批 7 张合成表、3 条物理外键、8 个问题；与失败基线保持相同提示词、结构、温度和 token 上限。没有业务行、真实业务结构或数据库凭据。

| 测试 | API / 应用校验 | 耗时 |
|---|---|---:|
| 订单表粒度与唯一性 | 通过 | 4.607 秒 |
| 未知状态码与币种 | 通过 | 4.050 秒 |
| 无行数据时的统计问题 | 通过 | 3.652 秒 |
| 数据库注释中的指令干扰 | 通过 | 2.833 秒 |
| 业务问题扩词 | 通过 | 2.540 秒 |
| 支付尝试候选排序 | 通过 | 3.763 秒 |
| 客户—订单—支付外键路径 | 通过 | 6.358 秒 |
| 支付尝试与订单的区别 | 通过 | 3.734 秒 |

**8/8 HTTP 成功、8/8 应用结构与证据校验通过，全部 `finish_reason=stop`，0 次重试，0 次输出修补。** 中位数 3.7485 秒，串行 API 耗时合计 31.537 秒；不是稳定性或性能基准。提供方报告输入 13,206 token、输出 3,192 token，输入缓存命中 5,120 token（已包含在输入量中），未推算费用。

实际测试调用当前桌面后端的准备、范围检查、HTTP 发送和输出校验，每题独立内存 SQLite。测试入口新增可选 `NODAL_ACCEPTANCE_PROVIDER_ENDPOINT` 和 `NODAL_ACCEPTANCE_MODEL_NAME`，让产品代码按真实提供方构造请求；仅在 `cfg(test)` 内将传输地址改到回环桥。桥校验完整请求与预览相等，再原样转发到官方接口，**不再修改模型名称或补加 thinking 参数**。旧的 CLI 验收默认参数保持兼容。

钥匙串密钥仅在测试进程内用于官方 API 认证，不写入文件。外部请求和原始响应、校验结果均独立保存在本地忽略目录，历史失败与诊断记录未覆盖。

## 本地回归与范围

- 桌面后端：73 项通过、6 项外部验收默认忽略；上述真实模型批次另行显式执行，内部 8 题不重复计作新增单测。
- 新增 7 项回归：官方主机匹配与其他服务兼容、空文本/不完整 JSON/完整 JSON 的截断拒绝、缺省结束原因的兼容、预览与实际发送一致、四类发现任务的参数、表解释与发现任务不重试截断。
- `cargo fmt --all -- --check` 和 `cargo clippy --offline --workspace --all-targets --all-features -- -D warnings` 通过。
- 本次未修改前端接口或持久化设置结构；错误仍由现有 AI 提示区展示。

本轮证明修复后的后端真实 API 通路通过这 8 项合成用例，不代表完整原生 GUI 点击流程、新安装包、SQL 草稿真实模型效果、真实业务库效果、业务负责人独立验收或长期稳定性已验证。

Codex 对照合成结构复核：排序优先选择 `payments`；未知状态和币种保持未知；无行数据时不编造统计；注释干扰仍按数据解释；两条外键字段映射与方向正确。路径回答仍有“非唯一订单号不能用于连接”及“主键不是跨表连接键本身”等过度概括。它们不影响本次截断修复的结构校验结论，但应作为回答质量问题保留，不能把 8/8 校验说成业务准确率 100%。

## 本机证据

- [修复后汇总](../target/deepseek-acceptance/2026-10-23/fix-validation/run-1/summary.json)
- [逐题预览、回答与校验](../target/deepseek-acceptance/2026-10-23/fix-validation/run-1/results.json)
- [API 指标](../target/deepseek-acceptance/2026-10-23/fix-validation/run-1/exchanges.json)
- [回归日志](../target/deepseek-acceptance/2026-10-23/fix-validation/desktop-tests.log)
- [Clippy 日志](../target/deepseek-acceptance/2026-10-23/fix-validation/clippy.log)

以上忽略目录链接仅在保留本机验收产物时可用。密钥、模型原始证据和本机应用数据不进入 Git。
