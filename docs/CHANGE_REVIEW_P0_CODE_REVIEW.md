# P0 代码复审与 SQL 编辑器右键入口

日期：2026-10-25。审查范围为当前未提交 P0 的存储、知识确认、采集收据、保留/清理、桌面 IPC、前端分页与预览，以及新增 SQL 右键执行入口。没有提交、推送或发布。

## 已修复发现

| 优先级 | 问题与触发条件 | 修复 |
| --- | --- | --- |
| P1 | 连接配置变化后，直接重新建立起点可能将旧连接采集结果绑定到当前身份；失败采集后的重建也没有先决校验 | 建立/重建起点检查采集收据，拒绝失败收据或与当前身份不符的成功收据；要求刷新成功。无收据的旧快照继续明确显示覆盖未知 |
| P2 | start/restart/complete 接受单项 key 并写入事件，旧重放逻辑可能将带有匹配证据的轮次事件当作事项已阅 | 轮次动作拒绝 itemKey；重放仅认可 seen、seenBatch、defer、acceptLimitation，兼容防御旧异常记录 |
| P2 | 确认或归档后保留的草稿，在相同对象再次出现或恢复时覆盖输入框中的当前原文 | 成功确认/归档/恢复后仅清除对应对象草稿；失败保持草稿。保存期间不开始后台重载，成功响应更新请求代次及版本 |
| P2 | 处理记录搜索只检查单项 title，批量事件没有单项 title，导致按成员对象名检索不到批量已阅记录 | 服务端搜索包含批量事件所有成员标题，保持大小写不敏感 |

## 回归范围

新增测试覆盖轮次动作带 key 的零写入拒绝、旧异常事件不会解决待办、错误连接/失败采集不能重建基线、批量成员搜索、恢复原文不会沿用旧草稿、确认后外部新文本不会被旧草稿覆盖。补充了空批次、重复 key、未知 key、超过 100 项的事务不变性断言。

复核了既有分页 source/filter/revision 绑定、全局完成校验、归档不覆盖现有文本、不恢复确认、缺失对象不可确认、操作幂等、审计失败回滚与同步队列原子性。后端分页仍在完整影响投影后执行，本次未宣称改善完整投影计算成本。

## SQL 编辑器右键

沿用现有菜单组件、SQL 方言解析和 QueryPage 只读执行入口：

- 执行选中 SQL；无选区时禁用。
- 执行光标当前语句；空语句、不可执行环境或查询执行中禁用。
- 执行中提供停止查询。
- 保留右键时选区，支持 Shift+F10、方向键、Enter、Escape；文本或选区变化后关闭旧菜单。
- 仍使用现有来源、行数限制、超时、只读校验及历史机制，不增加写入 SQL 能力。

自动化覆盖实际 QueryPage 调用参数、选区保留、当前语句解析、空输入、停止查询、重复执行禁用、键盘打开/关闭、修改文本关闭旧菜单。

## 验证证据

日志位于 `target/change-review-code-review/`：

- 最终全量前端 140 个文件、908 项通过（`frontend-final.log`）。
- 存储层 46 单元 + 16 集成，共 62 项通过（`store-verified.log`）。
- SQL / 复核专项 24 项通过（`focused-final.log`）。
- Rust Clippy（store、desktop、all targets、warnings denied）通过（`clippy.log`）。
- TypeScript、Vite 生产资源构建、独立原生 debug app 构建通过（`native-build.log`）；Vite 保留既有大 chunk 提示。
- 全量 ESLint 找到两处新增测试的类型/async 风格错误，修复后四个本轮实现/测试文件的 ESLint 复检通过（`lint-recheck.log`）；其余文件全量扫描未报问题。
- `cargo fmt --all -- --check`、`git diff --check` 通过。

原生验收仅使用 `com.claycosmos.nodalstudio.change-review-p0` 开发应用，不替换 `/Applications` 正式安装。已验证右键保留 `SELECT 2;` 选区、菜单显示及位置、Escape 关闭、Shift+F10 打开、无选区时仅禁用选中 SQL 执行。截图 `native-sql-context-menu.png`、AX `native-sql-context-menu.ax.txt`。本轮未连接数据库执行 SQL；QueryPage 的实际执行参数及取消路径由自动化测试覆盖。
