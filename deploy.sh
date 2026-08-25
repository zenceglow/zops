#!/usr/bin/env bash
# 本地交叉编译 Linux amd64 → 上传到 R2 (senapixel)
#
# 用法:
#   export CLOUDFLARE_API_TOKEN="cfat_..."
#   export CLOUDFLARE_ACCOUNT_ID="d29e6f9ac661174f715491f9c3d070c7"
#   ./deploy.sh
#
# R2 路径: senapixel/app/ops/zenceglow-ops-amd64
# CDN 地址: https://cdn.senapixel.com/app/ops/zenceglow-ops-amd64

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${TARGET:-x86_64-unknown-linux-gnu}"
BUCKET="senapixel"
R2_PATH="app/ops/zenceglow-ops-amd64"

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
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: 请先设置环境变量 CLOUDFLARE_API_TOKEN" >&2
  echo "       export CLOUDFLARE_API_TOKEN=\"cfat_...\"" >&2
  exit 1
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "error: 请先设置 CLOUDFLARE_ACCOUNT_ID" >&2
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

npx wrangler r2 object put "${BUCKET}/${R2_PATH}" \
  --file "$BIN" \
  --content-type application/octet-stream \
  --cache-control "public, max-age=300"

echo ""
echo "========================================="
echo " ✅ 发布完成"
echo " CDN: https://cdn.senapixel.com/${R2_PATH}"
echo "========================================="
