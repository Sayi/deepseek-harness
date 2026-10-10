#!/usr/bin/env bash
#
# 从源码启动 DSH 桌面客户端（Electron），使用隔离的 Harness home。
#
# 为什么需要这个脚本
#   桌面端开发默认就用隔离 home（apps/desktop/.desktop-build/development/home），
#   但本脚本把它固定到与 Web 开发相同的那一个（默认 ~/.dsh-dev），这样两边的
#   sessions、settings、credentials 是共享的，而 ~/.dsh（已安装客户端）不受影响。
#   桌面端会独占 $DSH_HOME 下的桌面 profile 目录，所以两者必须使用不同的 home：
#   README 明确警告两个桌面进程共用同一份桌面 profile 会互相竞争。
#
# 用法
#   ./dev-desktop-isolated.sh                    构建 + 启动桌面（隔离 home）
#   ./dev-desktop-isolated.sh --skip-build       复用已有构建产物，直接启动
#   ./dev-desktop-isolated.sh --no-devtools      不自动打开 DevTools
#   ./dev-desktop-isolated.sh --install-electron 只准备 Electron 二进制
#   ./dev-desktop-isolated.sh --status           只打印诊断结果后退出
#
# 选项
#   --home <dir>       隔离 home（默认 $HOME/.dsh-dev，与 Web 脚本一致）
#   --user-data <dir>  Electron 的 userData 目录（默认在 .desktop-build/development 下）
#   --skip-build       跳过构建（等同 pnpm run start:desktop）
#   --no-devtools      设 DSH_DESKTOP_OPEN_DEVTOOLS=0
#   --cn-mirror        用 npmmirror 下载 Electron 二进制，而不是 GitHub Releases
#   --timeout <分钟>   主运行时单个资源的下载超时（默认 30 分钟；DSH 内置默认只有 5 分钟）
#   --install-electron 只准备 Electron 二进制后退出
#   --reinstall-electron 强制重新下载 Electron 二进制
#   --use-env-home     改用环境里已导出的 $DSH_HOME，而不是默认隔离目录
#   --status           打印诊断结果后退出
#   -h, --help         显示本帮助
#
# 首次运行会做的重量级操作
#   1. pnpm run build（除非 --skip-build）：整个仓库的构建。
#   2. Electron 二进制下载：工作区安装不会运行它，约 100 MB，来自 GitHub Releases。
#      慢或被墙时加 --cn-mirror。
#   3. 主运行时准备：从 nodejs.org、GitHub(astral-sh) 与 files.pythonhosted.org
#      下载 Node/Python 载荷与 wheel，带锁定哈希校验与按哈希命名的下载缓存，
#      完成的资源不会重复下载，失败的资源重跑即可续上。
#      这三处都可能很慢：内置超时只有 5 分钟，本脚本默认放宽到 30 分钟。
#
# 与已安装的桌面客户端共存
#   可以同时运行：Electron 的单实例锁按 userData 划分，开发版用的是
#   .desktop-build/development/electron-user-data，与已安装客户端不同。
#   唯一的外部副作用在 macOS：启动器会用 lsregister 注册一个临时的
#   Harness Dev.app，它的 Info.plist 声明了 dsh:// 协议，于是它可能抢走
#   已安装客户端的 dsh:// 处理器。再启动一次已安装客户端即可注册回去。
#
# 注意
#   DEEPSEEK_BASE_URL 只有启动环境能设，任何 .env 都不准写它：DSH 启动时会直接
#   拒绝并报错（见 packages/boot/app-boot/src/index.ts 的 BOOTSTRAP_NAMES）。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$SCRIPT_DIR"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
DEVELOPMENT_ROOT="$DESKTOP_DIR/.desktop-build/development"

SANDBOX_HOME_DEFAULT="${HOME:?HOME 未设置}/.dsh-dev"
SHARED_HOME="${HOME}/.dsh"
ELECTRON_MIRROR_CN="https://npmmirror.com/mirrors/electron/"

HOME_DIR=""
USER_DATA_DIR=""
USE_ENV_HOME=0
SKIP_BUILD=0
STATUS_ONLY=0
INSTALL_ELECTRON_ONLY=0
FORCE_ELECTRON=0
DOWNLOAD_TIMEOUT_MINUTES=""
OPEN_DEVTOOLS=""
IGNORED_HOME=""

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" \
    | sed '/./,$!d'
}

die() {
  printf 'dev-desktop-isolated: %s\n' "$1" >&2
  shift
  for extra in "$@"; do printf '  %s\n' "$extra" >&2; done
  exit 1
}

# 展开开头的 ~，补成绝对路径，去掉结尾斜杠。
normalize_path() {
  local p="$1"
  case "$p" in
    '~') p="$HOME" ;;
    '~/'*) p="$HOME/${p#\~/}" ;;
  esac
  case "$p" in
    /*) : ;;
    *) p="$PWD/$p" ;;
  esac
  printf '%s' "${p%/}"
}

# 把绝对路径里的 $HOME 缩成 ~，只用于显示。
shorten_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

canonicalize_dir() {
  local p
  p="$(normalize_path "$1")"
  if [ -d "$p" ]; then (cd -- "$p" && pwd -P); else printf '%s' "$p"; fi
}

# 从 dotenv 风格文件读取单个键的值，取最后一个匹配项，不执行文件内容。
read_env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" | tail -n 1)" || return 1
  [ -n "$line" ] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    *) value="${value%%[[:space:]]#*}" ;;
  esac
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

env_has_key() {
  [ -f "$1" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1"
}

store_has_ref() {
  [ -s "$1" ] && grep -qE "^[[:space:]]*$2[[:space:]]*:" "$1"
}

# 返回文件里第一个 DSH 拒绝由 .env 提供的变量名（只返回名字，绝不返回值）。
env_bootstrap_violation() {
  local file="$1" is_home="$2" name upper
  [ -f "$file" ] || return 1
  while IFS= read -r name; do
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    case "$upper" in
      DEEPSEEK_BASE_URL|DEEPSEEK_SEARCH_BASE_URL) printf '%s' "$name"; return 0 ;;
      DSH_*|XDG_*|DYLD_*) printf '%s' "$name"; return 0 ;;
      HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)
        if [ "$is_home" = "no" ]; then printf '%s' "$name"; return 0; fi ;;
    esac
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$file")
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home) [ $# -ge 2 ] || die "--home 需要一个目录参数"; HOME_DIR="$2"; shift 2 ;;
    --user-data) [ $# -ge 2 ] || die "--user-data 需要一个目录参数"; USER_DATA_DIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-devtools) OPEN_DEVTOOLS=0; shift ;;
    --cn-mirror) export ELECTRON_MIRROR="$ELECTRON_MIRROR_CN"; shift ;;
    --timeout) [ $# -ge 2 ] || die "--timeout 需要一个分钟数"; DOWNLOAD_TIMEOUT_MINUTES="$2"; shift 2 ;;
    --install-electron) INSTALL_ELECTRON_ONLY=1; shift ;;
    --reinstall-electron) FORCE_ELECTRON=1; shift ;;
    --use-env-home) USE_ENV_HOME=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" "本脚本不转发 dsh 的启动参数（dev.ts 只接受 --skip-build）。用 --help 查看可用选项。" ;;
  esac
done

# home 解析：默认永远用隔离目录，不继承 $DSH_HOME。
# 已安装的桌面客户端独占 $HOME/.dsh 下的桌面 profile，静默继承会让两个桌面进程
# 争抢同一份 profile；所以继承必须显式开启。
INHERITED_HOME="${DSH_HOME:-}"
HOME_SOURCE="默认隔离目录"
if [ -n "$HOME_DIR" ]; then
  HOME_SOURCE="--home"
elif [ "$USE_ENV_HOME" -eq 1 ]; then
  [ -n "$INHERITED_HOME" ] || die "--use-env-home 需要环境里已导出 DSH_HOME"
  HOME_DIR="$INHERITED_HOME"
  HOME_SOURCE="继承的 \$DSH_HOME（--use-env-home）"
else
  HOME_DIR="$SANDBOX_HOME_DEFAULT"
fi
HOME_DIR="$(canonicalize_dir "$HOME_DIR")"

if [ -n "$INHERITED_HOME" ] && [ "$USE_ENV_HOME" -eq 0 ] && [ "$HOME_SOURCE" != "--home" ]; then
  IGNORED_HOME="$(canonicalize_dir "$INHERITED_HOME")"
fi

SHARED_HOME_CANON="$(canonicalize_dir "$SHARED_HOME")"
if [ "$HOME_DIR" = "$SHARED_HOME_CANON" ]; then
  die "解析出的 home 就是共享 home：$HOME_DIR" \
      "已安装的桌面客户端独占该 home 下的桌面 profile，两个桌面进程共用它会互相竞争。" \
      "改用 --home <dir> 指定一个隔离目录。"
fi

# 主运行时的每个资源有一个总时限；DSH 内置默认 300000ms，对 nodejs.org、
# GitHub 与 files.pythonhosted.org 这三个源偏紧。已显式设置时尊重调用方。
if [ -n "$DOWNLOAD_TIMEOUT_MINUTES" ]; then
  case "$DOWNLOAD_TIMEOUT_MINUTES" in
    ''|*[!0-9]*) die "--timeout 需要正整数分钟数，收到：$DOWNLOAD_TIMEOUT_MINUTES" ;;
  esac
  [ "$DOWNLOAD_TIMEOUT_MINUTES" -ge 1 ] || die "--timeout 至少为 1 分钟"
  export DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS=$((DOWNLOAD_TIMEOUT_MINUTES * 60000))
  TIMEOUT_SOURCE="--timeout"
elif [ -n "${DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS:-}" ]; then
  TIMEOUT_SOURCE="启动环境变量"
else
  export DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS=1800000
  TIMEOUT_SOURCE="默认放宽"
fi

format_timeout() {
  local ms="$1"
  case "$ms" in
    ''|*[!0-9]*) printf '%s（无效）' "$ms" ;;
    *) printf '%d 分钟（%s ms，%s）' "$((ms / 60000))" "$ms" "$2" ;;
  esac
}

[ -n "$USER_DATA_DIR" ] || USER_DATA_DIR="$DEVELOPMENT_ROOT/electron-user-data"
USER_DATA_DIR="$(normalize_path "$USER_DATA_DIR")"

CRED_STORE="$HOME_DIR/.credentials.yaml"
SHARED_STORE="$SHARED_HOME_CANON/.credentials.yaml"
HOME_ENV_FILE="$HOME_DIR/.env"
PROJECT_ENV_FILE="$REPO_ROOT/.env"

# 按 DSH 自己的顺序判定 key 的来源（桌面端无 key 时会在欢迎窗口要求配置）。
KEY_SOURCE=""
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  KEY_SOURCE="启动环境变量"
elif store_has_ref "$CRED_STORE" DEEPSEEK_API_KEY; then
  KEY_SOURCE="$CRED_STORE"
elif env_has_key "$PROJECT_ENV_FILE" DEEPSEEK_API_KEY \
  && [ -n "$(read_env_value "$PROJECT_ENV_FILE" DEEPSEEK_API_KEY)" ]; then
  KEY_SOURCE="$PROJECT_ENV_FILE"
elif env_has_key "$HOME_ENV_FILE" DEEPSEEK_API_KEY \
  && [ -n "$(read_env_value "$HOME_ENV_FILE" DEEPSEEK_API_KEY)" ]; then
  KEY_SOURCE="$HOME_ENV_FILE"
fi

BOOTSTRAP_WARNINGS=()
for pair in "$PROJECT_ENV_FILE|no" "$HOME_ENV_FILE|yes"; do
  file="${pair%|*}"
  is_home="${pair#*|}"
  if violation="$(env_bootstrap_violation "$file" "$is_home")"; then
    BOOTSTRAP_WARNINGS+=("$file 里的 $violation")
  fi
done

# Electron 二进制：工作区安装不会运行 electron 的 install.js，缺了 dev.ts 会直接抛错。
electron_ready() {
  [ -f "$DESKTOP_DIR/node_modules/electron/path.txt" ]
}

electron_state() {
  if electron_ready; then printf '已安装'; else printf '未安装（需要先准备）'; fi
}

build_state() {
  if [ -f "$DESKTOP_DIR/lib/main.js" ] && [ -f "$REPO_ROOT/apps/desktop-host/lib/index.js" ]; then
    printf '已构建'
  else
    printf '缺失（需要构建）'
  fi
}

ensure_electron() {
  electron_ready && [ "$FORCE_ELECTRON" -eq 0 ] && return 0
  printf 'dev-desktop-isolated: 准备 Electron 二进制（约 100 MB，来源 %s）\n' \
    "${ELECTRON_MIRROR:-https://github.com/electron/electron/releases}"
  printf '                     慢或失败时用 --cn-mirror 走 npmmirror。\n'
  if ! (cd -- "$REPO_ROOT" && pnpm --filter @deepseek-ai/dsh-desktop exec install-electron); then
    die "Electron 二进制准备失败" \
        "网络慢或被墙时改用镜像：./dev-desktop-isolated.sh --cn-mirror" \
        "走代理时还可以设 ELECTRON_GET_USE_PROXY=1。"
  fi
}

if [ "$STATUS_ONLY" -eq 1 ]; then
  printf '仓库根            : %s\n' "$REPO_ROOT"
  printf 'DSH_HOME          : %s  (%s)\n' "$HOME_DIR" "$HOME_SOURCE"
  printf '共享 home（避开） : %s\n' "$SHARED_HOME_CANON"
  [ -n "$IGNORED_HOME" ] && \
    printf '已忽略的 DSH_HOME : %s  (需要继承时传 --use-env-home)\n' "$IGNORED_HOME"
  printf 'Electron userData : %s\n' "$USER_DATA_DIR"
  printf 'Electron 二进制   : %s\n' "$(electron_state)"
  printf 'Electron 下载源   : %s\n' "${ELECTRON_MIRROR:-官方 GitHub Releases}"
  printf '构建产物          : %s\n' "$(build_state)"
  printf '下载超时          : %s\n' "$(format_timeout "$DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS" "$TIMEOUT_SOURCE")"
  if [ -n "$KEY_SOURCE" ]; then
    printf 'DEEPSEEK_API_KEY  : 已设置（来自 %s）\n' "$(shorten_path "$KEY_SOURCE")"
  else
    printf 'DEEPSEEK_API_KEY  : 未找到（桌面端启动后会在欢迎窗口要求配置）\n'
    printf '    隔离 home .env   %s\n' "$(shorten_path "$HOME_ENV_FILE")"
    printf '    隔离凭据存储     %s\n' "$(shorten_path "$CRED_STORE")"
    printf '    共享凭据存储     %s（隔离后不再使用）\n' "$(shorten_path "$SHARED_STORE")"
  fi
  for warning in ${BOOTSTRAP_WARNINGS[@]+"${BOOTSTRAP_WARNINGS[@]}"}; do
    printf '注意              : %s 只能由启动环境提供，DSH 会在启动时拒绝该文件\n' "$warning"
  done
  printf '将执行            : %s\n' "$([ "$SKIP_BUILD" -eq 1 ] && printf 'pnpm run start:desktop' || printf 'pnpm run dev:desktop')"
  printf 'DevTools          : %s\n' "$([ "${OPEN_DEVTOOLS:-1}" = "0" ] && printf '关闭' || printf '自动打开')"
  exit 0
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  die "尚未安装依赖：$REPO_ROOT/node_modules 不存在" \
      "先在仓库根运行 pnpm install。"
fi

if [ "$INSTALL_ELECTRON_ONLY" -eq 1 ]; then
  ensure_electron
  printf 'dev-desktop-isolated: Electron 二进制已就绪。\n'
  exit 0
fi

ensure_electron

for warning in ${BOOTSTRAP_WARNINGS[@]+"${BOOTSTRAP_WARNINGS[@]}"}; do
  printf 'dev-desktop-isolated: %s 只能由启动环境提供，DSH 会在启动时拒绝该文件。\n' "$warning" >&2
  printf '                      改成 export，或把它从该文件里删掉。\n' >&2
done

if [ "$USE_ENV_HOME" -eq 1 ]; then
  printf 'dev-desktop-isolated: 使用继承的 DSH_HOME=%s\n' "$HOME_DIR"
elif [ -n "$IGNORED_HOME" ]; then
  printf 'dev-desktop-isolated: 已忽略继承的 DSH_HOME=%s\n' "$IGNORED_HOME"
  printf '                      改用隔离 home=%s（要继承请传 --use-env-home）。\n' "$HOME_DIR"
fi

printf 'dev-desktop-isolated: 将注册一个临时的 Harness Dev.app，它声明了 dsh:// 协议；\n'
printf '                      这可能抢走已安装客户端的 dsh:// 处理器，再启动一次已安装客户端即可注册回去。\n'

mkdir -p -- "$HOME_DIR"
export DSH_HOME="$HOME_DIR"
export DSH_DESKTOP_USER_DATA_DIR="$USER_DATA_DIR"
if [ -n "$OPEN_DEVTOOLS" ]; then
  export DSH_DESKTOP_OPEN_DEVTOOLS="$OPEN_DEVTOOLS"
fi

# undici 有一个脚本无法调大的 10 秒连接超时；在部分网络上会让 Node 的 fetch 间歇
# 失败（UND_ERR_CONNECT_TIMEOUT），而同一网络下 curl 稳定可用。优先用 IPv4 结果
# 顺序可以显著降低触发概率。已有的 NODE_OPTIONS 原样保留。
case "${NODE_OPTIONS:-}" in
  *dns-result-order*) : ;;
  '') export NODE_OPTIONS='--dns-result-order=ipv4first' ;;
  *) export NODE_OPTIONS="$NODE_OPTIONS --dns-result-order=ipv4first" ;;
esac

cd -- "$REPO_ROOT"
if [ "$SKIP_BUILD" -eq 1 ]; then
  exec pnpm run start:desktop
fi
exec pnpm run dev:desktop
