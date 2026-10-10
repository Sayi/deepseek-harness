# Agent Note: Desktop macOS 菜单栏图标

Status: implemented

[English](2026-10-10-desktop-macos-menu-bar-icon.md) | 中文

macOS 状态栏项点击即打开窗口、不提供任何菜单，这两项行为由[关闭与退出决策](../architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.zh.md)负责；本笔记只记录该决策有意留给后人的 macOS 资源、接线与打包。

## 问题

关闭 Desktop 主窗口只是把它隐藏：页面与 Host 继续运行，窗口必须在保留当前文档的前提下重新找回。Windows 全程常驻托盘图标，并在首次隐藏时提示托盘就是回来的入口。macOS 此前没有菜单栏图标，只能依赖 Dock、再次启动和 `dsh://open`；因此用户关闭窗口后，必须在众多 Dock 图标里找到它，或重新启动应用——即便正在运行的任务让这个窗口值得随时找回。产品需求是一个随应用启动就存在的状态栏图标，让窗口在这个交互式使用场景下始终只差一次点击。

## 决策

macOS 常驻菜单栏状态栏项，启动即创建、整个运行期间存在，作用与 Windows 托盘一致：一个回到已隐藏窗口的可见入口。它有意不提供任何菜单，点击事件因此直达应用而不是展开菜单；退出走应用菜单、⌘Q 或 Dock。Windows 的行为、资源与首次隐藏提示保持不变；macOS 同时保留 Dock 图标，首次隐藏前依然不做任何确认。

### 图标资源

`resources/tray-macosTemplate.png` 为 16×16，`resources/tray-macosTemplate@2x.png` 为 32×32。两者在透明背景上呈现产品的圆角方块、鲸鱼镂空：所有不透明像素均为纯黑，鲸鱼为透明——这是 macOS 模板图像的硬性要求，也让系统能在深色菜单栏上反色该方块。`apps/desktop/scripts/render-tray-icon.ts` 从 `resources/icon-windows.svg` 中 `tray-glyph` 组里的那条 `<path>` 生成两者：去掉外层投影滤镜，测量该路径的 alpha 包围盒，再通过 SVG 蒙版把它从圆角方块里减去；方块填满整个 16 pt 视觉方框，鲸鱼则保持在方块边长的 76%。从已提交的矢量源派生可以避免复制一份路径数据；`apps/desktop` 下的 `pnpm run render:tray-icon` 是三份已提交资源（含 Windows ICO）的唯一产出途径。

### 应用集成

`apps/desktop/src/tray.ts` 的职责不变：tooltip 用 `aboutProduct`，分隔线两侧是 `openApplication` 与 `quitApplication`，`click` 走打开动作，locale 变化时 `relabel`，退出确认后 `dispose`。其选项新增 `templateImage`，构造函数在该标记为真时对载入的图像调用 `setTemplateImage(true)`，菜单栏因此按当前颜色在浅色、深色与高亮状态下绘制该图形。没有新增任何本地化文案。

`apps/desktop/src/main.ts` 在 `process.platform` 为 `win32` 或 `darwin` 时创建托盘。Windows 保持开发态 `resources/tray-windows.ico`、打包态 `process.resourcesPath/tray.ico`；macOS 使用开发态 `resources/tray-macosTemplate.png`、打包态 `process.resourcesPath/tray-macosTemplate.png`，命名使 Electron 能载入同级的 `@2x` 文件。创建失败仍然告警后继续运行。打开动作仍是 `focusPrimaryWindow`，因此状态栏项还原隐藏或最小化的窗口、重建已销毁的窗口，并和 Dock、二次启动一样尊重强制更新遮罩；退出仍是 `app.quit()`，从而进入统一退出确认。Linux 依然没有托盘：Desktop 正式发布的平台只有 macOS 与 Windows。

### macOS 点击行为

状态栏项不设置上下文菜单，因此 macOS 会把点击交给应用，由共享的 `click` 处理器显示并聚焦窗口。`DesktopTray` 只在 `contextMenu` 选项要求时才构建菜单，Windows 托盘正是如此。

### 打包

`apps/desktop/scripts/electron-builder-config.mjs` 在现有 `packagesMacOS` 条件下把两份 PNG 加入 `extraResources`，因此 macOS 构建只携带模板图像，Windows 构建只携带 ICO。

## 备选方案

**窗口隐藏时同时隐藏 Dock 图标，做成纯菜单栏应用。** 否决：Dock 正是「关闭后转入后台」决策已经依赖的 macOS 约定，隐藏它会一并去掉 Dock 菜单的退出、About 面板的激活入口和 Cmd+Tab 的存在感，而这些是长期运行任务类工具的用户的预期。

**直接把彩色应用图标当作菜单栏图像。** 否决：带背景与投影的彩色图块违反模板图像约定，无法在深色模式与高亮状态下正确反色，在原生状态栏项旁边也显得突兀。

**在 macOS 上复用 `resources/tray-windows.ico`。** 同样否决：多尺寸 ICO 自带图块背景与渐变，且 Electron 渲染 ICO 条目时不走模板图像处理。

**现在就抽出一套跨平台托盘抽象，并把 Linux 纳入。** 以范围为由否决。Windows 行为本已正确，Linux 也不是发布目标，抽象会在没有第二个真实使用方校验其形态时就出现。

**增加一个隐藏状态栏项的设置。** 推迟。需求是常驻图标，而偏好项会引入一个默认值与行为都还没有用户证据支撑的持久设置；该图标是叠加功能，若事实证明不受欢迎也很容易移除。

## 测试

单元测试固定已提交的模板图像（尺寸、透明背景、纯黑不透明像素、圆角方块填满画布且鲸鱼镂空、Retina 墨迹为标准版的两倍），渲染脚本对缺少托盘图形的矢量源报错，`DesktopTray` 的模板标记与无菜单模式，`main.ts` 中 macOS 与 Windows 的图标路径以及菜单栏项的点击与关闭路径，`extraResources` 的平台拆分，以及 macOS 发布配置的资源清单。

模板图像渲染、Retina `@2x` 载入与深色模式反色是单元测试无法证明的 macOS 与 Electron 行为，需要在 Retina macOS 机器上人工验证一次；提案的验收标准已列出它，且没有任何自动化通道覆盖。

## 影响

两个已发布平台上，窗口在整个运行期间都能从系统状态区找回；macOS 关闭窗口后也有了不依赖用户寻找 Dock 图标的可见回程。代价是 macOS 多了一个常驻且无法移除的界面，并且部分取代了[关闭与退出决策](../architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.zh.md)（其中关于 macOS 的表述现在指向本笔记）；那份笔记仍然是关闭、隐藏与退出确认行为的归属者。
