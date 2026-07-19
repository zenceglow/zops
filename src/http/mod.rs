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
    auth, automation, caddyfile, gateway, logs, member, permission, service, setup, ssh, system,
};
use crate::http::middleware::auth::auth_middleware;

pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let protected = Router::new()
        .nest("/auth", auth::protected_routes())
        .nest("/system", system::routes())
        .nest("/service", service::routes())
        .nest("/log", logs::protected_routes())
        .nest("/gateway", gateway::routes().merge(caddyfile::routes()))
        .nest("/member", member::routes())
        .nest("/permission", permission::routes())
        .nest("/automation", automation::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    Router::new()
        .nest("/api/ops/auth", auth::public_routes(state.clone()))
        .nest("/api/ops/setup", setup::routes(state.clone()))
        // SSH & log WebSocket authenticate via ?token= inside the handler
        .nest("/api/ops/ssh", ssh::routes())
        .nest("/api/ops/log", logs::public_routes())
        .nest("/api/ops", protected)
        .layer(cors)
        .with_state(state)
}
