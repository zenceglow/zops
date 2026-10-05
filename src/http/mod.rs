//! HTTP layer: Axum routes, DTOs, middleware. No direct I/O.

pub mod handlers;
pub mod middleware;
pub mod state;

mod assets_router;

pub use assets_router::assets_router;
pub use state::AppState;

use std::sync::Arc;

use axum::Router;
use tower_http::cors::{Any, CorsLayer};

use crate::http::handlers::{
    audit, auth, automation, caddyfile, files, gateway, logs, member, permission, service, setup,
    ssh, system, mcp, token as token_handler,
};
use crate::http::middleware::{audit::audit_middleware, auth::auth_middleware};

pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let protected = Router::new()
        .nest("/auth", auth::protected_routes())
        .nest("/system", system::routes())
        .nest("/service", service::routes())
        .nest("/files", files::routes())
        .nest("/log", logs::protected_routes())
        .nest("/gateway", gateway::routes().merge(caddyfile::routes()))
        .nest("/member", member::routes())
        .nest("/permission", permission::routes())
        .nest("/automation", automation::routes())
        .nest("/token", token_handler::routes())
        .nest("/audit", audit::routes())
        .nest("/agent", mcp::catalog_routes())
        // 顺序要紧：后加的层在外层、先执行。审计要看到 AuthUser，所以必须套在
        // 鉴权里面；同时它要在 handler 之前，才能同时拿到请求体和最终状态码。
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            audit_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    Router::new()
        .nest("/api/ops/auth", auth::public_routes(state.clone()))
        .nest("/api/ops/setup", setup::routes(state.clone()))
        // Agent surface: these authenticate with an `ops_…` API token (or a
        // panel JWT) inside the handler, so they must sit outside the JWT group.
        .nest("/api/ops/mcp", mcp::mcp_routes())
        .nest("/api/ops/skill", mcp::skill_routes())
        // SSH & log WebSocket authenticate via ?token= inside the handler
        .nest("/api/ops/ssh", ssh::routes())
        .nest("/api/ops/log", logs::public_routes())
        .nest("/api/ops", protected)
        .layer(cors)
        .with_state(state)
}
