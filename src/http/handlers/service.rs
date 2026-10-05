use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::container::{ContainerList, DockerStatus};
use crate::domain::permission::{OPS_SERVICE_CONTROL, OPS_SERVICE_LOG, OPS_SERVICE_READ};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct IdBody {
    id: String,
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: String,
}

#[derive(Deserialize)]
pub struct LogQuery {
    id: String,
    tail: Option<usize>,
}

async fn status(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<DockerStatus>>, AppError> {
    require_perm(&user, OPS_SERVICE_READ)?;
    Ok(Json(ApiResponse::ok(state.containers.status())))
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<ContainerList>>, AppError> {
    require_perm(&user, OPS_SERVICE_READ)?;
    Ok(Json(ApiResponse::ok(state.containers.list().await?)))
}

async fn start(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    state.containers.start(&body.id).await?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn stop(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    state.containers.stop(&body.id).await?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn restart(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    state.containers.restart(&body.id).await?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    state.containers.remove(&q.id).await?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn logs(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<LogQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SERVICE_LOG)?;
    let data = state
        .containers
        .logs(&q.id, q.tail.unwrap_or(100))
        .await?;
    Ok(Json(ApiResponse::ok(data)))
}

/// 清理垃圾。要显式指定清哪几类 —— 不给默认值，免得前端漏传一个参数就把
/// 用户没打算删的东西删了。
async fn prune(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<crate::infrastructure::docker::PruneRequest>,
) -> Result<Json<ApiResponse<crate::infrastructure::docker::PruneResult>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    Ok(Json(ApiResponse::ok(state.containers.prune(&body).await?)))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/list", get(list))
        .route("/status", get(status))
        .route("/start", post(start))
        .route("/stop", post(stop))
        .route("/restart", post(restart))
        .route("/prune", post(prune))
        .route("/", delete(remove))
        .route("/log", get(logs))
}
