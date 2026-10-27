# 查询输入框国际化验收

日期：2026-10-25。未提交或发布。

## 修复与排查

QueryDraftPanel 的初次输入和追问 placeholder 原先直接写成中文。现分别使用 business.initialQuestionPlaceholder 与 business.followUpQuestionPlaceholder，接入现有 useI18n 的响应式翻译，并补齐英文、简体中文资源。

排查范围为 components/query 全部组件及 DiscoveryAssistant。没有发现其他未按语言切换的中文界面字面量。SqlEditor 的中文菜单/错误提示已有 locale 分支；query-context 中的中文属于问题识别规则，测试中的中文属于输入样例，均保留。

## 自动验证

- 前端完整测试：143 个文件、935 项测试通过。
- 新增回归：初次输入/追问中英双向切换；切换保留输入和已有问题；新对话恢复初次提示；未触发 AI 准备、生成或 SQL 执行。
- 修改文件 ESLint、TypeScript/Vite、Rust/Tauri debug app 构建及 git diff --check 通过。Vite 存在已有的大 chunk 提示。

## 原生验收

使用本轮重新构建的 target/debug/bundle/macos/Nodal Studio Screenshots.app，复用隔离测试数据库。macOS WKWebView，深色、125% UI 缩放。

1. 英文新对话显示 Describe your question, e.g. count orders by month…。
2. 输入演示问题并 Enter，AI 未配置，不发送远程请求；追问提示显示 Ask a follow-up or add filters…。
3. 在设置切换简体中文，返回后既有问题仍保留，追问提示显示 继续追问，或补充筛选条件…。
4. 新对话显示 描述你的业务问题，例如：按月统计订单数量…。
5. 恢复英文，初次提示恢复英文。截图中无横向滚动条，提示与周围界面语言一致。

证据：target/query-i18n-acceptance/ 下 en-initial.jpg、en-followup.jpg、zh-initial.jpg、zh-followup.jpg、final.ax.txt、tests.log、build.log。输入保留的完整双向切换由组件测试覆盖，原生验收确认会话保留和四种提示状态。

本轮是共享界面的非 MAS 调试原生验收，不是签名或真实购买验收；没有替换 /Applications 中应用，也没有提交、上传或发布。
