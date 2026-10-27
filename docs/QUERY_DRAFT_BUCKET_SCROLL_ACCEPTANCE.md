# Draft query 分档与滚动修复验收

日期：2026-10-25。未提交、上传或发布。

## 问题与处理

1. Generate SQL 是远程发送前的明确预览确认。本轮保留该确认，中英文输入提示明确 Enter 只准备预览、Generate SQL 才发送给 AI 服务商。SQL 仍须从编辑器单独运行。
2. 校验器原先拒绝 CASE 与所有窗口表达式；此前提供的金额分档/占比演示超出支持范围。本轮允许 CASE 的所有条件、结果、默认值递归接受原有字段及表达式校验；仅新增全局分组计数分母 SUM(COUNT(*)) OVER ()，不放开一般窗口、CTE、子查询或写操作。同步模型提示，说明 NULLIF 防零分母的表达式。
3. 会话原先仅在 turns 更新时滚动，子组件异步预览及错误没有触发。改为观察消息内容和尺寸变化：位于底部时跟随，用户上滚阅读时保持位置，新提交问题恢复跟随。
4. 请求错误后预览标题改为 Request details，避免误报 Ready to generate。

## 验证

- ai-context 全量测试通过：12 单元、9 discovery、8 understanding，共 29 项。覆盖 PostgreSQL/MySQL 分档与占比通过，以及未知 CASE 字段、隐藏子查询、任意函数、命名/分区/排序/帧窗口拒绝。
- QueryDraftPanel 与 DiscoveryAssistant 共 35 项前端测试通过，覆盖异步预览滚动、上滚后错误不抢位置、新追问恢复跟随、发送与执行仍分别受控。
- 未签名原生调试包构建成功。Nodal Studio Screenshots 中输入 shop_orders 分档问题及追问；原生截图确认最新预览与 Generate SQL 自动进入可见区域，输入区固定、无横向溢出，页脚说明已更新。
- 本轮未点击 Generate SQL，未向第三方发送该库结构，未执行数据库查询。真实 DeepSeek 生成与数据库实际运行结果未在本轮复验；截图没有包含此前被拒绝的原始 SQL，因此不能确定其是否另含 CTE 等仍不支持语法。
- 原生证据及测试日志：target/query-draft-buckets/。重启前用户演示会话保存为 before-restart.ax.txt / .jpg；SQL 编辑器原文仍保留。当前窗口停在新分档追问的未发送预览。

## 演示边界

独立演示问题应开启 New conversation，只有针对同一分析的追问才连续输入。按月补齐无订单月份需要日历生成或其他数据来源，当前受限子集仍不保证支持，不能将该示例作为已验收能力。


## 更新：取消发送前二次确认（2026-10-25）

按用户最新要求覆盖上文第 1 条：Draft query 提交问题或追问后，自动准备并校验上下文，再直接调用 AI，不再停留在 Generate SQL。中英文页脚说明 Enter 发送给 AI 服务商，SQL 仍由编辑器手动运行。请求详情和取消保留；其他 discovery 使用场景保持现有行为。

调整上下文勾选不会立即发送，只有提交问题或主动点击发送请求才发起；从其他入口带入的未提交问题也不会因挂载而自行发送。准备阶段取消或卸载会阻止后续发送；过期、上下文不匹配仍阻止发送。StrictMode 提交仅发送一次，追问取消旧请求，迟到结果丢弃。

验证：36 项前端测试通过，类型检查通过，未签名原生包构建成功。自动审批拒绝退出正在运行的应用，理由为可能丢失未保存会话或查询；新版本的原生直接发送复验待用户允许重启后进行，不能沿用上一版预览验收作为本轮直接发送的证明。本轮未新增远程模型请求、未运行 SQL、未提交或发布。

## 原生直接发送复验（2026-10-25，用户已授权重启）

用户确认内容已保存后，成功退出并启动最新 Nodal Studio Screenshots 验收包。窗口页脚显示 Enter to send to your AI provider；使用现有 DeepSeek/deepseek-flash 与 public.shop_orders 的 schema-only 上下文。此处补齐上一节待完成的原生复验，不涉及 MAS 签名或购买。

- 首问：新会话输入四个订单字段、order_number 升序、最多 20 行，按 Enter 后直接进入等待模型状态，没有 Generate SQL 确认；真实返回只读 SELECT ... LIMIT 20。
- 追问：点击发送按钮要求保留字段与排序、改为 10 行，直接进入等待状态；真实返回同一投影与排序的 LIMIT 10，英文解释明确只修改行数上限。
- 自动跟随：首问返回后，滚动条位于底部，SQL 草稿及 Review in editor 可见，输入框仍固定。
- 阅读历史：第二次请求等待期间手动上滚至第一条问题；返回后画面仍显示第一条问题和 LIMIT 20，未被拉回底部。history-before-result.jpg 与 history-after-result.jpg 保存了前后位置。
- 恢复跟随：在历史位置提交第三条追问“最多 5 行”，立即滚到最新问题和等待状态。
- 并发操作干扰：首次尝试时用户也在输入月度趋势问题，测试追问混入该输入并获得澄清回答。样本保存为 mixed-followup-result.ax.txt，不作为 LIMIT 修改成功证据；通知用户暂不操作后，独立新会话完成上述验收。

证据目录：target/query-draft-buckets/direct-native/，包含 initial-sent/result、followup-waiting/result、history-before/after-result、resume-follow-sent 的 AX 文本或原生截图。既有 36 项前端测试结果仍通过，本轮仅补验收记录、未改实现代码。所有请求只生成草稿，未点击 Review in editor 或 Run，未执行 SQL；未修改服务商或凭据，未提交、上传或发布。

第三条追问最终返回相同字段与排序的 LIMIT 5，最新回答底部与 Review in editor 自动可见（final-result.ax.txt / .jpg）。独立会话的三条真实 DeepSeek 请求全部完成：20 → 10 → 5，首问 Enter、第二条点击发送、第三条 Enter；均无二次确认，均显示 Nothing has run。当前验收窗口保留此会话，输入框为空、无进行中的请求。
