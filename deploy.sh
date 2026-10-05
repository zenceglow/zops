#!/usr/bin/env bash
# 本地交叉编译 Linux amd64 → 上传到 R2 (senapixel)
#
# 用法:
#   ./deploy.sh
#
# 认证：用 `wrangler login` 登好的账号就行。CI 里没有浏览器，再改成设
#   export CLOUDFLARE_API_TOKEN="cfat_..."
#   export CLOUDFLARE_ACCOUNT_ID="d29e6f9ac661174f715491f9c3d070c7"
#
# R2 路径: senapixel/app/ops/{zenceglow-ops-amd64,install.sh}
# CDN 地址: https://cdn.senapixel.com/app/ops/…

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${TARGET:-x86_64-unknown-linux-gnu}"
BUCKET="senapixel"
R2_PATH="app/ops/zenceglow-ops-amd64"
INSTALL_PATH="app/ops/install.sh"

# ---- 检查必要命令 ----
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: 缺少命令 $1" >&2
    return 1
  fi
}

need_cmd cargo
need_cmd rustup
need_cmd pnpm
need_cmd zig

# ---- 检查 R2 凭证 ----
#
# 没设 token 也能发 —— wrangler 会用 `wrangler login` 存的 OAuth 凭据。这里只是
# 提前确认拿得到凭据，免得前端和 Rust 都编译完了才发现传不上去。
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if ! npx --yes wrangler whoami >/dev/null 2>&1; then
    echo "error: 没有 Cloudflare 凭据。先跑 wrangler login，或设 CLOUDFLARE_API_TOKEN" >&2
    exit 1
  fi
elif [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  # 只设 token 不设 account，往往传到一半才报错，一起检查掉。
  echo "error: 设了 CLOUDFLARE_API_TOKEN 就必须同时设 CLOUDFLARE_ACCOUNT_ID" >&2
  exit 1
fi

# ---- 1. 构建前端 ----
echo "========================================="
echo " 1/3  构建前端"
echo "========================================="
(cd frontend && pnpm install --frozen-lockfile && pnpm build)

# ---- 2. 交叉编译 Rust 二进制 ----
echo ""
echo "========================================="
echo " 2/3  交叉编译 Rust → $TARGET"
echo "========================================="

# 确保目标已安装
rustup target add "$TARGET" 2>/dev/null || true

cargo zigbuild --release --target "$TARGET"

BIN="target/${TARGET}/release/zenceglow-ops"
if [ ! -f "$BIN" ]; then
  echo "error: 编译产物未找到: $BIN" >&2
  exit 1
fi

echo ""
echo "  编译产物: $BIN"
file "$BIN" || true
ls -lh "$BIN"

# ---- 3. 上传到 R2 ----
echo ""
echo "========================================="
echo " 3/3  上传到 R2 → $BUCKET/$R2_PATH"
echo "========================================="

# `--remote` 不能省：wrangler 4 的 r2 命令默认打到**本地模拟器**，不加这个参数会
# 打印 "Resource location: local" 然后说"上传完成" —— 远端什么都没变。
npx wrangler r2 object put "${BUCKET}/${R2_PATH}" \
  --file "$BIN" \
  --content-type application/octet-stream \
  --cache-control "public, max-age=300" \
  --remote

# 安装脚本一起传：一行安装命令拉的是 CDN 上这份，不跟着更新，就会出现
# "二进制是新的、安装脚本还是旧的"。
npx wrangler r2 object put "${BUCKET}/${INSTALL_PATH}" \
  --file install.sh \
  --content-type "text/x-shellscript; charset=utf-8" \
  --cache-control "public, max-age=300" \
  --remote

echo ""
echo "========================================="
echo " ✅ 发布完成"
echo " CDN: https://cdn.senapixel.com/${R2_PATH}"
echo "      https://cdn.senapixel.com/${INSTALL_PATH}"
echo "========================================="
