#!/usr/bin/env bash
#
# Zenceglow Ops — 一行安装
#
#   curl -fsSL https://cdn.senapixel.com/app/ops/install.sh | bash
#
# 交互四步：端口 → 域名 → 用户名 → 密码。任一步都可以选随机，全部随机就是
# 一路回车。非交互（CI / 自动化）用环境变量：
#
#   OPS_PORT=5200 OPS_DOMAIN=ops.example.com OPS_USER=admin OPS_PASSWORD=secret \
#     bash install.sh
#
# 端口端口域名都留空 = 全部随机/跳过。

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
  ask "选择" "$def"
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

[ "$(id -u)" = "0" ] || die "请用 root 运行（需要写 systemd 与 /usr/local/bin）"
command -v systemctl >/dev/null 2>&1 || die "没有 systemd，本脚本按 Linux systemd 环境编写"
command -v curl >/dev/null 2>&1 || die "缺少 curl"

title "Zenceglow Ops 安装"
say "${DIM}服务器运维面板 · MCP + Codex 技能${N}"

# ─────────────────────── 第 1 步：端口 ───────────────────────

title "1/4 面板端口"
if [ -n "${OPS_PORT:-}" ]; then
  PORT="$OPS_PORT"; ok "使用指定端口 $PORT（来自环境变量）"
else
  choose "面板监听端口（不能和 80/443 冲突）：" "随机（推荐）" "手动输入" 1
  if [ "$REPLY" = "2" ]; then
    ask "输入端口" ""
    PORT="$REPLY"
    case "$PORT" in
      ''|*[!0-9]*) die "端口必须是数字" ;;
    esac
    [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口范围 1-65535"
    port_in_use "$PORT" && die "端口 $PORT 已被占用"
    ok "使用端口 $PORT"
  else
    PORT="$(rand_port)"; ok "随机端口 $PORT"
  fi
fi

# ─────────────────────── 第 2 步：域名 ───────────────────────

title "2/4 域名（可选）"
DOMAIN="${OPS_DOMAIN:-}"
if [ "${OPS_SKIP_DOMAIN:-0}" = "1" ]; then
  DOMAIN=""
elif [ -z "$DOMAIN" ]; then
  choose "给面板绑一个域名？（默认跳过，用 IP:端口 访问）" "跳过（推荐）" "输入域名" 1
  if [ "$REPLY" = "2" ]; then
    ask "域名（例如 ops.example.com，需已解析到本机）" ""
    DOMAIN="$REPLY"
  fi
fi
if [ -n "$DOMAIN" ]; then ok "将配置 Caddy 反代 $DOMAIN → 127.0.0.1:$PORT"; else ok "跳过域名"; fi

# ─────────────────── 第 3 步：用户名 ───────────────────

title "3/4 面板用户名"
ADMIN_USER="${OPS_USER:-}"
CUSTOM_USER=0
if [ -z "$ADMIN_USER" ]; then
  choose "面板登录用户名：" "随机（推荐）" "手动输入" 1
  if [ "$REPLY" = "2" ]; then
    ask "用户名" ""
    ADMIN_USER="$REPLY"; CUSTOM_USER=1
  else
    ADMIN_USER="ops-$(rand_word 6)"
  fi
fi
[ -n "$ADMIN_USER" ] || die "用户名不能为空"
ok "用户名 $ADMIN_USER"

# ─────────────────── 第 4 步：密码 ───────────────────

title "4/4 面板密码"
ADMIN_PASS="${OPS_PASSWORD:-}"
if [ -z "$ADMIN_PASS" ]; then
  # 按需求：上一步是「手动输入用户名」时才问密码；否则一并随机。
  if [ "$CUSTOM_USER" = "1" ] || [ "${OPS_ASK_PASSWORD:-0}" = "1" ]; then
    choose "面板登录密码（至少 6 位）：" "随机（推荐）" "手动输入" 1
    if [ "$REPLY" = "2" ]; then
      while :; do
        ask "密码（≥6 位）" ""
        ADMIN_PASS="$REPLY"
        [ "${#ADMIN_PASS}" -ge 6 ] && break
        warn "太短了，至少要 6 位"
      done
    else
      ADMIN_PASS="$(rand_word 16)"
    fi
  else
    ADMIN_PASS="$(rand_word 16)"
  fi
fi
[ "${#ADMIN_PASS}" -ge 6 ] || die "密码至少 6 位"
ok "密码已设置（${#ADMIN_PASS} 位）"

# ─────────────────────────── 安装 ───────────────────────────

title "安装中"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "· 下载二进制…"
if [ -n "${OPS_BIN_FILE:-}" ]; then
  cp "$OPS_BIN_FILE" "$TMP/zenceglow-ops"
else
  curl -fsSL "$BIN_URL" -o "$TMP/zenceglow-ops" || die "下载失败：$BIN_URL"
fi
chmod +x "$TMP/zenceglow-ops"
install -m 0755 "$TMP/zenceglow-ops" "$BIN_PATH"
ok "已安装 $BIN_PATH"

mkdir -p "$DATA_DIR"

say "· 写入 systemd 服务…"
CADDYFILE_DEFAULT="/etc/caddy/Caddyfile"
if [ -f /opt/docker-apps/caddy/config/Caddyfile ]; then
  CADDYFILE_DEFAULT="/opt/docker-apps/caddy/config/Caddyfile"
fi
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Zenceglow Ops Panel
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN_PATH
Environment=OPS_PORT=$PORT
Environment=OPS_DATA_DIR=$DATA_DIR
Environment=CADDYFILE_PATH=$CADDYFILE_DEFAULT
Environment=RUST_LOG=info,zenceglow_ops=debug
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
ok "已写入 $UNIT_PATH"

say "· 启动服务…"
systemctl restart "$SERVICE"

# 等端口起来（最多 15 秒）
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/ops/setup/status" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/ops/setup/status" >/dev/null 2>&1 \
  || die "服务未能启动，查看日志：journalctl -u $SERVICE -n 50"
ok "服务已启动"

# ─────────────────────── 初始化管理员 ───────────────────────

STATUS_JSON="$(curl -fsS "http://127.0.0.1:$PORT/api/ops/setup/status" || true)"
# 同上：用 case 而不是 `printf | grep -q`，避免 pipefail 把命中当成失败。
case "$STATUS_JSON" in
  *'"initialized":true'*) INITIALIZED=1 ;;
  *) INITIALIZED=0 ;;
esac
CREATED_ADMIN=0
if [ "$INITIALIZED" = "1" ]; then
  ok "面板已初始化过，跳过创建管理员"
else
  say "· 创建管理员…"
  # 首启时把一次性密钥打到 stderr，从 journal 里取回来
  SECRET=""
  for _ in $(seq 1 20); do
    SECRET="$(journalctl -u "$SERVICE" --no-pager -n 200 2>/dev/null \
      | sed -n 's/.*初始化密钥[:：][[:space:]]*\([^[:space:]]*\).*/\1/p' | tail -1)"
    [ -n "$SECRET" ] && break
    sleep 0.5
  done
  [ -n "$SECRET" ] || die "没读到初始化密钥，请手动访问 /setup 完成初始化"

  BODY="$(printf '{"secret":"%s","username":"%s","password":"%s"}' "$SECRET" "$ADMIN_USER" "$ADMIN_PASS")"
  RES="$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/ops/setup/complete" \
    -H 'Content-Type: application/json' -d "$BODY" 2>&1)" \
    || die "创建管理员失败：$RES"
  ok "管理员已创建"
  CREATED_ADMIN=1
fi

# ─────────────────────────── 域名反代 ───────────────────────────

if [ -n "$DOMAIN" ]; then
  title "配置 Caddy 反代"
  CADDYFILE="$CADDYFILE_DEFAULT"
  if [ ! -f "$CADDYFILE" ]; then
    warn "找不到 $CADDYFILE，跳过域名配置"
  elif grep -qF "$DOMAIN" "$CADDYFILE"; then
    ok "$CADDYFILE 里已有 $DOMAIN 的配置，跳过"
  else
    cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
    cat >> "$CADDYFILE" <<CADDY

# zenceglow-ops panel (added $(date '+%Y-%m-%d %H:%M'))
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
    ok "已追加 $DOMAIN 到 $CADDYFILE（原文件已备份）"

    CADDY_CONTAINERS="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
    if printf '%s\n' "$CADDY_CONTAINERS" | grep -qx caddy 2>/dev/null; then
      if docker exec caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        ok "Caddy（容器）已重载"
      else
        warn "Caddy 重载失败，请到面板「站点」页检查配置"
      fi
    elif command -v caddy >/dev/null 2>&1; then
      caddy reload --config "$CADDYFILE" >/dev/null 2>&1 && ok "Caddy 已重载" || warn "Caddy 重载失败"
    else
      warn "没找到可用的 Caddy，域名配置已写入但未生效"
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
    printf '%s' "$ip"; return
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}

IP="$(detect_public_ip)"
[ -n "$IP" ] || IP="<服务器IP>"
PRIVATE_IP_WARNED=0
case "$IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) PRIVATE_IP_WARNED=1 ;;
esac

HOST="http://$IP:$PORT"
[ -n "$DOMAIN" ] && HOST="https://$DOMAIN"

cat <<EOF

${B}=========================================${N}
${G} ✅ 安装完成${N}
${B}=========================================${N}
 面板地址   $HOST
 用户名     $ADMIN_USER
EOF

if [ "$CREATED_ADMIN" = "1" ]; then
  cat <<EOF
 密码       $ADMIN_PASS
EOF
else
  cat <<EOF
 密码       （沿用原密码，本次未修改）
EOF
fi

cat <<EOF

 MCP 地址   $HOST/api/ops/mcp

 提示
 · 若面板打不开，先放行端口：firewall-cmd --add-port=$PORT/tcp --permanent && firewall-cmd --reload
 · 打开面板 → 「接入 Codex」→ 生成令牌 → 复制配置贴给 Codex
 · 管理服务：systemctl status $SERVICE / journalctl -u $SERVICE -f
${B}=========================================${N}
EOF

if [ "$PRIVATE_IP_WARNED" = "1" ]; then
  warn "上面的地址是内网 IP（云主机 NAT）。对外访问还要在云控制台的安全组放行 TCP $PORT，"
  warn "或者跑一次：bash install.sh（第 2 步填一个指向本机的域名，会自动配好 HTTPS 反代）。"
fi
