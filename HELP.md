# HELP — 本仓库的日常操作

> 这份笔记属于本 fork（`Sayi/deepseek-harness`），上游 `deepseek-ai/deepseek-harness` 里没有它。
> 所有命令都**在仓库根目录**执行；日常开发分支是 `harness-pro`，`master` 只用来跟随上游。

## 目录

- [1. 启动](#1-启动)
  - [1.1 Web](#11-web)
  - [1.2 桌面版（Electron）](#12-桌面版electron)
- [2. 打包 macOS DMG](#2-打包-macos-dmg)
- [3. 同步上游并合并到自己的分支](#3-同步上游并合并到自己的分支)
- [4. 环境与坑（速查）](#4-环境与坑速查)

## 1. 启动

### 1.1 Web

用隔离启动器。它把源码开发的 Harness home 隔离到 `~/.dsh-dev`，不动已安装客户端用的 `~/.dsh`——源码版处于 pre-stable，session 格式可能写坏正式客户端的数据。

```sh
./dev-web-isolated.sh                      # 构建 + 启动（首次较慢）
./dev-web-isolated.sh --no-build           # 复用已有构建产物，直接启动
./dev-web-isolated.sh --port 3081 --no-open
./dev-web-isolated.sh --status             # 只打印诊断（home、API key 来源）后退出
./dev-web-isolated.sh --headless "总结这个仓库"
```

- 默认地址 `http://127.0.0.1:3080`（`--port` 可改）。
- 隔离 home 默认 `$HOME/.dsh-dev`，**与桌面开发版共用**（sessions / settings / credentials 互通）。
- 其余参数原样转发给 `dsh web`（如 `--patch ./scratch-plugin/cordis.yml`）。
- 等价的直接命令（用普通 home `~/.dsh`，会与已安装客户端共享数据，谨慎）：

```sh
pnpm run dev:web            # tsx scripts/dev-web.ts --poll：构建 + 启动
pnpm run start:web          # 跳过构建
make dev-web ARGS='--no-open'
```

### 1.2 桌面版（Electron）

```sh
./dev-desktop-isolated.sh                  # 构建 + 启动
./dev-desktop-isolated.sh --skip-build     # 复用已有构建产物（注意 Web 那边叫 --no-build）
./dev-desktop-isolated.sh --no-devtools
./dev-desktop-isolated.sh --cn-mirror      # Electron 二进制改走 npmmirror
./dev-desktop-isolated.sh --status         # 只诊断，不启动
```

按重要性排列的注意事项，全部是实际踩过的：

1. **先完全退出已在运行的客户端。** 开发版与打包版共用同一份 userData（`~/Library/Application Support/@deepseek-ai/dsh-desktop`），而 Electron 的单实例锁按 userData 划分：后启动的实例会立刻退出，把请求交给先启动的那个。表现就是"点了新客户端，开出来的却是旧窗口"。

   ```sh
   pkill -f "Harness Dev.app"                                       # 开发版
   osascript -e 'tell application id "com.deepseek.dsh" to quit'     # 已安装的发布版
   ```

2. **从 DSH 会话（或任何 Electron-as-Node 环境）里启动，要清掉 `ELECTRON_RUN_AS_NODE`**，否则 Electron 退化成 Node，报 `bad option: --remote-debugging-port=9222`：

   ```sh
   env -u ELECTRON_RUN_AS_NODE ./dev-desktop-isolated.sh --skip-build
   ```

3. **必须在文件沙箱之外运行**（普通终端即可）：Chromium 要初始化自己的进程沙箱，在 DSH 沙箱里会 `sandbox initialization failed`，接着 GPU/网络/渲染进程连续崩溃。

4. 首次运行会下载 Electron 二进制（约 128 MB，落在 `apps/desktop/.desktop-build/downloads`）并准备主运行时。网络不稳定时先灌运行时缓存（用 curl 绕过 undici 的 10 秒连接超时）：

   ```sh
   node prefetch-primary-runtime.mjs --list    # 只列出将要下载的产物
   node prefetch-primary-runtime.mjs           # 预取并校验（已完成的不会重复下载）
   ```

5. 关键路径：

   | 用途 | 路径 |
   |---|---|
   | 开发态 DSH home | `~/.dsh-dev` |
   | 开发应用包 | `apps/desktop/.desktop-build/development/Harness Dev.app` |
   | 开发态 Electron userData | `apps/desktop/.desktop-build/development/electron-user-data` |
   | 下载缓存（内容寻址） | `apps/desktop/.desktop-build/downloads` |

6. 状态栏 / 通知区行为：

   - **macOS**：菜单栏图标点击**直接显示并聚焦窗口，没有任何菜单**（左键右键都没有）；退出走应用菜单、⌘Q 或 Dock。
   - **Windows**：通知区图标单击开窗，右键菜单提供「打开 / 退出」。

7. 启动器会注册一个临时的 `Harness Dev.app`，它的 Info.plist 声明了 `dsh://`，可能抢走已安装客户端的协议处理器；再启动一次已安装客户端即可注册回去。

## 2. 打包 macOS DMG

本地未签名包，不需要任何 Apple 凭据：

```sh
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries \
DSH_DESKTOP_NPM_REGISTRY=https://registry.npmmirror.com \
pnpm run package:desktop:mac:arm64:unsigned
```

- 产物：`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/deepseek-harness-<版本>-mac-arm64-unsigned.dmg`
- 校验：`hdiutil verify "<dmg 路径>"`
- 版本号默认取 `apps/desktop/package.json`；要指定就追加 `--build-version 0.2.1-alpha.3`。
- Intel 机器把 `mac:arm64` 换成 `mac:x64`（`pnpm run package:desktop:mac:x64:unsigned`）。

**为什么必须带这两个镜像：**

- `ELECTRON_BUILDER_BINARIES_MIRROR`：electron-builder 打 DMG 时要从 GitHub Releases 下 `dmg-builder@1.2.5/dmgbuild-bundle-arm64-75c8a6c.tar.gz`（约 23 MB）。本地网络下官方源会 **600 秒超时**；npmmirror 实测 **18 MB/s**，且文件的 sha256 与 electron-builder 内置校验值一致（`793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb`），它自己也会验。拼法是 `<基址>/<releaseName>/<文件名>`，结尾 `/` 会自动补。
- `DSH_DESKTOP_NPM_REGISTRY`：运行时依赖走 npm。官方源实测 **65 KB/s**，npmmirror **7 MB/s**；16 分钟的安装能降到 16 秒。

其它注意：

- 打包过程会在文件沙箱外做运行时冒烟测试（真实分配 pty、Office 转换、CLI 离线装插件），**必须在普通终端里跑**。
- 这个包的特性/限制：
  - app id 是 `com.deepseek.harness`，**不是**发布版的 `com.deepseek.dsh` → 两个应用并存，要"替代"得手动删掉旧的那个。
  - ad-hoc 签名、不做公证。本地构建没有 `com.apple.quarantine` 隔离标记，双击即可打开；万一被 Gatekeeper 拦，右键 →「打开」一次即可。
  - **不带自动更新通道**，升级需要重新打包。
  - 安装：打开 DMG，把 `DeepSeek Harness.app` 拖进「应用程序」。
- 万一还是卡在 DMG 那一步超时：`ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL`（整段 URL 覆盖）或 `ELECTRON_BUILDER_BINARIES_CUSTOM_DIR`（本地目录，只接受相对路径、不能含 `://`、`..`、前导 `/`）可以替换下载来源。

## 3. 同步上游并合并到自己的分支

远端约定：

```sh
origin    https://github.com/Sayi/deepseek-harness.git          # 自己的 fork
upstream  https://github.com/deepseek-ai/deepseek-harness.git   # 原仓库
```

```sh
# 1) master 跟随上游
git fetch upstream
git switch master
git merge --ff-only upstream/master
git push origin master

# 2) 把 master 合进自己的工作分支
git switch harness-pro
git merge master
git push
```

- **冲突处理**：`git status` 看冲突文件 → 编辑 → `git add <file>` → `git commit` → `git push`。
- **想要线性历史**：用 `git rebase master`，然后 `git push --force-with-lease`（**不要**用裸 `--force`）。
- **别在 dev 客户端运行中 push**：pre-push 钩子会跑 `pnpm run typecheck`（全量构建，约 25 秒），期间会重写 `apps/desktop/lib`、`apps/cli/lib`，可能把你正跑着的客户端脚下的产物换掉。
- 本分支相对上游多出来的东西（`HELP.md`、`dev-*-isolated.sh`、`prefetch-primary-runtime.mjs`）如需保持可提交，注意 `.git/info/exclude` 是**每个 clone 独立**的本地忽略文件；已跟踪的文件不受它影响。

## 4. 环境与坑（速查）

| 症状 | 原因 | 处理 |
|---|---|---|
| `Electron: bad option: --remote-debugging-port` | 环境里有 `ELECTRON_RUN_AS_NODE=1` | `env -u ELECTRON_RUN_AS_NODE` 再启动 |
| 点新客户端，开出来的是旧客户端 | 共用 userData + 单实例锁 | 先完全退出另一个 |
| `sandbox initialization failed`、渲染进程崩溃 | 在 DSH 文件沙箱内启动 Electron | 换到普通终端 |
| 打 DMG 卡住 600 秒后超时 | 在从 GitHub 下 dmgbuild 资源 | 加 `ELECTRON_BUILDER_BINARIES_MIRROR` |
| 依赖安装极慢 | 走的 npm 官方源 | 加 `DSH_DESKTOP_NPM_REGISTRY` |
| `$HOME` 下 `mkdtemp` 报 EPERM | DSH 文件沙箱限制 | 在沙箱外运行该命令 |
| `pip` 提示 `~/Library/Caches/pip` 不可写 | 目录归属/权限 | 无害，忽略 |
| 菜单栏图标偏小或偏大 | 几何常量 | 调 `MACOS_GLYPH_EDGE` / `MACOS_GLYPH_MARGIN` / `MACOS_TILE_GLYPH`，重跑 `pnpm --dir apps/desktop run render:tray-icon` |

## 5. 相关文档

- 桌面端功能与打包细节：`apps/desktop/README.md`（中文：`apps/desktop/README.zh.md`）
- 顶层构建/测试命令：`AGENTS.md`、`docs/testing.md`
- macOS 菜单栏图标的决策记录：`.agents/notes/implemented/feature/2026-10-10-desktop-macos-menu-bar-icon.md`
