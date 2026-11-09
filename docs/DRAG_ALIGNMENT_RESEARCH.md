# 独立拖动与自动对齐源码调研

日期：2026-11-09。状态：调研及需求修订完成；实现、部署与验收的当前状态以 [行为规范](DRAG_ALIGNMENT_SPEC.md) 和 [实施记录](DRAG_ALIGNMENT_PLAN.md) 为准。以下旧代码分析只描述研究时快照，不是当前实现。

## 用户要解决的问题

- 邻近时真正自动对齐，而不只是出现参考线。
- Ctrl 独立拖动只影响当前方格；其他方格无论远近都不能抖动。
- 保留普通左键整组移动、跨屏自由位置，不采用网格重排或邻居避让。
- 沿用不使用 computer use、不弹出测试窗口的约束。

## 调研执行与边界

按用户指定，实际调用本机 codex-mmx-max 执行外部源码研究。其报告重点为 Rainmeter、FancyZones、i3；管理者复核关键代码，并补查更贴近桌面组件的 KDE Plasma。原始报告位于当前用户临时目录 netmeter-mmx-snap-research-20261109.md，不作为长期唯一依据。

子任务的受限环境无法运行正常 Node 协调 CLI，因此第二个研究进程未登记、未取得本地声明，协作保护在该子任务中不完整。它只读取外部公开源码，没有修改 NetMeter 文件。首次失败研究进程已停止，其遗留登记已按停止证据回收。没有安装或运行被调研软件。

下面的函数、行为和许可证来自实际源码；参数与架构选择若为 NetMeter 建议，明确单列。链接中的 master/main 是本次读取的分支，不冒称固定提交；Rainmeter 子报告提供了 82ad54e640a7 与 DPI 修订 a469a993dca4 作为额外定位，核心结论以列出的函数为准。

## 已核实的实现

| 项目 | 具体入口 | 可借鉴的机制 | 适用边界 |
|---|---|---|---|
| Rainmeter | Library/Skin.cpp，Skin::Initialize、OnWindowPosChanging、SnapToWindow | 每个 skin 独立顶层窗口；只改当前 WINDOWPOS；邻居只读；吸 X 前要求 Y 区间交叠，吸 Y 前要求 X 区间交叠 | 最贴近浮动小组件；按键约定不能照搬 |
| PowerToys FancyZones | FancyZonesLib/WindowDrag.cpp，MoveSizeStart/Update/End | 拖动时区分移动、预览、提交；跨显示器切换 work area；在结束时把当前窗口送入目标区域 | 是分区窗口管理，不是方格边缘磁吸；不应引入其分区重排 |
| KDE Plasma | components/containmentlayoutmanager/itemcontainer.cpp，mousePress/Move/ReleaseEvent、mouseUngrabEvent | 独占抓取指针，映射到父对象坐标，只更新被拖 ItemContainer；预览占位，结束后提交布局 | 证明共享画布可行的前提是父画布稳定；不采用其网格分配 |

### Rainmeter

Skin.cpp 第 294 行为每个 skin 创建分层工具顶层窗口。第 4702 行开始的 OnWindowPosChanging 基于按下时的窗口位置加当前指针位移生成目标。第 4800-4828 行的 SnapToWindow 仅改本格的 wp->x/y，不改被参照 skin。

g_SnapDistance 在该文件第 68 行为 10，并按窗口 DPI 转为物理像素距离。横向吸附先检查纵向区间交叠，纵向吸附先检查横向区间交叠；这直接避免了只看某一轴造成的远距离吸附。源代码中的 Ctrl/Shift 禁用吸附不适合 NetMeter，因为 Ctrl 已用于独立拖动。未在已核实函数中发现显式的双阈值迟滞，不把迟滞描述为 Rainmeter 既有功能。

来源：[Skin.cpp](https://github.com/rainmeter/rainmeter/blob/master/Library/Skin.cpp#L4702)、[SnapToWindow](https://github.com/rainmeter/rainmeter/blob/master/Library/Skin.cpp#L4800)、[LICENSE](https://github.com/rainmeter/rainmeter/blob/master/LICENSE)。仓库许可证为 GPL-2.0。这里只研究机制，没有复制实现代码。

### FancyZones

MoveSizeUpdate 在显示器变化时切换工作区，把屏幕点映射到工作区点，再更新高亮区域；MoveSizeEnd 才对当前窗口调用 MoveWindowIntoZoneByIndexSet。研究子报告中“拖动中只有被拖窗在动、坐标不变”的表述有歧义，本报告不采用该句；直接以这两个函数的操作范围为准。区域布局的其他副作用不满足 NetMeter 的绝不重排邻居要求，不整体照搬。

来源：[WindowDrag.cpp](https://github.com/microsoft/PowerToys/blob/main/src/modules/fancyzones/FancyZonesLib/WindowDrag.cpp#L51)、[LICENSE](https://github.com/microsoft/PowerToys/blob/main/LICENSE)。许可证 MIT。

### KDE Plasma

ItemContainer::mouseMoveEvent 使用映射到 parentItem 的位置，不混用 scene 坐标；第 640 行只调用当前项的 setPosition。移动跨过单元边界时更新占位符；mouseReleaseEvent 和 mouseUngrabEvent 负责释放抓取及交给布局管理器。不能把这段代码解释成所有共享画布天然稳定：NetMeter 现有父窗口会在手势中移动，前提不同。

来源：[itemcontainer.cpp](https://github.com/KDE/plasma-workspace/blob/master/components/containmentlayoutmanager/itemcontainer.cpp#L552)、[appletslayout.cpp](https://github.com/KDE/plasma-workspace/blob/master/components/containmentlayoutmanager/appletslayout.cpp#L471)。itemcontainer.cpp 的 SPDX 标记为 LGPL-2.0-or-later。

子报告还检查了 i3 的 tiling_drag.c（拖动指示窗与结束后重排），但平铺窗口重排并非本需求，未选为主方案。Cairo 调研没有核实到适合此需求的磁吸函数，因此不把猜测的 classic C 路径或 404 结果当作实现证据，也不声称 Cairo 不存在类似功能。

## 研究时旧实现（2026-11-09，已取代）

研究时 index.html 的 nearestAlignment 只返回接近轴；applyMeterDrag 把结果用于参考线，写回的仍是原始 positionX/Y；settleMeterPosition 直接原样返回。当时没有真正自动对齐；当前已改为主进程独立窗口及实际分轴吸附。

独立拖动越过窗口左/上边缘时，moveWindowSync 会移动整个承载窗口，随后 shiftOtherMeters 修改所有其他方格坐标。最终坐标被补偿，不等于原生窗口合成和网页绘制的中间帧原子一致；这是与“其他方格完全不参与拖动”要求相冲突的结构性路径。该分析不是对每次用户抖动逐帧根因的替代证明。

## 建议的实现方向

1. 首选每格独立无边框原生窗口。主进程单次采集继续共用，不能为每格重复创建采集器。Ctrl 手势仅对当前窗口 setPosition/setBounds，禁止更新邻居窗口、样式或累计布局；普通拖动则按同一组位移更新全组。
2. 把磁吸计算独立为纯几何函数。其他窗口矩形只读，返回当前窗新矩形及参考线，同距离保持当前候选。研究时建议的正交交叠过滤后来排除了正常隔隙单轴摆放，2026-11-10 已修正为有限 32 DIP 正交间隙范围；该参数是 NetMeter 实现选择，不是被研究项目的既有规则，详见行为规范。
3. 进入距离建议沿用现有 8 个逻辑像素；脱离距离建议大于进入距离，例如 12。12 是实施建议，尚未用户验收，不冒称来源项目采用该值。X/Y 分别锁定和脱离，远处候选永不进入。
4. 统一逻辑坐标。Rainmeter 的物理像素 DPI 缩放不能原样照搬到已经是 DIP/CSS 像素的 Electron 路径；不要再乘 devicePixelRatio 造成二次缩放。Electron screen.getCursorScreenPoint 返回 DIP，涉及物理坐标时明确转换一次。
5. 保留指针捕获、稳定抓取偏移、取消恢复和按下次序切换。组拖与独立拖分别建状态；松手只保存本次改变的对象，不做全局收紧或重排。若保留共享画布，则必须证明整个手势不移动、不缩放父窗口。

DIP 来源：[Electron screen 文档](https://www.electronjs.org/docs/latest/api/screen)。以上是架构与实现建议，不是已交付代码。

## 后续验收

- 远处拖动：邻居的原生窗口调用次数为 0，位置和尺寸均不变。
- 进入邻近范围才吸附；正交轴远离时不吸附；退出后继续跟手。
- 等距候选、慢速往返阈值、长按、取消和多次 Ctrl 切换不抖。
- 主副屏往返、负坐标及混合 DPI；普通拖动保持组内相对位置。
- 验证真实指针捕获及正式主进程处理器，禁止通过替换被测逻辑来“通过”。
- 隐藏探针只能证明其可观测范围；实际视觉抖动仍需用户复测通过。此前的 130 项测试不能证明新需求已实现。
