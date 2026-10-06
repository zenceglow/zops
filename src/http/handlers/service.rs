use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::container::{ContainerList, DockerInfo, DockerStatus, ImageList, NetworkList};
use crate::domain::permission::{
    OPS_SERVICE_CONTROL, OPS_SERVICE_LOG, OPS_SERVICE_READ, OPS_SYSTEM_WRITE,
};
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

async fn images(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<ImageList>>, AppError> {
    require_perm(&user, OPS_SERVICE_READ)?;
    Ok(Json(ApiResponse::ok(state.containers.images().await?)))
}

async fn networks(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<NetworkList>>, AppError> {
    require_perm(&user, OPS_SERVICE_READ)?;
    Ok(Json(ApiResponse::ok(state.containers.networks().await?)))
}

/// Docker 引擎自身的配置（`docker info` 的原始 JSON）。
async fn info(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<DockerInfo>>, AppError> {
    require_perm(&user, OPS_SERVICE_READ)?;
    Ok(Json(ApiResponse::ok(state.containers.info().await)))
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
    state.containers.remove(&q.id, true).await?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

/// `POST /service/remove`：和 start/stop/restart 一个形状（POST + `{id}`）。
///
/// 前端三个动作都是 `containerAction(id, 'start'|'stop'|'restart')`，删除自然
/// 写成 `containerAction(id, 'remove')` —— 但后端只有 `DELETE /service?id=`，
/// 那个请求打到不存在的路由上，界面上就是一句"请求响应失败"。
#[allow(clippy::needless_pass_by_value)]
async fn remove_post(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    state.containers.remove(&body.id, true).await?;
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

#[derive(Deserialize)]
struct RemoveImageQuery {
    /// 镜像 id 或 name:tag —— 两者 docker 都认。
    reference: String,
    #[serde(default)]
    force: bool,
}

/// 删镜像。`force` 会连带删掉正在用它的容器，所以前端必须先确认过再带上它。
async fn remove_image(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<RemoveImageQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    let output = state.containers.remove_image(&q.reference, q.force).await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "output": output }))))
}

/// 引擎配置（daemon.json）。只读要 service.read 就够。
async fn daemon_get(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<crate::domain::container::DaemonFile>>, AppError> {
    require_perm(&user, OPS_SERVICE_READ)?;
    Ok(Json(ApiResponse::ok(state.containers.daemon_read())))
}

#[derive(Deserialize)]
struct DaemonBody {
    content: String,
}

/// 改引擎配置。
///
/// 要 `ops.system.write` 而不是 `ops.service.control`：这一步会重启 Docker 守护
/// 进程，**这台机器上所有容器都会跟着重启**，比启停单个容器重得多。写之前先校验
/// JSON、先备份，任何一步不过就不落盘。
async fn daemon_put(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<DaemonBody>,
) -> Result<Json<ApiResponse<crate::domain::container::DaemonWriteResult>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    Ok(Json(ApiResponse::ok(
        state.containers.daemon_write(&body.content).await?,
    )))
}

/// 扫描可清理项。前端弹窗"扫描"那一步的数据来源。
async fn junk(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<crate::infrastructure::docker::JunkSummary>>, AppError> {
    require_perm(&user, OPS_SERVICE_CONTROL)?;
    Ok(Json(ApiResponse::ok(state.containers.junk_summary().await?)))
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
        .route("/images", get(images).delete(remove_image))
        .route("/daemon", get(daemon_get).put(daemon_put))
        .route("/networks", get(networks))
        .route("/info", get(info))
        .route("/start", post(start))
        .route("/stop", post(stop))
        .route("/restart", post(restart))
        .route("/remove", post(remove_post))
        .route("/junk", get(junk))
        .route("/prune", post(prune))
        .route("/", delete(remove))
        .route("/log", get(logs))
}
