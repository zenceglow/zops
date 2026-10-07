# ZOPS 连接器包（提交给 WorkBuddy 开放平台）

ZOPS 面板的连接器。装上它，agent 就能通过面板的 MCP 服务器看清这台服务器的负载、
磁盘、Docker 容器、Caddy 网关、日志和定时任务，并在用户确认后重启容器、重载网关
或改 Caddyfile。

- 市场上展示的名字：`ZOPS - 轻松搞定运维工作` / `ZOPS - Server Ops Made Easy`
- 面板本体：<https://github.com/zenceglow/zops>
- MCP 端点：`<协议>://<主机>:<端口>/api/ops/mcp`（Streamable HTTP + JSON-RPC 2.0）
- 工具面：31 个 `ops_*` 工具，每个返回里都带 `_host` 指纹
- 接入方式：**MCP + Skill**，`auth_mode: token`（用户自填 Token）

## ⚠️ 这里的结构和"装好之后"的结构不一样

别照着客户端里已安装的连接器反推这个包。平台会把**提交格式**转换成**安装格式**：

| 提交格式（本目录，给平台） | 装到客户端后（`~/.workbuddy/plugins/…`） |
|---|---|
| `connector-meta.json` | `.codebuddy-plugin/plugin.json`（名字/描述/示例进 `extensions["ai.workbuddy"].display`，`minWorkbuddyVersion` 进 `policy`） |
| `mcp.json` 的 `mcpServers.<name>` | `ai.workbuddy.urlTemplatedMcpServers.<name>`（带 `${VAR}` 时）或 `ai.workbuddy.mcpServers` |
| `token-schema.json` | `ai.workbuddy/token-schema.json` |
| `icon.svg` | `ai.workbuddy/assets/icon.svg` |
| `skills/zops/SKILL.md` 的 `description_zh/en`、`version`、`author` | SKILL.md 的 `metadata` 块（`ai.workbuddy.*`） |

有个官方连接器（`24haowan-space`）甚至把提交时的 frontmatter 原样存在
`metadata["ai.workbuddy.legacy-frontmatter"]` 里，可以直接对着它核对提交格式。

判断依据是官方规范 <https://open.workbuddy.cn/docs/connector>，不是猜的。

## 目录结构

```
zops/
├── connector-meta.json       # 元信息：名字、描述、source、version、auth_mode…
├── mcp.json                  # 一个 MCP Server，url / headers 里用 ${VAR} 占位
├── token-schema.json         # 弹给用户的表单，字段 key 与 ${VAR} 一一对应
├── icon.svg                  # ← frontend/public/favicon.svg
├── README.md
└── skills/zops/              # ← 仓库根 skills/zops/
    ├── SKILL.md
    └── references/{deploy,troubleshooting}.md
```

## 三个真源，多份拷贝

包里的文件内容**不在这里维护**，改这里会被 `sync` 覆盖：

| 包内路径 | 真源 | 为什么 |
|---|---|---|
| `skills/zops/**` | 仓库根 `skills/zops/**` | `src/domain/mcp.rs` 用 `include_str!` 把它编进了二进制，同时作为 MCP resources 暴露 |
| `icon.svg` | `frontend/public/favicon.svg` | 面板图标，两边应该长得一样 |
| `connector-meta.json` 的 `version` | `Cargo.toml` | 连接器描述的就是这个版本面板的工具集 |
| `skills/zops/SKILL.md` 的 `version` | 同上 | 技能自己的版本，平台会转成 `metadata["ai.workbuddy.version"]` |

```bash
./connectors/package.sh sync     # 改完技能/图标、或 bump 版本之后跑
./connectors/package.sh check    # 只校验（CI、提交前）
./connectors/package.sh zip      # 校验通过后出 connectors/dist/zops-<version>.zip
```

`src/domain/mcp.rs` 里有五个同名单测把这件事钉在 `cargo test` 里 ——
`deploy.sh` 的冒烟门禁会跑 `cargo test`，所以包和实现分叉是发不出去的。

## 用户侧的连接配置

`auth_mode: token`，用户填四项，平台拼出 URL 并注入请求头：

| 字段 | 默认 | 说明 |
|---|---|---|
| `ZOPS_SCHEMA` | `http` | 面板前有 Caddy 配了域名走 HTTPS 时填 `https` |
| `ZOPS_HOST` | — | 面板所在机器的可达地址（内网 IP 或域名） |
| `ZOPS_PORT` | `5200` | 官方安装脚本默认 5200 |
| `ZOPS_API_KEY` | — | 面板「MCP」页建的 `ops_…` 令牌；只读令牌不能启停容器 |

令牌只在创建时显示一次，服务端只存 SHA-256。用户填的值只存在本机 `~/.workbuddy` 下。

## 提交前对照官方检查清单

- [x] 接入方案选 MCP + Skill，目录结构符合规范
- [x] `source` 用 kebab-case（`zops`）且唯一
- [x] 名称、说明、中英文示例填写完整（各 5 条）
- [x] MCP 只配置一个 Server
- [ ] **远程地址使用 HTTPS** —— 见下
- [x] 自填 Token 模式的 `${VAR}` 与表单字段 key 一一对应，敏感字段为 `password`
- [x] Skill 覆盖全部核心能力
- [x] 任何文件里都没有真实凭证
- [x] 图标清晰可辨；版本号和 `minWorkbuddyVersion` 声明正确

### 唯一一条可能被审核打回的：明文 http

官方要求「远程 MCP 使用 HTTPS」，而 ZOPS 是自托管面板，最常见的用法就是
`http://<服务器IP>:5200` —— 用户还没配域名、没有证书。所以这里把协议做成了
**用户可填的 `${ZOPS_SCHEMA}`**（默认 `http`），而不是硬编码一个 http 地址：
配了域名的用户可以直接填 `https`。

规范里「用户指定私有部署地址」正是 `auth_mode: token` 的适用场景，但
「远程地址使用 HTTPS」那条是写在安全要求里的，所以**审核方有可能不认**。
如果被打回，可选的两条路：

1. 默认值改成 `https`，文档里写明「没有证书就用内网 IP + http，自行承担」；
2. 把面板的域名/证书作为前置条件，要求用户先配好再连接。

现在这一版选择保留 `http` 默认值，是因为绝大多数自托管用户第一步就是 `IP:端口`，
默认 `https` 会让连接直接失败，且失败原因（证书）对用户来说很难自己诊断。

## 版本号

`connector-meta.json` 和 `SKILL.md` 里都写 `0.2.50`，跟 `Cargo.toml` 一致。
官方市场里已安装连接的 `version` 一律带 `+wb.<16位内容哈希>` 构建元数据
（例：`1.0.1+wb.b762bd07f61ff387`），那是平台发布时回填的，不要自己编。
