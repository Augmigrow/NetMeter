# NetMeter 项目记忆

## 用户目标

- Windows 上常驻一个接近托盘大小的悬浮方格。
- 每个方格对应一个用户填写的域名或 URL，展示本机代理与该域名之间的实时下载/上传速度、均速（可点切换峰值）和累计流量。
- 均速口径（用户确认）：按设置页选定的最近 2/5/10 分钟滑动窗口统计，分母只算「有流量的活跃秒」，下载与上传各自独立判定；窗口内该方向无流量显示「—」。默认 5 分钟。
- 数据来自本机代理控制器活动连接的字节计数，不主动测速；外观参考用户截图，尺寸先保持紧凑，之后再调。

## 当前实现

- `UI_DESIGN_SPEC.md` 是当前 UI 的权威基线，固定方格尺寸、字号、箭头、颜色、网格线、8px 分轴对齐、历史页、设置页和交互边界；项目级 `AGENTS.md` 要求后续 UI 改动先遵循该规范。
- `server.mjs` 只监听回环地址，可接收启动时恢复的控制器配置，并代理 `/connections` 请求；禁用状态保留密钥，只停止采集。
- `index.html` 同时支持设置视图和 `?view=widget` 悬浮视图；浏览器设置和历史仍与密钥分离，历史按分钟写入 IndexedDB。
- `main.mjs` 使用 Electron 异步 `safeStorage` 将控制器地址、启用状态和密钥加密到当前用户的应用数据目录；密钥不进入 `localStorage`、项目文件或日志。`preload.cjs`、`package.json` 继续提供 Electron 置顶小窗、托盘显隐和设置窗口；方格不再使用 `-webkit-app-region: drag` 标题栏，普通左键整窗拖动走即时的 `widget:move-fast` IPC，`widget:move` 只用于需要返回实际位移的操作。
- 域名按控制器连接的目标主机匹配，子域名归并；历史保留支持 7 天、30 天和长期。
- 紧凑卡片约 180×148；主速度 17px，标签 12px，统计行 13px；方向箭头用 SVG 细描边，统计行箭头略小于实时行。每秒轮询仅更新现有节点，避免替换按钮导致点击/焦点丢失。
- 峰值与均速共用设置页选定的同一时间窗口：峰值是窗口内该方向有流量的最高单次采样速度，样本滑出窗口后自动回落，不再保留会话级峰值；均速和峰值可在各方格独立切换，切换仅在当前渲染会话保持。
- 实现：`pollConnections` 每秒为每个域名记录一条 `{ at, down, up, elapsed }` 样本到 `metric.rateSamples`，只保留最长 10 分钟；`windowRates(samples, cutoff)` 在渲染时一次遍历按当前窗口裁剪，分别累加该方向有流量样本的字节与 `elapsed` 得到均速，同时取 `sample.down / sample.elapsed` 的最大值得到峰值；无活跃样本返回 `null`，由 `formatRate` 显示为「—」。`currentRates` 每次渲染用 `Date.now()` 重算，因此窗口过期、切换窗口、断连都会实时反映。旧的 `sessionDown/sessionUp/activeSeconds`、`metric.peakDown/peakUp` 累计和 `metric.samples` 已移除。样本只存内存，不落盘；窗口设置 `avgWindow` 存在 `localStorage` 的 `netmeter-controller-v2`，设置页保存后主进程重载悬浮窗使其生效。
- 设置页在「历史流量保留」之后新增「均速统计窗口」下拉（2/5/10 分钟，默认 5 分钟），并带一行 11px 口径说明；`readValues`、`restore`、`persist`、`copySummary` 均同步该值。悬浮窗另监听 `storage` 事件，其他窗口改设置时只更新均速窗口并立即重算，不重置拖动或方格坐标；Electron 里主进程保存设置后仍会重载悬浮窗。历史摘要的「下载均速/上传均速」复用同一个窗口化均速，四列标题保持不变。
- 悬浮模式下方格整面（标题栏、速度区、统计区）都接受鼠标左键拖动。普通左键拖动移动整块悬浮窗，所有方格一起走、相对排布不变；只有按住 `Ctrl` 拖动时才移动指针所在的那一个方格，其余方格不动。位移小于 4px 仍算点击，因此域名、设置齿轮和均速/峰值按钮的点击不受影响。
- 单个方格的拖动没有人为限位：落点使用窗口内 `clientX/clientY` 相对方格容器计算，方格始终跟随指针；向右或向下拖动时工作区与悬浮窗按需增长，向左或向上拖出画布时渲染进程用 `window.moveTo` 同任务平移窗口并反向补偿其余方格。其他方格的 X 或 Y 坐标只用于显示对齐参考线，不得把当前方格拉走、拉回或卡住。松手后落点就是指针位置，独立拖动不吸附、不联动；收紧窗口时仍按实际位移补偿其余方格。拖动开始时从主进程 `widget:position` 校准窗口位置；松手后按所有方格的实际外接边界收紧窗口，并把像素位置写入本地布局。
- 悬浮窗始终贴紧方格外接矩形：方格整体平移到外接矩形左上角，窗口同步平移相同距离，屏幕上的位置不变，窗口内不留透明空隙（透明区域会挡住下层软件的点击）。三个以上方格时该规则同样成立。
- 设置页保存设置时不再回写方格坐标，避免用设置页启动时的旧快照覆盖悬浮窗里刚摆好的布局。
- 悬浮窗在屏幕上的位置保存在用户数据目录的 `widget-window.json`，窗口移动后落盘，重启后恢复并限制在可见屏幕范围内。启动时执行 `normalizeMeterLayout()`：先把整体平移到原点，若仍超过窗口可见范围则回退为两列紧凑默认布局，避免方格被拖到几千像素外后无法找回。
- `scripts/install-start-menu.ps1` 生成开始菜单快捷方式（`NetMeter.lnk`）和 `netmeter.ico` 图标；托盘菜单“固定到开始菜单”可随时重新生成，缺失时启动也会自动补齐，窗口图标使用同一个 ico。
- 历史流量只由方格头部域名触发，直接替换悬浮窗内容，并使用与方格一致的整窗实色深背景，不再透出桌面；仍不使用内层 `<dialog>`、嵌套弹窗或滚动区，点击累计统计行不会打开历史。
- 历史面板新增标签栏：「历史流量」是原有的 24 小时柱状图，「历史均速」是同窗口的 24 小时曲线图，两者共用固定 380×306 窗口，切换只换图表不换摘要。历史标题从「域名 · 历史流量」改为只写域名，视图名交给标签栏表达。
- 历史标签采用“记住上次选择”，不新增设置页默认视图：首次使用是“历史流量”，切换时把 `traffic` 或 `speed` 存到独立的 `netmeter-history-tab` 本地键；关闭重开、换域名和应用重启后恢复。存储不可用时当前渲染会话仍保留选择；无效存储值回退“历史流量”。
- 「历史均速」曲线口径与方格均速完全一致：横轴是最近 24 小时的每一分钟，纵轴是当前统计窗口（2/5/10 分钟）内的均速 = 字节 ÷ 该方向有流量的秒数，下载与上传各自独立。为支持这个口径，IndexedDB 的分钟样本新增 `downSeconds`/`upSeconds` 字段记录该分钟两个方向各自的有流量秒数；老记录没有该字段时按整分钟 60 秒折算（读取侧 `historyActiveSeconds` 与写入侧 `addHistorySample` 都有兜底），不会把速率算成 0。
- 曲线用 SVG 画在 100×100 的 viewBox 里并 `preserveAspectRatio="none"` 拉伸到图表区，`vector-effect: non-scaling-stroke` 保证描边不被拉粗；下载/上传两条曲线共用一个纵轴上限（取两者最大值），某个方向在窗口内没有流量时该段路径断开而不是画成 0。悬停提示由 `bindHistorySpeedHover` 绑定在 SVG 上：一个透明 `rect` 接收指针事件，另有 `line.history-speed-cursor` 标出光标所在分钟，提示浮层 `.history-speed-tip` 显示该分钟的下载/上传均速（与曲线点同值，`data-down`/`data-up` 暴露原始字节每秒值供测试断言）。
- 标签栏用 `role="tablist"`/`role="tab"` + `aria-selected` + roving tabindex，左右方向键在两个标签间切换；切换标签会重新读一次 IndexedDB，让曲线反映面板打开期间新增的样本。
- 设置页的监听地址和 API 密钥右侧为显示/隐藏按钮。设置窗和悬浮方格是同时显示、可独立操作的两个窗口；若两者重叠，设置窗会自动移动到方格旁边，不再隐藏方格；悬浮窗在画布尺寸变化后会重新避让，避免方格被设置窗盖住。
- 设置页在已保存密钥时显示“已安全保存，留空继续使用”。留空保存会复用同地址密钥；禁用控制器不会删除密钥，更换监听地址时需重新输入。
- 界面支持中文和英文双语，入口是设置页的「界面语言」下拉框。`index.html` 顶部的 `I18N` 字典同时保存 zh 和 en 两套文案，键集合必须完全一致；静态文案用 `data-i18n` / `data-i18n-aria` / `data-i18n-title` / `data-i18n-placeholder` 标记，`applyStaticTranslations()` 统一套用；动态文案（方格标签、历史摘要、图表提示、连接状态、提示条、需求摘要）一律走 `t('key', vars)`。
- 语言存放在独立的本地存储键 `netmeter-language`，不写进 `netmeter-controller-v2` 设置对象，因此保存设置不会覆盖语言。设置窗口切换语言后立即 `setLanguage()` 重绘当前窗口并 `saveLanguage()` 落盘；悬浮方格通过 `storage` 事件（`event.key === LANGUAGE_KEY`）跟随切换，`setLanguage()` 会重绘方格、已打开的历史面板和连接状态。切换语言不触发 `markSettingsDirty`，所以不会把设置标成未保存。
- 下拉框的取值（「7 天」「30 天」「长期」「最近 2/5/10 分钟」）是本地存储用的稳定键，两种语言完全一致；`SELECT_OPTION_KEYS` 只映射「取值 → 文案键」，`applyStaticTranslations()` 按当前语言重写 option 的可见文本，取值本身不变。因此历史数据、统计窗口和已保存设置在两种语言下完全兼容。
- 英文文案更宽，`body.lang-en .stat` 把统计行标签列从 30px 放宽到 37px、数值列收窄到 59px，方格总尺寸仍是 180×148；探针用 `Range` 量出标签文字右边缘与数值列左边缘的间距，要求中英文都 ≥3px，避免英文 “Total” 贴住方向箭头。
- Electron 主进程也做了本地化：`main.mjs` 的 `UI_STRINGS` 提供托盘菜单和设置窗口标题的中英文案，`ipcMain.on('app:language')` 收到渲染进程的 `setLanguage` 后重建托盘菜单并更新窗口标题；`preload.cjs` 暴露 `setLanguage`。
- `scripts/screenshot-probe.cjs` 用离屏 Electron 渲染中英文两版界面并写出 `docs/screenshots/` 下的 8 张效果图（方格、历史流量柱状图、历史均速曲线、设置页，中英各一套），README 双语版引用这些图。设置页截图按内容高度加高，让「界面语言」下拉框出现在同一张图里；方格截图用 384×162、历史截图用真实的 380×306。

## 验证

- 2026-11-06 复核：`npm test` 38/38 通过，覆盖密钥不泄漏到状态响应、启用/禁用配置、对齐落位、窗口化均速与峰值、历史均速、历史标签记忆和双语字典；`index.html` 内嵌脚本及 Electron 脚本语法检查通过。正式 Electron 实例已重启并在 4174 监听，`/api/status` 返回已启用且已配置；实机切换到历史均速后打开另一域名，恢复同一标签，检查后还原原先的历史流量选择。
- `layout.test.mjs` 从 `index.html` 直接取出 `nearestAlignment` 与 `settleMeterPosition` 两个纯函数做单元测试：8px 阈值、落点保持指针位置、邻近方格不得改写坐标、拖动中位置不受对齐影响。
- `average.test.mjs`（10 项）取出 `windowRates`、`trimRateSamples`、`averageWindowMs` 做纯函数测试：均速与峰值共用窗口裁剪及边界、下载/上传各自独立分母、空闲秒排除、`elapsed` 加权、空窗返回 `null`、峰值取单次采样最大值且滑出窗口即过期、样本裁剪、2/5/10 分钟映射与默认 5 分钟，并断言会话级累计字段已移除。
- `scripts/average-probe.cjs` 用离屏 Electron 真实窗口 + 合成控制器（下载恒定 100B/s、上传恒为 0）验证 10 项：设置页三档下拉与默认值、保存写入 `localStorage`、重载恢复、悬浮窗读到 2 分钟窗口、只有下载有流量时 `100B/s` 且上传显示「—」、停流后均速不衰减（实测 97.3B/s）、切换峰值显示窗口内峰值、把渲染器时钟快进 3 分钟后峰值与均速都回落为「—」、无脚本错误。运行需 `env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/average-probe.cjs`；本会话环境默认带 `ELECTRON_RUN_AS_NODE=1`，不取消会让 Electron 退化成普通 Node，且 `.mjs` 探针在当前 Electron 45 里无法解析 `electron` 具名导出，故用 `.cjs`。
- `scripts/drag-probe.cjs` 用离屏 Electron 窗口派发真实 `PointerEvent`，以主进程窗口边界计算屏幕坐标，覆盖拖出窗口边缘、拖到/拖近相邻格、不松手、拖第二格、全格偏移触发收紧、远距离拖动，以及静置多轮轮询观察抖动，共 15 项。修复前"向左拖出窗口边缘"导致其余方格随窗口左移 118px；修复后全部 `othersMoved=false`、`othersMovedDuringDrag=false`、`jitter=false`。
- 单格拖动落点改用窗口内 `clientX/clientY`（减去方格容器偏移）计算，丢弃 `screenX - window.screenX` 方案，避免副屏不同 DPI 缩放时坐标系混用造成方格脱离指针并反复触发平移抖动；拖动开始时会主动用 `widget:position` 校准窗口位置。
- 整窗拖动改走即时通道 `widget:move-fast`（`send`），不再进入 `invoke` + 串行队列；`widget:move` 只服务需要实际位移的收紧补偿。`Ctrl` 状态同时由 `event.ctrlKey` 和 `keydown/keyup` 跟踪，降低误判为整窗拖动的概率；拖动中按下 `Ctrl` 会把待定拖动或已开始的整窗拖动标记为单格，下一次鼠标移动由 `beginSingleDragFromWindow()` 以当前指针位置重建抓取点并切换为单格拖动；切换前松开 `Ctrl` 则取消该标记。
- 单格拖动恢复向任意方向移动：越过窗口左/上边缘时在渲染进程调用 `window.moveTo` 同步平移窗口，并在同一个 JS 任务里对其他方格做反向补偿，窗口与方格同帧提交。真实设备诊断日志显示旧的 IPC 平移会晚一帧，导致其余方格瞬间偏移 4px；改为同步 `moveTo` 后逐帧采样零位移，同时左移不再受限。
- 曾因清理旧代码误删 `moveWindowSync`，导致越过左边缘即抛错、方格停在边缘，表现为 `Ctrl` 拖动失效；探针现覆盖该路径，防止再次回归。
- 单格拖动时逐帧监测其余方格屏幕位置，超过 1px 位移即写入 `%APPDATA%\netmeter\drag-diagnostics.jsonl`（超过 512KB 自动清空），便于在真实设备上取得残余联动的直接证据。
- 2026-11-06 双语与发布收尾：真实 Electron 实例里手动切换语言验证过，设置页切到 English 后，悬浮方格立刻变成 Down/Up/Avg/Total，窗口标题变成 “NetMeter Controller Tiles”，切回中文后全部还原。实机验证同时暴露并修掉了三个只在真实窗口出现的问题：设置页状态行被统一成 “Not connected”（改为 stage/status 两套 key，初值分别是「未连接」和「等待保存配置」）、密钥占位符和说明在切换语言后没有跟着换（拆出 `applySecretStorageState()` 同步刷新）、眼睛按钮标题拼成 “Hidelisten address”（改为直接用整句 key，不再拼接“显示/隐藏 + 名词”）。
- 仓库已初始化为 Git 仓库并推送到 `https://github.com/Augmigrow/NetMeter.git`（私有仓库，默认分支 `main`）。GitHub 需要走系统代理 `http://127.0.0.1:7897`，直连超时；代理配置写在仓库本地 `.git/config` 的 `http.proxy`/`https.proxy`。凭据用 Windows 凭据管理器的 GitHub oauth token，Git Credential Manager 会自动提供，不要把 token 写进文件或命令行。本仓库作者身份按兄弟仓库统一为 `Augmigrow <3123196845@qq.com>`，只在仓库本地配置。
- `scripts/start-app.ps1` 负责重启应用：先杀掉旧的 NetMeter electron 进程，再用 `node_modules/electron/dist/electron.exe .` 启动并轮询 `http://127.0.0.1:4174/api/status` 直到就绪。Windows 下 Electron 是 GUI 子系统进程，必须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（本会话环境默认带 `ELECTRON_RUN_AS_NODE=1`）。`scripts/run-probe.ps1` 是通用探针启动器。
- `scripts/drag-probe.cjs` 现有 15 项场景（含逐帧采样、远距离、不松手、整窗拖动、副屏坐标、先鼠标后 Ctrl 切换），全部通过。
- `history-speed.test.mjs`（8 项）取出 `historySpeedSeries`、`historyActiveSeconds` 与 `storedHistoryTab` 测试：曲线覆盖 24 小时分钟分辨率、均速与方格同为「字节 ÷ 活跃秒」、空闲秒不进分母、下载与上传独立、窗口按选定分钟数滑出、窗口外样本被忽略、老记录缺活跃秒时按整分钟折算；历史标签在未保存、无效值和存储不可用时回退流量页。
- `i18n.test.mjs`（12 项）直接从 `index.html` 取出 `I18N` 字典做纯函数测试：中英键集合完全一致、没有空文案、英文文案不含中文、占位符两边一致、`t()` 能替换占位符并在缺键时回退到中文、标记里的 `data-i18n*` 钩子和 JS 里的 `t('key')` 引用都指向存在的键、语言下拉框存在且语言不写进设置对象、`setLanguage` 会重绘方格与历史面板、悬浮方格通过 `storage` 事件跟随、主进程托盘菜单与窗口标题已本地化。
- `scripts/i18n-probe.cjs` 用离屏 Electron 真实窗口验证双语渲染与切换；最近保存的探针日志为 27/27 通过，覆盖中英文方格文案、`<html lang>`、标题与 aria 文案、语言落盘、历史面板标题与标签、摘要四列、曲线 aria-label 与悬停提示、切回中文、另一个窗口（设置页）跟随切换、下拉框显示文案翻译但取值不变、标签文字与箭头间距 ≥3px、无渲染脚本错误。
- `scripts/history-curve-probe.cjs` 用离屏 Electron 真实窗口（内容区 380×306）验证历史面板；最近探针为 22/22 通过，覆盖流量页 24 根柱、速度页两条 SVG 曲线、标签互斥切换、分钟均速悬停读数而非小时峰值、曲线无 NaN、面板不溢出，以及选择后关闭重开和重载窗口的双向记忆。Windows 下 Electron 是 GUI 子系统进程、不接管控制台，探针把结果写入 `scripts/history-curve-probe.log`，运行时需 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 后用 `Start-Process -WindowStyle Hidden` 启动并轮询日志文件。
- `node --check` 已通过 `main.mjs`、`preload.cjs`、`server.mjs`、`average.test.mjs`、`scripts/average-probe.cjs`，内嵌前端脚本语法已通过；自由拖动使用 Pointer Events、分轴对齐和指针捕获，窗口尺寸由像素外接边界驱动。Electron 实际启动时确认设置窗口与方格窗口同时存在且会互相避让。
- 通过 CDP 派发指针事件并在实际 Electron 窗口中验证：普通左键拖动使悬浮窗整体位移且两格相对位置不变（实测窗口 +80/+60），`Ctrl` 拖动只移动被按下的那一格（实测 +120/+80，另一格不动）；拖出画布左/上边界时悬浮窗同步平移且方格仍跟随指针；域名点击仍打开历史、齿轮点击仍打开设置、均速/峰值仍可切换；历史窗口实测为 380×306。
- Electron 45.2.1 已安装并启动过；使用独立临时用户数据写入合成测试密钥后，完成一次真实 Electron 重启，确认 `/api/status` 自动恢复为已配置，设置页显示安全保存提示，随后已清理临时测试数据。正式实例在 4174 监听。
- UI 规范文档已按当前实现核对；后续 explicit design change 必须同步规范、项目约束和本记忆。
- 2026-11-06 拖动复核：`scripts/drag-probe.cjs` 15 项场景全部通过（其余方格 `othersMoved=false`、逐帧 `swings=0`、`jitter=false`；普通拖动三格同位移 +100/+80；先按鼠标再按 Ctrl 时首段位移为 0、切换后仅被拖方格移动 60px；副屏 `\\.\DISPLAY1` 下逐帧零位移）。

- 2026-11-06 修正「历史均速」悬停读数（用户指出原实现用峰值代替了均速）：原实现曲线本身画的确实是均速，但悬停提示是「每小时一个透明 `rect` + `<title>`」，标题里取的是该小时切片的 `Math.max`，于是提示显示成峰值。已改为：删掉按小时的 `<title>` 聚合读数，改为自绘悬停浮层——`.history-speed-surface` 透明 `rect` 接收指针事件，`line.history-speed-cursor` 竖直指示线跟随光标标出所在分钟，`.history-speed-tip` 浮层显示该分钟的下载/上传均速（与曲线点同值），i18n key 由 `history.peakTitle` 换成 `history.pointDown`/`history.pointUp`。规范 `UI_DESIGN_SPEC.md` 第「历史流量」节同步改写：历史曲线只报均速，不得用峰值代替，也不得按小时聚合成一个读数。回归：`scripts/history-curve-probe.cjs` 新增 4 项（悬停可见、读数等于该分钟均速、读数不等于该小时峰值、读数随位置变化），`scripts/i18n-probe.cjs` 相应把「峰值标题」断言换成「不得出现 peak」和「悬停读数是均速」两项；`scripts/screenshot-probe.cjs` 在拍「历史均速」截图前先派发一次 mousemove，让效果图里直接带出均速读数。

## 待办

- 正式实例当前已启用且已配置；不得读取或记录控制器密钥。尚未构建安装包、实现开机自启，也未在真实代理流量下验收连接增量和历史曲线。
- GitHub 仓库是私有的；如果要公开，需要在仓库设置里改可见性，并复查 README 里的截图与文字是否适合公开。
