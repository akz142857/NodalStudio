# Nodal Studio Code 扩展功能开发方案

2026-11-26 · 产品、工程与发行评审修订稿

产品目标是在 Nodal Studio Code 中提供类似 VS Code Extensions 的「扩展」入口。用户可以自行查找和安装兼容扩展、查看已安装及运行状态、启用、禁用、更新和卸载。扩展由兼容宿主运行，能在 Code 工作区提供诊断、语言服务等能力。 [VS Code 扩展管理](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)

「检查」是 Code 的底部结果面板。P0 的内置 Markdown 检查和 P1 的项目 ESLint 已在开发版接入。macOS 预览版支持本地 VSIX 安装及 Open VSX 搜索、详情、安装和更新，复用底部诊断和结果定位。第 7.3 至 7.5 节记录原型范围与验收，包括从 VSIX 启动的 ESLint 语言服务器。 [Code View 开发计划](CODE_VIEW_DEVELOPMENT_PLAN.md) · [文件树设计](CODE_FILES_TREE_DESIGN.md)

## 1. 产品范围与交付顺序

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| P0 · 审阅检查 | 随应用打包 `markdownlint`。先打通从 Changes 打开文件、检查当前文件并跳回对应 Diff，再支持批量检查变更中的 Markdown 文件。 | 在含 Markdown、TS 和 SQL 的本地项目离线验收。真实 Markdown 结果能按目标改动行筛选，其他文件有明确的覆盖状态。 |
| P1 · 项目检查工具 | 在直装桌面版接入用户授权的本地 ESLint，用项目配置检查 JS、TS、JSX、TSX。 | 在真实项目验证规则定位、多包项目的配置选择、缺工具或解析器、取消、超时和授权撤销。 |
| P2 · 扩展管理与兼容宿主 | 先打通本地 `.vsix` 安装、启用、禁用、卸载和扩展实际运行，再接入 Open VSX 的搜索、安装和更新。 | 在真实项目中安装两类扩展并使用各自的功能，验证重启后的安装状态、兼容性提示和扩展停止后的行为。验收范围见第 7 节。 |

检查结果供用户判断是否标记「已阅」或「需修改」。Code 继续使用只读阅读器。内置检查直接处理文本，外部工具的执行权限见第 5 节。

## 2. 用户流程

1. 点击 Code 底部状态栏的错误／警告计数，在状态栏上方打开「检查」。拖动面板上沿可以调整高度。右栏继续显示大纲，检查入口独立于大纲和 LSP，在 Mac App Store 候选构建中也可打开。检查结果支持键盘操作和定位。 [Code 工作区](../../apps/frontend/src/components/code-view/CodeReviewWorkspace.tsx)
2. 「检查当前文件」使用正在显示的版本，并标明「工作树」或「暂存区」。普通目录支持单文件检查。删除文件的基准预览、外部依赖源码、二进制和未支持的文件类型应显示为何无法检查。普通目录、Git 不可用和 Changes 为空时，分别说明批量入口不可用的原因。
3. 「检查变更文件」复用 Changes 的基准和文件清单。开始前按文件类型和已有目标状态估算数量，读取、超限等结果在运行后按实际情况统计。
4. 结果按文件分组，显示严重度、规则编号、消息、行号及工具名。有 Diff 时默认显示「改动行上的发现」，同时显示全部结果数，切换「全部结果」直接使用已有结果。文件级和位置待确认的发现有独立标签。Source 和缺少可用 Diff 的文件默认显示全部结果。
5. 点击结果打开对应文件版本并定位。Diff 自动展开所在折叠区，只有行号的结果定位整行，缺行号的结果打开文件。旧版本结果可供查看，定位和内联标记需通过版本复核。审阅状态与备注仍由用户主动修改。

运行状态、覆盖情况和发现数量分别展示。只有至少成功检查一个文件、请求范围完整且全部结果为零时显示「未发现问题」。零候选显示「本次没有可检查的文件」。部分文件成功且零发现时显示「已检查范围内未发现问题」及跳过、失败或未处理的数量。全部失败、取消或旧版本各有状态。默认筛选结果为零时，仍提示其他行或文件级结果的数量。

## 3. 实现结构

| 层 | 实现职责 |
| --- | --- |
| 项目输入 | 复用 `CodeReviewPlatform.changes` 和 `file`。原生层校验项目根及真实相对路径。协调器保存运行开始时的比较标识，按第 3.2 节复核实际读到的版本。 [原生项目读取](../../apps/desktop/src-tauri/src/code_view/review.rs) · [平台接口](../../apps/frontend/src/platform/code-review.ts) |
| 检查提供器 | P0 延迟加载随包分发的 `markdownlint` 浏览器构建，在 Web Worker 内检查文本。P1 通过受控的原生入口调用固定的 ESLint 适配器。提供器返回统一格式。 [markdownlint 浏览器 API](https://github.com/DavidAnson/markdownlint#browser) |
| 检查协调 | 每个 Code 项目会话最多一个活动运行。切换文件、关闭检查面板或切到审阅笔记时继续运行。用户取消、启动新运行、换项目、关闭工作区或工作区卸载时终止旧任务。用 `runId` 和 `projectId` 拒绝迟到结果。 |
| Code 界面 | 检查结果显示在底部面板，复用 CodeMirror 阅读器和 `@codemirror/lint`。增加按版本和视图定位的入口，Diff 展开折叠区后再定位。检查标记各自维护，与查找及符号引用高亮共存。 [工作区](../../apps/frontend/src/components/code-view/CodeReviewWorkspace.tsx) · [阅读器](../../apps/frontend/src/components/code-view/CodeReviewReader.tsx) |

现有 `crates/extension-model` 表达数据库变更来源、环境漂移等模型。检查任务与结果归 Code 工作区。跨提供器的结构在第二个工具接入时验证再提炼。

### 3.1 输入和结果契约

| 记录 | 字段与约定 |
| --- | --- |
| 检查运行 | `runId`、`projectId`、范围（当前文件／变更文件）、适用时的 Git 基准、工具及版本、配置来源及可验证的摘要、开始时间、运行状态、覆盖统计。 |
| 文件版本 | 真实相对路径、工作树或暂存区、实际检查文本摘要、结果视图（Source／Diff），以及适用时的比较基准和非空 `evidence`。即使文本相同，也保留工作树与暂存区的区别。 |
| 检查结果 | 提供器及规则编号、消息、严重度、文件版本、可选的半开范围、改动行分类。内部使用零基行号和 UTF-16 列，界面显示一基行号。缺列保留行级定位，缺行保留文件级定位。 |
| 文件检查状态 | 成功、跳过、失败、未处理或需重新运行，附具体原因。文件数与发现数量独立计数，失败项可单独重跑。 |

检查输入、Source 和 Diff 两侧均去除开头 BOM，将 CRLF 和单独的 CR 转为 LF，并保留末尾换行。适配器将坐标转换并验证在当前文本内，越界列退到有效整行，越界行退到文件级。拒绝其他文件的结果和无效输出结构，消息按纯文本呈现。结果仅保存在当前项目会话。

### 3.2 Diff 范围和版本一致性

- **冻结比较范围。** 批量开始时复制项目会话、基准、路径和 Changes 的 `evidence`。逐个调用原生 `file(..., true)`，将返回值与冻结条目核对。手动刷新会更新原生缓存，返回了有效文档也可能与运行开始时的范围不同。证据发生变化时提示重跑。证据缺失时记录无法核对的原因，若工作树文本可读，用户仍可从 Source 单独检查，按内容摘要验证。
- **选定目标版本。** Source 读取工作树。Diff 检查返回文档的 `after`，以 `Document.indexOnly` 确定是否为暂存区专有版本。P0 支持两类文本，P1 首版跳过暂存区专有版本。删除文件保留基准预览，重命名按新路径定位。仓库没有提交时，仍可使用 Changes 已确认的新增文件及其空基准。
- **计算改动行。** 对目标完整文本运行检查，按结果范围和 Diff 目标侧行区间是否重叠来分类。阅读器与检查器共享规范化和 diff 参数，用 CodeMirror `Chunk` 的 `fromB`／`toB` 计算目标侧半开区间，处理 EOF 越界和纯删除的空区间。精确命中优先，涉及不精确区块的其余发现进入「位置待确认」。已知新增文件的目标行均属改动。分类仅表示发现所在的行。 [CodeMirror Merge API](https://codemirror.net/docs/ref/#merge)
- **复核结果。** 发布结果、刷新项目、打开旧结果或点击定位时，复核会话、目标种类、版本摘要和适用的比较证据。P0 同时复核被冻结的规则来源和内容。遇到内容、暂存目标或可验证配置变化时，移除内联标记并提示重跑。Diff 定位先展开包含结果的折叠范围，再选中并滚到目标行。

### 3.3 任务与覆盖

依次处理文件，保留正在处理的文本和已生成的必要结果。P0 试验预算为单文件 512 KiB、每次 200 个候选、整个批次累计 16 MiB、保留 2,000 条结果、单文件 Worker 检查 5 秒和整批 60 秒。用真实项目和大文件样本测量后确认数值。

分别显示 Changes 枚举不完整、未检查的文件和结果截断。单文件超时终止 Worker，记为失败，并重建 Worker 处理下一项。用户取消或批次到达时限时终止任务，标记未完成项。已完成结果仍附着原版本。

## 4. 提供器接入计划

### P0 · Markdown

- 锁定 `markdownlint` 版本，使用字符串入口和结构化输出。规则编号、坐标与同版本上游结果对照，严重度由适配器明确映射。引擎随应用打包成同源 Worker。若打包版本加载失败，在「检查」中显示原因。 [引擎输入和输出](https://github.com/DavidAnson/markdownlint#usage)
- 支持 `.md`、`.markdown`，以及项目根目录工作树版本的 `.markdownlint.json`。用现有原生文件入口读取配置，运行全程使用同一份静态配置。配置不存在时使用并标明「内置默认规则」。配置无法读取、JSON 损坏、含继承或自定义规则时说明原因并停止该次运行。界面明确首版支持的配置格式，内联禁用注释沿用引擎约定。 [markdownlint 配置](https://github.com/DavidAnson/markdownlint#config)

### P1 · ESLint 与其他语言

- 先锁定并公布支持的 Node、ESLint 主版本、配置格式及解析器矩阵。按项目和目标文件所在包解析工具和配置，记录该次运行实际使用的工作目录、工具路径与版本。JS、TS、JSX、TSX 以项目已装解析器和规则为准。
- 原生层通过系统进程 API 直接调用已核验的 Node 和 ESLint JS 入口。使用 `--stdin --stdin-filename` 传入固定文本快照和原生验证过的工作区文件路径，读取有大小限制的 JSON 输出。退出码 0 或 1 结合有效输出区分成功、发现问题、被忽略和源文件解析错误，退出码 2、启动失败及无效输出另行报告。调用只使用适配器设定的参数，Windows 同样直接调用 Node。自动安装和自动修复留在应用外。 [ESLint CLI](https://eslint.org/docs/latest/use/command-line-interface#exit-codes)
- ESLint 的插件和动态配置可读取依赖、环境和其他文件。记录可验证的上下文，每次主动检查重新运行，刷新项目或发现工具、配置或依赖变化时提示重跑。两种提供器完成后，再按实际审阅需求评估 YAML 检查、Java 的 P3C/PMD 或 LSP 诊断。LSP 诊断须另行验证异步结果的版本关联。 [ESLint 插件](https://eslint.org/docs/latest/use/configure/plugins) · [P3C-PMD](https://github.com/alibaba/p3c/tree/master/p3c-pmd) · [现有 LSP 接口](../../apps/desktop/src-tauri/src/code_view/definition.rs)

## 5. 分发与运行边界

| 发行方式 | 方案 |
| --- | --- |
| macOS / Windows 直装桌面版 | P0 随应用打包，验证 WKWebView 和 WebView2 的离线 Worker 加载。P1 只对获授权的本地工具开放。 |
| Mac App Store 版 | P0 以随包引擎和纯数据配置作为候选，用签名沙箱构建验证检查入口、授权目录及重启后书签恢复。P1 外部工具命令在原生层禁用，并验证直接 IPC 无法启动进程。发行以实际审核为准。 [Apple 审核指南 2.4.5 与 2.5.2](https://developer.apple.com/app-store/review/guidelines/#software-requirements) |
| Web | 沿用当前 Code 的桌面入口。将来如有支持本地项目的产品入口，可复用纯文本检查器及其坐标模型。 |

P0 使用打包的同源静态 Worker 和已授权项目中的文本与 JSON，沿用现有内容安全策略。上线前验证断网、加载失败和超时恢复。 [Tauri 配置](../../apps/desktop/src-tauri/tauri.conf.json)

P1 的 JS 配置及插件会以本地工具进程的权限执行，可能读取、写入文件或联网。授权提示展示项目、实际工具和运行时以及可获得的权限。目录选择、LSP 和检查工具各自授权。原生层先核验项目会话和工具身份，再执行检查及任何会加载配置的探测。工具身份变化时重新授权。仅向进程传递适配器需要的环境变量，避免传递应用凭据。 [ESLint 插件](https://eslint.org/docs/latest/use/configure/plugins)

macOS 进程组和 Windows Job Object 用于管理进程树。实测取消、超时、切项目、撤销和退出时受管进程均结束。完全离线模式由原生入口阻止 P1 启动，开启时也终止活动任务，P0 继续可用。 [现有原生离线限制](../../apps/desktop/src-tauri/src/commands/settings.rs)

发布前核对随包引擎及传递依赖的版本、来源和许可证，确认预打包 Worker 资源也被第三方公告覆盖。按发行渠道更新相关说明并通过现有打包校验。 [仓库的许可清单流程](../legal/README.md)

## 6. 验收与发布条件

| 场景 | 通过标准 |
| --- | --- |
| P0 · 真实审阅 | 断网从 Changes 打开一个 Markdown 文件，运行检查并点击结果回到同一 Diff。样本包含改动行和已折叠的未改动行各一条规则发现，切换「全部结果」可看到并定位第二条。随后执行批量检查，TS、SQL 等跳过原因和工具来源可见。 |
| P0 · 行号和导航 | 两侧含 BOM、CRLF 或单独的 CR，另测中文、Emoji、末尾无换行、多行和无列范围。键盘可定位到正确视图和实际行，包含结果的折叠范围自动展开。 |
| P0 · Git 与刷新 | 覆盖新增、EOF 纯删除、已删文件、重命名、普通目录、无提交基准和枚举上限。暂存区与工作树同文或异文都能区分。在冻结清单后、读取文件前手动刷新，受影响文件提示重跑。 |
| P0 · 状态与回归 | 分别验收完整零发现、零候选、部分覆盖、全部失败、取消和配置变化。超限、Worker 异常、项目切换和连续重跑后，旧结果不会覆盖当前。检查前后核对工作树、Git 索引、人工审阅标记及备注，回归查找、引用高亮、定义跳转和大纲。 |
| P0 · 桌面打包 | macOS WKWebView 与 Windows WebView2 用实际安装构建验证首次离线加载、终止及重跑 Worker。Mac App Store 候选额外验证沙箱目录授权恢复及无 LSP 大纲时的检查入口。 |
| P1 · 工具与权限 | macOS 和 Windows 使用真实 JS、TS 和多包项目，覆盖解析器或配置缺失、忽略文件、规则发现及坏输出。验证直接调用原生入口也遵循发行版、完全离线和项目授权约束，取消或退出后无残留进程。 |

P0 先完成单文件 Diff 定位，再进入批量开发。P0 的功能验收须通过真实引擎对照、坐标和版本回归及 macOS 原生交互测试。各发行渠道须通过对应的实际安装构建验收后才开放。P1 先验证进程生命周期和发行门禁，再开放项目授权入口。

## 7. 扩展管理与 `.vsix` 兼容

### 7.1 扩展入口和使用流程

1. 在 Code 中打开「扩展」，查看已安装的扩展、发布者、版本和启用状态。可从本地选择 `.vsix` 安装。安装和启用分别显示状态，启用后展示实际运行状态及错误原因。
2. 管理扩展的启用、禁用和卸载。在项目里启用可运行代码的扩展前，显示其来源和所需的工作区访问。禁用或卸载后结束该扩展的活动并清理其界面结果。
3. 在「Open VSX」页签搜索并打开详情，查看发布者、许可证、版本及预览版兼容性。在「已安装」页签检查更新，打开目标版本详情并确认更新。 [Open VSX](https://open-vsx.org/)

### 7.2 宿主原型和验收

兼容原型优先考察 Eclipse Theia。在实际宿主中验证扩展激活、工作区文档和所需的 `vscode` API。记录可用能力和已知限制。主题、语法、诊断、命令及调试器分别看扩展实际依赖的 API、运行环境和许可。 [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) · [Theia 兼容说明](https://theia-ide.org/docs/user_install_vscode_extensions/)

首轮用两类扩展验证安装和运行流程。诊断候选包括 markdownlint，再选择一款语言或语法扩展。核对发行包和兼容性后锁定样本版本。诊断须由扩展发布，显示在底部「检查」里，并能跳回对应文件和行。语言或语法扩展须在 Code 中生效。两类都要验证禁用、卸载和重启后的状态。 [markdownlint 扩展源码](https://github.com/DavidAnson/vscode-markdownlint)

为每个候选包记录来源、发布者、版本、哈希、平台及许可。发行包可来自符合许可的本地 `.vsix` 或 Open VSX。微软及其关联方发布在 Visual Studio Marketplace 上的扩展有特定使用限制。 [微软 Marketplace FAQ](https://code.visualstudio.com/docs/supporting/faq#_can-i-use-a-microsoft-extension-outside-of-vs-code)

发行前独立验证兼容宿主的进程生命周期、版本固定及更新失败恢复。验证文件、进程和网络的访问边界。项目文件访问限制在获授权的工作区内，Nodal 的数据库连接和凭据留在应用自身的进程中。

### 7.3 macOS 本地 VSIX 原型

Code 左侧项目标题旁的「扩展」入口使用系统选择器安装本地 VSIX。安装包保存在预览版的应用数据目录，安装后默认禁用，启用状态按项目保存。卸载会移除安装包及其项目授权。

Theia 的 VS Code 插件宿主依赖其前后端服务。本次原型在 WKWebView 的 Worker 中使用 QuickJS WebAssembly 运行浏览器扩展的诊断入口。该解释器接收当前 Markdown 文档快照及静态规则配置，虚拟文件系统仅提供该快照。声明式语言扩展通过 TextMate 语法给 CodeMirror 着色。通用 VS Code API、Node 扩展和语言服务器留待后续兼容宿主。 [Theia 插件宿主架构](https://github.com/eclipse-theia/theia/blob/master/doc/Plugin-API.md)

```sh
pnpm --filter @nodalstudio/desktop tauri build --debug --features code-extensions-preview --bundles app --config src-tauri/tauri.code-extensions-preview.conf.json
```

使用真实 NodalStudio 项目完成两份原版 Open VSX 包的安装、启用、运行、禁用和卸载。两份包均为通用平台与 MIT 许可。重启并重新打开项目后，两份包保持启用。卸载后再次重启，扩展列表保持为空。

| 验收包 | SHA-256 | 在 macOS 预览版中观察到的行为 |
| --- | --- | --- |
| [DavidAnson.vscode-markdownlint 0.62.1](https://open-vsx.org/api/DavidAnson/vscode-markdownlint/0.62.1/file/DavidAnson.vscode-markdownlint-0.62.1.vsix) | `b6baf90037c903aa21b9c525972910561a903b82e12fe8d67220740ec15b1aa0` | 从底部「检查」运行该 VSIX 后，点击 `MD012` 定位到 `README.md` 第 101 行第 1 列。禁用后扩展结果和计数清空。 |
| [vscode.docker 1.95.3](https://open-vsx.org/api/vscode/docker/1.95.3/file/vscode.docker-1.95.3.vsix) | `5de2f31e7e8e9c64b17d0b2eb915a5c14653904376a06d07f2229890fe296078` | `apps/frontend/Dockerfile` 使用该扩展的 Docker 语言模式并高亮 `FROM`、`AS` 等关键字。禁用或卸载后立即恢复纯文本。 |

### 7.4 Open VSX 原型

市场详情读取通用平台版本的公开元数据及扩展清单。安装或手动更新使用用户确认的稳定版本。原生层核对注册表的 SHA-256、包内扩展 ID、版本与宿主兼容性。下载使用 Open VSX 及其官方 CDN，完全离线模式会中止网络请求。 [Open VSX Registry API](https://github.com/eclipse-openvsx/openvsx/wiki/Registry-API)

新安装默认禁用。更新在校验完成后原子替换安装目录，保留各项目的启用状态。下载、校验或替换失败时原版本仍可用。更新成功后清除旧版本诊断，重新运行会加载新版本。

2026-11-27 在 macOS Open VSX 预览版和真实 NodalStudio 项目中，通过市场搜索并打开 `DavidAnson.vscode-markdownlint` 详情，选择安装 0.62.1，启用后在底部「检查」运行。检查更新发现 0.63.1，安装后启用状态保留、旧诊断清空。重新运行仍得到 `MD012`，点击定位到 `README.md` 第 101 行第 1 列。再次检查显示没有可用更新。0.63.1 的 SHA-256 为 `a3cfccc3714febf06b895eb70af301a8eb64ac5b14029e7527eb025558156967`。 [0.63.1 注册表元数据](https://open-vsx.org/api/DavidAnson/vscode-markdownlint/universal/0.63.1)

### 7.5 VS Code ESLint 扩展的诊断

macOS 预览版支持 Open VSX 上的 `dbaeumer.vscode-eslint` 3.0.34 通用包，许可证为 MIT。原生层固定安装包和 `server/out/eslintServer.js` 的 SHA-256，用本机 Node 启动经过校验的原版服务器。兼容范围为 JS、TS、JSX 和 TSX 的只读 LSP 诊断，复用项目安装的 ESLint 9 或 10 与 JavaScript flat config。 [Open VSX 扩展](https://open-vsx.org/extension/dbaeumer/vscode-eslint) · [上游服务器](https://raw.githubusercontent.com/microsoft/vscode-eslint/release/3.0.34/server/src/eslintServer.ts)

安装和启用后，在底部「检查」选择「运行 ESLint（VSIX）」。授权显示 VSIX 服务器、本机 Node、项目 ESLint 和配置路径。授权绑定项目会话、安装包和工具身份。禁用、卸载、撤销、切项目或取消运行会结束相应任务。诊断使用编辑器文档快照，结果归入底部「检查」并复用行列定位。

安装包 SHA-256 为 `ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308`。服务器文件 SHA-256 为 `baf39a57d3e04d63140a1d606b76042ccca304309846b2b0374c60d1caacbdb2`。

2026-11-27 在真实 NodalStudio 仓库的 macOS ESLint VSIX 预览版中，从 Open VSX 安装并启用 3.0.34，再从底部授权。原版服务器使用 `apps/frontend/eslint.config.js` 和项目的 ESLint 10.6.0，对临时 TypeScript 文件发布 `@typescript-eslint/no-unused-vars`。点击诊断在 Source 和 Diff 中都选中了第 7 行第 9 列开始的变量。撤销后再运行会重新提示授权。验收后移除了临时文件。

### 7.6 Python 调试与 VSIX 兼容方案

目标分两步。先在 macOS 直装预览版验证本地 Python 调试，再验证 Open VSX 的原版 Python Debugger VSIX。第一步使用上游 `debugpy` 调试适配器，第二步增加运行扩展本身所需的 Node 宿主和 VS Code API。Windows 和 Mac App Store 的分发分别验收。 [debugpy](https://github.com/microsoft/debugpy) · [VS Code 调试扩展架构](https://code.visualstudio.com/api/extension-guides/debugger-extension)

当前 QuickJS 文档宿主只提供 Markdown 检查需要的 API。ESLint 集成直接启动锁定版本的原版语言服务器，Code 现有 LSP 处理索引、大纲和定义。Python Debugger 2026.6.0 声明了 Node 入口、`debugpy` 调试器和 `ms-python.python` 依赖。它还会选择 Python 解释器、解析启动配置并创建适配器进程。 [Open VSX 包清单](https://open-vsx.org/api/ms-python/debugpy/2026.6.0/file/package.json) · [上游适配器工厂](https://github.com/microsoft/vscode-python-debugger/blob/main/src/extension/debugger/adapter/factory.ts)

```mermaid
flowchart LR
  UI["Code 调试界面"] --> Session["Tauri 调试会话与执行授权"]
  Session -->|DAP| Adapter["debugpy 适配器"]
  Adapter --> Python["项目的 Python 进程"]
  VSIX["原版 VSIX · 第二阶段"] --> Host["独立 Node 扩展宿主"]
  Host -->|注册调试器和解析配置| Session
```

| 阶段 | 开发范围 | 验收 |
| --- | --- | --- |
| 1. 本地 DAP 原型 | 使用明确选择的解释器和验证过的 `debugpy`。首版支持在项目中启动指定的本地 `.py` 文件，读取和验证工作目录及参数。Tauri 处理 `initialize`、`launch`、`initialized`、`setBreakpoints`、`configurationDone`，以及继续、单步、查看调用栈和变量、结束会话。Code 的 Source 显示断点和暂停行，点击调用栈跳到源文件。调试输出单独显示，静态诊断继续进入底部「检查」。 | 在真实 Python 项目的现有虚拟环境中，从执行授权跑到命中断点。验证单步进入、跳过、跳出、查看变量、输出和停止后清理进程。切换项目、撤销执行权限、退出或连接失败时能回收属本次会话的进程。 |
| 2. 原版 VSIX 兼容 | 锁定并验证 `ms-python.debugpy` 和 Python 扩展的版本、架构、哈希及依赖关系。对照真实包的激活调用评估 Theia 宿主可复用范围和定向 Node 宿主成本。提供扩展激活与释放、`contributes.debuggers`、命令注册、工作区与配置、解释器相关的扩展 API、调试配置提供器和适配器描述符工厂。宿主注册与原生进程启动走同一个 DAP 会话管理器。 | 从 Open VSX 安装、启用并激活原版包，验证选解释器、解析配置和创建适配器的调用由原版扩展完成。跑完第一阶段的断点流程，再验证缺失依赖、禁用、卸载、重启和更新失败回退。只有通过这条路径的版本才标为「Python Debugger 兼容」。 |
| 3. 按需求扩大范围 | 单独评估可复用 `launch.json`、Python 模块启动、交互式终端、表达式求值、本地附加和远程调试。对其他语言复用 DAP 会话、断点和调试面板，分别验证每种适配器及其安装和运行依赖。 | 每新增一种启动或附加形式，都验证来源选择、权限、路径映射和终止行为。 |

授权复用现有项目身份验证和 ESLint 的执行同意模式。目录访问、扩展启用和运行 Python 分别授权，启动前显示实际解释器、入口文件和工作目录。Node 扩展进程与应用数据和数据库凭据分离，限制传入环境，限制原生层可执行的请求。Node 进程分离本身无法限制本机文件和网络权限，发布前验证实际隔离能力。首版沿用现有外部工具的离线策略。App Store 版根据签名沙箱的实际运行结果与适用审核条款单独评估。 [DAP 会话顺序](https://microsoft.github.io/debug-adapter-protocol/overview) · [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) · [Theia 插件宿主](https://github.com/eclipse-theia/theia/blob/master/doc/Plugin-API.md) · [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
