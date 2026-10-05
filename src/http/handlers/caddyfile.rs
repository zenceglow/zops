use std::sync::Arc;

use axum::{
    extract::{Extension, Path, Query, State},
    routing::{delete, get, put},
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

#[derive(Deserialize)]
pub struct AddSiteRequest {
    /// 站点地址，例如 `shop.example.com`。
    addr: String,
    /// 完整的站点块文本（`addr { … }`）。
    block: String,
}

#[derive(Deserialize)]
pub struct SiteQuery {
    addr: String,
}

/// 加一个站点。查重、包标记、校验、落盘都在服务层一次做完。
async fn add_site(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<AddSiteRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_WRITE)?;
    Ok(Json(ApiResponse::ok(
        state
            .caddyfile
            .add_site(body.addr, body.block, &user.username)
            .await?,
    )))
}

/// 删一个站点。同样只动它自己那一段。
async fn delete_site(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<SiteQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_WRITE)?;
    Ok(Json(ApiResponse::ok(
        state.caddyfile.delete_site(&q.addr, &user.username).await?,
    )))
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
        .route("/sites", axum::routing::post(add_site))
        .route("/sites", delete(delete_site))
        .route("/versions", get(list_versions))
        .route("/versions/{id}", get(get_version))
        .route("/versions/{id}/restore", axum::routing::post(restore_version))
}
