use std::sync::Arc;

use axum::{
    extract::{Extension, Path, State},
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
        state
            .caddyfile
            .update_as(body.raw, &user.username, "保存配置")
            .await?,
    )))
}

async fn list_versions(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<crate::infrastructure::db::CaddyfileVersionRow>>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(state.caddyfile.versions(50)?)))
}

async fn get_version(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(state.caddyfile.version(id)?)))
}

async fn restore_version(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_WRITE)?;
    Ok(Json(ApiResponse::ok(
        state.caddyfile.restore(id, &user.username).await?,
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/file", get(get_caddyfile))
        .route("/file", put(update_caddyfile))
        .route("/versions", get(list_versions))
        .route("/versions/{id}", get(get_version))
        .route("/versions/{id}/restore", axum::routing::post(restore_version))
}
