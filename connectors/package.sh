#!/usr/bin/env bash
#
# ZOPS 连接器包：把仓库里的真源同步进来、校验没漂移、打出上架用的 zip。
#
#   ./connectors/package.sh sync    同步 skills / icon / 版本号进包（改完技能后跑）
#   ./connectors/package.sh check   只校验、不改文件（提交前和 CI 跑）
#   ./connectors/package.sh zip     校验通过后打出 connectors/dist/zops-<version>.zip
#
# 包的结构按 WorkBuddy 开放平台的连接器规范（https://open.workbuddy.cn/docs/connector）：
#
#   zops/
#   ├── connector-meta.json   连接器元信息（必须）
#   ├── mcp.json              MCP Server 连接配置（必须）
#   ├── token-schema.json     用户自填 Token 模式的表单（auth_mode: token 时必须有）
#   ├── icon.svg              市场图标（必须）
#   ├── README.md
#   └── skills/zops/          AI 使用说明
#
# 注意这套结构和**装到客户端之后**的形态不一样 —— 那个是 `.codebuddy-plugin/plugin.json`
# 加 `ai.workbuddy/…`，平台会把这里的提交格式转换过去。别照着已安装的包反推。
#
# 为什么要这个脚本：技能正文的真源在仓库根的 `skills/zops/`（`include_str!` 把它编进
# 二进制），图标真源在前端的 `favicon.svg`，版本号真源在 `Cargo.toml`；而上架用的包
# 需要各自一份拷贝。多份拷贝、多个真源，靠人记是记不住的 —— 交给脚本和 `cargo test`
# 里那几个同名单测（`src/domain/mcp.rs`）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK="$ROOT/connectors/zops"
DIST="$ROOT/connectors/dist"

VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"(.*)".*/\1/')"
[ -n "$VERSION" ] || { echo "读不出 Cargo.toml 的 version" >&2; exit 1; }

META="$PACK/connector-meta.json"
SKILL_SRC="$ROOT/skills/zops/SKILL.md"

# 包里这些文件的内容来源在别处。`(源, 包内相对路径)`。
copy_pairs() {
  printf '%s\t%s\n' \
    "$SKILL_SRC"                                      "skills/zops/SKILL.md" \
    "$ROOT/skills/zops/references/deploy.md"          "skills/zops/references/deploy.md" \
    "$ROOT/skills/zops/references/troubleshooting.md" "skills/zops/references/troubleshooting.md" \
    "$ROOT/frontend/public/favicon.svg"               "icon.svg"
}

# 版本号在两个文件里各写一份，都要跟 Cargo.toml 走：`connector-meta.json` 是给平台
# 注册用的；SKILL.md 的 frontmatter 是技能自己的版本，平台转换后会变成
# `metadata["ai.workbuddy.version"]`。两处写错都会让"这个包描述的是哪个版本的面板"
# 说不清，所以两处都跟同一个真源比。
declared_in_meta()  { sed -nE 's/^[[:space:]]*"version": "([^"]*)".*/\1/p' "$META" | head -1; }
declared_in_skill() { sed -nE '1,15s/^version: (.*)$/\1/p' "$SKILL_SRC" | head -1; }

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
  done < <(copy_pairs)

  local meta skill
  meta="$(declared_in_meta)"
  skill="$(declared_in_skill)"
  [ "$meta"  = "$VERSION" ] || { echo "版本不符  connector-meta.json=$meta  Cargo.toml=$VERSION"; drift=1; }
  [ "$skill" = "$VERSION" ] || { echo "版本不符  skills/zops/SKILL.md=$skill  Cargo.toml=$VERSION"; drift=1; }

  # JSON 本身能不能解析。cargo test 里也拦了，但提交前先看一眼更省事。
  if command -v python3 >/dev/null 2>&1; then
    for f in "$META" "$PACK/mcp.json" "$PACK/token-schema.json"; do
      python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" \
        || { echo "JSON 非法  ${f#$ROOT/}"; drift=1; }
    done
  else
    echo "提示：没找到 python3，跳过 JSON 语法检查（cargo test 里那几个单测仍会拦）"
  fi

  return $drift
}

do_sync() {
  local changed=0 was

  # 先把版本写进两个真源再往下拷 —— 否则拷出来的还是旧版本。
  was="$(declared_in_skill)"
  if [ "$was" != "$VERSION" ]; then
    sed -i.bak -E "1,15s/^version: .*/version: $VERSION/" "$SKILL_SRC"
    rm -f "$SKILL_SRC.bak"
    echo "同步    skills/zops/SKILL.md version $was → $VERSION"
    changed=1
  fi

  was="$(declared_in_meta)"
  if [ "$was" != "$VERSION" ]; then
    sed -i.bak -E "s/^([[:space:]]*\"version\": \")[^\"]*(\")/\1$VERSION\2/" "$META"
    rm -f "$META.bak"
    echo "同步    connector-meta.json version $was → $VERSION"
    changed=1
  fi

  local src rel dst
  while IFS=$'\t' read -r src rel; do
    dst="$PACK/$rel"
    mkdir -p "$(dirname "$dst")"
    if cmp -s "$src" "$dst" 2>/dev/null; then continue; fi
    cp "$src" "$dst"
    echo "同步    $rel"
    changed=1
  done < <(copy_pairs)

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
  # 规范要求：解压后只有一个顶层目录 `zops/`。
  ( cd "$PACK/.." && zip -qr "$out" zops -x '*.DS_Store' -x '__MACOSX/*' )
  echo
  echo "已打出 $out"
  unzip -l "$out" | tail -3
}

case "${1:-}" in
  sync)  do_sync ;;
  check) if check; then echo "包与真源一致（版本 ${VERSION}）。"; else echo >&2 "包已漂移，跑 sync 修。" >&2; exit 1; fi ;;
  zip)   do_zip ;;
  *)     sed -nE '2,20s/^# ?//p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
