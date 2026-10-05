#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================="
echo " ZOPS — 本地开发启动"
echo "========================================="

cleanup() {
  echo ""
  echo ">>> 清理进程..."
  kill $FRONTEND_PID 2>/dev/null || true
  kill $BACKEND_PID 2>/dev/null || true
  wait $FRONTEND_PID 2>/dev/null || true
  wait $BACKEND_PID 2>/dev/null || true
  echo ">>> 已退出"
}
trap cleanup EXIT INT TERM

# 1. 前端 dev server（后台）
echo ">>> 启动前端 Vite dev server (port 5173)..."
(cd frontend && pnpm dev) &
FRONTEND_PID=$!

# 2. 后端 Rust 服务（后台）
echo ">>> 编译并启动后端 Rust 服务..."
echo "    (打开浏览器访问 http://localhost:5173)"
echo "    按 Ctrl+C 停止所有"
echo ""

OPS_PORT=5200 cargo run &
BACKEND_PID=$!

while true; do
  if ! kill -0 $FRONTEND_PID 2>/dev/null && ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo ">>> 前后端均已退出"
    break
  fi
  sleep 2
done
