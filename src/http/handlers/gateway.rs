use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_GATEWAY_CONTROL, OPS_GATEWAY_READ};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::infrastructure::caddy::logs::GatewayLog;
use crate::service::gateway::GatewayStatus;
use crate::shared::{ApiResponse, AppError};

async fn status(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<GatewayStatus>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(state.gateway.status())))
}

#[derive(Deserialize)]
struct LogQuery {
    tail: Option<usize>,
}

/// 网关自己的日志。读它和"读状态"是同一档权限 —— 都是看，不改。
async fn logs(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<LogQuery>,
) -> Result<Json<ApiResponse<GatewayLog>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(
        state.gateway.logs(q.tail.unwrap_or(300)),
    )))
}

async fn install(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    Ok(Json(ApiResponse::ok(state.gateway.install()?)))
}

async fn start(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    state.gateway.start()?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn stop(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    state.gateway.stop()?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn reload(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    state.gateway.reload()?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/logs", get(logs))
        .route("/install", post(install))
        .route("/start", post(start))
        .route("/stop", post(stop))
        .route("/reload", post(reload))
}
