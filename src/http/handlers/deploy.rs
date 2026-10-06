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
use crate::service::deploy::{ApplyResult, DeployInput, DeployPlan, DeployedService};
use crate::shared::{ApiResponse, AppError};

/// 部署体检。只读，不改任何东西。
async fn plan(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<DeployInput>,
) -> Result<Json<ApiResponse<DeployPlan>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.deploy.plan(&body)?)))
}

/// 落地并起服务。会写文件、跑构建，属于重写操作。
async fn apply(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<DeployInput>,
) -> Result<Json<ApiResponse<ApplyResult>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    Ok(Json(ApiResponse::ok(state.deploy.apply(body).await?)))
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<DeployedService>>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.deploy.list())))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/plan", post(plan))
        .route("/apply", post(apply))
        .route("/list", get(list))
        // 部署任务通道（目录 + 产物 + 脚本 + 记录）挂在同一棵 /deploy 下面。
        .merge(super::deploy_job::routes())
}
