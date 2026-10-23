# Diagram 排版、固定位置、撤销与布局保存

## 操作规则

用 Shift / ⌘ / Ctrl 点击或框选多张表，在 Diagram 顶部工具栏选择布局操作。原先覆盖画布的大型选择/布局面板已移除：框选、清除选中、撤销/重做、固定/解除固定和选区布局为紧凑按钮，对齐/均分与业务域操作按需展开菜单。工具栏占独立一行，菜单支持 Escape、外部点击和移焦关闭；操作门槛与保存规则放在悬停提示中，不常驻长说明。操作结果与失败重试显示为可关闭的紧凑反馈行。

- 两张及以上未固定表可按选区边界左对齐、水平居中、右对齐、上对齐、垂直居中、下对齐。
- 三张及以上未固定表可水平或垂直均分。均分的是卡片边缘之间的空隙，按坐标排序，固定两端表；支持不同尺寸和负坐标。
- 空间不足以容纳全部选中未固定卡片时，操作保留原位置，并提示将两端表拉开。
- 仅改变选中且未固定表的坐标。保留另一轴坐标、表尺寸、选中状态和未选中表的位置；关系连线随位置重新计算。
- 这些操作调整展示布局，不修改数据库结构、关系定义或业务域成员。比较图的已删除表也可参与临时排版，导出使用当前布局。

## 固定表位置与选中表自动布局

选择一张或多张表，点击 **Fix positions** 固定位置；**Unlock positions** 解除固定。混合选区中分别只固定未固定表、解除已固定表。固定表标题显示 `⌖ Fixed`，仍可选中、查看字段、关系和业务语义，但不能拖动、用方向键移动或调整尺寸；对齐、均分、初次及手动自动布局都会跳过固定表。操作门槛仅按未固定的选中表计数。

**Layout selected** 只布局触发时选中且未固定的表，至少需要一张。ELK 使用这些表之间的当前可见关系与实际卡片尺寸，保留表尺寸、语义和选区；未选中表、固定表及其关系不改变。生成的选区整体先放到原选区左上角，遇到其他表时沿布局方向（向右或向下）平移到无卡片重叠的位置，并保留设置中的表间距。它是确定性的卡片避让，不保证与固定表的连线最短或没有交叉；用户可继续手动调整。

完整图 **Auto layout** 同样跳过固定表并避让其卡片。所有表固定或选区没有未固定表时，相应操作不可用，不创建工作线程或新的历史。异步自动布局期间，选区可改变；结果只应用到原目标表，保留最新选区。新的固定、解除固定、拖动、撤销、排版操作及图范围变化会废弃旧计算结果。

固定状态是个人布局属性 `pinned`，与位置、尺寸一起保存；旧布局缺少该属性时默认未固定，不需要数据库迁移。最新完整模型或保存视图新增表时，保留所有已有表的有效位置、尺寸和固定状态，只安排新增节点；无需事先固定旧表。临时视图继承完整图中仍可见表的固定状态和坐标；在临时视图中的固定/解除固定只影响当前视图，离开后恢复完整图原状态。

## 布局撤销与重做

**Undo layout / Redo layout** 支持对齐、均分、单表/多表拖动、尺寸调整、方向键移动和用户触发的 **Auto layout**、**Auto layout selected**、固定及解除固定。按钮提示展示将要撤销/重做的操作名称。一次连续拖动或尺寸调整只占一步；初次自动布局、载入已保存布局、选区、缩放和平移不进入历史。

图表节点或工具栏拥有键盘焦点时，使用 ⌘/Ctrl+Z 撤销、⌘/Ctrl+Shift+Z 重做；Windows/Linux 也支持 Ctrl+Y。输入框、可编辑文本、对话框和其他面板保留自身的快捷键行为。拖动或尺寸调整进行中不可撤销。

历史只在当前图会话中保留最近 **50 步**，不写入磁盘。切换数据源、快照、搜索、聚焦、保存视图或比较图，或可见表集合改变时，清空历史；退出临时视图后也不能用它撤销此前完整图的动作。业务域颜色、注释和选区等更新不清空同范围的布局历史。撤销只恢复曾改变的坐标/尺寸/固定状态属性，保留当前物理快照、语义、关系和选区；不回滚数据库或业务域编辑。

撤销后执行新的有效布局操作会清空重做分支；位置没有变化的操作或失败操作保留重做分支。撤销/重做遵循下表的保存范围：完整图自动保存恢复后的完整布局，临时视图只更新当前视图。保存失败仍保留恢复后的位置和重做能力，重试保存不会产生新的撤销记录。

## 保存范围

| 当前 Diagram | 保存规则 |
| --- | --- |
| 桌面 Database 完整图，无搜索、聚焦或保存视图 | 初次自动布局、Auto layout、拖动结束、批量拖动结束、尺寸调整结束、对齐、均分、选中表自动布局、固定及解除固定，均自动保存完整图的坐标、尺寸及固定状态 |
| 搜索结果 | 仅当前搜索视图生效，改变搜索或退出后重置；不覆盖完整图 |
| 表聚焦 / N-hop 图 | 仅当前聚焦视图生效，改变聚焦或退出后重置；不覆盖完整图 |
| 保存视图，包括旧的根表/层数视图 | 按来源和 `viewId` 独立保存位置、尺寸、固定状态及手动调整的视角；不覆盖完整图或其他视图 |
| 业务域 | 仅当前视图生效；不向完整图或 `viewId` 布局写入 |
| 从历史进入的普通 Database 图 | 仅临时排版；通过 Return to latest model 回到最新模型和原保存视图 |
| 比较图，包括删除对象 | 仅当前比较视图生效，切换比较或离开后重置；不保存历史对象位置到当前模型 |
| Web 共享图 | 仅当前页面视图生效，离开或重新加载后重置；不写入共享模型或浏览器布局缓存 |

退出搜索/聚焦时恢复原工作区布局；全局定位退出局部视图后，可通过 View 下拉重新打开。手动平移/缩放持久保存到所属完整模型或保存视图，选区和 Inspector 焦点不持久化。视图筛选、主题和关系显示设置仍遵循各自已有的保存机制。桌面完整图先等待语义数据及已有布局加载，再开放排版与保存，避免初始化布局提前覆盖已保存的布局。

桌面持久化沿用现有数据模型：完整模型 `viewId = null`，保存视图使用各自 UUID。可选 viewport 字段向后兼容旧布局，不要求清空或迁移现有数据。历史写入在 App 和后端快照校验两层阻止；过期快照写入被拒绝。桌面以 SQLite 为持久依据，浏览器后备缓存不冒充保存成功。位置不完整时增量安排新节点，保留已有有效坐标；排版失败保留旧位置并可重试。

写入按触发顺序串行执行，避免旧操作晚完成覆盖新操作。界面显示保存中、成功或失败；失败保留当前坐标和完整图内存状态，点击 **Retry layout save** 重试当前完整布局。切换数据源后，旧请求的反馈不会出现在新图中。较早的异步 Auto layout 结果不会覆盖后续手动排版。

## 保存模型视图（2026-10-23）

多选表后点击 **Save selection as view**，输入名称并核对成员。新视图为明确成员（depth 0），初始布局与视图在同一 SQLite 事务保存。刷新不自动增加成员。旧根表/层数视图原语义不变，编辑时标明层数；每个视图现在也有独立布局。

View 下拉提供完整模型和保存视图。Edit view 修改名称/成员；Duplicate view 创建独立标识和布局；Delete view 明确只删除本地视图及其布局，不删除表、说明和项目关系，也不撤销已有导出或分享副本。缺失成员保留并标明 unavailable。最后打开的视图是本机导航偏好；布局本体在 SQLite 中保存。个人视角及每视图布局不扩展现有云/Git 共享范围，便携备份沿用已有布局备份能力。

## 验证

算法测试覆盖八种操作、不同尺寸、负坐标、端点固定、未选中表不变、输入不变和空间不足。历史测试覆盖多步撤销/重做、属性级恢复、真实尺寸持久化、分支规则和容量上限。使用真实 React Flow 的组件测试覆盖按钮、节点坐标、完整布局保存、临时视图退出恢复、比较图删除对象、Web 隔离、失败重试、写入顺序、过期 Auto layout 结果和快捷键隔离；手势测试通过真实 React Flow 的公开回调验证连续拖动/尺寸调整合并以及拖动状态收尾。浏览器验证多表拖动、尺寸调整和快捷键。

固定与选中布局测试补充：真实 React Flow 验证固定标记、尺寸手柄隐藏、单表/混合选区方向键、固定节点拖动/尺寸事件防护、固定与解除固定撤销重做、完整图保存恢复、临时视图隔离、继承固定状态、缺表恢复、保存失败重试和过期计算丢弃。工作线程边界测试验证目标节点与关系过滤、不同方向的实际尺寸避让、连续障碍避让、全固定跳过计算和失败释放资源。Rust 验证旧格式兼容与固定状态 SQLite 保存回读。浏览器使用真实 ELK 验证多选自动布局、固定表不移动、撤销恢复及固定操作后的快捷键焦点。

## Navigating from the schema tree

The sidebar has its own table/view name filter; it does not filter the Diagram. Searching opens matching schema/type groups temporarily, and clearing restores their previous disclosure state. A table click or **Locate in diagram** switches to Database, clears Diagram search/saved-view filters, leaves relationship isolation and centers/selects the requested table after layout and node measurement finish. Repeating the same click recenters it. Requests are scoped to a source and snapshot, canceled by a new selection/mode/source, and acknowledged after use so they do not replay on remount.

Navigation changes the viewport and selection only; it does not move or resize tables or save a new arrangement. Saved layout loading is allowed to settle before navigation, including falling back to the rendered graph if local semantics cannot load. View results expose their captured SQL definition read-only; views are not rendered as physical table cards. Sidebar right-click actions never rename/drop database objects or execute queries automatically.

Clicking the active data source toggles its directory locally, without loading another snapshot or changing the Diagram. Collapsing retains the tree's search and group disclosure state; refreshing the same source keeps it collapsed, while selecting another source opens that source's directory. Source, schema and type rows share a compact SVG disclosure chevron, with rotation disabled when reduced motion is requested.

Enum rows open read-only details with every value in declared order, including empty strings, and table/field usage across the captured schemas. References match the exact type schema/name; enum arrays also use the captured formatted type, including quoted identifiers, rather than guessing from generated array names. Domains and view-column dependencies are not present in the snapshot model and are not inferred. Same-named enums in different schemas remain distinct. Table links use the same Diagram location request as table rows, so they leave preflight/filtered views, select and center the table, and support repeat clicks. Enum details stay open for further navigation. Refresh updates the values/references, deleting an enum or changing source closes stale details, and Escape/close restores focus to the object row or search. This does not execute SQL or modify layouts.

## 大图渲染与导出

100 张表及以上，从初次绘制起仅挂载视口可见的表和关系。固定卡片尺寸及临时端口先由字段模型声明，避免必须挂载/测量全部字段才能启用裁剪；卡片进入详细视图后以 DOM 测量修正端口，撤去临时端口声明，避免下一次拖动覆盖已测量锚点。恢复已保存的尺寸时同时更新初始几何。节点更新按画布、按提交批量测量，不再为每张表分别触发全图关系计算。

平移/缩放不再逐帧订阅整个画布；坐标变化保留表的数据与选中/关系高亮投影对象，TableNode 仅在实际使用的属性变化时重绘。大图缩放低于 35% 时省略不可辨识的字段/索引正文，保留表名、字段数量、变更标记和关系；放大、选中或定位后恢复。概览不改变坐标、大小、固定状态，不写入布局。

500+ 张表且 1,000+ 条关系时，首次关系 SVG 按帧逐批挂载，并显示 Drawing relationships；完整模型始终保留。完整关系绘制完成前暂不开放全图自动布局/导出。普通选择不重启绘制序列，切换图会取消旧序列；高密图拖动时暂时只挂载与移动表或所选关系相关的线，松开后优先保留相关线并分帧恢复完整图，避免大量无关关系订阅每次坐标更新。关系模型始终完整，移动中暂停导出，复原后才能导出全图；大图布局后的全图适配直接定位，避免缩放动画中反复挂载大批节点。

自动布局在线程内按连通组处理。组划分和节点结果查找改为索引；500+ 表模型中的小组使用较低搜索开销的 ELK 策略。单个连通组达到 200 张表时，改用邻接遍历排序与实际尺寸紧凑排布，避免分层算法为大量长边引入二次规模的中间节点。横/竖方向仍决定卡片排布方向，但快速排布不保证父子拓扑层级、连线最短或最少交叉。固定卡片、选区范围、卡片避让、撤销与保存规则继续适用。ELK 仅在需要时加载，超时及回退规则保留。

SVG/PNG 导出在 100+ 表时使用独立、可测量但不绘制的导出层，每批最多挂载 16 张完整表卡片或 64 条关系。交互画布始终保持视口裁剪，不为导出切换到全量概览，也不向其 React Flow 模型增加/移除节点、关系或临时 hidden 属性。导出层复用 TableNode、ComparisonEdge、当前主题/设置和 React Flow 的实际端口计算；端口取自当前画布缓存，离屏端口沿用已有临时几何，不通过导出重新测量整图。范围沿用当前搜索/聚焦/业务域和比较版本，包含视口外对象；主题、关系图例和变更标记保留。可见卡片手动展开的索引状态一并传入。导出副本不创建交互端口、尺寸手柄或测量订阅；关系标签等待自身测量提交后才采集。

导出层复用固定卡片/关系槽位，每批提交后同步读取实际样式和几何；累计约 8 ms 的工作后让出一帧，较重的卡片会缩小后续批次，不再为每个小批次固定等待一帧。带标签关系重新挂载其测量组件并等待标签提交，避免复用旧标签边界；索引展开由当前批次控制，避免状态串到另一张表。每批读取后立即序列化，恢复只清理末批并恢复交互，不再整体卸载全图。8 ms 是协作预算，不能抢占单张复杂表的同步读取，也不是帧率上限保证。切换范围、缺失端口或表几何、批次采集异常，均取消捕获并清理导出层，保留原画布与重试能力。文件输出按模型身份验证每张表及每条关系恰好一次，缺少任一对象时明确失败；不保存布局。小图仍直接采集当前画布。

文字几何共用一个 Range，避免 WebKit 在卸载节点时维护大量 Range 边界。SVG 使用轻量数据树、共享文字样式、0.01 像素表几何精度，并仅为实际溢出的内容生成裁剪。每张表采集后立即序列化为已转义片段，累计 UTF-8 预算及最终总文件检查共同执行原 32 MiB 上限。XML token 的 UTF-8 大小直接计数，不为每个小 token 分配编码数组；已序列化片段保留其字节数，最终合并不再重复编码片段来计数。序列化同时提供实际字节数；SVG 用 encodeInto 直接写入最终字节缓冲区，每块最多 128 Ki UTF-16 字符，累计约 8 ms 后让出一帧，不拆分代理对，支持源范围变化后取消。字节准备不再经过整份 SVG 字符串的 Blob/arrayBuffer 往返，缺少字节元数据的调用方仍受原大小预算约束。PNG 栅格化、像素上限和 Blob 通路保持。

大图导出期间，交互画布保留原辅助功能树、节点组件状态和交互订阅，用 aria-disabled 与输入捕获守卫暂停鼠标、键盘激活、滚轮、触控和上下文菜单；保留 Tab 导航及导出反馈按钮。被动滚轮/触控监听不调用 preventDefault。工具栏动作继续禁用，结束或异常后恢复。小图仍使用原地采集与 inert 隔离，其关系端口保留。桌面使用 Uint8Array 原始二进制 IPC，原数字数组接口继续兼容；原生格式、文件名、大小、内容及独占创建检查保持。关系仍包含全部路径、箭头、虚线、标签与比较偏移；导出副本不带交互用的辅助功能属性，文件字节数和校验和可能与旧版不同，不以字节相同代替内容/几何校验。

性能复测工具、环境、指标口径和原始结果见 [DIAGRAM_PERFORMANCE.md](./DIAGRAM_PERFORMANCE.md)。回归包含 1,000/2,000 表、端口修正、画布隔离的批量测量、选中表拖动时的数据身份、渐进关系绘制/取消/导出、带循环和长边的 2,000 表无重叠布局。首次挂载、极密关系绘制及完整导出仍有成本，实测结果不作为所有设备的帧率保证。

### 大图交互绘制补充

500 张及以上表的缩略图合并绘制并按帧更新，保留原平移/缩放控制器；普通表路径在几何未变时复用。概览卡片保留可测量的轻量端口，选择、放大或连接关系时恢复交互端口，不改变布局几何。密集关系的挂载与拖动恢复每帧最多提交 128 条边，优先保持交互响应，完整恢复可能需要更多帧；期间导出仍等待关系就绪。共享 SVG 的批量提交只暂离绘制根，并在同次提交恢复原根、顺序及仍存在的焦点。表位置、尺寸、固定状态、撤销与保存规则保持上述约定。原生 2,000 表实测和未解决的重载/拖动长帧见 [DIAGRAM_PERFORMANCE.md](./DIAGRAM_PERFORMANCE.md)。

密集关系的共享 SVG 以当前画布的 world-coordinate viewBox 和显式隐藏溢出限制绘制范围，随平移和缩放更新；关系路径和分层 DOM 保持原身份。它只裁剪可视绘制，不裁剪拥有的关系模型或全图导出。每个 React Flow 画布实例使用独立资源命名空间，隔离 marker 与辅助功能描述 ID，卸载重挂后不复用另一实例的资源 ID。原测量合并、128 条关系渐进批次、键盘操作和导出规则保持。视口/资源隔离回归及原生重复采样见 [性能报告](./DIAGRAM_PERFORMANCE.md)。

密集图共享 SVG 的空 React Flow 代理包装使用专用 class 与 `:empty` 守卫退出渲染树，marker 和实际关系路径保留；代理未来出现内容时不再隐藏。拖动松开后的 128 条关系渐进恢复批次之间留出一个 RAF 机会，初次绘制节奏不变。恢复更平缓但可能延长全量关系重新出现及导出重新可用的等待；不改变模型、坐标、撤销或保存规则。阶段归因、原生 CPU 证据、完整恢复耗时及仍有的布局尖峰见 `DIAGRAM_PERFORMANCE.md` 最后一节。
