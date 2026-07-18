#!/usr/bin/env bash
# Build frontend then compile Rust binary in one step
set -euo pipefail
cd "$(dirname "$0")"
echo "==> Building frontend..."
(cd frontend && pnpm install && pnpm build)
echo "==> Building Rust binary..."
cargo build --release
echo "==> Done: target/release/zenceglow-ops"
