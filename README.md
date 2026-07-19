# Zenceglow Ops

Server operations panel — system monitoring, Docker service management, and log viewer, all in a single Rust binary with an embedded web UI.

## Features

- **First-run setup** — console prints init URL + secret; set admin via web UI
- **SQLite storage** — local DB for users and future config (`data/ops.db`)
- **Layered backend** — `http → service → domain ← infrastructure`
- **System monitoring** — CPU, memory, disk, network, processes, load average
- **Docker management** — list containers, start/stop/restart/remove, view logs
- **Log viewer** — tail application log files on the server
- **JWT authentication** — Argon2-hashed passwords, token-based API access
- **Embedded SPA** — React + Vite frontend, compiled into binary via `rust-embed`

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
zenceglow-ops/
├── API-CONVENTIONS.md
├── Cargo.toml
├── src/
│   ├── main.rs                 # Bootstrap + DI
│   ├── config.rs
│   ├── assets.rs
│   ├── shared/                 # ApiResponse, AppError
│   ├── domain/                 # Pure models / rules
│   ├── service/                # Use-cases
│   ├── infrastructure/         # DB, Docker, Caddy, sysinfo, fs
│   └── http/                   # Handlers, middleware, router
└── frontend/
    └── src/
        ├── lib/api.ts          # Unified HTTP client only
        ├── stores/             # authorize / user / theme
        └── pages/*/ _api/      # Page-scoped API functions
```
