# DSH 插件 UI 设计交互规范

面向 dsh 插件（`packages/client/*` 之外的扩展包）开发整理，全部条款经源码核验；来源为仓库内文件时标注路径。**注意：本仓 API 未稳定，引用 `ctx.*` 面与 ui-primitives 导出前先对照当前源码**（根 AGENTS.md「Pre-stable APIs」）；仓内文档未覆盖外部插件如何向浏览器注入样式，此空白需以宿主 profile 的实际构建方式为准。

---

## 0. 对插件作者的三条基本事实

1. **插件之间禁止互相导入组件/值**。`ui-primitives` 是唯一跨插件的共享控件通道；没有对外稳定导出承诺。〔packages/client/AGENTS.md 导出纪律〕
2. **插件不拥有主题**。全局 token 表归 `ui-theme` 属主；插件只能①消费语义别名，②经 `ctx.theme.register` 注册别名覆盖，③定义组件内局部布局变量。
3. **文案归属 locale 字典**。仓内 i18n 门禁（`scripts/verify-client-ui-i18n.ts`）只扫描 `packages/client/*`、`apps/web`、`apps/desktop` 等路径，**外部插件包不在扫描面内**——规范靠自觉，机制上无人拦截。

---

## 1. Token 消费纪律

三层架构：静态色阶 `--dsw-static-*` → 语义别名 `--dsw-alias-*` / 场景专用 `--dsw-specific-*` → 组件消费。插件只碰第三层。〔ui-theme/src/styles/design-platform.css〕

### 1.1 常用语义 token 速查

| 类别 | Token |
|---|---|
| 背景 | `--dsw-alias-bg-base` / `-bg-layer-1..3` / `-bg-overlay` / `-bg-mask-1..3` / `-bg-skeleton` / `-bg-multi-select` |
| 文本 | `--dsw-alias-label-primary/-secondary/-tertiary/-caption/-dimmed/-inverted/-shimmer`、`--dsw-alias-brand-text`、`--dsw-alias-link` |
| 边框 | `--dsw-alias-border-l1..l4`（4%–20% 阶梯；中性实线用 `--dsh-hairline-width`，按 DPR 发布） |
| 状态 | `--dsw-alias-state-{success\|warn\|error\|business\|idle}-primary/-secondary/-tertiary`（danger 即 error 系） |
| 交互 | `--dsw-alias-interactive-bg-{hover\|active\|hover-danger}`、`--dsw-alias-button-*` |
| 浮层 | `--dsw-alias-tooltip-bg`、`--dsw-alias-toast-bg/-label`、`--dsw-menu-surface-fill`、`--dsw-menu-backdrop-filter`（菜单材质，禁止覆写） |
| 圆角 | `--dsw-radius-xs4/sm8/md12/lg16/xl20/panel28`（base.css）；全局超椭圆 `--dsw-corner-shape: superellipse(1.5)`，全圆须配 `corner-shape: round` |
| 阴影/高程 | `--dsw-shadow-lv1..3`；浮层用 `--dsw-elevation-panel/-prominent/-soft` + 描边重绑 `--dsw-elevation-stroke-color` |
| 动效 | `--ds-transition-duration`（.2s）/`-fast`（.1s）/`-slow`（.3s）、`--ds-ease-in-out: cubic-bezier(.4,0,.2,1)` |
| 焦点 | `--dsw-focus-ring-width: 2px`、`--dsw-focus-ring-color`（默认 business-primary） |
| 滚动条 | `--dsh-scrollbar-thumb(-hover,-border,-width:5px)` 重绑体系（scrollbar.css） |
| 字号/字体 | `--dsh-content-font-size`（默认14）/`--dsh-code-font-size`（11）/`--dsh-terminal-font-size`（13）、`--dsh-font-family-{text\|code\|terminal}` |

### 1.2 硬性条款

1. 禁止字面颜色；禁止复制 `--dsw-static-*` 数值——只引用 `--dsw-alias-*`/`--dsw-specific-*`。〔docs/web-styling.md〕
2. 插件 CSS 中不得出现主题选择器（`[data-ds-dark-theme]`）或 `[data-platform=…]` 全局改写；深浅差异由别名层承担。
3. 浮层 `border: 0` 用 elevation，**禁止 border+shadow 叠加**。
4. 圆角取六档之一，不造越档值。
5. 每个动效提供 `prefers-reduced-motion` 分支；键盘焦点环不得移除。
6. `:hover` 包在 `@media (hover: hover)`；JS hover 预览锁 `(any-hover: hover)`。
7. 滚动条不自写 `::-webkit-scrollbar`，重绑 `--dsh-scrollbar-*` 即可。
8. 文字禁用 `-dimmed` 色调；每个墨/底组合必须在 light 与 dark 双主题验证可读。
9. 字重上限 500（ui-theme 的 markdown 排版 token 除外）；强调用字号或墨色。
10. 字号取自主题变量或宿主页面既有刻度（13px 为行/详情惯用尺寸）；禁止为单元素造新字号；无先例时借用最相似页面的比例。
11. 样式实现：CSS Modules（`组件名.module.css`，camelCase 类）+ `clsx`；无组件库、无 Tailwind、无全局类前缀。
12. 中性边框 0.5px（`--dsh-hairline-width`）；元素与相邻项沿明确轴（基线/垂直中线/共享边）对齐，图标尺寸与旁侧文字成比例。

### 1.3 主题覆盖（插件可做）

- `ctx.theme.register(definition)`：注册主题 id + `tokens` 别名覆盖。**每个覆盖必须同时给 `{light, dark}`，裸字符串被 `validateOverrides` 抛错**。〔ui-theme/src/client/index.ts:181,354〕
- `ctx.theme.overrideTokens(source, tokens)`：叠加层，seq 序后者胜。〔同上:388,601〕
- 图标替换走 `ThemeDefinition.icons`（`ICON_SYMBOLS` id → 完整 SVG 文档），`validateIcons` 校验 viewBox、禁 `<style>/<script>`、要求 id 前缀；仅产品图标可换。〔ui-theme/README.md, src/client/icon-sprite.ts〕

---

## 2. 扩展面：插件的四条注册通道

### 2.1 Slot（UI 进宿主结构）

- 四种 kind：`single | list | keyed | chain`；命名镜像组合路径 `<domain>.<entry>.<hole>`。
- 在**自己**入口声明 `children` 即授权；渲染未声明 slot 或重复声明他人 slot 在加载期抛错。
- 宿主已声明、可被插件 keyed 注册的主要落点：
  - `tool.call.toolview` —— 工具卡片按 wire tool name 键控注册；**未注册工具自动落通用卡**（插件不注册也有基本展示）。
  - `conversation.chat.node` —— 聊天流业务节点，一个业务功能注册一个 `ConversationNodeDefinition` + 渲染器，不要指望往 Session/中心分发器里加分支。
  - 右栏/侧栏内容注册 slot 进现有 sidebar，**绝不另起第二个 sidebar**。
- 跨包注入他包 slot 用 `ctx.slots.inject(name, () => ctx.slots.register(...))`：等待声明出现、声明塌缩时自动移除、可多次 yield 原子注册/回滚。〔docs/subsystems/slots.md, packages/client/AGENTS.md〕

### 2.2 Locale（文案）

- `ctx.locale.register(ns, {zh, en, ...})` 注册命名空间；**zh 与 en 是强制基线**，字典用 `satisfies Record<string,string>` 保类型。
- 消费走 `ctx.locale.bind(ns)` 或框架注入的 `t`；回退链必须终止于 `en`（查找顺序：命名空间链 → `common` 链 → 直接显示 key）。
- 外部语言包经 `ctx.locale.addLanguage({id, label, fallback})` 扩展。〔packages/client/locale/README.md:40-96〕

### 2.3 Shortcuts（键位）

- 命令经 `ctx.shortcuts` 在 `ctx.effect()` 内注册；按 6 个 profile 声明默认键（`desktop|web` × `macos|windows|linux`），缺省即不绑定。
- `primary` 展开为设备修饰键：**macOS=Command，其余=Control，记法统一 `Mod`**；Windows 展示修饰键间用 ` + `。
- 只读"固定动作"走 `registerFixed()`。〔shortcuts/src/client/registry.ts:50〕
- 用户覆盖存设备本地：Web localStorage `dsh.keybindings.v1`，Desktop `userData/keybindings.json`。〔shortcuts/src/client/storage.ts:6, shortcuts/README.md〕

### 2.4 Theme（见 1.3）

---

## 3. 组件 API 速查（ui-primitives，经 /client 入口可用）

- **原子组件零 Cordis、纯 props**：不接 slot/service/locale；**所有产品文案（含无障碍名、tooltip、placeholder）是必填 label props，包内无语言兜底，漏传即编译失败**——这是外部插件最强的 i18n 约束力来源。〔ui-primitives/README.md〕
- 已核验可用：`Button`（variant `primary|ghost|outline|toolbar`，默认 ghost；`md`=H36/R12、`sm`=H28/R8；outline 用 hairline 内描边）、`RiskConfirmation`（敏感操作显式勾选门控）、`Modal` + `useModalLayer`（统一 Escape/Tab/焦点归还，含 `isBehindModal`、`closeTopModal`）、`Menu`/`MenuSurface`、`MarkdownText`（不可信 GFM+TeX，剥离原始 HTML、限制链接；`variant="body|compact"`）、`UserMessageBubble`、`useClipboardCopy`（成功 1s 就地反馈）、`ConnectionIndicator`（断线/重试/恢复三态胶囊）、`SegmentedTabs`（42/34px）、`Switch`（36×20）、`Tag`/`Pill`/`SegmentedControl`（语义不同不可混用）。
- 注意：`FoldToggle` 包内私有未导出。
- **刻意的视觉差异提升为 prop，而不是复制第二份组件**；写控件前先对照上表，宿主没有的通道才在自己的包内做，值得共享的再考虑推动进 primitives。
- z-index 事实分层（无 token）：局部 1–6；HoverCard/Tooltip/Menu 触发层 100–110；Modal/Lightbox 1000；Toast 与 portal 化浮层 1100。插件浮层按此对齐。

---

## 4. 交互规则

### 4.1 浮层三验（每个菜单/浮层必须过）

1. 外部点击 + Escape 均可关闭；
2. 贴边视口自适应翻转且不震荡；
3. 逃出 overflow 祖先，不被父级裁剪。

Modal/菜单共享 `--dsh-frame-top-clearance`（+20px）顶部避让（macOS 恒有该安全量，由宿主 preload 写 `data-platform='darwin'`，插件只消费变量、不改写）。〔dsh-client-ui-ux, ui-layout〕

### 4.2 反馈面选择（按消息寿命相对产生它的面）

- **瞬时操作结果 → 全局 Toast**：宿主必须比报告面板长寿（`shell.overlay` 条目）——操作可能关掉发起面板，只有外部 Toast 存活；报成功与失败，不报 pending；重复同错不重置计时，异错立即替换。
- **失败保留数据可见**：删除失败行不消失，Toast 报失败；绝不因瞬态错误清空内容。
- **就地提示只用于与表面自身绑定的状态**：查询失败+Retry、字段校验挂 owning 表单；已填充面板用紧凑提示，仅空面板用居中大错误态。
- **Loading**：列表用 skeleton；页级加载居中裸 spinner（禁角落 spinner）；一页只一种加载态；失败态自带 retry。
- 复制成功用 1s 就地反馈，不打 Toast。
- **危险操作分档**（宿主先例）：归档/停止会话→二次确认对话框（注册进 `shell.overlay`，按实体 key 一请求一对话框）；定时任务删除→不弹窗，Toast 播报成败；敏感项→`RiskConfirmation` 勾选门控。
- 审批面板先例：聚焦后 Enter=允许（限定范围）、Escape=拒绝；持久授权（Always allow）必须显式点击，不做键位默认；同一 pending-request 加锁防重复应答。〔ui-approval/README.md〕

### 4.3 输入区先例（插件扩展候选菜单时对齐）

- Enter 按配置投递、Ctrl/Cmd+Enter 互补、Shift+Enter 换行；IME 组合期间 Enter 只确认候选；空/纯空白不可发送，提交失败恢复草稿。
- `/`、`@` 触发分组候选：Tab 确认（可下钻），Escape/Shift+Tab 只退出不消费草稿；pointer 在菜单与卡片外按下才关闭；同 token 同 query 关闭后保持关闭。
- Stop 惯例：聚焦输入区连按两次 Esc（`response.stop`，默认 500ms 窗口，ui-conversation 注册）；固定动作在 tooltip 展示 `Esc Esc`。

### 4.4 响应式（插件面板同样适用）

- 决策顺序：先重排空间/换行 → 再截断/图标化/收进 More；主操作与主状态不得丢失；截断内容必须在二级页面或菜单完整可得；错误信息不得被截断。
- 图标化双条件：语义明确 + hover tooltip；跳页类操作不许图标化；键位提示在 `(pointer: coarse)` 且无键盘导航时隐藏。
- 窄屏阈值先例：sidebar <1024px 自动折叠；右栏 <768px 打开即 fullscreen。
- `(pointer: coarse)` 下输入框字号 ≥16px 防 iOS 聚焦缩放；禁止解析 UA 分支布局；宽度变化保持焦点、不重挂载；移动端不弹纯辅助说明型 tooltip，解释型支持点按；不自动唤起键盘。〔dsh-responsive-ui〕

---

## 5. 内容与工具卡

- 工具卡默认折叠 maxLines **16** 是 ui-primitives 默认值（head-tail 折叠算法）；**宿主聊天里 ui-tool 已按类型收紧：diff 9、read 8、search 8**——插件工具卡应参考同量级，不要照搬 16。〔ui-primitives `head-tail-cap.ts`, ui-tool/src/client/tool/models/〕
- 输出卡共享几何：`pre + 横向滚动 + head-tail 折叠`；未知/畸形数据降级为通用形态。
- 滚动所有权惯例：读者手势即夺回跟随，程序回底只恢复外层跟随；转轮/触摸/按下打断平滑动画。
- 消息呈现复用 `MarkdownText`（冻结已完成块、尾部增量解析）与 `UserMessageBubble`，不自造 Markdown 管线。

---

## 6. 文案规范

- 一切产品可见字符串——文本、无障碍名、tooltip、placeholder、状态/单位 formatter——进类型化字典并经 `t` 消费；用户/模型/wire 数据与代码 token 保持原文；内部匹配用判别式或稳定 id，绝不用本地化文本。
- 错误文案：平实、短、最多两句（中文两句内省略句号）；不出现内部术语，除非需暴露错误码；**不得引起布局位移**——预留或覆盖，不推挤。
- 英文文案（含插件标题）用 sentence case。〔AGENTS.md, dsh-prose-standard〕

---

## 7. 组件实现约束（防交互劣化）

〔docs/defensive-patterns/client-components.md, packages/client/AGENTS.md〕

1. 注册组件必须模块级稳定引用，防止重挂载丢焦点/丢草稿；`key` 只表述实体身份。
2. 组件永不见 `ctx`；数据与回调全部经 props 的五个派生 share（runtime/children/factories/store/inject face）。
3. props 不传 ReactNode（走 slot）；业务组件零 React context。
4. 实时数据三条通道：父级已知→owner props；仅组件已知→局部 state；跨条目或需存活重挂载→注册时声明的 store（导出 `createXXXStore()` 工厂，模块级 handle 禁）。派生数据是 hook 数据的纯函数，不自建订阅。
5. `useLayoutEffect` 非默认；effect 不向父级回推渲染可派生数据。

---

## 8. 插件作者自检清单

1. 双主题下每个颜色对可读；无字面色、无 `-dimmed` 文字、字重 ≤500。
2. 圆角/动效/焦点环/滚动条全部走 token；浮层用 elevation 且 `border:0`。
3. 浮层三验通过；顶部避让用 `--dsh-frame-top-clearance`。
4. `prefers-reduced-motion` 分支齐备；`:hover` 锁 `(hover:hover)`。
5. 文案全部进 `ctx.locale.register` 字典（zh+en 基线），外部消费无门禁拦截、全靠自觉。
6. 不导入其他插件包的值；控件走 ui-primitives 或包内私有。
7. 注册进 slot 前确认该 slot 已被宿主声明（否则加载期抛错）；跨包用 `ctx.slots.inject`。
8. 工具卡注册 `tool.call.toolview`；不注册时确认通用卡展示可接受。
9. 引用 `ctx.*` 面与 primitives 导出前对照当前源码（API 未稳定）。

---

### 主要来源

`packages/client/ui-theme/{README.md,src/boot-theme.ts,src/client/index.ts,src/client/styles.ts,src/styles/*.css}`、`packages/client/ui-primitives/{README.md,src/*}`、`packages/client/locale/README.md`、`packages/client/shortcuts/{README.md,src/*}`、`packages/client/{ui-conversation,ui-input-trigger,ui-approval,ui-layout,ui-sidebar-right,ui-dockkit,ui-chat,ui-tool,ui-slots}/README.md`、`packages/client/AGENTS.md`、`docs/{web-styling.md,ui-radius.md,subsystems/slots.md,defensive-patterns/client-components.md}`、`.agents/skills/{dsh-client-ui-ux,dsh-responsive-ui}/SKILL.md`、`scripts/verify-client-ui-i18n.ts`、`apps/desktop/src/preload-platform.ts`。
