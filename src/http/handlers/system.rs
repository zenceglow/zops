use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_SYSTEM_READ, OPS_SYSTEM_WRITE};
use crate::domain::system::SystemOverview;
use crate::infrastructure::system::{TimezoneInfo, UpdateReport};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

async fn overview(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<SystemOverview>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.overview())))
}

/// 系统补丁情况（读缓存）。
async fn updates(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<UpdateReport>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.updates())))
}

/// 立刻检查一次（会读包管理器元数据，慢）。
async fn check_updates(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<UpdateReport>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.check_updates().await?)))
}

#[derive(Deserialize)]
pub struct ApplyUpdatesBody {
    packages: Vec<String>,
}

/// 装补丁。要 OPS_SYSTEM_WRITE —— 这是会上主机改软件包的动作。
async fn apply_updates(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ApplyUpdatesBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let output = state.system.apply_updates(body.packages).await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "output": output }))))
}

#[derive(Deserialize)]
pub struct TimezoneBody {
    zone: String,
}

async fn timezone(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<TimezoneInfo>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.timezone())))
}

async fn set_timezone(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<TimezoneBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let via = state.system.set_timezone(body.zone).await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "via": via }))))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/overview", get(overview))
        .route("/updates", get(updates))
        .route("/updates/check", post(check_updates))
        .route("/updates/apply", post(apply_updates))
        .route("/timezone", get(timezone).post(set_timezone))
}
