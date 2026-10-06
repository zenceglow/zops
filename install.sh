#!/usr/bin/env bash
#
# ZOPS — one-line installer
#
#   curl -fsSL https://cdn.zenceglow.com/app/ops/install.sh | bash
#
# Interactive: language → port → domain → username → password. Every step can be
# left to the default; a run of plain Enter gives you a working panel.
#
# Non-interactive (CI / automation):
#
#   OPS_LANG=en OPS_PORT=5200 OPS_DOMAIN=ops.example.com OPS_USER=admin \
#   OPS_PASSWORD=secret bash install.sh
#
# 交互式：语言 → 端口 → 域名 → 用户名 → 密码，每步都能直接回车用默认值。
# 非交互用上面的环境变量。

set -euo pipefail

BIN_URL="${OPS_BIN_URL:-https://cdn.zenceglow.com/app/ops/zenceglow-ops-amd64}"
BIN_PATH="/usr/local/bin/zenceglow-ops"
DATA_DIR="${OPS_DATA_DIR:-/var/lib/zenceglow-ops}"
UNIT_PATH="/etc/systemd/system/zenceglow-ops.service"
SERVICE="zenceglow-ops"

# ────────────────────────────── 输出 ──────────────────────────────

if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); G=$(printf '\033[32m')
  Y=$(printf '\033[33m'); R=$(printf '\033[31m'); N=$(printf '\033[0m')
else
  B=""; DIM=""; G=""; Y=""; R=""; N=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
title() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }

# ────────────────────────────── 语言 ──────────────────────────────
#
# 界面语言在第一步问，之后所有文案跟着它走。这里用一张 case 表而不是 gettext：
# 就两种语言，多一个依赖不如多四十行字符串直白。
#
# `msg <键> [参数…]` 输出该语言下的文案，%s 按传入参数填。

L="${OPS_LANG:-}"

msg() {
  local k="$1"; shift
  case "$k" in
    root)      [ "$L" = zh ] && printf '请用 root 运行（需要写 systemd 与 /usr/local/bin）' || printf 'Please run as root (needs systemd and /usr/local/bin)' ;;
    nosystemd) [ "$L" = zh ] && printf '没有 systemd，本脚本按 Linux systemd 环境编写' || printf 'No systemd found — this installer targets Linux + systemd' ;;
    nocurl)    [ "$L" = zh ] && printf '缺少 curl' || printf 'curl is required' ;;

    banner)    [ "$L" = zh ] && printf 'ZOPS 安装' || printf 'ZOPS installer' ;;
    tagline)   [ "$L" = zh ] && printf '服务器运维面板 · MCP + Codex 技能' || printf 'Server operations panel · MCP + Codex skills' ;;

    step_lang) [ "$L" = zh ] && printf '1/6 界面语言' || printf '1/6 Language' ;;
    step_detect) [ "$L" = zh ] && printf '2/6 检查现有安装' || printf '2/6 Existing installation' ;;
    step_port) [ "$L" = zh ] && printf '3/6 面板端口' || printf '3/6 Panel port' ;;
    step_domain) [ "$L" = zh ] && printf '4/6 域名（可选）' || printf '4/6 Domain (optional)' ;;
    step_user) [ "$L" = zh ] && printf '5/6 面板用户名' || printf '5/6 Username' ;;
    step_pass) [ "$L" = zh ] && printf '6/6 面板密码' || printf '6/6 Password' ;;

    detect_none) [ "$L" = zh ] && printf '没有检测到已有的 ZOPS，将全新安装' || printf 'No existing ZOPS found — installing fresh' ;;
    detect_found) [ "$L" = zh ] && printf '检测到已安装的 ZOPS %s' "$1" || printf 'Found an existing ZOPS %s' "$1" ;;
    detect_nover) [ "$L" = zh ] && printf '（版本未知）' || printf '(version unknown)' ;;
    d_data) [ "$L" = zh ] && printf '  数据目录  %s' "$1" || printf '  Data dir  %s' "$1" ;;
    d_port) [ "$L" = zh ] && printf '  端口      %s' "$1" || printf '  Port      %s' "$1" ;;
    d_domain) [ "$L" = zh ] && printf '  域名      %s' "$1" || printf '  Domain    %s' "$1" ;;
    mode_upgrade) [ "$L" = zh ] && printf '将升级 %s → %s（数据保留，账号密码不动）' "$1" "$2" || printf 'Upgrading %s → %s (data and credentials are kept)' "$1" "$2" ;;
    mode_upgrade_unknown) [ "$L" = zh ] && printf '将升级到 %s（原版本问不出来 —— 那一版还没有 --version，接口里也没带版本号；数据保留）' "$1" || printf 'Upgrading to %s (the installed version could not be read — that build predates --version; data is kept)' "$1" ;;
    mode_replace) [ "$L" = zh ] && printf '将重新安装一遍（数据保留）' || printf 'Reinstalling over it (data kept)' ;;
    mode_same) [ "$L" = zh ] && printf '已经是最新的 %s，将重新安装一遍（数据保留）' "$1" || printf 'Already on %s — reinstalling over it (data kept)' "$1" ;;
    mode_downgrade) [ "$L" = zh ] && printf '将降级 %s → %s。旧库比这版新，可能不兼容 —— 已经自动备份，但请留意。' "$1" "$2" || printf 'Downgrading %s → %s. The data was written by a newer build and may not be compatible — a backup has been taken.' "$1" "$2" ;;
    mode_fresh) [ "$L" = zh ] && printf '将安装 %s' "$1" || printf 'Installing %s' "$1" ;;
    confirm_proceed) [ "$L" = zh ] && printf '继续？' || printf 'Continue?' ;;
    continue_now) [ "$L" = zh ] && printf '继续' || printf 'Continue' ;;
    cancel) [ "$L" = zh ] && printf '取消' || printf 'Cancel' ;;
    keep_creds) [ "$L" = zh ] && printf '（沿用原账号，本次未修改）' || printf '(unchanged — kept the existing account)' ;;
    upgrade_keep) [ "$L" = zh ] && printf '沿用现有配置：端口、域名、账号都不动' || printf 'Keeping the existing port, domain and credentials' ;;
    backup_run) [ "$L" = zh ] && printf '· 备份数据库…' || printf '· Backing up the database…' ;;
    backup_ok) [ "$L" = zh ] && printf '已备份到 %s' "$1" || printf 'Backed up to %s' "$1" ;;
    backup_fail) [ "$L" = zh ] && printf '备份失败（%s）—— 不影响继续，但这次没有安全网' "$1" || printf 'Backup failed (%s) — continuing without a safety net' "$1" ;;
    migrate_found) [ "$L" = zh ] && printf '发现旧位置的数据 %s，已迁移到 %s' "$1" "$2" || printf 'Found data at the old location %s — migrated to %s' "$1" "$2" ;;
    stop_old) [ "$L" = zh ] && printf '· 停止旧服务…' || printf '· Stopping the old service…' ;;
    ver_record) [ "$L" = zh ] && printf '· 记录版本…' || printf '· Recording version…' ;;

    choose)    [ "$L" = zh ] && printf '选择' || printf 'Choice' ;;
    random)    [ "$L" = zh ] && printf '随机（推荐）' || printf 'Random (recommended)' ;;
    manual)    [ "$L" = zh ] && printf '手动输入' || printf 'Enter manually' ;;
    skip)      [ "$L" = zh ] && printf '跳过（推荐）' || printf 'Skip (recommended)' ;;

    port_q)    [ "$L" = zh ] && printf '面板监听端口（不能和 80/443 冲突）：' || printf 'Panel port (must not clash with 80/443):' ;;
    port_env)  [ "$L" = zh ] && printf '使用指定端口 %s（来自环境变量）' "$1" || printf 'Using port %s (from environment)' "$1" ;;
    port_ask)  [ "$L" = zh ] && printf '输入端口' || printf 'Port' ;;
    port_nan)  [ "$L" = zh ] && printf '端口必须是数字' || printf 'Port must be a number' ;;
    port_rng)  [ "$L" = zh ] && printf '端口范围 1-65535' || printf 'Port must be between 1 and 65535' ;;
    port_busy) [ "$L" = zh ] && printf '端口 %s 已被占用' "$1" || printf 'Port %s is already in use' "$1" ;;
    port_set)  [ "$L" = zh ] && printf '使用端口 %s' "$1" || printf 'Using port %s' "$1" ;;
    port_rand) [ "$L" = zh ] && printf '随机端口 %s' "$1" || printf 'Random port %s' "$1" ;;

    domain_q)  [ "$L" = zh ] && printf '给面板绑一个域名？（默认跳过，用 IP:端口 访问）' || printf 'Bind a domain to the panel? (default: skip and use IP:port)' ;;
    domain_ask) [ "$L" = zh ] && printf '域名（例如 ops.example.com，需已解析到本机）' || printf 'Domain (e.g. ops.example.com, must already resolve here)' ;;
    domain_set) [ "$L" = zh ] && printf '将配置 Caddy 反代 %s → 127.0.0.1:%s' "$1" "$2" || printf 'Will configure Caddy to proxy %s → 127.0.0.1:%s' "$1" "$2" ;;
    domain_skip) [ "$L" = zh ] && printf '跳过域名' || printf 'Skipping domain' ;;

    user_q)    [ "$L" = zh ] && printf '面板登录用户名：' || printf 'Panel username:' ;;
    user_ask)  [ "$L" = zh ] && printf '用户名' || printf 'Username' ;;
    user_empty) [ "$L" = zh ] && printf '用户名不能为空' || printf 'Username cannot be empty' ;;
    user_set)  [ "$L" = zh ] && printf '用户名 %s' "$1" || printf 'Username %s' "$1" ;;

    pass_q)    [ "$L" = zh ] && printf '面板登录密码（至少 6 位）：' || printf 'Panel password (at least 6 characters):' ;;
    pass_ask)  [ "$L" = zh ] && printf '密码（≥6 位）' || printf 'Password (>= 6 chars)' ;;
    pass_short) [ "$L" = zh ] && printf '太短了，至少要 6 位' || printf 'Too short — at least 6 characters' ;;
    pass_set)  [ "$L" = zh ] && printf '密码已设置（%s 位）' "$1" || printf 'Password set (%s characters)' "$1" ;;
    pass_min)  [ "$L" = zh ] && printf '密码至少 6 位' || printf 'Password must be at least 6 characters' ;;

    installing) [ "$L" = zh ] && printf '安装中' || printf 'Installing' ;;
    dl_bin)    [ "$L" = zh ] && printf '· 下载二进制…' || printf '· Downloading binary…' ;;
    dl_fail)   [ "$L" = zh ] && printf '下载失败：%s' "$1" || printf 'Download failed: %s' "$1" ;;
    dl_ok)     [ "$L" = zh ] && printf '已安装 %s' "$1" || printf 'Installed %s' "$1" ;;
    zops_link) [ "$L" = zh ] && printf '已建立命令 %s' "$1" || printf 'Linked command %s' "$1" ;;
    unit_write) [ "$L" = zh ] && printf '· 写入 systemd 服务…' || printf '· Writing systemd unit…' ;;
    unit_ok)   [ "$L" = zh ] && printf '已写入 %s' "$1" || printf 'Wrote %s' "$1" ;;
    svc_start) [ "$L" = zh ] && printf '· 启动服务…' || printf '· Starting service…' ;;
    svc_fail)  [ "$L" = zh ] && printf '服务未能启动，查看日志：journalctl -u %s -n 50' "$1" || printf 'Service failed to start — check: journalctl -u %s -n 50' "$1" ;;
    svc_ok)    [ "$L" = zh ] && printf '服务已启动' || printf 'Service started' ;;
    init_done) [ "$L" = zh ] && printf '面板已初始化过，跳过创建管理员' || printf 'Panel already initialised — skipping admin creation' ;;
    admin_make) [ "$L" = zh ] && printf '· 创建管理员…' || printf '· Creating admin user…' ;;
    admin_nosecret) [ "$L" = zh ] && printf '没读到初始化密钥，请手动访问 /setup 完成初始化' || printf 'Could not read the setup secret — finish setup manually at /setup' ;;
    admin_fail) [ "$L" = zh ] && printf '创建管理员失败：%s' "$1" || printf 'Failed to create admin: %s' "$1" ;;
    admin_ok)  [ "$L" = zh ] && printf '管理员已创建' || printf 'Admin user created' ;;

    caddy_title) [ "$L" = zh ] && printf '配置 Caddy 反代' || printf 'Configuring Caddy' ;;
    caddy_missing) [ "$L" = zh ] && printf '找不到 %s，跳过域名配置' "$1" || printf '%s not found — skipping domain setup' "$1" ;;
    caddy_exists) [ "$L" = zh ] && printf '%s 里已有 %s 的配置，跳过' "$1" "$2" || printf '%s already has an entry for %s — skipping' "$1" "$2" ;;
    caddy_added) [ "$L" = zh ] && printf '已追加 %s 到 %s（原文件已备份）' "$1" "$2" || printf 'Appended %s to %s (original backed up)' "$1" "$2" ;;
    caddy_reloaded) [ "$L" = zh ] && printf 'Caddy（容器）已重载' || printf 'Caddy (container) reloaded' ;;
    caddy_reload_fail_panel) [ "$L" = zh ] && printf 'Caddy 重载失败，请到面板「站点」页检查配置' || printf 'Caddy reload failed — check the Sites page in the panel' ;;
    caddy_reloaded_bin) [ "$L" = zh ] && printf 'Caddy 已重载' || printf 'Caddy reloaded' ;;
    caddy_reload_fail) [ "$L" = zh ] && printf 'Caddy 重载失败' || printf 'Caddy reload failed' ;;
    caddy_none) [ "$L" = zh ] && printf '没找到可用的 Caddy，域名配置已写入但未生效' || printf 'No usable Caddy found — the domain entry was written but is not live yet' ;;

    done)      [ "$L" = zh ] && printf ' ✅ 安装完成' || printf ' ✅ Installation complete' ;;
    f_panel)   [ "$L" = zh ] && printf ' 面板地址  ' || printf ' Panel    ' ;;
    f_user)    [ "$L" = zh ] && printf ' 用户名    ' || printf ' Username ' ;;
    f_pass)    [ "$L" = zh ] && printf ' 密码      ' || printf ' Password ' ;;
    f_pass_keep) [ "$L" = zh ] && printf '（沿用原密码，本次未修改）' || printf '(unchanged — kept the existing password)' ;;
    f_mcp)     [ "$L" = zh ] && printf ' MCP 地址  ' || printf ' MCP      ' ;;
    f_notes)   [ "$L" = zh ] && printf ' 提示' || printf ' Notes' ;;
    f_firewall) [ "$L" = zh ] && printf ' · 若面板打不开，先放行端口：firewall-cmd --add-port=%s/tcp --permanent && firewall-cmd --reload' "$1" || printf ' · If the panel is unreachable, open the port: firewall-cmd --add-port=%s/tcp --permanent && firewall-cmd --reload' "$1" ;;
    f_codex)   [ "$L" = zh ] && printf ' · 打开面板 → 「接入 Codex」→ 生成令牌 → 复制配置贴给 Codex' || printf ' · Open the panel → "MCP" → create a token → paste the config into Codex' ;;
    f_service) [ "$L" = zh ] && printf ' · 管理服务：systemctl status %s / journalctl -u %s -f' "$1" "$2" || printf ' · Manage the service: systemctl status %s / journalctl -u %s -f' "$1" "$2" ;;
    f_cli)     [ "$L" = zh ] && printf ' · 常用命令：zops info ｜ zops update ｜ zops restart ｜ zops unlock ｜ zops resetpwd ｜ zops access local ｜ zops uninstall' || printf ' · Handy commands: zops info | zops update | zops restart | zops unlock | zops resetpwd | zops access local | zops uninstall' ;;
    f_private) [ "$L" = zh ] && printf '上面的地址是内网 IP（云主机 NAT）。对外访问还要在云控制台的安全组放行 TCP %s，' "$1" || printf 'That address is a private IP (cloud NAT). Open TCP %s in your cloud security group,' "$1" ;;
    f_private2) [ "$L" = zh ] && printf '或者跑一次：bash install.sh（第 2 步填一个指向本机的域名，会自动配好 HTTPS 反代）。' || printf 'or re-run the installer with a domain that resolves here to get HTTPS automatically.' ;;
    *) printf '' ;;
  esac
}

# ────────────────────────────── 交互 ──────────────────────────────

# 支持 `curl | bash`：stdin 是脚本本身，提示必须从终端读。
# 支持 `curl | bash`：stdin 是脚本本身，提示得从终端读。终端读不到就当成
# 非交互，一路走默认值 —— 不能因为读不了 tty 就把一行错误信息甩在屏幕上。
if [ -t 0 ]; then
  TTY="/dev/stdin"
elif { : < /dev/tty; } 2>/dev/null; then
  TTY="/dev/tty"
else
  TTY=""
fi
INTERACTIVE=1
[ -n "$TTY" ] || INTERACTIVE=0

ask() { # ask <提示> <默认值> -> $REPLY
  local prompt="$1" def="${2:-}"
  if [ "$INTERACTIVE" = "0" ]; then REPLY="$def"; return; fi
  if [ -n "$def" ]; then
    printf '%s [%s]: ' "$prompt" "$def"
  else
    printf '%s: ' "$prompt"
  fi
  read -r REPLY < "$TTY" || REPLY=""
  [ -z "$REPLY" ] && REPLY="$def"
  return 0
}

choose() { # choose <提示> <1 的说明> <2 的说明> <默认 1|2> -> $REPLY
  local prompt="$1" a="$2" b="$3" def="${4:-1}"
  if [ "$INTERACTIVE" = "0" ]; then REPLY="$def"; return; fi
  printf '%s\n' "$prompt"
  printf '  1) %s\n' "$a"
  printf '  2) %s\n' "$b"
  ask "$(msg choose)" "$def"
}

rand_port() {
  local p tries=0
  while [ "$tries" -lt 200 ]; do
    tries=$((tries + 1))
    p=$(( (RANDOM % 20000) + 30000 ))
    port_in_use "$p" || { printf '%s' "$p"; return; }
  done
  printf '%s' "5200"
}

LISTEN_PORTS=""
load_listen_ports() {
  LISTEN_PORTS="$(ss -lntH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u || true)"
}

# 端口是否被占用。
#
# 不用 `ss ... | grep -q`：grep -q 命中即退出，上游被 SIGPIPE 杀掉，在
# `set -o pipefail` 下整条管道会变成失败，"已占用"会被误判成"空闲"。
port_in_use() {
  [ -n "$LISTEN_PORTS" ] || load_listen_ports
  case "
$LISTEN_PORTS
" in
    *"
$1
"*) return 0 ;;
  esac
  return 1
}

rand_word() { # 随机用户名/密码，避免一眼看出是默认口令
  local n="${1:-10}" chars="abcdefghijkmnpqrstuvwxyz23456789" out="" i
  for ((i = 0; i < n; i++)); do
    out+="${chars:$((RANDOM % ${#chars})):1}"
  done
  printf '%s' "$out"
}

# ─────────────────────────── 环境检查 ───────────────────────────

# 语言还没选，这几条只能是双语的。
[ "$(id -u)" = "0" ] || die "Please run as root / 请用 root 运行"
command -v systemctl >/dev/null 2>&1 || die "No systemd / 没有 systemd"
command -v curl >/dev/null 2>&1 || die "curl is required / 缺少 curl"

# ─────────────────────── 先把新版本拿下来 ───────────────────────
#
# 下载放在最前面，是因为"这次是升级还是全新安装"要拿新旧两个版本号比 —— 不知道
# 新版本是多少就没法回答。反正装的时候本来也要下，早下晚下一样。

# 带超时地跑一个命令。
#
# 这里必须限时：**问一个不认识 --version 的旧二进制要版本号，它不会报错，
# 而是直接启动一个面板跑起来** —— 于是安装脚本就永远停在那儿了。这不是假设，
# 47.99.101.158 上第一次测试就是这么卡住的。
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    # timeout 超时返回 124，而调用处是 `VAR="$(run_with_timeout …)"` —— 在
    # `set -e` 下那会直接结束整个安装脚本。超时是预期结果，不是失败。
    timeout "$secs" "$@" || true
  else
    "$@" & local pid=$!
    ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
    # 被 kill 的子进程让 wait 返回 137，同样不能让它冒泡出去。
    wait "$pid" 2>/dev/null || true
  fi
  return 0
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NEW_BIN="$TMP/zenceglow-ops"
if [ -n "${OPS_BIN_FILE:-}" ]; then
  cp "$OPS_BIN_FILE" "$NEW_BIN"
else
  curl -fsSL "$BIN_URL" -o "$NEW_BIN" || die "Download failed / 下载失败：$BIN_URL"
fi
chmod +x "$NEW_BIN"
# 给个一次性数据目录 + 端口 0：万一下来的包是个旧版本，它启动的那个实例也碰不到
# 真库、占不到真端口。
NEW_VER="$(OPS_DATA_DIR="$TMP/verprobe" OPS_PORT=0 run_with_timeout 5 "$NEW_BIN" --version 2>/dev/null | awk '{print $2}')"
[ -n "$NEW_VER" ] || NEW_VER="unknown"

# ─────────────────────── 已有安装的检测 ───────────────────────
#
# 静默收集，等语言选完再汇报 —— 不然"检测到已安装"这句话得先说一遍双语。
#
# 判据是三个里任意一个：unit 文件、二进制、数据目录里的库。只留二进制也算
# "装过"：上一次可能装到一半失败了，这次要能接上，而不是当成全新机器。

CADDYFILE_DEFAULT="/etc/caddy/Caddyfile"
if [ -f /opt/docker-apps/caddy/config/Caddyfile ]; then
  CADDYFILE_DEFAULT="/opt/docker-apps/caddy/config/Caddyfile"
fi

EXISTING=0
EXIST_VER=""
EXIST_DATA=""
EXIST_PORT=""
EXIST_DOMAIN=""
EXIST_LANG=""

# 从 Caddyfile 里找出反代到这个端口的那一段，取它的域名。
find_domain() {
  local port="$1" addr=""
  [ -f "$CADDYFILE_DEFAULT" ] || return 0
  addr="$(awk -v needle="127.0.0.1:$port" '
    /^[^[:space:]#]/ && /\{/ { cur=$1 }
    index($0, needle) { print cur; exit }
  ' "$CADDYFILE_DEFAULT")"
  printf '%s' "$addr"
}

detect_existing() {
  if [ -f "$UNIT_PATH" ] || [ -x "$BIN_PATH" ] || [ -f "$DATA_DIR/ops.db" ]; then
    EXISTING=1
  fi
  [ "$EXISTING" = "1" ] || return 0

  if [ -f "$UNIT_PATH" ]; then
    EXIST_DATA="$(sed -n 's/^Environment=OPS_DATA_DIR=//p' "$UNIT_PATH" | head -1)"
    EXIST_PORT="$(sed -n 's/^Environment=OPS_PORT=//p' "$UNIT_PATH" | head -1)"
    EXIST_LANG="$(sed -n 's/^Environment=OPS_DEFAULT_LANG=//p' "$UNIT_PATH" | head -1)"
  fi
  # unit 里没写就按默认值走 —— 尤其是数据目录：**不能**因为读不到就换一个，
  # 那等于把原来的库扔在原地。
  [ -n "$EXIST_DATA" ] || EXIST_DATA="$DATA_DIR"

  # 正在跑的面板最知道自己的版本（这个接口不用登录）。
  if [ -n "$EXIST_PORT" ]; then
    local s
    s="$(curl -fsS --max-time 4 "http://127.0.0.1:$EXIST_PORT/api/ops/setup/status" 2>/dev/null || true)"
    EXIST_VER="$(printf '%s' "$s" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  fi
  # 最后看安装时留下的版本文件。
  if [ -z "$EXIST_VER" ] && [ -f "$EXIST_DATA/version" ]; then
    EXIST_VER="$(head -1 "$EXIST_DATA/version" 2>/dev/null | tr -d '[:space:]')"
  fi
  # 故意**不**去执行已装的那个二进制问版本：不认识 --version 的老版本会直接
  # 启动一个面板，把安装脚本挂死（真踩过）。问不出来就报"版本未知"，那不影响
  # 升级 —— 数据目录和端口是从 unit 里读的，跟版本号没关系。
  if [ -n "$EXIST_PORT" ]; then
    EXIST_DOMAIN="$(find_domain "$EXIST_PORT")"
  fi
}

# 版本比大小。按点分段逐段比数字，够用了 —— 这是给自己看的升级判断，不是
# 包管理器。预发布后缀（-rc1）不参与比较，按普通字符串看待。
ver_gt() { # $1 > $2 -> 输出 1/0
  awk -v a="$1" -v b="$2" 'BEGIN{
    n=split(a,x,"."); m=split(b,y,".");
    k=(n>m?n:m);
    for(i=1;i<=k;i++){
      xi=x[i]+0; yi=y[i]+0;
      if(xi>yi){print 1; exit}
      if(xi<yi){print 0; exit}
    }
    print 0;
  }'
}

detect_existing

# ─────────────────────────── 第 1 步：语言 ───────────────────────────

# 这一步的提示本身得是双语的 —— 用户还没告诉我们说哪种话。
title "1/6  Language / 界面语言"
if [ -z "$L" ]; then
  # 升级时默认沿用原来那版的语言 —— 装过中文的人按回车不该被切成英文。
  lang_default=1
  [ "$EXIST_LANG" = "zh" ] && lang_default=2
  if [ "$lang_default" = "2" ]; then
    choose "Choose a language / 选择语言：" "English" "中文（当前）" 2
  else
    choose "Choose a language / 选择语言：" "English (default)" "中文" 1
  fi
  if [ "$REPLY" = "2" ]; then L="zh"; else L="en"; fi
else
  [ "$L" = "zh" ] || L="en"
  ok "Language: $L (from environment / 环境变量)"
fi

title "$(msg banner)"
say "${DIM}$(msg tagline)${N}"

# ─────────────────────── 第 2 步：检查现有安装 ───────────────────────

title "$(msg step_detect)"

MODE="fresh"
if [ "$EXISTING" = "1" ]; then
  if [ -n "$EXIST_VER" ]; then
    ok "$(msg detect_found "$EXIST_VER")"
  else
    ok "$(msg detect_found "$(msg detect_nover)")"
  fi
  say "$(msg d_data "$EXIST_DATA")"
  [ -n "$EXIST_PORT" ] && say "$(msg d_port "$EXIST_PORT")"
  [ -n "$EXIST_DOMAIN" ] && say "$(msg d_domain "$EXIST_DOMAIN")"
  say ""
  if [ -n "$NEW_VER" ] && [ -n "$EXIST_VER" ] && [ "$NEW_VER" != "$EXIST_VER" ]; then
    if [ "$(ver_gt "$NEW_VER" "$EXIST_VER")" = "1" ]; then
      MODE="upgrade"; say "$(msg mode_upgrade "$EXIST_VER" "$NEW_VER")"
    else
      MODE="downgrade"; warn "$(msg mode_downgrade "$EXIST_VER" "$NEW_VER")"
    fi
  elif [ -n "$NEW_VER" ] && [ "$NEW_VER" = "$EXIST_VER" ]; then
    MODE="same"; say "$(msg mode_same "$NEW_VER")"
  elif [ -n "$NEW_VER" ]; then
    # 新版本知道、老版本问不出来。真实场景：装的那一版还没有 --version，
    # /setup/status 也还没带 version 字段。
    MODE="upgrade"; say "$(msg mode_upgrade_unknown "$NEW_VER")"
  else
    MODE="upgrade"; say "$(msg mode_replace)"
  fi
  choose "$(msg confirm_proceed)" "$(msg continue_now)" "$(msg cancel)" 1
  [ "$REPLY" = "2" ] && die "$(msg cancel)"
else
  say "$(msg detect_none)"
  [ -n "$NEW_VER" ] && say "$(msg mode_fresh "$NEW_VER")"
fi

# 升级时不重问端口/域名/账号：这些都在 unit 和 Caddyfile 里，改了反而容易出事。
# 数据目录更是**必须**沿用原来那个 —— 换成默认值等于让面板去看一个空库。
DETECTED_MODE="$MODE"
if [ "$MODE" != "fresh" ]; then
  # 端口：优先用已装那台的，其次环境变量，最后回到面板惯用的 5200。
  PORT="${EXIST_PORT:-${OPS_PORT:-5200}}"
  DOMAIN="$EXIST_DOMAIN"
  DATA_DIR="$EXIST_DATA"
  ADMIN_USER=""; ADMIN_PASS=""; CREATED_ADMIN=0
  say "$(msg upgrade_keep)"
fi

# ─────────────────────────── 第 3 步：端口 ───────────────────────────

if [ "$DETECTED_MODE" != "fresh" ]; then
  : # 升级：端口已经确定，跳过
else

title "$(msg step_port)"
if [ -n "${OPS_PORT:-}" ]; then
  PORT="$OPS_PORT"; ok "$(msg port_env "$PORT")"
else
  choose "$(msg port_q)" "$(msg random)" "$(msg manual)" 1
  # 提示写的是"1) 随机 2) 手动"，但总有人直接把端口号打在这一行上。以前这种输入
  # 既不是 1 也不是 2，就默默走了随机端口 —— 用户看到的和自己填的对不上，还以为
  # 脚本没听见。约定：1/回车 = 第一个选项，2 = 第二个选项，其它非空输入 = 值本身。
  RANDOM_PORT=0
  case "$REPLY" in
    2) ask "$(msg port_ask)" ""; PORT="$REPLY" ;;
    1|"") RANDOM_PORT=1 ;;
    *) PORT="$REPLY" ;;
  esac
  if [ "$RANDOM_PORT" = "1" ]; then
    PORT="$(rand_port)"; ok "$(msg port_rand "$PORT")"
  else
    case "$PORT" in
      ''|*[!0-9]*) die "$(msg port_nan)" ;;
    esac
    [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "$(msg port_rng)"
    port_in_use "$PORT" && die "$(msg port_busy "$PORT")"
    ok "$(msg port_set "$PORT")"
  fi
fi

# ─────────────────────────── 第 4 步：域名 ───────────────────────────

title "$(msg step_domain)"
DOMAIN="${OPS_DOMAIN:-}"
if [ "${OPS_SKIP_DOMAIN:-0}" = "1" ]; then
  DOMAIN=""
elif [ -z "$DOMAIN" ]; then
  choose "$(msg domain_q)" "$(msg skip)" "$(msg manual)" 1
  # 同上：直接把域名打进来的，就当他选了"手动输入"。以前这会走"跳过"分支，
  # 域名被静默丢掉，装完才发现没绑上。
  case "$REPLY" in
    1|"") DOMAIN="" ;;
    2)     ask "$(msg domain_ask)" ""; DOMAIN="$REPLY" ;;
    *)     DOMAIN="$REPLY" ;;
  esac
fi
if [ -n "$DOMAIN" ]; then ok "$(msg domain_set "$DOMAIN" "$PORT")"; else ok "$(msg domain_skip)"; fi

# ─────────────────────────── 第 5 步：用户名 ───────────────────────────

title "$(msg step_user)"
ADMIN_USER="${OPS_USER:-}"
CUSTOM_USER=0
if [ -z "$ADMIN_USER" ]; then
  choose "$(msg user_q)" "$(msg random)" "$(msg manual)" 1
  case "$REPLY" in
    2)     ask "$(msg user_ask)" ""; ADMIN_USER="$REPLY"; CUSTOM_USER=1 ;;
    1|"") ADMIN_USER="ops-$(rand_word 6)" ;;
    *)     ADMIN_USER="$REPLY"; CUSTOM_USER=1 ;;
  esac
fi
[ -n "$ADMIN_USER" ] || die "$(msg user_empty)"
ok "$(msg user_set "$ADMIN_USER")"

# ─────────────────────────── 第 5 步：密码 ───────────────────────────

title "$(msg step_pass)"
ADMIN_PASS="${OPS_PASSWORD:-}"
if [ -z "$ADMIN_PASS" ]; then
  # 上一步是「手动输入用户名」时才问密码；否则一并随机 —— 一路回车也能装完。
  if [ "$CUSTOM_USER" = "1" ] || [ "${OPS_ASK_PASSWORD:-0}" = "1" ]; then
    choose "$(msg pass_q)" "$(msg random)" "$(msg manual)" 1
    case "$REPLY" in
      1|"") ADMIN_PASS="$(rand_word 16)" ;;
      2)
        while :; do
          ask "$(msg pass_ask)" ""
          ADMIN_PASS="$REPLY"
          [ "${#ADMIN_PASS}" -ge 6 ] && break
          warn "$(msg pass_short)"
        done
        ;;
      # 直接把密码打进来的：太短下面那句统一的校验会拦住。
      *) ADMIN_PASS="$REPLY" ;;
    esac
  else
    ADMIN_PASS="$(rand_word 16)"
  fi
fi
[ "${#ADMIN_PASS}" -ge 6 ] || die "$(msg pass_min)"
ok "$(msg pass_set "${#ADMIN_PASS}")"

fi # 全新安装的向导到此结束

# ─────────────────────────── 安装 ───────────────────────────

title "$(msg installing)"

say "$(msg dl_bin)"
# 二进制在最前面已经下好了，这里只是把它放进系统里。

# ── 保护数据 ──
#
# 这一段的每一句都是"不许丢东西"：升级会覆盖二进制和 unit，但数据目录只读不写，
# 只在**升级前**额外做一份备份。库是用户的账号、令牌、审计、访问流水，丢了没处找。

mkdir -p "$DATA_DIR"

# 有些更早的部署是把数据放在工作目录的 data/ 下的（那时候 OPS_DATA_DIR 默认是
# 相对路径）。新位置还没有库、而老位置有的话，搬过来 —— 不搬就等于"升级完数据
# 全没了"。已经是新位置就不动。
if [ ! -f "$DATA_DIR/ops.db" ]; then
  for cand in /opt/zenceglow-ops/data /opt/docker-apps/zenceglow-ops/data \
              /usr/local/zenceglow-ops/data /root/zenceglow-ops/data; do
    if [ -f "$cand/ops.db" ]; then
      cp -a "$cand/ops.db" "$DATA_DIR/ops.db"
      [ -d "$cand/trash" ] && cp -a "$cand/trash" "$DATA_DIR/trash"
      ok "$(msg migrate_found "$cand/ops.db" "$DATA_DIR/ops.db")"
      break
    fi
  done
fi

if [ -f "$DATA_DIR/ops.db" ]; then
  say "$(msg backup_run)"
  # sqlite3 的 .backup 会带上 WAL 里还没落盘的部分，比直接 cp 可靠；
  # 机器上没有 sqlite3 就退回拷贝（连着 -wal/-shm 一起）。
  STAMP="$(date '+%Y%m%d-%H%M%S')"
  BAK="$DATA_DIR/backups/ops.db.${EXIST_VER:-unknown}.$STAMP"
  mkdir -p "$DATA_DIR/backups"
  if command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$DATA_DIR/ops.db" ".backup '$BAK'" 2>/dev/null; then
    ok "$(msg backup_ok "$BAK")"
  elif cp -f "$DATA_DIR/ops.db" "$BAK" 2>/dev/null; then
    [ -f "$DATA_DIR/ops.db-wal" ] && cp -f "$DATA_DIR/ops.db-wal" "$BAK-wal"
    ok "$(msg backup_ok "$BAK")"
  else
    warn "$(msg backup_fail "$BAK")"
  fi
  # 只留最近 5 份：备份是安全网，不是归档，堆满磁盘反而是另一种事故。
  ls -1t "$DATA_DIR/backups"/ops.db.* 2>/dev/null | tail -n +6 | while IFS= read -r old; do
    rm -f "$old" "$old-wal" 2>/dev/null || true
  done
fi

# 覆盖正在运行的可执行文件在 Linux 上会 ETXTBSY，先停。
if [ "$DETECTED_MODE" != "fresh" ] && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  say "$(msg stop_old)"
  systemctl stop "$SERVICE" || true
fi

install -m 0755 "$NEW_BIN" "$BIN_PATH"
ok "$(msg dl_ok "$BIN_PATH")"

# `zops` 这个短名字也建上：装完之后要敲的是 `zops info` / `zops update`，
# 而不是一长串 zenceglow-ops。软链跟着二进制走，升级时不需要重建。
ln -sf "$BIN_PATH" "$(dirname "$BIN_PATH")/zops" &&
  ok "$(msg zops_link "$(dirname "$BIN_PATH")/zops")"

say "$(msg unit_write)"
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=ZOPS Panel
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN_PATH
Environment=OPS_PORT=$PORT
Environment=OPS_DATA_DIR=$DATA_DIR
Environment=CADDYFILE_PATH=$CADDYFILE_DEFAULT
Environment=OPS_DEFAULT_LANG=$L
Environment=RUST_LOG=info,zenceglow_ops=debug
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
ok "$(msg unit_ok "$UNIT_PATH")"

# 把这一版记下来。下次安装时如果面板没在跑、二进制也读不出，还能靠它判断
# "是升级还是全新安装"。
say "$(msg ver_record)"
printf '%s\n' "$NEW_VER" > "$DATA_DIR/version" 2>/dev/null || true

say "$(msg svc_start)"
systemctl restart "$SERVICE"

# 等端口起来（最多 15 秒）
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/ops/setup/status" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/ops/setup/status" >/dev/null 2>&1 \
  || die "$(msg svc_fail "$SERVICE")"
ok "$(msg svc_ok)"

# ─────────────────────── 初始化管理员 ───────────────────────

STATUS_JSON="$(curl -fsS "http://127.0.0.1:$PORT/api/ops/setup/status" || true)"
# 同上：用 case 而不是 `printf | grep -q`，避免 pipefail 把命中当成失败。
case "$STATUS_JSON" in
  *'"initialized":true'*) INITIALIZED=1 ;;
  *) INITIALIZED=0 ;;
esac
CREATED_ADMIN=0
if [ "$INITIALIZED" = "1" ]; then
  ok "$(msg init_done)"
else
  say "$(msg admin_make)"
  # 升级模式下账号是空着的（沿用原来那个）。可库里要是没初始化过，就说明
  # 根本没有账号 —— 这时生成一组随机的，结尾会打印出来。
  if [ -z "$ADMIN_USER" ]; then
    ADMIN_USER="ops-$(rand_word 6)"
    ADMIN_PASS="$(rand_word 16)"
  fi
  # 首启时把一次性密钥打到 stderr，从 journal 里取回来
  SECRET=""
  for _ in $(seq 1 20); do
    SECRET="$(journalctl -u "$SERVICE" --no-pager -n 200 2>/dev/null \
      | sed -n 's/.*初始化密钥[:：][[:space:]]*\([^[:space:]]*\).*/\1/p' | tail -1)"
    [ -n "$SECRET" ] && break
    sleep 0.5
  done
  [ -n "$SECRET" ] || die "$(msg admin_nosecret)"

  BODY="$(printf '{"secret":"%s","username":"%s","password":"%s"}' "$SECRET" "$ADMIN_USER" "$ADMIN_PASS")"
  RES="$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/ops/setup/complete" \
    -H 'Content-Type: application/json' -d "$BODY" 2>&1)" \
    || die "$(msg admin_fail "$RES")"
  ok "$(msg admin_ok)"
  CREATED_ADMIN=1
fi

# ─────────────────────────── 域名反代 ───────────────────────────

if [ -n "$DOMAIN" ]; then
  title "$(msg caddy_title)"
  CADDYFILE="$CADDYFILE_DEFAULT"
  if [ ! -f "$CADDYFILE" ]; then
    warn "$(msg caddy_missing "$CADDYFILE")"
  elif grep -qF "$DOMAIN" "$CADDYFILE"; then
    ok "$(msg caddy_exists "$CADDYFILE" "$DOMAIN")"
  else
    cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
    cat >> "$CADDYFILE" <<CADDY

# ZOPS panel (added $(date '+%Y-%m-%d %H:%M'))
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
    ok "$(msg caddy_added "$DOMAIN" "$CADDYFILE")"

    CADDY_CONTAINERS="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
    if printf '%s\n' "$CADDY_CONTAINERS" | grep -qx caddy 2>/dev/null; then
      if docker exec caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        ok "$(msg caddy_reloaded)"
      else
        warn "$(msg caddy_reload_fail_panel)"
      fi
    elif command -v caddy >/dev/null 2>&1; then
      caddy reload --config "$CADDYFILE" >/dev/null 2>&1 && ok "$(msg caddy_reloaded_bin)" || warn "$(msg caddy_reload_fail)"
    else
      warn "$(msg caddy_none)"
    fi
  fi
fi

# ─────────────────────────── 结论 ───────────────────────────

# 云主机是 NAT：网卡上只有内网地址，公网 IP 只能问外部服务。阿里云/腾讯云
# 有时访问不到某个查询接口，因此多试几个，并允许显式指定。
detect_public_ip() {
  local u ip
  if [ -n "${OPS_PUBLIC_HOST:-}" ]; then
    printf '%s' "$OPS_PUBLIC_HOST"; return
  fi
  for u in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip https://ip.3322.net; do
    ip="$(curl -fsS --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$ip" in
      ''|*[!0-9.]*) continue ;;
    esac
    printf '%s' "$ip"; return 0
  done
  # `hostname -I` 只有 GNU 版有；macOS 上会直接报错。加上 `|| true` 是因为
  # `set -o pipefail` 下这条管道失败会让整个函数返回非零，而调用处是
  # `IP="$(detect_public_ip)"` —— 在 `set -e` 里那会**静默退出整个安装脚本**，
  # 前面装得好好的，最后连结论都不打印。
  hostname -I 2>/dev/null | awk '{print $1}' || true
  return 0
}

IP="$(detect_public_ip)"
[ -n "$IP" ] || IP="<server-ip>"
PRIVATE_IP_WARNED=0
case "$IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) PRIVATE_IP_WARNED=1 ;;
esac

HOST="http://$IP:$PORT"
[ -n "$DOMAIN" ] && HOST="https://$DOMAIN"

cat <<EOF

${B}=========================================${N}
${G}$(msg done)${N}
${B}=========================================${N}
$(msg f_panel)$HOST
$(msg f_user)${ADMIN_USER:-$(msg keep_creds)}
EOF

if [ "$CREATED_ADMIN" = "1" ]; then
  printf '%s%s\n' "$(msg f_pass)" "$ADMIN_PASS"
else
  printf '%s%s\n' "$(msg f_pass)" "$(msg f_pass_keep)"
fi

cat <<EOF

$(msg f_mcp)$HOST/api/ops/mcp

$(msg f_notes)
$(msg f_firewall "$PORT")
$(msg f_codex)
$(msg f_service "$SERVICE" "$SERVICE")
$(msg f_cli)
${B}=========================================${N}
EOF

if [ "$PRIVATE_IP_WARNED" = "1" ]; then
  warn "$(msg f_private "$PORT")"
  warn "$(msg f_private2)"
fi
