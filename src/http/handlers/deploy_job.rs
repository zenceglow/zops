//! 部署任务通道的 HTTP 接口。面板的三步走（传产物 → 写脚本 → 执行）走这里，
//! agent 走 MCP 里同名的那几个工具，两边操作的是同一批记录。

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Extension, Query, State},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::deploy_job::{
    CreateDeployJob, DeployJob, DeployRun, RunLog, SaveDeployScript,
};
use crate::domain::permission::{OPS_DEPLOY, OPS_SYSTEM_READ};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

/// 单个产物的上限，和服务层保持一致（DMG/tgz 常见十几 MB）。
const MAX_UPLOAD: usize = 256 * 1024 * 1024;

#[derive(Deserialize)]
pub struct IdQuery {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct LogQuery {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub offset: Option<u64>,
}

#[derive(Deserialize)]
pub struct UploadQuery {
    pub id: String,
    /// 部署目录内的相对路径，例如 `package.tgz` 或 `conf/app.yaml`。
    pub path: String,
}

#[derive(Deserialize)]
pub struct FileBody {
    pub id: String,
    pub path: String,
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<DeployJob>>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.deploy_jobs.list()?)))
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateDeployJob>,
) -> Result<Json<ApiResponse<DeployJob>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    let job = state
        .deploy_jobs
        .create(
            &body.name,
            &body.note,
            &body.source,
            &user.username,
            "user",
            body.kind.as_deref().unwrap_or("backend"),
            body.port,
        )?;
    Ok(Json(ApiResponse::ok(job)))
}

async fn get_one(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<DeployJob>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.deploy_jobs.get_by_ref(&q.id)?)))
}

async fn delete_one(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    let job = state.deploy_jobs.get_by_ref(&q.id)?;
    state.deploy_jobs.delete(&job.id)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn save_script(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SaveDeployScript>,
) -> Result<Json<ApiResponse<DeployJob>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    let job = state.deploy_jobs.get_by_ref(&body.id)?;
    Ok(Json(ApiResponse::ok(
        state.deploy_jobs.save_script(&job.id, &body.script)?,
    )))
}

/// 传产物。走原始 body + `?path=`，不走 multipart：产物动辄几十 MB，
/// 少一层封装少一份出错的地方，`curl -T` 也能直接用。
async fn upload(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> Result<Json<ApiResponse<DeployJob>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    let job = state.deploy_jobs.get_by_ref(&q.id)?;
    Ok(Json(ApiResponse::ok(state.deploy_jobs.upload(
        &job.id,
        &q.path,
        &body,
        &user.username,
    )?)))
}

async fn delete_file(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<FileBody>,
) -> Result<Json<ApiResponse<DeployJob>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    let job = state.deploy_jobs.get_by_ref(&body.id)?;
    Ok(Json(ApiResponse::ok(
        state.deploy_jobs.delete_file(&job.id, &body.path)?,
    )))
}

async fn run_now(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<DeployRun>>, AppError> {
    require_perm(&user, OPS_DEPLOY)?;
    let job = state.deploy_jobs.get_by_ref(&q.id)?;
    Ok(Json(ApiResponse::ok(
        state.deploy_jobs.run(&job.id, &user.username, "user").await?,
    )))
}

async fn list_runs(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<Vec<DeployRun>>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    let job = state.deploy_jobs.get_by_ref(&q.id)?;
    Ok(Json(ApiResponse::ok(
        state.deploy_jobs.runs(&job.id, q.limit.unwrap_or(30))?,
    )))
}

/// 增量拉执行日志。前端按返回的 `offset` 接着拉，就是在看实时进度。
async fn run_log(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<LogQuery>,
) -> Result<Json<ApiResponse<RunLog>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(
        state
            .deploy_jobs
            .run_log(&q.id, q.offset.unwrap_or(0))
            .await?,
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/jobs", get(list).post(create))
        .route("/job", get(get_one).delete(delete_one))
        .route("/job/script", put(save_script))
        .route("/job/file", post(delete_file))
        .route("/job/run", post(run_now))
        .route("/job/runs", get(list_runs))
        .route("/run/log", get(run_log))
        // 上传这一条单独放开 body 上限：默认 2MB 连个 tgz 都塞不下。
        .route(
            "/job/upload",
            post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
}
