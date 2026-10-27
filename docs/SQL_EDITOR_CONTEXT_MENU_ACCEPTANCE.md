# SQL 编辑器右键编辑能力验收

日期：2026-10-25。未提交、未推送、未发布。

## 行为

现有执行选中 SQL、执行当前语句和停止查询入口不变，新增复制、剪切、粘贴、全选与格式化。复制/剪切没有选区时禁用；空文本不能格式化。编辑草稿不依赖数据库连接，不绕过原有只读查询校验。

复制保留原始选区文本。剪切必须先成功写入剪贴板才删除选区；粘贴替换选区或插入光标位置，空剪贴板不删除选区。异步剪贴板或首次格式化加载期间发生编辑/选区变化，即使再改回原状，也拒绝覆盖旧位置；切换编辑器或卸载后不修改新实例。失败显示可见提示并保留原文。

格式化使用按需加载的 [sql-formatter](https://github.com/sql-formatter-org/sql-formatter)，明确使用当前 PostgreSQL/MySQL 方言，不调用 AI 或网络服务。有选区时仅格式化选区并保留边界空白；无选区时格式化全文。不做参数替换或强制修改关键字/标识符大小写。解析失败不改动 SQL。剪切、粘贴、格式化均为可撤销的独立编辑事务。

撤销测试发现异步编辑后旧 React 被动同步可能覆盖撤销结果，已将外部值同步移至布局阶段，相关回归覆盖剪切、粘贴及格式化的一步撤销。

## 自动化与原生证据

日志保留于 `target/sql-editor-menu-acceptance/`：

- 最终全量前端 141 个文件、919 项测试通过（`frontend-final.log`）。
- 专项测试 24 项通过（`focused.log`），其中新增编辑菜单测试 11 项，覆盖原文复制、剪切失败不删除、空粘贴不清空、延迟操作遇到编辑/选区 ABA 时拒绝、全选、两种方言的字面量/引用标识符/参数保留、选区格式化、格式化失败保留原文、一步撤销。既有 QueryPage 执行与能力测试同跑通过。
- TypeScript 通过（`typecheck.log` 及最终构建）；全量 ESLint 通过（`lint-final.log`）。
- 最终 Tauri debug 原生构建通过（`native-build-final.log`），Vite 保留既有大 chunk 提示。
- `git diff --check` 通过。

原生验收使用独立 `com.claycosmos.nodalstudio.change-review-p0` 应用，未替换正式安装。实际通过菜单复制 `select 'copy-test';`、在新行粘贴、剪切后撤销、菜单全选、格式化选区、格式化后撤销。无选区时复制/剪切禁用，原执行入口仍存在；SQL 从未通过这些编辑动作自动执行。本次未重新连接真实数据库执行查询。

证据：`native-menu.png`、`native-formatted.png`、`native-formatted.ax.txt`、`native-format-undo.ax.txt`。原生深色、125% 缩放下菜单可完整显示，没有越界。
