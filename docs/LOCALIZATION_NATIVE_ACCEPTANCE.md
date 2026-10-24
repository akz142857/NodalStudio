# 多语言真实桌面验收

日期：2026-10-24。平台：本机 macOS、Tauri 开发构建、原生 WebView；不是浏览器模拟。尚未发布安装包。

## 环境与数据

- 使用当前工作区源码构建，独立标识 `com.claycosmos.nodalstudio.locale-acceptance`，启动包装位于 `/tmp/Nodal Locale Acceptance.app`。未覆盖正式安装应用及其本地数据库。
- 使用仓库 `infrastructure/docker-compose.ai-acceptance.yml`，Compose 项目 `nodal-locale-acceptance`，仅本机随机端口。PostgreSQL 17.10 / MySQL 8.4.10。
- 测试数据为仓库 fixtures 及合成中文客户。测试脚本对一次性 PostgreSQL 库新增 `app.orders.acceptance_note` 以制造历史变更；应用负责采集、只读查询和本地模型编辑。
- 截图、测试日志和实际导出 CSV 保存在本机 `.private-docs/localization-native-2026-10-24/`（忽略提交）。

## 已实际操作通过

| 流程 | 观察与结果 |
| --- | --- |
| 中文 → 英文 → 中文 | 原生设置即时生效并保存；重启后中文、浅色主题、连接和本地关系恢复 |
| PostgreSQL 数据源 | 创建、测试、保存、系统凭据存储、采集成功；未加密状态有中文提示 |
| MySQL 数据源 | 创建、测试、保存、采集成功；TLS 已加密状态正确显示 |
| 对象树与详情 | 展开模式/表分类、选择 orders、字段/索引/约束详情显示；技术类型与数据库注释保留原文 |
| 画布 | 两种数据库的表及外键可见；本地逻辑关系保存后新增连线；右侧详情面板可开关 |
| 查询 | PostgreSQL 联表查询返回“中文验收客户 / 128.50”；MySQL 返回“中文验收 / MySQL / 0”；SQL 与已返回结果在切换语言后保留 |
| 本地知识 | orders 的双语说明保存成功 |
| 关系 | 创建 order_items.order_id → users.id 的本地逻辑关系，重启后恢复；类型不匹配提示已在真实后端返回后显示中文，创建按钮保持禁用 |
| 历史与变更 | 新增测试字段后刷新采集；两个版本可选择、比较；正确显示 1 项“添加字段”、前后属性及风险颜色 |
| 导出 | 系统保存窗口导出 CSV 成功，文件中文内容核对正确；范围文案和中文括号修复后已检查；解锁后最终原生窗口显示“导出当前查询结果”，取消后显示中文取消反馈 |
| 视觉与键盘 | 深色模型、浅色查询/变更/关系页检查；关系表单可滚动，Tab 可到达底部类型覆盖选项，操作按钮可达 |

| 125% 界面缩放 | 中英文设置、查询与模型布局检查；发现并修复画布底部裁切和连线端点偏移，自动适配后连线正确对齐；最终恢复中文、100% 缩放 |
| 锁屏恢复 | 解锁后此前 MySQL 查询已成功返回 1 行，耗时显示 31 毫秒；未复现查询故障 |

## 本轮修复

1. 连接诊断增加可选稳定 `code`，前端按码翻译空密码、认证拒绝、数据库不存在、权限不足、TLS 握手、连接不可达等应用诊断；未知和旧版诊断保留原文。
2. 关系验证增加与消息对应的 `messageCodes`，翻译字段数量、自连接、缺失字段、类型冲突、物理外键覆盖和重复关系等提示。
3. 补齐 React Flow 的连线/节点键盘辅助说明、移动播报和连接点名称；辅助文案不再误称可删除物理外键。
4. 修复历史摘要与对比摘要的英文风险等级；风险详情保持 `data-risk="medium"` 等稳定样式值，显示文本单独翻译。
5. 查询结果单行英文改为 `1 row`；导出范围改为完整插值句，修复中文语序和不配对括号。
6. 新增共享 `select.ds-select`，用于历史版本、变更筛选和关系类型。显式重置 WebKit 原生外观，统一高度、间距、圆角、焦点和下拉箭头，保留原生键盘/选项语义。
7. 查询导出原生窗口标题与文件类型标签接收应用解析后的语言；系统自身 Save/Cancel 等按钮仍由 macOS 系统语言决定。

8. 新增按应用缩放折算的共享视口宽高变量，供应用外壳和连接/关系弹窗使用；修复 125% 下画布底部工具栏、小地图被裁切。React Flow 使用独立于应用 CSS zoom 的坐标空间，图表通过自身缩放控制，修复字段端点偏移。
9. 布局保存成功反馈使用消息标识，在切换语言时重新翻译，避免保留切换前的英文；补充双语回归测试。

## 自动验证

- 完整前端：135 个测试文件、865 个测试通过。
- 后续风险样式和 IPC 语言参数回归：6 个文件、29 个测试通过（包含新增 3 个测试；未把局部测试数量误计为另一次全量运行）。
- 导出交互与文案覆盖补充回归：2 个文件、6 个测试通过。
- 解锁后缩放与语言切换修复回归：4 个文件、77 个测试通过（App、画布、关系详情定位、业务页中英文切换）；包含布局保存反馈切换语言的新增用例。
- Rust 连接诊断 3 个、关系验证 1 个、CSV/JSON/XLSX 导出 4 个测试通过；原生开发构建成功。
- ESLint、TypeScript/生产构建、`git diff --check` 通过。构建仍提示大分块警告。

## 验收边界

- 锁屏中断的原生导出标题与最大支持缩放（125%）检查已补完。新增截图包含 `export-native-zh.png`、`settings-zh-125.png`、`query-en-125.png`、`model-en-125-fixed.png` 和 `model-zh-final.png`。
- 本次窗口约 1440–1512 逻辑像素宽；没有宣称穷尽所有窗口尺寸、缩放、主题和业务状态的组合。
- Windows/Linux、签名发布包、真实 SSH 跳板/TLS 证书认证、在线 AI/云同步、本轮未逐项验收。
- 数据库原始值、SQL、注释、后端结构摘要（如 `text nullable`）、第三方品牌及未接入消息码的诊断保持原文；没有宣称所有英文均已消除。
- 验收应用保留在中文、100% 缩放的模型页，隔离测试服务及合成数据保留，便于继续人工复核；未覆盖正式应用、提交代码或发布安装包。

## 提交前追加体验修复

- 用户反馈三项主导航的当前页不明显：统一 selection 填色和 accent 内描边，选中状态持续显示，不依赖鼠标悬停/焦点。
- 首次查询闪屏根因为应用级 Suspense 替换整个外壳；改为查询内容区、设置和 DDL 覆盖层各自加载。DDL 背景保持挂载但 inert。延迟模块测试覆盖三条首次进入路径和导航唯一选中态。
- 全局补齐原生及语义点击控件的 pointer 光标；禁用、文本编辑、拖动/调整尺寸保持专用状态。移除画布对子按钮强制 default 的通配覆盖。
- 原生端复核查询/变更切换与 DDL 打开/返回；截图 `navigation-changes-fixed.png`。首次懒加载期间外壳保持挂载另由受控延迟回归测试验证。

提交前最终完整前端回归：136 个文件、870 个测试通过。生产构建通过（保留已有大分块警告）。

## 数据库可执行对象扩展（2026-10-24，主要桌面流程验收完成）

实现函数、存储过程、触发器的采集、分组搜索、详情及复制名称；PG 标识保留重载参数。新增目录确认的依赖/被引用列表，表详情包含触发器入口，物化视图包含索引详情。索引与约束补齐 PG 完整索引定义、MySQL 表达式/前缀/倒序、CHECK 和唯一约束。界面已接入中英文和共享样式。

快照新增字段默认兼容旧记录，空字段不改变旧快照的序列化形状。函数/过程/触发器的新增、修改、删除及依赖变化进入变更历史。第一次刷新旧版本采集的数据库可能显示新对象与补充的索引元数据，这是采集范围扩充，不代表数据库刚执行了对应 DDL。

已完成验证：

- 前端完整回归：137 个文件、872 项测试通过；共享详情抽取后的 3 个文件、14 项测试通过。ESLint、TypeScript 和生产构建通过，保留已有大分块提示。
- 真实 PostgreSQL 17 / MySQL 8.4：隔离项目 `nodal-locale-acceptance`。新集成测试验证重载、过程参数、触发器归属、函数/视图依赖、物化视图覆盖索引、MySQL 表达式/前缀索引及约束；重复采集指纹稳定。
- 新集成测试及 `fixtures/catalog-objects/` 已接入 CI 对应数据库任务，CI 远端运行结果尚未验证。
- 旧快照兼容、程序定义及依赖差异的 Rust 测试通过。开发版桌面构建成功。

验收边界：

- 解锁后已在隔离原生应用验证 MySQL 函数可见定义、权限不足定义提示、存储过程参数和函数体、触发器状态与定义，以及依赖点击定位到表详情。表检查约束展示正常，并修复检查/唯一/排他约束类型的中英文标签遗漏。
- 刷新曾停在系统钥匙串读取（线程采样确认 `capture_snapshot_using → Entry::get_password → Security`），并连带出现本地存储连接池超时。同步读取已移入阻塞任务，替换最终原生构建、解锁并重启后，PG 刷新、设置保存和数据源切换正常，后续刷新快速完成。
- PG 原生复核：重载函数标识与参数、SQL 完整定义、存储过程、触发器状态及到函数/表的依赖跳转、物化视图完整覆盖索引（含 INCLUDE）。MySQL 原生复核：表达式、前缀倒序与唯一索引、约束详情。
- 真实历史验收：仅在隔离 PG fixture 中将 `accounts.account_guard` 从启用改为禁用，界面捕获一项程序修改，前后属性显示启用→禁用；之后已恢复启用，并采集恢复快照。修复历史状态 O/D 原始码的中英文展示，原始摘要保留事实值。
- 中文 100%、英文/中文 125% 原生复核；检查范围约 1440–1920 逻辑像素窗口。修复从列表下方切换程序对象时详情标题不可见的问题，自动滚动并避开固定搜索栏。当前隔离应用保留中文、125%、MySQL 索引详情，供人工复核。
- 本地截图：`.private-docs/catalog-objects-2026-10-24/history-trigger-zh.png`、`function-en-125.png`、`mysql-index-zh-125.png`。本轮未穷尽所有主题、窗口尺寸和权限组合。
- Rust 核心 workspace 测试通过。桌面本地 AI HTTP mock 最初等待超时，在测试进程设置 `NO_PROXY=127.0.0.1,localhost` 与 `no_proxy` 后恢复；桌面套件 81 项通过、6 项忽略。没有改动正式应用的代理策略。
- 追加前端全量运行 871 项通过、1 项千表画布性能测试超时（与 Rust 编译并行）；该文件隔离重跑 2 项通过。新增详情及业务中英文的定向回归 2 个文件、10 项通过。此前完整 872 项通过的记录仍保留，追加运行不宣称全绿。
- 依赖仅来自 PG `pg_depend`/视图规则、MySQL 视图使用目录与触发器归属；未解析字符串函数体或动态 SQL，不宣称完整调用/读写图。MySQL 定义展示函数体与参数，不宣称提供可直接迁移执行的完整 CREATE 脚本。
- 较旧 MySQL 缺少元数据目录时按能力跳过；本轮未实测 MySQL 5.7。权限不足时可能看不到对象或函数体，详情保留不可见提示。
- 本轮没有发布安装包或改动正式用户数据；上一轮测试 DMG 不包含本轮扩展。

最终追加回归：对象详情/历史 2 个文件、13 项测试通过；ESLint、TypeScript/生产构建、桌面 Clippy 和格式/差异检查通过。保留已有大分块警告。

## Central object documents — 2026-10-24

- Functions, views/materialized views, procedures and triggers now open in a central read-only object document. Tree selection and disclosure state remain in the sidebar. Table inspector trigger/dependency links use the same navigation.
- Definition, properties and dependency sections use shared tokens and segmented controls. The read-only CodeMirror viewer provides syntax highlighting, line numbers, wrap control, copy and document search. Missing definitions retain an explicit permission/availability message.
- The canvas remains mounted at the same dimensions, invisible and inert while an object document is open. Its interactions are paused. Returning to the diagram does not issue a locate request or reset its saved view. Following a table dependency deliberately locates that table.
- Native validation used `/tmp/Nodal Locale Acceptance.app` (existing isolated Tauri development wrapper, backend reports 0.2.2-beta.1; current frontend served by Vite). This is not validation of a newly packaged release.
- At 125% UI scale, verified MySQL functions, procedures, triggers, views, view-to-table dependency navigation, and table-inspector-to-trigger navigation. Verified PostgreSQL materialized-view definition/indexes and overloaded function identity. Verified Chinese and English native UI.
- A temporary MySQL function `catalog_document_long_acceptance` with 800 comment lines was created only in the dedicated `nodal-locale-acceptance-mysql-1` fixture container. Native search reached the final `RETURN value_in` statement; the tree and document header stayed in place. The temporary function was dropped and the model refreshed afterward. Acceptance snapshot history can retain this synthetic fixture.
- Compared native screenshots before/after opening and closing a function: central canvas crop `(1250,400,3000,1780)` in 3840×1996 screenshots was pixel-identical. This verifies the sampled viewport, not every possible sidebar size or window configuration.
- Evidence (ignored local files): `.private-docs/object-documents-2026-10-24/long-definition-zh.png`, `function-en.png`.
- Validation: existing full frontend suite 137 files / 873 tests passed; new reader tests 2 passed separately. App navigation regression verifies canvas DOM identity/inert state, preserved sidebar search and no layout save on document open/close. TypeScript, lint and frontend production build passed (existing large-chunk warning remains).
- Scope: single reusable central document; pinned/multiple document tabs and document navigation history are deferred. No new installer was built in this change.
