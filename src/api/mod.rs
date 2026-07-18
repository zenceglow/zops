use std::sync::Arc;

use axum::Router;
use tower_http::cors::{Any, CorsLayer};

use crate::state::AppState;

mod auth;
mod logs;
mod services;
mod system;

pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api = Router::new()
        .nest("/system", system::routes())
        .nest("/services", services::routes())
        .nest("/logs", logs::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    Router::new()
        .nest("/api/ops/auth", auth::routes(state.clone()))
        .nest("/api/ops", api)
        .layer(cors)
        .with_state(state)
}
