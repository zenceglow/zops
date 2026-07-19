use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::caddy::CaddyfileData;
use crate::domain::permission::{OPS_GATEWAY_READ, OPS_GATEWAY_WRITE};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct UpdateCaddyfileRequest {
    raw: String,
}

async fn get_caddyfile(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<CaddyfileData>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(state.caddyfile.get().await?)))
}

async fn update_caddyfile(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<UpdateCaddyfileRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_WRITE)?;
    Ok(Json(ApiResponse::ok(
        state.caddyfile.update(body.raw).await?,
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/file", get(get_caddyfile))
        .route("/file", put(update_caddyfile))
}
