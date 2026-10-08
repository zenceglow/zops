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
    analytics, app_market, audit, auth, automation, caddyfile, deploy, deploy_job, files, gateway,
    logs, member, permission, notify, security, service, setup, ssh, system, mcp,
    token as token_handler,
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
        .nest("/analytics", analytics::routes())
        .nest("/deploy", deploy::routes())
        // 应用市场：装的是"预置好的部署任务"，所以和 /deploy 同级、用同一套权限
        // （看目录是只读，install 要 ops.deploy）。
        .nest("/app", app_market::routes())
        .nest("/security", security::routes())
        .nest("/notify", notify::routes())
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
        // 无鉴权的身份端点：只回"版本 / 主机名 / 启动时刻 / 指纹"，用来核对
        // agent 连的是哪个面板。不含任何账号、容器、路径信息，所以不需要令牌。
        .route("/api/ops/version", axum::routing::get(system::version))
        .nest("/api/ops/auth", auth::public_routes(state.clone()))
        .nest("/api/ops/setup", setup::routes(state.clone()))
        // Agent surface: these authenticate with an `ops_…` API token (or a
        // panel JWT) inside the handler, so they must sit outside the JWT group.
        .nest("/api/ops/mcp", mcp::mcp_routes())
        .nest("/api/ops/skill", mcp::skill_routes())
        // 产物上传：agent 拿 `ops_…` 令牌直接 `curl -T` 打这里，所以同样得待在
        // JWT 组外面，由 handler 自己认凭证。
        .nest("/api/ops/deploy", deploy_job::agent_routes())
        // SSH & log WebSocket authenticate via ?token= inside the handler
        .nest("/api/ops/ssh", ssh::routes())
        .nest("/api/ops/log", logs::public_routes())
        .nest("/api/ops", protected)
        .layer(cors)
        .with_state(state)
}
