# Zenceglow Ops

Server operations panel — system monitoring, Docker service management, and log viewer, all in a single Rust binary with an embedded web UI.

## Features

- **System monitoring** — CPU, memory, disk, network, processes, load average
- **Docker management** — list containers, start/stop/restart/remove, view logs
- **Log viewer** — tail application log files on the server
- **JWT authentication** — simple login, token-based API access
- **Embedded SPA** — built-in React + Vite frontend, compiled into binary via `rust-embed`

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+ and pnpm (for building frontend)
- Docker (optional, for container management)

### Build & Run

```bash
# 1. Build the frontend
cd frontend
pnpm install
pnpm build
cd ..

# 2. Run the ops panel
OPS_PORT=5200 cargo run
```

Open http://127.0.0.1:5000 in your browser.

Default credentials: `admin` / `zenceglow`

### All-in-one build script

```bash
./build.sh
```

A convenience script (`build.sh`) is included that builds the frontend, then compiles the Rust binary:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
(cd frontend && pnpm install && pnpm build)
cargo build --release
echo "Binary: target/release/zenceglow-ops"
```

## API

All API routes are prefixed with `/api/ops` and require a `Bearer` token obtained from login.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ops/auth/login` | Login, returns JWT token |
| GET | `/api/ops/system/overview` | CPU / memory / disk / network overview |
| GET | `/api/ops/services/` | List Docker containers |
| POST | `/api/ops/services/{id}/start` | Start a container |
| POST | `/api/ops/services/{id}/stop` | Stop a container |
| POST | `/api/ops/services/{id}/restart` | Restart a container |
| DELETE | `/api/ops/services/{id}/remove` | Remove a container |
| GET | `/api/ops/services/{id}/logs?tail=100` | Fetch container logs |
| GET | `/api/ops/logs/tail?path=...&tail=200` | Tail server log files |

## Configuration

| Environment | Default | Description |
|-------------|---------|-------------|
| `OPS_PORT` | `5000` | HTTP listen port |
| `RUST_LOG` | `info,zenceglow_ops=debug` | Tracing/logging level |

## Project Structure

```
zenceglow-ops/
├── Cargo.toml          # Rust dependencies
├── src/
│   ├── main.rs         # Entry point
│   ├── state.rs        # Application state
│   ├── assets.rs       # rust-embed frontend
│   ├── assets_router.rs# Static file serving + SPA fallback
│   └── api/
│       ├── mod.rs      # Router + CORS + JWT middleware
│       ├── auth.rs     # Login & JWT
│       ├── system.rs   # System monitoring
│       ├── services.rs # Docker container management
│       └── logs.rs     # File log viewer
├── frontend/           # React SPA
│   ├── package.json
│   ├── src/
│   │   ├── main.tsx
│   │   └── pages/
│   │       ├── Login.tsx
│   │       └── Dashboard.tsx
│   └── vite.config.ts
└── LICENSE
```

## Tech Stack

- **Backend**: Rust, Axum, sysinfo, bollard (Docker), jsonwebtoken
- **Frontend**: React, TypeScript, Vite, react-router-dom
- **Embedding**: rust-embed

## License

MIT
