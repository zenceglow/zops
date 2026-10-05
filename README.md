# ZOPS

Server operations panel — system monitoring, Docker service management, and log viewer, all in a single Rust binary with an embedded web UI.

## Features

- **First-run setup** — console prints init URL + secret; set admin via web UI
- **SQLite storage** — local DB for users and future config (`data/ops.db`)
- **Layered backend** — `http → service → domain ← infrastructure`
- **System monitoring** — CPU, memory, disk, network, processes, load average
- **Docker management** — list containers, start/stop/restart/remove, view logs
- **Gateway (Caddy)** — status / reload / edit Caddyfile. When Caddy already runs in
  Docker (`-v /opt/docker-apps/caddy/config:/etc/caddy`), the panel **adopts that
  container** — it resolves the host side of the bind mount, drives `docker exec
  caddy caddy reload`, and validates via the container's own binary. No second
  Caddy is installed.
- **Log viewer** — tail application log files on the server
- **JWT authentication** — Argon2-hashed passwords, token-based API access
- **Embedded SPA** — React + Vite frontend, compiled into binary via `rust-embed`
- **MCP server** — the panel is an MCP endpoint, so Codex can operate the server
- **Codex skill pack** — shipped in the binary and served over the API

## 安装到服务器（一行）

```bash
curl -fsSL https://cdn.senapixel.com/app/ops/install.sh | bash
```

交互四步，每步都可以选随机（一路回车即可）：

| 步骤 | 选项 |
|---|---|
| 1. 面板端口 | 1) 随机 2) 输入 |
| 2. 域名 | 1) 跳过（默认，用 IP:端口） 2) 输入（自动写 Caddy 反代并重载） |
| 3. 面板用户名 | 1) 随机 2) 输入 |
| 4. 面板密码 | 只在第 3 步选了「输入」时才问；1) 随机 2) 输入（≥6 位） |

安装脚本会：下载二进制 → 写 systemd 服务 → 启动 → 用一次性密钥自动建好管理员 →
打印面板地址、账号密码和 MCP 地址。重复执行不会覆盖已有数据（已初始化就跳过建管理员）。

非交互（CI / 批量）用环境变量：

```bash
OPS_PORT=5200 OPS_USER=admin OPS_PASSWORD=xxx OPS_SKIP_DOMAIN=1 bash install.sh
```

> 云主机是 NAT，网卡上只有内网 IP。脚本会问外部服务取公网 IP；如果取不到（或你想指定），
> 传 `OPS_PUBLIC_HOST=1.2.3.4`。**对外访问还需要在云控制台安全组放行该端口**，
> 或者填一个域名走 443（安全组默认通常已放行）。

## 接入 Codex（MCP + 技能）

面板的「接入 Codex」页会生成令牌并给出可直接复制的配置。手工版：

```bash
export OPS_TOKEN="ops_..."
codex mcp add zops --url https://ops.example.com/api/ops/mcp \
  --bearer-token-env-var OPS_TOKEN
```

```toml
# ~/.codex/config.toml
[mcp_servers.zops]
url = "https://ops.example.com/api/ops/mcp"
bearer_token_env_var = "OPS_TOKEN"
```

装上技能包，Codex 才知道这些工具该怎么用：

```bash
mkdir -p ~/.agents/skills/zops/references
curl -fsSL -H "Authorization: Bearer $OPS_TOKEN" \
  https://ops.example.com/api/ops/skill/raw > ~/.agents/skills/zops/SKILL.md
curl -fsSL -H "Authorization: Bearer $OPS_TOKEN" \
  https://ops.example.com/api/ops/skill/references/troubleshooting \
  > ~/.agents/skills/zops/references/troubleshooting.md
```

**令牌分两档**：`read` 只能看（负载 / 容器 / 日志 / Caddyfile），`write` 还能启停容器、
重载网关、执行定时任务。明文只在创建时显示一次，服务端只存 SHA-256。

**MCP 工具**（`tools/list` 会按令牌权限过滤）：

```text
ops_panel_info            ops_system_overview       ops_container_list
ops_container_status      ops_container_logs        ops_log_source_list
ops_log_tail              ops_gateway_status        ops_caddyfile_get
ops_container_start       ops_container_stop        ops_container_restart
ops_gateway_reload        ops_caddyfile_put         ops_automation_task_list
ops_automation_task_run   ops_member_list
```

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+ and pnpm (for building frontend)
- Docker (optional, for container management)

### Build & Run

```bash
cd frontend && pnpm install && pnpm build && cd ..
OPS_PORT=5200 cargo run
```

On first start the console prints the initialization URL, one-time setup secret, and a firewall reminder.

Open `/setup` → enter secret → create admin → sign in at `/login`.

### Dev

```bash
./dev.sh
```

Frontend: http://localhost:5173 · Backend: http://127.0.0.1:5200

## API

See [API-CONVENTIONS.md](./API-CONVENTIONS.md) for URL / method rules (Senapixel-aligned) and the full route table.

All JSON responses use:

```json
{ "success": true, "code": 200, "message": "Successfully", "data": {} }
```

## Configuration

| Environment | Default | Description |
|-------------|---------|-------------|
| `OPS_PORT` | `5000` | HTTP listen port |
| `OPS_DATA_DIR` | `./data` | SQLite directory (`ops.db`) |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | Gateway config path |
| `RUST_LOG` | `info,zenceglow_ops=debug` | Tracing/logging level |

## Project Structure

```
zops/
├── API-CONVENTIONS.md
├── Cargo.toml
├── install.sh                  # 一行安装（交互四步）
├── skills/zops/       # Codex 技能包（编译进二进制，经 /api/ops/skill 下发）
│   ├── SKILL.md
│   └── references/troubleshooting.md
├── src/
│   ├── main.rs                 # Bootstrap + DI
│   ├── config.rs
│   ├── assets.rs
│   ├── shared/                 # ApiResponse, AppError
│   ├── domain/                 # Pure models / rules（含 mcp.rs / token.rs）
│   ├── service/                # Use-cases
│   ├── infrastructure/         # DB, Docker, Caddy（含 docker.rs）, sysinfo, fs
│   └── http/                   # Handlers, middleware, router（含 mcp.rs）
└── frontend/
    └── src/
        ├── lib/api.ts          # Unified HTTP client only
        ├── stores/             # authorize / user / theme
        └── pages/*/ _api/      # Page-scoped API functions
```
