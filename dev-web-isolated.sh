#!/usr/bin/env bash
#
# 从源码启动 DSH，使用隔离的 Harness home，并诊断 API key 的来源。
#
# 为什么需要这个脚本
#   `pnpm run dev:web` / `start:web` / `pnpm dsh web` 使用正常的 Harness home
#   （默认 ~/.dsh），与你已安装的 dsh 客户端共享 sessions、settings、
#   credentials、workspaces、storage。源码版处于 pre-stable，写入的数据
#   （尤其是 session 格式）可能无法被已安装的客户端读回——已存 session 遇到
#   更高版本会被直接拒绝，且不支持降级。本脚本把源码开发的 home 隔离到单独目录。
#
# 用法
#   ./dev-web-isolated.sh                          构建 + 启动 Web（隔离 home）
#   ./dev-web-isolated.sh --no-build               跳过构建，直接启动
#   ./dev-web-isolated.sh --no-open --port 3081    参数原样转发给 dsh web
#   ./dev-web-isolated.sh --patch ./scratch-plugin/cordis.yml
#   ./dev-web-isolated.sh --headless "总结这个仓库"
#   ./dev-web-isolated.sh --status                 只打印诊断结果后退出
#
# 选项
#   --home <dir>     隔离 home（默认 $HOME/.dsh-dev）
#   --no-build       用 start:web 取代 dev:web（需要先跑过一次完整构建）
#   --headless       以 headless profile 一次性运行，其余参数作为任务文本
#   --use-env-home   改用环境里已导出的 $DSH_HOME，而不是默认隔离目录
#   --status         打印诊断结果后退出，不启动任何东西
#   -h, --help       显示本帮助
#
# 凭据
#   本脚本不把任何值导入环境，也不打印任何值——DSH 自己按下面的顺序读，脚本只做诊断。
#   顺序（高到低），依据 packages/credentials/credentials-local/README.md：
#     1. 启动环境变量：DEEPSEEK_API_KEY=... ./dev-web-isolated.sh
#     2. 凭据存储：$DSH_HOME/.credentials.yaml（覆盖下面两个 .env）
#     3. 项目 .env：<仓库根>/.env
#     4. home .env：$DSH_HOME/.env
#   隔离 home 是空的，所以已安装客户端存在 ~/.dsh/.credentials.yaml 里的 key
#   不会自动跟着过来；--status 会把这一点指出来，并给出四种修法。
#
# 行为
#   - home 优先级：--home > $HOME/.dsh-dev。默认绝不继承已导出的 $DSH_HOME：
#     在 DSH 自身进程或配置过它的 shell 里，$DSH_HOME 常常指向共享 home，
#     静默继承正是本脚本要避免的污染。需要继承时显式传 --use-env-home，
#     被忽略的 $DSH_HOME 会打印出来。解析结果若等于共享 home（$HOME/.dsh），
#     脚本拒绝启动。
#
# 注意
#   - DEEPSEEK_BASE_URL 只有启动环境能设，任何 .env 都不准写它：DSH 启动时会
#     直接拒绝并报错（见 packages/boot/app-boot/src/index.ts 的 BOOTSTRAP_NAMES）。
#     要改 base URL，用 export。本脚本会替你检出这种文件并警告。
#   - 代理变量同理不能放仓库根 .env；只有隔离 home 自己的 .env 接受它们。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$SCRIPT_DIR"

SANDBOX_HOME_DEFAULT="${HOME:?HOME 未设置}/.dsh-dev"
SHARED_HOME="${HOME}/.dsh"

HOME_DIR=""
MODE="dev-web"
STATUS_ONLY=0
USE_ENV_HOME=0
IGNORED_HOME=""
FORWARD_ARGS=()

# 打印文件开头的注释块（跳过 shebang 与前导空行，遇到第一行非注释即停）。
usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" \
    | sed '/./,$!d'
}

die() {
  printf 'dev-web-isolated: %s\n' "$1" >&2
  shift
  for extra in "$@"; do printf '  %s\n' "$extra" >&2; done
  exit 1
}

# 展开开头的 ~，补成绝对路径，去掉结尾斜杠。不做 .. 折叠与符号链接解析。
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

# 目录存在时用 pwd -P 取得真实路径，让共享 home 的守卫对符号链接也成立。
canonicalize_dir() {
  local p
  p="$(normalize_path "$1")"
  if [ -d "$p" ]; then (cd -- "$p" && pwd -P); else printf '%s' "$p"; fi
}

# 从 dotenv 风格文件读取单个键的值，取文件中最后一个匹配项，不执行文件内容。
# 只用于判断"值是否为空"，调用方从不把结果打印出来。
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
    # 未加引号：只在 # 前有空白时视为行尾注释，避免吃掉值里的 #
    *) value="${value%%[[:space:]]#*}" ;;
  esac
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# 文件里是否有该键的行。
env_has_key() {
  [ -f "$1" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1"
}

# 凭据存储（YAML 文档）里是否声明了该引用名。值留在文件里，从不读出。
store_has_ref() {
  [ -s "$1" ] && grep -qE "^[[:space:]]*$2[[:space:]]*:" "$1"
}

# 用一个词描述某个 .env 里 DEEPSEEK_API_KEY 的状态，不含任何值。
classify_env_file() {
  local file="$1" value
  [ -f "$file" ] || { printf '不存在'; return; }
  if ! env_has_key "$file" DEEPSEEK_API_KEY; then printf '存在，但没有该键的行'; return; fi
  value="$(read_env_value "$file" DEEPSEEK_API_KEY)"
  if [ -n "$value" ]; then printf '存在，且有非空的值'; else printf '存在，但值为空（等同于未设置）'; fi
}

# 描述凭据存储里是否声明了 DEEPSEEK_API_KEY。
classify_store() {
  local file="$1"
  if [ ! -s "$file" ]; then printf '不存在或为空'; return; fi
  if store_has_ref "$file" DEEPSEEK_API_KEY; then
    printf '存在，且声明了该键'
  else
    printf '存在，但未声明该键'
  fi
}

# 返回文件里第一个 DSH 拒绝由 .env 提供的变量名（只返回名字，绝不返回值）。
# 覆盖最常见的几类；完整规则见 app-boot 的 BOOTSTRAP_NAMES 与 BOOTSTRAP_PREFIXES。
env_bootstrap_violation() {
  local file="$1" is_home="$2" name upper
  [ -f "$file" ] || return 1
  while IFS= read -r name; do
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    case "$upper" in
      DEEPSEEK_BASE_URL|DEEPSEEK_SEARCH_BASE_URL) printf '%s' "$name"; return 0 ;;
      DSH_*|XDG_*|DYLD_*) printf '%s' "$name"; return 0 ;;
      HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)
        # home 层的 .env 是被允许设代理的唯一例外。
        if [ "$is_home" = "no" ]; then printf '%s' "$name"; return 0; fi
        ;;
    esac
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$file")
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home) [ $# -ge 2 ] || die "--home 需要一个目录参数"; HOME_DIR="$2"; shift 2 ;;
    --no-build) MODE="start-web"; shift ;;
    --headless) MODE="headless"; shift ;;
    --use-env-home) USE_ENV_HOME=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; FORWARD_ARGS+=("$@"); break ;;
    -*) FORWARD_ARGS+=("$1"); shift ;;
    *) FORWARD_ARGS+=("$1"); shift ;;
  esac
done

# home 解析：默认永远用隔离目录，不继承 $DSH_HOME。
# 关键点：在本机 shell 或 DSH 自身进程里，$DSH_HOME 很可能已经被导出并指向共享 home；
# 静默继承会正好造成本脚本要避免的污染，所以继承必须显式开启。
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
      "这会与已安装的 dsh 客户端共享 sessions/settings/credentials。" \
      "改用 --home <dir> 指定一个隔离目录。"
fi

CRED_STORE="$HOME_DIR/.credentials.yaml"
SHARED_STORE="$SHARED_HOME_CANON/.credentials.yaml"
HOME_ENV_FILE="$HOME_DIR/.env"
PROJECT_ENV_FILE="$REPO_ROOT/.env"

# 按 DSH 自己的顺序判定 key 的来源。只判断存在性，不导入、不打印任何值。
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

# .env 里出现 DSH 拒绝的名字会导致启动直接报错，提前指出来。
BOOTSTRAP_WARNINGS=()
for pair in "$PROJECT_ENV_FILE|no" "$HOME_ENV_FILE|yes"; do
  file="${pair%|*}"
  is_home="${pair#*|}"
  if violation="$(env_bootstrap_violation "$file" "$is_home")"; then
    BOOTSTRAP_WARNINGS+=("$file 里的 $violation")
  fi
done

case "$MODE" in
  dev-web)   COMMAND=(pnpm run dev:web) ;;
  start-web) COMMAND=(pnpm run start:web) ;;
  headless)
    [ ${#FORWARD_ARGS[@]} -gt 0 ] || die "--headless 需要在后面给出任务文本"
    COMMAND=(pnpm dsh --profile headless "${FORWARD_ARGS[@]}")
    FORWARD_ARGS=()
    ;;
esac
COMMAND+=("${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}")

# 找不到 key 时的明细与修法。共享凭据存储是已安装客户端最可能的存放位置。
key_missing_detail() {
  printf '    项目 .env        %-44s %s\n' "$(shorten_path "$PROJECT_ENV_FILE")" "$(classify_env_file "$PROJECT_ENV_FILE")"
  printf '    隔离 home .env   %-44s %s\n' "$(shorten_path "$HOME_ENV_FILE")" "$(classify_env_file "$HOME_ENV_FILE")"
  printf '    隔离凭据存储     %-44s %s\n' "$(shorten_path "$CRED_STORE")" "$(classify_store "$CRED_STORE")"
  printf '    共享凭据存储     %-44s %s（隔离后不再使用）\n' "$(shorten_path "$SHARED_STORE")" "$(classify_store "$SHARED_STORE")"
  printf '  任选一种修法：\n'
  printf '    1) 沿用已安装客户端的凭据：cp -p %s %s\n' "$(shorten_path "$SHARED_STORE")" "$(shorten_path "$CRED_STORE")"
  printf '    2) 追加进隔离 home 的 .env：%s\n' \
    "echo 'DEEPSEEK_API_KEY=sk-...' >> $(shorten_path "$HOME_ENV_FILE") && chmod 600 $(shorten_path "$HOME_ENV_FILE")"
  printf '    3) 只覆盖本次运行：DEEPSEEK_API_KEY=sk-... ./dev-web-isolated.sh\n'
  printf '    4) 启动后在 Web UI 里登录或配置一次，会写进隔离 home 的凭据存储\n'
}

if [ "$STATUS_ONLY" -eq 1 ]; then
  printf '仓库根            : %s\n' "$REPO_ROOT"
  printf 'DSH_HOME          : %s  (%s)\n' "$HOME_DIR" "$HOME_SOURCE"
  printf '共享 home（避开） : %s\n' "$SHARED_HOME_CANON"
  [ -n "$IGNORED_HOME" ] && \
    printf '已忽略的 DSH_HOME : %s  (需要继承时传 --use-env-home)\n' "$IGNORED_HOME"
  if [ -n "$KEY_SOURCE" ]; then
    printf 'DEEPSEEK_API_KEY  : 已设置（来自 %s）\n' "$(shorten_path "$KEY_SOURCE")"
  else
    printf 'DEEPSEEK_API_KEY  : 未找到\n'
    key_missing_detail
  fi
  for warning in ${BOOTSTRAP_WARNINGS[@]+"${BOOTSTRAP_WARNINGS[@]}"}; do
    printf '注意              : %s 只能由启动环境提供，DSH 会在启动时拒绝该文件\n' "$warning"
  done
  printf '将执行            : %s\n' "${COMMAND[*]}"
  printf '工作目录          : %s\n' "$REPO_ROOT"
  exit 0
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  die "尚未安装依赖：$REPO_ROOT/node_modules 不存在" \
      "先在仓库根运行 pnpm install。"
fi

if [ "$MODE" = "headless" ] && [ -z "$KEY_SOURCE" ]; then
  printf 'dev-web-isolated: 未找到 DEEPSEEK_API_KEY。\n' >&2
  key_missing_detail >&2
  exit 1
fi

if [ "$USE_ENV_HOME" -eq 1 ]; then
  printf 'dev-web-isolated: 使用继承的 DSH_HOME=%s\n' "$HOME_DIR"
elif [ -n "$IGNORED_HOME" ]; then
  printf 'dev-web-isolated: 已忽略继承的 DSH_HOME=%s\n' "$IGNORED_HOME"
  printf '                  改用隔离 home=%s（要继承请传 --use-env-home）。\n' "$HOME_DIR"
fi

if [ -z "$KEY_SOURCE" ]; then
  printf 'dev-web-isolated: 未找到 DEEPSEEK_API_KEY。\n' >&2
  key_missing_detail >&2
fi

for warning in ${BOOTSTRAP_WARNINGS[@]+"${BOOTSTRAP_WARNINGS[@]}"}; do
  printf 'dev-web-isolated: %s 只能由启动环境提供，DSH 会在启动时拒绝该文件。\n' "$warning" >&2
  printf '                  改成 export，或把它从该文件里删掉。\n' >&2
done

if [ "$MODE" = "start-web" ]; then
  printf 'dev-web-isolated: --no-build 复用已有构建产物；若从未构建过，先跑 pnpm run build。\n'
fi

mkdir -p -- "$HOME_DIR"
export DSH_HOME="$HOME_DIR"

cd -- "$REPO_ROOT"
exec "${COMMAND[@]}"
