# ZOPS 连接器包

ZOPS 面板的 WorkBuddy / CodeBuddy 连接器。装上它，agent 就能通过面板的 MCP 服务器
看清这台服务器的负载、磁盘、Docker 容器、Caddy 网关、日志和定时任务，并在你确认后
重启容器、重载网关或改 Caddyfile。

- 市场上展示的名字：`ZOPS - 轻松搞定运维工作` / `ZOPS - Server Ops Made Easy`
- 面板本体：<https://github.com/zenceglow/zops>
- MCP 端点：`<协议>://<主机>:<端口>/api/ops/mcp`（Streamable HTTP + JSON-RPC 2.0）
- 工具面：31 个 `ops_*` 工具，每个返回里都带 `_host` 指纹

## 和别的连接器不一样的地方

ZOPS **不是 SaaS**。它是一个装在用户自己服务器上的单二进制面板，所以这个连接器没有
固定的服务端地址 —— 用户要把自己那台机器的地址和令牌填进来。包里的
`urlTemplatedMcpServers` 就是为这种情况准备的：用户填 `ZOPS_SCHEMA` / `ZOPS_HOST` /
`ZOPS_PORT` / `ZOPS_API_KEY`，平台拼出 MCP URL 并在 `Authorization` 头上带令牌。

因此上架时要注意：这个连接器**没有**可以直接拨测的公共端点。评审如果要验活，需要
先在一台机器上装一次面板（`curl -fsSL https://cdn.zenceglow.com/app/ops/install.sh | bash`，
六步交互、一路回车即可）。

## 目录结构

```
connectors/zops/
├── .codebuddy-plugin/plugin.json          # agent-plugins 1.0.0 + ai.workbuddy 扩展
├── ai.workbuddy/
│   ├── assets/icon.svg                    # ← frontend/public/favicon.svg
│   └── token-schema.json                  # 用户要填的四个字段
├── skills/zops/                           # ← 仓库根 skills/zops/
│   ├── SKILL.md
│   └── references/{deploy,troubleshooting}.md
└── README.md
```

没有 `mcp.json`：连接地址由用户填，不是写死的，所以走 `urlTemplatedMcpServers`。

## 三个真源，三份拷贝

包里的文件内容**不在这里维护**，改这里会被 `sync` 覆盖：

| 包内路径 | 真源 | 为什么 |
|---|---|---|
| `skills/zops/**` | 仓库根 `skills/zops/**` | `src/domain/mcp.rs` 用 `include_str!` 把它编进了二进制，同时作为 MCP resources 暴露 |
| `ai.workbuddy/assets/icon.svg` | `frontend/public/favicon.svg` | 面板图标，两边应该长得一样 |
| `.codebuddy-plugin/plugin.json` 的 `version` | `Cargo.toml` | 连接器描述的就是这个版本面板的工具集 |

```bash
./connectors/package.sh sync     # 改完技能/图标、或 bump 版本之后跑
./connectors/package.sh check    # 只校验（CI、提交前）
./connectors/package.sh zip      # 校验通过后出 connectors/dist/zops-<version>.zip
```

`src/domain/mcp.rs` 里有四个同名单测把这件事钉在 `cargo test` 里 ——
`deploy.sh` 的冒烟门禁会跑 `cargo test`，所以包和实现分叉是发不出去的。

## 上架前要确认的两件事

1. **`visible_in`** 现在填的是官方市场里最常见的四环境值
   `["internal","iOA","cloudhosted","selfhosted"]`（147/151 个声明了该字段的连接器都是这个）。
   如果开放平台的环境枚举不一样，按平台要求改。

2. **明文 http**。面板默认跑在 `http://<服务器IP>:5200`，用户把 `ZOPS_SCHEMA` 留成
   `http` 就是明文 —— 但 `urlTemplate` 允许用户自己选协议，不是写死的明文端点，
   所以没有用 `insecureHttpMcpServers`（全市场只有 1 例，是硬编码的 http URL）。
   官方仓库里的 `tdengine` 同样是「`schema` 字段默认 `http` + `urlTemplate`」的写法，
   这是这个仓库里既有的先例。如果平台上架校验要求明文必须走
   `insecureHttpMcpServers`，再按那种形式补一份。

## 版本号

本地写 `0.2.50`（跟 `Cargo.toml` 一致）。官方市场里 317 个连接器的 `version` 一律带
`+wb.<16位内容哈希>` 构建元数据（例：`1.0.1+wb.b762bd07f61ff387`），看起来是发布
流水线算出来回填的。这里不编一个假哈希 —— 交给平台发布时补。semver 里构建元数据不参与
优先级比较，所以 `0.2.50` 和 `0.2.50+wb.xxxx` 视为同版本。

## 用户侧的连接配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `ZOPS_SCHEMA` | `http` | 直连 IP:端口填 `http`；前面有 Caddy 配了域名走 HTTPS 填 `https` |
| `ZOPS_HOST` | — | 面板所在机器的可达地址（内网 IP 或域名） |
| `ZOPS_PORT` | `5200` | 官方安装脚本默认 5200 |
| `ZOPS_API_KEY` | — | 面板「MCP」页建的 `ops_…` 令牌；只读令牌不能启停容器 |

令牌只在创建时显示一次，服务端只存 SHA-256。用户填的这些值只存在本机 `~/.workbuddy` 下。
