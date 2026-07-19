use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_GATEWAY_CONTROL, OPS_GATEWAY_READ};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::service::gateway::GatewayStatus;
use crate::shared::{ApiResponse, AppError};

async fn status(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<GatewayStatus>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(state.gateway.status())))
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
        .route("/install", post(install))
        .route("/start", post(start))
        .route("/stop", post(stop))
        .route("/reload", post(reload))
}
