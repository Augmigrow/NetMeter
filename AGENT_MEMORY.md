# NetMeter 项目记忆

## 用户目标

- Windows 上常驻一个接近托盘大小的悬浮方格。
- 网址用可增删、直接编辑的条目列表管理，勾选后才显示对应方格；展示本机代理与该域名之间的实时下载/上传速度、均速（可点切换峰值）和累计流量。
- 均速口径（用户确认）：按设置页选定的最近 2/5/10 分钟滑动窗口统计，分母只算「有流量的活跃秒」，下载与上传各自独立判定；窗口内该方向无流量显示「—」。默认 5 分钟。
- 数据来自本机代理控制器活动连接的字节计数，不主动测速；外观参考用户截图，尺寸先保持紧凑，之后再调。

## 当前实现

- `UI_DESIGN_SPEC.md` 是当前 UI 的权威基线，固定方格尺寸、字号、箭头、颜色、网格线、8px 分轴对齐、历史页、设置页和交互边界；项目级 `AGENTS.md` 要求后续 UI 改动先遵循该规范。
- `server.mjs` 只监听回环地址，可接收启动时恢复的控制器配置，并代理兼容的 `/connections` 请求。新的后台采集由主进程内的 `TrafficCollector` 每秒读取控制器，`TrafficLedger` 用 SQLite/WAL 保存分钟、累计和去重高水位；服务关闭时同步停止定时器与数据库，禁用控制器只停止采集并保留密钥。
- `index.html` 同时支持设置视图和 `?view=widget` 悬浮视图；设置与密钥分离。正式 Electron 模式的方格只读取 `/api/collector/state` 和 `/api/collector/history`，旧 IndexedDB 仅用于一次性幂等迁移；只有缺少 collector 的独立预览环境保留旧的渲染器采样兼容路径。
- `main.mjs` 使用 Electron 异步 `safeStorage` 将控制器地址、启用状态和密钥加密到当前用户的应用数据目录；密钥不进入 `localStorage`、项目文件或日志。`preload.cjs`、`package.json` 继续提供 Electron 置顶小窗、托盘显隐和设置窗口；方格不再使用 `-webkit-app-region: drag` 标题栏，普通左键整窗拖动走即时的 `widget:move-fast` IPC，`widget:move` 只用于需要返回实际位移的操作。
- 网址条目存为 `domainEntries: [{ url, visible }]`，兼容保留 `domains` 数组；旧字符串数组由 `normalizeDomainEntries` 迁移为全选。保存/取消沿用设置流程，空白与重复值禁止保存。`targetNames` 只返回勾选项，`trackedTargetNames` 返回全部条目供后台采集配置；隐藏仍采集，历史与累计保留，全部不选显示空状态。新增默认勾选；删除不清历史，编辑到不同网址使用新统计目标。域名匹配包含子域名。
- 紧凑卡片约 180×148；主速度 17px，标签 12px，统计行 13px；方向箭头用 SVG 细描边，统计行箭头略小于实时行。每秒轮询仅更新现有节点，避免替换按钮导致点击/焦点丢失。
- 峰值与均速共用设置页选定的同一时间窗口：峰值是窗口内该方向有流量的最高单次采样速度，样本滑出窗口后自动回落，不再保留会话级峰值；均速和峰值可在各方格独立切换，切换仅在当前渲染会话保持。
- 实现：主进程 collector 每秒生成每个域名的 `{ at, down, up, elapsed }` 样本，保留最近 10 分钟并通过 `/api/collector/state` 提供给 renderer；`windowRates(samples, cutoff)` 在渲染时按当前窗口裁剪，分别累加该方向有流量样本的字节与 `elapsed` 得到均速，同时取 `sample.down / sample.elapsed` 的最大值得到峰值；无活跃样本返回 `null`，由 `formatRate` 显示为「—」。`currentRates` 每次渲染用 `Date.now()` 重算，因此窗口过期、切换窗口、断连都会实时反映。`avgWindow` 仍存在 `localStorage` 的 `netmeter-controller-v2`，设置页保存后主进程重载悬浮窗使其生效。
- 2026-11-08 后台采集修复：主进程窗口设置 `backgroundThrottling: false`，隐藏、最小化或遮挡时仍以约 1 秒间隔采样；连接身份按开始时间与传输端点生成稳定指纹，不依赖可变的连接 ID 或嗅探域名。新连接首次观察到时计入已有字节；连接消失后保留高水位以避免尾随快照和 ID 重用重复计数。控制器 `downloadTotal/uploadTotal` 独立累计用于校验全局流量，分钟按响应实际观测时间归桶。失败请求不清空基线，不并发重试，停止后不重新调度。
- 设置页在「历史流量保留」之后新增「均速统计窗口」下拉（2/5/10 分钟，默认 5 分钟），并带一行 11px 口径说明；`readValues`、`restore`、`persist`、`copySummary` 均同步该值。悬浮窗另监听 `storage` 事件，其他窗口改设置时只更新均速窗口并立即重算，不重置拖动或方格坐标；Electron 里主进程保存设置后仍会重载悬浮窗。历史摘要的「下载均速/上传均速」复用同一个窗口化均速，四列标题保持不变。
- 悬浮模式下方格整面（标题栏、速度区、统计区）都接受鼠标左键拖动。普通左键拖动移动整块悬浮窗，所有方格一起走、相对排布不变；只有按住 `Ctrl` 拖动时才移动指针所在的那一个方格，其余方格不动。位移小于 4px 仍算点击，因此域名、设置齿轮和均速/峰值按钮的点击不受影响。
- 单个方格的拖动没有人为限位：落点使用窗口内 `clientX/clientY` 相对方格容器计算，方格始终跟随指针；向右或向下拖动时工作区与悬浮窗按需增长，向左或向上拖出画布时渲染进程用 `window.moveTo` 同任务平移窗口并反向补偿其余方格。其他方格的 X 或 Y 坐标只用于显示对齐参考线，不得把当前方格拉走、拉回或卡住。松手后落点就是指针位置，独立拖动不吸附、不联动；收紧窗口时仍按实际位移补偿其余方格。拖动开始时从主进程 `widget:position` 校准窗口位置；松手后按所有方格的实际外接边界收紧窗口，并把像素位置写入本地布局。
- 悬浮窗始终贴紧方格外接矩形：方格整体平移到外接矩形左上角，窗口同步平移相同距离，屏幕上的位置不变，窗口内不留透明空隙（透明区域会挡住下层软件的点击）。三个以上方格时该规则同样成立。
- 设置页保存设置时不再回写方格坐标，避免用设置页启动时的旧快照覆盖悬浮窗里刚摆好的布局。
- 悬浮窗在屏幕上的位置保存在用户数据目录的 `widget-window.json`，窗口移动后落盘，重启后恢复并限制在可见屏幕范围内。启动时执行 `normalizeMeterLayout()`：先把整体平移到原点，若仍超过窗口可见范围则回退为两列紧凑默认布局，避免方格被拖到几千像素外后无法找回。
- `main.mjs` 的 `ensureAppIcon()` 在创建窗口前更新用户数据目录中的 ICO。`shell-identity.mjs` 统一窗口重启属性与快捷方式 AppUserModelID（`local.netmeter.desktop`）、NetMeter 名称、ICO 和带项目目录参数的命令；两个窗口先 `show:false`，调用 `setAppDetails` 后再显示。启动时安装并修复旧 .lnk，通过 `shell.writeShortcutLink` 保存正确身份，不会自动固定；原 PowerShell 安装器只负责复制图标和基础 .lnk，AppUserModelID 的最终修复由主进程完成。
- 历史流量只由方格头部域名触发，直接替换悬浮窗内容，保留 380×306 实色整窗；不使用内层弹窗或纵向滚动。2026-11-07 用户明确要求时间跨度和可滚动图表，已允许图表时间轴单独横向滚动，替代旧的“禁止滚动/全宽压缩”要求。
- 历史面板的“历史流量”和“历史均速”共用最近 1/6/24 小时、7/30 天范围选择（默认 24 小时），独立 `netmeter-history-range` 键记忆范围；保留完整时间边界，标题上方显示当前可视日期/时分与可视时长，轴下有时间刻度。1/6 小时流量按 5 分钟画柱，较长范围按小时，默认完整显示所选总范围（没有有效已保存缩放时），不再设定 32px 柱宽或 4px/分钟的初始密度；速度仍保留原始分钟样本，手动缩放和记忆保持不变。普通滚轮、原生横向滚动条、触摸板及 Home/End 可导航；打开/换范围先到最新，标签切换保留各自位置。
- 2026-11-07 用户补充“可视跨度”独立于总范围：两个图表支持 Ctrl＋滚轮上放大、下缩小，以光标时间为锚点（边界才约束），普通滚轮仍横向滚动；顶部起止时间和双语可视时长实时跟随。`historyVisibleSpans` 在 `netmeter-history-visible-spans` 中仅以 `{ range, traffic, speed }` 保存当前总范围的两图偏好；同一总范围内关闭重开、换域名、重启后保留。2026-11-08 用户修订：切换总范围清空两图记忆，切回旧范围也不恢复，不缓存其他范围。最大缩到全范围，最小放到均速 5 分钟或流量 1 个桶。缩放只改现有时间轴宽度，不重采样、不改原始字节/活跃秒/均速口径或纵轴；流量柱间隔随密度缩小，刻度只生成可视区附近少量节点。分钟指示线与曲线路径统一 5 位小数，30 天极限放大仍对齐。
- 2026-11-08 用户确认“默认初始显示对应全跨度”：`historySpanWidth` 在没有有效缩放偏好时直接返回可视宽度，两种图表、全部 1/6/24 小时及 7/30 天范围统一适配完整时间边界（含空白），删除旧 `historyTimelineWidth` 和固定密度 fallback；只改变初始 X 轴尺度，当前总范围未切换时已有手动缩放仍按图表独立恢复。
- 2026-11-08 用户要求“只保留当前所选跨度的可视范围记忆”：`setHistoryRange` 对实际范围变更清空两图缩放/滚动位置并覆盖当前记录，选择相同范围不清空；存储读取必须匹配当前 `range` 标签，无标签旧格式和不匹配记录丢弃，启动立即正规化。只保存一份当前范围记录，不为旧范围建立缓存；同一总范围关闭重开/重启仍可记忆，不跨范围继承或恢复。
- 历史标签采用“记住上次选择”，不新增设置页默认视图：首次使用是“历史流量”，切换时把 `traffic` 或 `speed` 存到独立的 `netmeter-history-tab` 本地键；关闭重开、换域名和应用重启后恢复。存储不可用时当前渲染会话仍保留选择；无效存储值回退“历史流量”。
- 「历史均速」曲线口径与方格均速一致：从用户选择的范围按分钟计算，保留真实首尾与空闲区段，纵轴是当前统计窗口（2/5/10 分钟）内的字节 ÷ 该方向有流量秒数，下载上传各自独立。后台 SQLite 分钟样本的 `downSeconds`/`upSeconds` 保存各方向活跃秒；旧 IndexedDB 数据按 target+minute 幂等迁移。2026-11-06 纠错：旧记录有字节而缺少活跃秒时，原读取和同分钟更新都擅自按 60 秒兜底，短时高速流量会被显著压低；现 `historyActiveSeconds` 返回 `null` 表示未知，`historySpeedSeries` 按方向阻断受污染窗口的曲线，写入侧合并新样本时继续保留该方向的未知状态。全缺秒时双语说明，部分缺秒时图表标注；历史流量柱状图保留字节。先前已被旧代码补写成 60 秒的记录无法与真正持续 60 秒的样本可靠区分，不能自动恢复真实均速。
- 2026-11-07 新要求取代早期“有效数据直接满宽”：已移除 `historySpeedViewport` 首尾裁剪，`historySpeedSeries` 新增可选范围参数，历史加载保留统计窗口预热分钟。`historySpeedX` 使用同一完整时间映射，归一化 X 坐标保留 5 位小数，避免 30 天长轴出现像素量化。SVG 路径仍 1.4px 不缩放描边，下载/上传共用纵轴，无活跃流量按方向断线；滚动后的悬停仍读该分钟窗口均速，不用峰值替代。提示与旧数据缺秒标注固定在可视窗口内，不随时间轴滚走。
- 标签栏用 `role="tablist"`/`role="tab"` + `aria-selected` + roving tabindex，左右方向键在两个标签间切换；切换标签会重新读一次后台历史接口，让曲线反映面板打开期间新增的样本。
- 设置页的监听地址和 API 密钥右侧为显示/隐藏按钮。设置窗和悬浮方格是同时显示、可独立操作的两个窗口；若两者重叠，设置窗会自动移动到方格旁边，不再隐藏方格；悬浮窗在画布尺寸变化后会重新避让，避免方格被设置窗盖住。
- 设置页在已保存密钥时显示“已安全保存，留空继续使用”。留空保存会复用同地址密钥；禁用控制器不会删除密钥，更换监听地址时需重新输入。
- 界面支持中文和英文双语，入口是设置页的「界面语言」下拉框。`index.html` 顶部的 `I18N` 字典同时保存 zh 和 en 两套文案，键集合必须完全一致；静态文案用 `data-i18n` / `data-i18n-aria` / `data-i18n-title` / `data-i18n-placeholder` 标记，`applyStaticTranslations()` 统一套用；动态文案（方格标签、历史摘要、图表提示、连接状态、提示条、需求摘要）一律走 `t('key', vars)`。
- 语言存放在独立的本地存储键 `netmeter-language`，不写进 `netmeter-controller-v2` 设置对象，因此保存设置不会覆盖语言。设置窗口切换语言后立即 `setLanguage()` 重绘当前窗口并 `saveLanguage()` 落盘；悬浮方格通过 `storage` 事件（`event.key === LANGUAGE_KEY`）跟随切换，`setLanguage()` 会重绘方格、已打开的历史面板和连接状态。切换语言不触发 `markSettingsDirty`，所以不会把设置标成未保存。
- 下拉框的取值（「7 天」「30 天」「长期」「最近 2/5/10 分钟」）是本地存储用的稳定键，两种语言完全一致；`SELECT_OPTION_KEYS` 只映射「取值 → 文案键」，`applyStaticTranslations()` 按当前语言重写 option 的可见文本，取值本身不变。因此历史数据、统计窗口和已保存设置在两种语言下完全兼容。
- 英文文案更宽，`body.lang-en .stat` 把统计行标签列从 30px 放宽到 37px、数值列收窄到 59px，方格总尺寸仍是 180×148；探针用 `Range` 量出标签文字右边缘与数值列左边缘的间距，要求中英文都 ≥3px，避免英文 “Total” 贴住方向箭头。
- 应用图标：`assets/tray/netmeter.ico`（16/20/24/32/40/48/64px），绿下载/蓝上传、深底浅轮廓；托盘、窗口标题栏和开始菜单快捷方式统一复用。旧 SVG 原生解码为空，已改 ICO 并检查非空；2026-11-07 补齐用户截图指出仍为旧图标的设置窗口标题栏。`scripts/generate-tray-icons.cjs` 从 SVG 重建 ICO/PNG 与浅深背景预览，详见 README。
- Electron 主进程也做了本地化：`main.mjs` 的 `UI_STRINGS` 提供托盘菜单和设置窗口标题的中英文案，`ipcMain.on('app:language')` 收到渲染进程的 `setLanguage` 后重建托盘菜单并更新窗口标题；`preload.cjs` 暴露 `setLanguage`。
- `scripts/screenshot-probe.cjs` 可重建中英文方格/历史/设置效果图；当前四张历史效果图由 `scripts/history-timeline-probe.cjs` 以真实 380×306 窗口与合成分钟数据更新，显示当前可视日期、双语可视跨度、横向滚动条、时间刻度和均速悬停。设置页效果图仍按内容高度加高，方格仍为 384×162。

## 验证

- 2026-11-08 当前跨度限定记忆：`npm test` 89/89；实际 Electron 主进程探针 58/58，覆盖当前范围双图独立记忆/重载、换范围清空两图、切回不恢复旧缩放、旧无标签与错标签的安全丢弃和正规化，且全跨度/滚动/分钟均速悬停不回归。内联、主进程、preload 与探针语法通过；四张中英截图以隔离合成数据更新并逐张检查。未占用桌面控制；此前受策略限制的正式实例自动重启仍未完成。

- 2026-11-08 默认全跨度：`npm test` 87/87；真实 Electron 主进程探针 50/50，验证五档范围默认整段可见、中英两图初始全宽、缩放/滚动/悬停/记忆不回归；内联和 Electron 脚本语法通过。四张历史截图已更新为未保存缩放时的全跨度初始效果，使用隔离合成数据并逐张查看。本轮没有桌面控制会话；此前正式实例自动重启被环境策略拒绝，仍需用户从托盘退出后重开，未冒充已重启。

- 2026-11-07 可视跨度缩放：`npm test` 86/86；实际 Electron 主进程历史探针 45/45（包括原生 Ctrl 滚轮、光标锚定、双图独立持久化、普通滚动、总范围与字节/曲线不变、30 天缩放上下界、720 根流量柱压缩、5 分钟极限的分钟指示线、双语截图），双语探针 27/27；内联、主进程、preload、服务与探针语法检查通过。四张中英文历史截图已用隔离合成数据更新并逐张查看，不是用户真实历史；本轮无可用 Playwright，视觉检查使用实际 Electron 捕获。
- 2026-11-07 正式实例自动重启受阻：经实例租约尝试正常桌面退出，但 Windows Computer Use 返回 native pipe 不存在；进程重启命令在执行前被工具策略拒绝，未绕过限制，原实例保留。控制运行时已重置、实例租约已释放。必须明确告知用户仍需从托盘退出并重新打开，不能沿用上一轮“已重启”结论。

- 2026-11-07 时间范围/任务栏身份修复：`npm test` 78/78；历史实际主进程探针 23/23，双语探针 27/27，Windows 原生属性探针 13/13；Electron、前端内联及探针语法检查通过。任务栏验收读取了两个实际 HWND 的重启名称/图标/命令和 AppUserModelID，并读取生成的 .lnk，均一致；未自动改写用户现有固定项，也未冒充已经目视验收 Windows 已固定磁贴。
- 正式实例已重启，仍启用且配置已恢复；`Get-StartApps -Name NetMeter` 现报告 `local.netmeter.desktop`，不再是此前的 AutoGenerated ID，真实开始菜单快捷方式显式引用新 ICO。用户先前固定的通用 Electron 项是旧快照，须取消后重新固定 NetMeter；不得批量操作其他 Electron 程序。

- 2026-11-07 开始菜单固定修复：原入口只创建 .lnk 而没有固定，且忽略安装结果。现 `start-menu.mjs` 统一处理安装、请求、已固定确认、失败反馈、重复点击和系统引导；`scripts/pin-start-menu.ps1` 只调用真正的 Pin verb，必须观察到 Unpin verb 才确认成功，超时/拒绝/未知状态不报成功，启动不请求固定。真实 Windows 上已观察到 Pin verb 存在但 `DoIt()` 返回 `0x80070005 E_ACCESSDENIED`，因此最终固定仍需用户在系统右键菜单确认，不能宣称已替用户固定。
- 本轮 `npm test` 70/70、Electron/前端内联/PowerShell 语法检查通过；`scripts/start-menu-probe.cjs` 14/14 用实际主进程和菜单、模拟的系统拒绝结果验证双语原生引导、取消不打开 Explorer、启动不固定，生成 `docs/screenshots/start-menu-guide-zh.png` / `start-menu-guide-en.png`。这不是“真实系统固定成功”的验收；原生截图只裁切本进程对话框边界，不保存其他窗口内容。正式实例已重启，保持已启用且已配置，真实开始菜单快捷方式目标与图标路径已刷新校验。

- 2026-11-07 设置窗口图标补齐：`npm test` 58/58；主进程、前端内联脚本、测试、探针及 PowerShell 语法检查通过；真实 Electron 主进程隔离探针 12/12，通过原生标题栏截图目视确认中英文窗口左上角均为双箭头。正式实例已直接重启，仍已启用且已配置，用户数据目录图标与随应用提供的 ICO 一致；现有开始菜单快捷方式已刷新。未打开 GitHub 登录或桌面控制通道。

- 2026-11-06 复核：`npm test` 54/54 通过，覆盖密钥不泄漏到状态响应、启用/禁用配置、对齐落位、窗口化均速与峰值、历史均速、历史标签记忆和双语字典；`index.html` 内嵌脚本及 Electron 脚本语法检查通过。正式 Electron 实例已重启并在 4174 监听，`/api/status` 返回已启用且已配置；托盘新 ICO 已随正式实例启动，服务与方格窗口正常；桌面控制报 native pipe 不存在，重试/重置无效，未目视验收真实任务栏；已检查浅深背景预览和 17/17 原生托盘测试。控制连接与实例租约已释放。
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
- 仓库已初始化为 Git 仓库并推送到 `https://github.com/Augmigrow/NetMeter.git`（私有仓库，默认分支 `main`）。GitHub 需要走系统代理 `http://127.0.0.1:7897`，直连超时；代理配置写在仓库本地 `.git/config` 的 `http.proxy`/`https.proxy`。凭据用 Windows 凭据管理器的 GitHub oauth token，Git Credential Manager 会自动提供，不要把 token 写进文件或命令行。本仓库作者身份按兄弟仓库统一为 `Augmigrow <3123196845@qq.com>`，只在仓库本地配置。 2026-11-07 实测：非交互模式下显式指定 `credential.username=Augmigrow` 后可复用已有 GCM 凭据成功推送；本仓库本地已设置 GitHub 用户名和 `credential.interactive=false`。后续 Git 命令仍须设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`，禁止弹登录窗口；认证失败时报告，不索取或显示凭据。窗口图标修复与中英实机截图已在 `71754fd` 推送并核对远端。
- `scripts/start-app.ps1` 负责重启应用：先杀掉旧的 NetMeter electron 进程，再用 `node_modules/electron/dist/electron.exe .` 启动并轮询 `http://127.0.0.1:4174/api/status` 直到就绪。Windows 下 Electron 是 GUI 子系统进程，必须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（本会话环境默认带 `ELECTRON_RUN_AS_NODE=1`）。`scripts/run-probe.ps1` 是通用探针启动器。
- `scripts/drag-probe.cjs` 现有 15 项场景（含逐帧采样、远距离、不松手、整窗拖动、副屏坐标、先鼠标后 Ctrl 切换），全部通过。
- `tray-icon.test.mjs` 8 项覆盖 PNG/ICO 格式、尺寸、统一入口、旧图标更新、首次启动和快捷方式安装；`scripts/tray-icon-probe.cjs` 17/17 验证像素、原生解码、Shell 注册和临时图标清理。`scripts/window-icon-probe.cjs` 12/12 使用真实主进程和隔离临时数据验证旧图标迁移、双窗口可见、双语原生标题及绿/蓝箭头像素，并截取 `docs/screenshots/window-icon-zh.png` / `window-icon-en.png`。Windows 窗口缩略图不含原生标题栏，因此该探针通过 Electron 显示器采集后只裁取本窗口顶部，不保存其他桌面内容或控制器字段。
- `domain-entries.test.mjs` 7 项验证迁移、显示筛选、隐藏持续采集与累计保留；独立配置的 `scripts/domain-entries-probe.cjs` 20/20 验证增删编辑、保存取消、重载记忆、全不选、中英文控件、560/440px 无溢出，并更新中英文设置页截图。
- `history-speed.test.mjs` 与 `history-timeline.test.mjs` 覆盖分钟均速、方向独立活跃秒、旧记录缺秒、范围边界与统计预热、5 分钟/小时流量桶字节守恒、未来/范围外过滤、时间轴宽度、独立范围记忆与过时异步加载丢弃。早期首尾裁剪/全宽压缩断言已按用户新要求替换。
- `i18n.test.mjs`（12 项）直接从 `index.html` 取出 `I18N` 字典做纯函数测试：中英键集合完全一致、没有空文案、英文文案不含中文、占位符两边一致、`t()` 能替换占位符并在缺键时回退到中文、标记里的 `data-i18n*` 钩子和 JS 里的 `t('key')` 引用都指向存在的键、语言下拉框存在且语言不写进设置对象、`setLanguage` 会重绘方格与历史面板、悬浮方格通过 `storage` 事件跟随、主进程托盘菜单与窗口标题已本地化。
- `scripts/i18n-probe.cjs` 用离屏 Electron 真实窗口验证双语渲染与切换；最近保存的探针日志为 27/27 通过，覆盖中英文方格文案、`<html lang>`、标题与 aria 文案、语言落盘、历史面板标题与标签、摘要四列、曲线 aria-label 与悬停提示、切回中文、另一个窗口（设置页）跟随切换、下拉框显示文案翻译但取值不变、标签文字与箭头间距 ≥3px、无渲染脚本错误。
- `scripts/history-timeline-probe.cjs` 使用实际主进程、独立临时配置和合成分钟数据，58/58 验证真实 380×306 窗口、独立设置窗口、范围选择、横向滚动、悬停值与方向独立均速、切换/重载记忆、旧数据提示、暗/浅色和中英文截图；`scripts/history-curve-probe.cjs` 是兼容入口，日志同时写旧名。截图仅覆盖合成数据，不读取用户密钥或替换真实历史。
- `node --check` 已通过 `main.mjs`、`preload.cjs`、`server.mjs`、`average.test.mjs`、`scripts/average-probe.cjs`，内嵌前端脚本语法已通过；自由拖动使用 Pointer Events、分轴对齐和指针捕获，窗口尺寸由像素外接边界驱动。Electron 实际启动时确认设置窗口与方格窗口同时存在且会互相避让。
- 通过 CDP 派发指针事件并在实际 Electron 窗口中验证：普通左键拖动使悬浮窗整体位移且两格相对位置不变（实测窗口 +80/+60），`Ctrl` 拖动只移动被按下的那一格（实测 +120/+80，另一格不动）；拖出画布左/上边界时悬浮窗同步平移且方格仍跟随指针；域名点击仍打开历史、齿轮点击仍打开设置、均速/峰值仍可切换；历史窗口实测为 380×306。
- Electron 45.2.1 已安装并启动过；使用独立临时用户数据写入合成测试密钥后，完成一次真实 Electron 重启，确认 `/api/status` 自动恢复为已配置，设置页显示安全保存提示，随后已清理临时测试数据。正式实例在 4174 监听。
- UI 规范文档已按当前实现核对；后续 explicit design change 必须同步规范、项目约束和本记忆。
- 2026-11-06 拖动复核：`scripts/drag-probe.cjs` 15 项场景全部通过（其余方格 `othersMoved=false`、逐帧 `swings=0`、`jitter=false`；普通拖动三格同位移 +100/+80；先按鼠标再按 Ctrl 时首段位移为 0、切换后仅被拖方格移动 60px；副屏 `\\.\DISPLAY1` 下逐帧零位移）。

- 2026-11-06 修正「历史均速」悬停读数（用户指出原实现用峰值代替了均速）：原实现曲线本身画的确实是均速，但悬停提示是「每小时一个透明 `rect` + `<title>`」，标题里取的是该小时切片的 `Math.max`，于是提示显示成峰值。已改为：删掉按小时的 `<title>` 聚合读数，改为自绘悬停浮层——`.history-speed-surface` 透明 `rect` 接收指针事件，`line.history-speed-cursor` 竖直指示线跟随光标标出所在分钟，`.history-speed-tip` 浮层显示该分钟的下载/上传均速（与曲线点同值），i18n key 由 `history.peakTitle` 换成 `history.pointDown`/`history.pointUp`。规范 `UI_DESIGN_SPEC.md` 第「历史流量」节同步改写：历史曲线只报均速，不得用峰值代替，也不得按小时聚合成一个读数。回归：`scripts/history-curve-probe.cjs` 新增 4 项（悬停可见、读数等于该分钟均速、读数不等于该小时峰值、读数随位置变化），`scripts/i18n-probe.cjs` 相应把「峰值标题」断言换成「不得出现 peak」和「悬停读数是均速」两项；`scripts/screenshot-probe.cjs` 在拍「历史均速」截图前先派发一次 mousemove，让效果图里直接带出均速读数。

- 2026-11-08 后台流量采集修复：新增 traffic-ledger.mjs（Node 24 node:sqlite + WAL）和 traffic-collector.mjs。Electron 主进程每秒采样，两个 BrowserWindow 均设置 backgroundThrottling: false；渲染器只读取 /api/collector/state 与历史接口。账本按稳定传输生命周期指纹去重，保留连接消失后的高水位，控制器全局累计独立记账，分钟按实际观测时间归桶，旧 IndexedDB/累计幂等迁移。
- 2026-11-08 限制与口径：Mihomo /connections 是活动连接快照，关闭连接会从 map 删除；全局 downloadTotal/uploadTotal 能包含已结束连接但没有域名归属或完成事件。因此域名统计标为 active-snapshots-lower-bound，不伪造遗漏尾段；控制器重置/系统休眠/API 故障仍可能造成暂时漏记。
- 2026-11-08 验证：npm test 115/115；scripts/background-collector-probe.cjs 五分钟隐藏实测 297 个样本、最大间隔 1037ms、平均 1008.54ms，global 10000/20000，域名 8840 并报告未观测 1160/2320；快速隐藏回归 7/7 并验证托盘 app.quit 的优雅关闭。scripts/history-timeline-probe.cjs 58/58；scripts/window-ready-probe.cjs 8/8；测试窗口均不可见且非置顶，无 NetMeter 测试进程/4196–4198 端口残留或常驻 watcher。
- 2026-11-08 用户约束：不得新增关不掉的可见辅助窗、永久 watcher、开机自启或电源设置；测试必须有硬超时并自动退出。设置页重试路径在用户关闭后不会迟到弹回；黑屏原始根因未确定，但失败时显示白底可读双语错误页并记录脱敏诊断。

## 待办

- 旧通用 Electron 固定项需先取消，再从更新后的 NetMeter 固定；应用不会替用户改写已固定布局。
- 固定到开始菜单的最后一步仍需用户在 Windows 右键菜单选择“固定到开始”；这台机器拒绝程序化调用，应用已提供可操作引导，不应按已固定处理。
- 2026-11-08 正式实例已重启到后台采集版本并在 4174 监听；`/api/status` 返回已启用、已配置、`collector:true`，采集器状态为 `connected`，时间戳持续前进，用户数据目录中的 `traffic.sqlite` 已建立并增长。未读取或记录控制器密钥。仍需更长时间的真实代理流量对比来量化域名尾段缺失率和控制器全局累计长期一致性；尚未构建安装包或实现开机自启。
- GitHub 仓库是私有的；如果要公开，需要在仓库设置里改可见性，并复查 README 里的截图与文字是否适合公开。

- 2026-11-06 历史均速低估修复：代码及回归 41/41 通过；`scripts/history-curve-probe.cjs` 离屏 Electron 24/24 验证曲线、悬停均速、旧记录提示与柱状流量保留；`scripts/screenshot-probe.cjs` 11/11 生成并检查中英截图，速度页用 6 秒活跃的合成数据避免误示“整分钟摊薄”；探针使用独立临时 userData，不覆盖真实用户历史。正式 Electron 实例经菜单正常退出并重启，`/api/status` 显示已启用且已配置；实机历史均速页可见旧数据缺秒提示和新数据曲线，检查后关闭面板，释放实例租约与桌面控制。
