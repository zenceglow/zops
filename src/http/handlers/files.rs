use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_FILES_READ, OPS_FILES_WRITE};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::service::files::{DirListing, FileEntry, FilePreview};
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    q: String,
}

async fn list(
    State(_state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<PathQuery>,
) -> Result<Json<ApiResponse<DirListing>>, AppError> {
    require_perm(&user, OPS_FILES_READ)?;
    Ok(Json(ApiResponse::ok(crate::service::files::list(&q.path)?)))
}

async fn search(
    State(_state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<ApiResponse<Vec<FileEntry>>>, AppError> {
    require_perm(&user, OPS_FILES_READ)?;
    Ok(Json(ApiResponse::ok(crate::service::files::search(&q.path, &q.q)?)))
}

async fn preview(
    State(_state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<PathQuery>,
) -> Result<Json<ApiResponse<FilePreview>>, AppError> {
    require_perm(&user, OPS_FILES_READ)?;
    Ok(Json(ApiResponse::ok(crate::service::files::preview(&q.path)?)))
}

#[derive(Deserialize)]
pub struct PathsBody {
    paths: Vec<String>,
    #[serde(default)]
    to: String,
}

#[derive(Deserialize)]
pub struct IdsBody {
    ids: Vec<String>,
}

/// 移动到目标目录。界面上的"剪切 + 粘贴"最终落在这里。
async fn move_paths(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<PathsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    state.files.move_into(&body.paths, &body.to)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "ok": true }))))
}

async fn copy_paths(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<PathsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    state.files.copy_into(&body.paths, &body.to)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "ok": true }))))
}

/// 删除 = 进回收站。要彻底删除得走回收站里的那一步。
async fn trash(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<PathsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    let n = state.files.trash_items(&body.paths)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "count": n }))))
}

async fn trash_list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<crate::infrastructure::db::TrashRow>>>, AppError> {
    require_perm(&user, OPS_FILES_READ)?;
    Ok(Json(ApiResponse::ok(state.files.trash_list()?)))
}

async fn trash_restore(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    let n = state.files.trash_restore(&body.ids)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "count": n }))))
}

async fn trash_purge(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    let n = state.files.trash_purge(&body.ids)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "count": n }))))
}

async fn trash_empty(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    let n = state.files.trash_empty()?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "count": n }))))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/list", get(list))
        .route("/search", get(search))
        .route("/preview", get(preview))
        .route("/move", post(move_paths))
        .route("/copy", post(copy_paths))
        .route("/trash", post(trash))
        // 彻底删除走 POST：前端的 DELETE 封装只带查询参数，塞不下一组 id。
        .route("/trash/purge", post(trash_purge))
        .route("/trash/list", get(trash_list))
        .route("/trash/restore", post(trash_restore))
        .route("/trash/empty", post(trash_empty))
}
