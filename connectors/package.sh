#!/usr/bin/env bash
#
# ZOPS 连接器包：把仓库里的真源同步进来、校验没漂移、打出上架用的 zip。
#
#   ./connectors/package.sh sync    同步 skills / icon / 版本号进包（改完技能后跑）
#   ./connectors/package.sh check   只校验、不改文件（提交前和 CI 跑）
#   ./connectors/package.sh zip     校验通过后打出 connectors/dist/zops-<version>.zip
#
# 为什么要这个脚本：技能正文的真源在仓库根的 `skills/zops/`（`include_str!` 把它编进
# 二进制），图标真源在前端的 `favicon.svg`，版本号真源在 `Cargo.toml`；而上架用的包
# 需要各自一份拷贝。三份拷贝、三个真源，靠人记是记不住的 —— 交给脚本和 `cargo test`
# 里那几个同名单测（`src/domain/mcp.rs`）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK="$ROOT/connectors/zops"
DIST="$ROOT/connectors/dist"

VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"(.*)".*/\1/')"
[ -n "$VERSION" ] || { echo "读不出 Cargo.toml 的 version" >&2; exit 1; }

# 包里这些文件的内容来源在别处。`(源, 包内相对路径)`。
sync_pairs() {
  printf '%s\t%s\n' \
    "$ROOT/skills/zops/SKILL.md"                          "skills/zops/SKILL.md" \
    "$ROOT/skills/zops/references/deploy.md"              "skills/zops/references/deploy.md" \
    "$ROOT/skills/zops/references/troubleshooting.md"     "skills/zops/references/troubleshooting.md" \
    "$ROOT/frontend/public/favicon.svg"                   "ai.workbuddy/assets/icon.svg"
}

PLUGIN="$PACK/.codebuddy-plugin/plugin.json"

check() {
  local drift=0 src rel dst
  while IFS=$'\t' read -r src rel; do
    dst="$PACK/$rel"
    if [ ! -f "$dst" ]; then
      echo "缺文件  $rel"
      drift=1
    elif ! cmp -s "$src" "$dst"; then
      echo "已漂移  $rel   （真源：${src#$ROOT/}）"
      drift=1
    fi
  done < <(sync_pairs)

  # plugin.json 的版本要跟 Cargo.toml 走 —— 连接器描述的就是这个版本面板的工具集。
  local declared
  declared="$(sed -nE 's/^[[:space:]]*"version": "([^"]*)".*/\1/p' "$PLUGIN" | head -1)"
  if [ "$declared" != "$VERSION" ]; then
    echo "版本不符  plugin.json=$declared  Cargo.toml=$VERSION"
    drift=1
  fi

  # JSON 本身能不能解析。cargo test 里也拦了，但提交前先看一眼更省事。
  if command -v python3 >/dev/null 2>&1; then
    for f in "$PLUGIN" "$PACK/ai.workbuddy/token-schema.json"; do
      python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" \
        || { echo "JSON 非法  ${f#$ROOT/}"; drift=1; }
    done
  else
    echo "提示：没找到 python3，跳过 JSON 语法检查（cargo test 里那几个单测仍会拦）"
  fi

  return $drift
}

do_sync() {
  local src rel dst changed=0
  while IFS=$'\t' read -r src rel; do
    dst="$PACK/$rel"
    mkdir -p "$(dirname "$dst")"
    if cmp -s "$src" "$dst" 2>/dev/null; then continue; fi
    cp "$src" "$dst"
    echo "同步    $rel"
    changed=1
  done < <(sync_pairs)

  local declared
  declared="$(sed -nE 's/^[[:space:]]*"version": "([^"]*)".*/\1/p' "$PLUGIN" | head -1)"
  if [ "$declared" != "$VERSION" ]; then
    sed -i.bak -E "s/^([[:space:]]*\"version\": \")[^\"]*(\")/\1$VERSION\2/" "$PLUGIN"
    rm -f "$PLUGIN.bak"
    echo "同步    plugin.json version $declared → $VERSION"
    changed=1
  fi

  [ "$changed" = 1 ] || echo "包已是最新，没动任何文件。"
  echo
  check || { echo >&2 "同步后仍然不一致，看看上面几行。" >&2; exit 1; }
  echo "包与真源一致（版本 ${VERSION}）。"
}

do_zip() {
  check || { echo >&2 "包和真源对不上，先跑 sync 或修掉上面几行。" >&2; exit 1; }
  mkdir -p "$DIST"
  local out="$DIST/zops-$VERSION.zip"
  rm -f "$out"
  # 归档里带一层 `zops/`，解开就是连接器目录本身。
  ( cd "$PACK/.." && zip -qr "$out" zops -x '*.DS_Store' )
  echo
  echo "已打出 $out"
  unzip -l "$out" | tail -3
}

case "${1:-}" in
  sync)  do_sync ;;
  check) if check; then echo "包与真源一致（版本 ${VERSION}）。"; else echo >&2 "包已漂移，跑 sync 修。" >&2; exit 1; fi ;;
  zip)   do_zip ;;
  *)     sed -nE '2,12s/^# ?//p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
