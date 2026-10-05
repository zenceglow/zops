#!/usr/bin/env bash
#
# ZOPS — one-line installer
#
#   curl -fsSL https://cdn.senapixel.com/app/ops/install.sh | bash
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

BIN_URL="${OPS_BIN_URL:-https://cdn.senapixel.com/app/ops/zenceglow-ops-amd64}"
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

    step_lang) [ "$L" = zh ] && printf '1/5 界面语言' || printf '1/5 Language' ;;
    step_port) [ "$L" = zh ] && printf '2/5 面板端口' || printf '2/5 Panel port' ;;
    step_domain) [ "$L" = zh ] && printf '3/5 域名（可选）' || printf '3/5 Domain (optional)' ;;
    step_user) [ "$L" = zh ] && printf '4/5 面板用户名' || printf '4/5 Username' ;;
    step_pass) [ "$L" = zh ] && printf '5/5 面板密码' || printf '5/5 Password' ;;

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
    f_private) [ "$L" = zh ] && printf '上面的地址是内网 IP（云主机 NAT）。对外访问还要在云控制台的安全组放行 TCP %s，' "$1" || printf 'That address is a private IP (cloud NAT). Open TCP %s in your cloud security group,' "$1" ;;
    f_private2) [ "$L" = zh ] && printf '或者跑一次：bash install.sh（第 2 步填一个指向本机的域名，会自动配好 HTTPS 反代）。' || printf 'or re-run the installer with a domain that resolves here to get HTTPS automatically.' ;;
    *) printf '' ;;
  esac
}

# ────────────────────────────── 交互 ──────────────────────────────

# 支持 `curl | bash`：stdin 是脚本本身，提示必须从终端读。
if [ -t 0 ]; then TTY="/dev/stdin"; else TTY="/dev/tty"; fi
INTERACTIVE=1
if [ ! -r "$TTY" ]; then INTERACTIVE=0; fi

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

# ─────────────────────────── 第 1 步：语言 ───────────────────────────

# 这一步的提示本身得是双语的 —— 用户还没告诉我们说哪种话。
title "1/5  Language / 界面语言"
if [ -z "$L" ]; then
  choose "Choose a language / 选择语言：" "English (default)" "中文" 1
  if [ "$REPLY" = "2" ]; then L="zh"; else L="en"; fi
else
  [ "$L" = "zh" ] || L="en"
  ok "Language: $L (from environment / 环境变量)"
fi

title "$(msg banner)"
say "${DIM}$(msg tagline)${N}"

# ─────────────────────────── 第 2 步：端口 ───────────────────────────

title "$(msg step_port)"
if [ -n "${OPS_PORT:-}" ]; then
  PORT="$OPS_PORT"; ok "$(msg port_env "$PORT")"
else
  choose "$(msg port_q)" "$(msg random)" "$(msg manual)" 1
  if [ "$REPLY" = "2" ]; then
    ask "$(msg port_ask)" ""
    PORT="$REPLY"
    case "$PORT" in
      ''|*[!0-9]*) die "$(msg port_nan)" ;;
    esac
    [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "$(msg port_rng)"
    port_in_use "$PORT" && die "$(msg port_busy "$PORT")"
    ok "$(msg port_set "$PORT")"
  else
    PORT="$(rand_port)"; ok "$(msg port_rand "$PORT")"
  fi
fi

# ─────────────────────────── 第 3 步：域名 ───────────────────────────

title "$(msg step_domain)"
DOMAIN="${OPS_DOMAIN:-}"
if [ "${OPS_SKIP_DOMAIN:-0}" = "1" ]; then
  DOMAIN=""
elif [ -z "$DOMAIN" ]; then
  choose "$(msg domain_q)" "$(msg skip)" "$(msg manual)" 1
  if [ "$REPLY" = "2" ]; then
    ask "$(msg domain_ask)" ""
    DOMAIN="$REPLY"
  fi
fi
if [ -n "$DOMAIN" ]; then ok "$(msg domain_set "$DOMAIN" "$PORT")"; else ok "$(msg domain_skip)"; fi

# ─────────────────────────── 第 4 步：用户名 ───────────────────────────

title "$(msg step_user)"
ADMIN_USER="${OPS_USER:-}"
CUSTOM_USER=0
if [ -z "$ADMIN_USER" ]; then
  choose "$(msg user_q)" "$(msg random)" "$(msg manual)" 1
  if [ "$REPLY" = "2" ]; then
    ask "$(msg user_ask)" ""
    ADMIN_USER="$REPLY"; CUSTOM_USER=1
  else
    ADMIN_USER="ops-$(rand_word 6)"
  fi
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
    if [ "$REPLY" = "2" ]; then
      while :; do
        ask "$(msg pass_ask)" ""
        ADMIN_PASS="$REPLY"
        [ "${#ADMIN_PASS}" -ge 6 ] && break
        warn "$(msg pass_short)"
      done
    else
      ADMIN_PASS="$(rand_word 16)"
    fi
  else
    ADMIN_PASS="$(rand_word 16)"
  fi
fi
[ "${#ADMIN_PASS}" -ge 6 ] || die "$(msg pass_min)"
ok "$(msg pass_set "${#ADMIN_PASS}")"

# ─────────────────────────── 安装 ───────────────────────────

title "$(msg installing)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "$(msg dl_bin)"
if [ -n "${OPS_BIN_FILE:-}" ]; then
  cp "$OPS_BIN_FILE" "$TMP/zenceglow-ops"
else
  curl -fsSL "$BIN_URL" -o "$TMP/zenceglow-ops" || die "$(msg dl_fail "$BIN_URL")"
fi
chmod +x "$TMP/zenceglow-ops"
install -m 0755 "$TMP/zenceglow-ops" "$BIN_PATH"
ok "$(msg dl_ok "$BIN_PATH")"

mkdir -p "$DATA_DIR"

say "$(msg unit_write)"
CADDYFILE_DEFAULT="/etc/caddy/Caddyfile"
if [ -f /opt/docker-apps/caddy/config/Caddyfile ]; then
  CADDYFILE_DEFAULT="/opt/docker-apps/caddy/config/Caddyfile"
fi
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
$(msg f_user)$ADMIN_USER
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
${B}=========================================${N}
EOF

if [ "$PRIVATE_IP_WARNED" = "1" ]; then
  warn "$(msg f_private "$PORT")"
  warn "$(msg f_private2)"
fi
