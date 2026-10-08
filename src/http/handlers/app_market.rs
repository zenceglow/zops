//! 应用市场的 HTTP 接口。
//!
//! 三个动作：看目录（`/list`）、看方案（`/plan`）、装（`/install`）。分开是有用的 ——
//! `plan` 只读、不改任何东西，所以它可以比 `install` 低一档权限，Agent 也能在动手
//! 之前先把 compose 摊开给人看。

use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_DEPLOY, OPS_SYSTEM_READ};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::service::app_market::{InstallOptions, InstallPlan, InstallResult, MarketApp};
use crate::shared::{ApiResponse, AppError};

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<MarketApp>>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.app_market.list()?)))
}

async fn plan(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<InstallOptions>,
) -> Result<Json<ApiResponse<InstallPlan>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.app_market.plan(&body).await?)))
}

async fn install(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<InstallOptions>,
) -> Result<Json<ApiResponse<InstallResult>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    Ok(Json(ApiResponse::ok(
        state
            .app_market
            .install(&body, &user.username, "user")
            .await?,
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/list", get(list))
        .route("/plan", post(plan))
        .route("/install", post(install))
}
