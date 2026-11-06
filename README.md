# NetMeter

[中文](#中文) · [English](#english)

NetMeter 是一个 Windows 本机代理流量悬浮方格，界面支持中文和英文双语。它读取代理控制器当前活动连接的累计字节数，按目标域名展示下载、上传速度和本机累计流量，不会主动发起测速。

NetMeter is a compact always-on-top traffic tile for Windows. The interface ships in Chinese and English. It reads the byte counters of the proxy controller's active connections and shows per-domain download/upload speed and local totals. It never runs an active speed test.

## 截图 / Screenshots

悬浮方格 / Floating tiles

| 中文 | English |
|---|---|
| ![方格 tiles-zh](docs/screenshots/tiles-zh.png) | ![方格 tiles-en](docs/screenshots/tiles-en.png) |

历史面板：「历史流量」与「历史均速」 / History panel: traffic and average speed

| 中文 | English |
|---|---|
| ![历史流量 history-traffic-zh](docs/screenshots/history-traffic-zh.png) | ![历史流量 history-traffic-en](docs/screenshots/history-traffic-en.png) |
| ![历史均速 history-speed-zh](docs/screenshots/history-speed-zh.png) | ![历史均速 history-speed-en](docs/screenshots/history-speed-en.png) |

设置页 / Settings

| 中文 | English |
|---|---|
| ![设置 settings-zh](docs/screenshots/settings-zh.png) | ![设置 settings-en](docs/screenshots/settings-en.png) |

托盘图标：浅色 / 深色背景、多种尺寸预览 / Tray icon: light/dark backgrounds and size variants

![托盘图标 / Tray icon preview](docs/screenshots/tray-icon-preview.png)

窗口标题栏实际截图 / Native window title bars

| 中文 | English |
|---|---|
| ![窗口图标 / Chinese window icon](docs/screenshots/window-icon-zh.png) | ![窗口图标 / English window icon](docs/screenshots/window-icon-en.png) |

系统拒绝自动固定时的实际引导 / Native guide when automatic pinning is unavailable

| 中文 | English |
|---|---|
| ![固定引导 / Chinese pinning guide](docs/screenshots/start-menu-guide-zh.png) | ![固定引导 / English pinning guide](docs/screenshots/start-menu-guide-en.png) |

---

# 中文

## UI 设计规范

当前视觉基线、交互规则和后续 UI 修改要求统一记录在 [UI_DESIGN_SPEC.md](UI_DESIGN_SPEC.md)。项目级约束见 [AGENTS.md](AGENTS.md)，修改方格、设置页或历史页前应先阅读规范。

## 桌面版

需要 Node.js 24 或更新版本。首次在项目目录运行：

```powershell
npm install
npm start
```

启动后设置窗口和置顶方格会同时显示，两者可独立操作；应用同时驻留在 Windows 托盘。设置窗与方格重叠时会自动移动到方格旁边。在方格任意位置按住鼠标左键拖动可整体移动悬浮窗口，所有方格一起走；按住 `Ctrl` 拖动才是摆放单个方格（Ctrl 在按下鼠标前后按都有效，拖动中按下会切换为单格拖动），横排、上下排列或错位摆放都可以，松手后保留实际位置并保存在本机。拖动时方格始终跟随指针，其他方格的 X 或 Y 坐标进入 8px 范围只显示对齐参考线，不会吸附；松手后落点就是指针位置，拖动一个方格时其余方格既不跟随也不偏移。拖动单个方格期间悬浮窗会按需扩大或平移，方格始终跟随指针，放开后再收紧到所有方格实际占用的范围，窗口内不留透明空隙。悬浮窗在屏幕上的位置会记住，重启后回到同一位置。右键方格可打开设置、隐藏方格或退出，单击托盘图标可显示/隐藏方格。

Windows 托盘使用绿色下载、蓝色上传双箭头图标；`assets/tray/netmeter.ico` 含 16–64px 七档尺寸，避免原 SVG 被原生接口解码为空图。单击和右键菜单保持不变。

设置窗口标题栏、悬浮方格窗口和托盘统一使用同一份双箭头 ICO；应用在创建窗口前先更新用户数据目录中的旧图标。开始菜单里的 `NetMeter` 快捷方式由 `scripts/install-start-menu.ps1` 生成，并复制同一份 ICO，不再绘制旧波形，缺失时应用启动会自动补齐。

**创建快捷方式不等于固定。** 托盘或方格右键菜单选择“固定到开始菜单…”后，应用会准备快捷方式并请求系统固定，只有确认系统已固定才显示成功。若 Windows 拒绝自动固定，会明确提示尚未固定：点击“打开快捷方式位置”，右键选中的 `NetMeter` → “固定到开始”或“固定到开始屏幕”（必要时先选“显示更多选项”）。取消不会打开资源管理器，启动不会自动固定。

方格的统计行默认显示均速；点击“均速”可切换为“峰值”，每个方格独立切换。均速与峰值共用设置页选定的统计窗口（最近 2 / 5 / 10 分钟，默认 5 分钟）：均速是窗口内该方向的字节增量 ÷ 该方向有流量的秒数，下载与上传各自独立、空闲秒不计入分母；峰值取窗口内该方向有流量的最高单次采样速度，样本滑出窗口后自动回落，窗口内无流量时两者都显示“—”。点击方格顶部的域名可查看该域名的历史流量，历史视图直接在方格窗口内展开，使用与方格一致的整窗实色背景，不使用内层弹窗或滚动区域。历史面板带两个标签：「历史流量」是最近 24 小时的柱状图，「历史均速」是同窗口的曲线图，纵轴是同一统计窗口内的均速，口径与方格一致。曲线会将最近 24 小时内首尾有效均速点之间的真实时间范围铺满横轴，中间断档保留；悬停读数仍对应实际分钟。曲线上的悬停读数给出光标所在分钟的均速（该统计窗口内该方向的字节增量 ÷ 有流量的秒数），并带一条竖直指示线标出该分钟；历史曲线只用均速，不使用峰值代替。旧历史若有字节但缺少对应方向的活跃秒，该方向窗口均速无法还原，曲线留空并提示，流量柱状图仍保留原字节；不再擅自按 60 秒摊薄。此前已经被补写为 60 秒的少量旧记录无法与真实 60 秒数据可靠区分，不能自动恢复。

历史面板会记住上次选中的标签：下次打开任意域名的历史或重启应用后会恢复该视图。首次使用默认“历史流量”，无需在设置页另选默认值。

## 界面语言

设置页的「界面语言」提供「简体中文」和「English」两项，选择后立即生效，无需重启。设置窗口与悬浮方格共用同一个选择：切换语言后设置页立刻换文案，已打开的悬浮方格也会通过 `storage` 事件同步换成同一语言。语言记录在独立的 `netmeter-language` 本地存储键里，不会被设置保存覆盖。

下拉框的取值（如「最近 5 分钟」「7 天」）是本地存储用的稳定键，切换语言只改变显示文案，取值保持不变，因此两种语言下的历史数据和均速窗口完全一致。

托盘菜单、设置窗口标题和悬浮方格的右键菜单同样跟随界面语言。

## 控制器配置

- 地址填写代理控制器的本机 HTTP API 地址，默认 `127.0.0.1:9097`。
- 在 API 密钥框输入访问密钥；网址使用条目列表，点“+”新增、在输入框直接编辑、点“×”移除。每条左侧的复选框控制是否显示方格，保存后生效并记住选择；取消勾选仍保留条目和历史，继续采集，重新勾选即可恢复。旧网址自动迁移为已勾选条目。路径不参与匹配，子域名会归并到对应方格。监听地址和密钥右侧的眼睛按钮只在显示与隐藏之间切换，不写入剪贴板。
- 保存后，小窗每秒读取一次控制器活动连接并比较字节计数增量，得出当前速度。控制器只提供活动连接时，连接结束前未被轮询到的最后一段流量可能无法计入。
- 密钥不写入 `localStorage`、项目文件或日志，而是由 Electron `safeStorage` 使用 Windows 当前用户凭据加密保存。首次输入后，重启应用无需再次输入；密钥框留空会继续使用已保存值。禁用控制器不会删除已保存密钥，只有更换控制器地址时才需要重新输入。
- 历史流量按分钟聚合到当前本机浏览器配置的 IndexedDB，可选保留 7 天、30 天或长期；新分钟样本同时记录下载与上传各自的有流量秒数，供历史均速曲线使用；旧样本可能缺少活跃秒，无法精确计算均速。详情图表展示最近 24 小时。累计总量保存在浏览器本地设置中。

默认控制器地址要求为本机回环地址，采集服务只绑定 `127.0.0.1`。若默认端口 `4174` 被占用，应用会尝试后续 9 个端口。

## 网页调试

也可单独运行同源转发服务检查设置页：

```powershell
node server.mjs
```

访问 `http://127.0.0.1:4174/`。此模式没有 Windows 托盘或独立置顶窗口。

## 开发校验

```powershell
npm test
```

`npm test` 覆盖均速与峰值口径、历史曲线、拖动对齐、服务端密钥处理和双语字典一致性。离屏 Electron 探针位于 `scripts/`：`i18n-probe.cjs` 校验中英文渲染与语言切换，`screenshot-probe.cjs` 生成 `docs/screenshots/` 下的效果图，`history-curve-probe.cjs` 校验历史曲线与标签栏，`domain-entries-probe.cjs` 校验网址条目的增删编辑、显示选择与重载记忆，并更新中英文设置页效果图。`generate-tray-icons.cjs` 从 SVG 重建多尺寸 ICO/PNG 和托盘预览；`tray-icon-probe.cjs` 校验像素、原生解码和 Windows 托盘注册。

---

# English

## UI design spec

The current visual baseline, interaction rules and the requirements for later UI changes are recorded in [UI_DESIGN_SPEC.md](UI_DESIGN_SPEC.md). Project-level constraints live in [AGENTS.md](AGENTS.md); read the spec before changing the tiles, the settings page or the history panel.

## Desktop app

Requires Node.js 24 or newer. On a fresh checkout run:

```powershell
npm install
npm start
```

After launch the settings window and the always-on-top tiles are visible at the same time and can be operated independently; the app also stays in the Windows tray. When the two windows overlap the settings window moves aside instead of covering the tiles. A plain left-button drag anywhere on a tile moves the whole widget with all tiles; holding `Ctrl` while dragging moves only the tile under the pointer (Ctrl works before or after the button goes down, and pressing it mid-drag switches to a single-tile drag). Tiles can be arranged in a row, in a column or out of alignment, and the position you drop them at is kept on this machine. During a drag the tile follows the pointer exactly; a neighbouring tile's X or Y coordinate within 8px only shows an alignment guide and never snaps. Dragging one tile never moves or shifts the others. The widget grows or pans as needed while a single tile is dragged, then tightens to the actual area the tiles occupy, leaving no transparent gap inside the window. The widget's position on screen is remembered and restored on the next launch. Right-click a tile to open the settings, hide the tiles or quit; click the tray icon to show or hide them.

The Windows tray uses green download and blue upload arrows. `assets/tray/netmeter.ico` includes seven sizes from 16 to 64px, replacing the SVG input that decoded as an empty native image. Click and context-menu behavior is unchanged.

The settings title bar, widget window, and tray share the same transfer-arrow ICO. Startup updates the old icon in the user-data directory before creating any windows. `scripts/install-start-menu.ps1` creates the `NetMeter` Start menu shortcut using that same shipped icon instead of redrawing the obsolete waveform; startup recreates a missing shortcut.

**Creating a shortcut is not pinning it.** Choose “Pin to Start…” in the tray or tile context menu to prepare the shortcut and request native pinning. Success is reported only after Windows confirms it. If Windows rejects automatic pinning, the app explicitly says it is not pinned yet: choose “Open shortcut location”, right-click the selected `NetMeter` shortcut, then choose “Pin to Start” (use “Show more options” first if needed). Cancel does not open Explorer, and startup never automatically pins the app.

The statistics row of a tile shows the average by default; click “Avg” to switch it to “Peak”. Each tile switches on its own. The average and the peak share the statistics window chosen in the settings (last 2 / 5 / 10 minutes, 5 minutes by default): the average is the byte delta in that window ÷ the seconds in that direction that carried traffic, computed separately for download and upload with idle seconds excluded from the denominator; the peak is the highest single-sample speed of that direction inside the same window, and it falls back as soon as its sample leaves the window. Both show “—” when the direction had no traffic in the window. Click the domain at the top of a tile to open that domain's traffic history; the history view expands inside the tile window itself, using the same solid window background as the tiles, with no inner dialog and no scroll area. The history panel has two tabs: “Traffic” is the bar chart of the last 24 hours, and “Average speed” is the curve for the same window, whose vertical axis is the average inside the same statistics window and uses the same definition as the tiles. The time range between the first and last valid average points within the last 24 hours fills the plot width; internal gaps retain their actual duration and hover readouts keep the real minute. Hovering the curve reads out the average speed of the minute under the cursor (the byte delta in that statistics window ÷ the seconds that carried traffic) and marks the minute with a vertical guide line; the history curve only ever reports averages and never substitutes a peak. If older byte records lack active seconds for a direction, that direction’s window cannot have a truthful average: the curve has a gap and a bilingual notice, while the traffic bars retain their byte totals. We no longer spread such bytes over an invented 60 seconds. Some earlier records already written with a synthetic 60 seconds cannot reliably be distinguished from genuine 60-second records or reconstructed automatically.

The history panel remembers the last selected tab. Reopening another domain or restarting the app restores that view. On first use it starts with “Traffic”; there is no separate default-view setting.

## Interface language

The settings page offers “简体中文” and “English” under “Interface language”. The choice applies immediately, without a restart. The settings window and the floating tiles share the same choice: switching the language repaints the settings page right away, and an open widget follows it through the `storage` event. The language is stored under its own `netmeter-language` local storage key, so saving the settings never overwrites it.

The values behind the dropdowns (such as “最近 5 分钟” / “7 天”) are stable keys used for local storage. Switching the language changes only the visible text and keeps the values, so the history data and the statistics window are identical in both languages.

The tray menu, the settings window title and the tile right-click menu follow the interface language as well.

## Controller configuration

- The address is the local HTTP API address of your proxy controller; it defaults to `127.0.0.1:9097`.
- Enter the access key in the API key box. Websites are editable list entries: use “+” to add one, edit its input directly, or use “×” to remove it. The checkbox controls whether its tile is shown. Save to apply and remember the selection. Unchecked entries keep collecting traffic and retain their history; check them again to restore the tile. Existing websites migrate as checked entries. Paths do not participate in matching, and subdomains are folded into the matching tile. The eye buttons next to the listen address and the key only toggle between showing and hiding; they never write to the clipboard.
- After saving, the small window reads the controller's active connections once per second and compares the byte counters to derive the current speed. When the controller only exposes active connections, the last stretch of traffic before a connection ends may not be counted.
- The key is never written to `localStorage`, project files or logs. Electron's `safeStorage` encrypts it with the current Windows user credential. After the first entry the app restarts without asking again; leaving the key box empty keeps the saved value. Disabling the controller does not delete the saved key — only changing the controller address requires a new one.
- Traffic history is aggregated per minute into the IndexedDB of the local browser profile and can be kept for 7 days, 30 days or forever. New minute samples record the active seconds of download and upload independently for the average-speed curve; older samples may lack those seconds and cannot yield an exact average. The detail chart shows the last 24 hours. Cumulative totals are kept in the browser's local settings.

The default controller address must be a loopback address, and the collector only binds to `127.0.0.1`. If the default port `4174` is taken, the app tries the following 9 ports.

## Browser debugging

The same-origin forwarder can also run on its own to inspect the settings page:

```powershell
node server.mjs
```

Open `http://127.0.0.1:4174/`. This mode has no Windows tray and no separate always-on-top window.

## Development checks

```powershell
npm test
```

`npm test` covers the average and peak definitions, the history curve, drag alignment, the server-side secret handling and the consistency of the bilingual dictionary. The offscreen Electron probes live in `scripts/`: `i18n-probe.cjs` verifies the Chinese and English rendering and the language switch, `screenshot-probe.cjs` produces the images under `docs/screenshots/`, and `history-curve-probe.cjs` verifies the history curve and its tab bar, and `domain-entries-probe.cjs` checks website editing, visibility and reload persistence while updating the bilingual settings screenshots. `generate-tray-icons.cjs` rebuilds ICO/PNG sizes and the preview from the SVG source; `tray-icon-probe.cjs` checks pixels, native decoding and Windows tray registration.
