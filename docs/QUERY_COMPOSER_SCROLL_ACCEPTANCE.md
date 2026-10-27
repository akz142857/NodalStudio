# Automatic context 输入框滚动修复

日期：2026-10-25。未提交、上传或发布。

## 修复

原生 WKWebView 中复现空 textarea 显示横向滚动条。此前只指定 overflow-y:auto，未显式限制横向溢出。现为输入框设置 overflow-x:hidden、white-space:pre-wrap、overflow-wrap:anywhere 和 wrap=soft，让普通文本及无空格长标识符换行，而非仅裁掉长文本。

保留原有自动增高、最大高度 min(180px,22vh)、宽度变化重算和 overflow-y:auto。软换行不在用户输入中插入新换行；显式换行保留。没有修改 AI 发送、SQL 执行或上下文选择逻辑。

## 验证

- QueryDraftPanel 回归：13 项通过；新增中英文长文本、无空格标识符、显式换行、Shift+Enter 不发送、清空禁用发送检查。
- ESLint 专项、TypeScript/Vite、Rust/Tauri 调试 app 构建及 git diff --check 通过。
- jsdom 测试不作为排版证据；排版由下述原生验收确认。

## 原生界面验收

复用隔离应用 `com.claycosmos.nodalstudio.change-review-p0` 及已有测试快照，使用当前源码重新构建。应用路径为 `target/debug/bundle/macos/Nodal Studio Change Review.app`。这是共享前端组件的非 MAS 调试原生验收，不是正式 MAS 签名/购买验收。没有替换 /Applications 中的正式应用。

macOS WKWebView、英文界面、深色、既有缩放配置下：

1. 旧包空输入框横向滚动条可见，保存 before.png。
2. 新包空输入框横向滚动条消失，保存 empty.png。
3. 粘贴重复中文句子及无空格长英文标识符：自动换行，达到高度上限后显示纵向滚动条，无横向滚动条；保存 long.png 与回滚后的 long-top.png。
4. 将长文本替换为短句，Shift+Enter 后输入第二行：高度缩回，换行可见，无需滚动；没有生成会话或发送请求，保存 short-multiline.png 和 native-final.ax.txt。
5. 清空后恢复 placeholder，发送按钮禁用；保存 cleared.png，退出隔离应用。

测试只操作输入框，未启用远程 AI、执行 SQL 或刷新数据库。证据与构建日志位于忽略目录 `target/composer-scroll-acceptance/`。本轮未宣称完成全部系统版本/分辨率矩阵或正式商店包复验。
