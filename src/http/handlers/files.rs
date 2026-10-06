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

fn store_public(row: &crate::infrastructure::db::ObjectStoreRow) -> serde_json::Value {
    let hint = if row.access_key.chars().count() <= 4 {
        "••••".to_string()
    } else {
        let tail: String = row.access_key.chars().rev().take(4).collect::<String>().chars().rev().collect();
        format!("••••{tail}")
    };
    serde_json::json!({
        "id": row.id,
        "name": row.name,
        "provider": row.provider,
        "endpoint": row.endpoint,
        "region": row.region,
        "bucket": row.bucket,
        "prefix": row.prefix,
        "path_style": row.path_style,
        "access_key_hint": hint,
    })
}

async fn stores(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<serde_json::Value>>>, AppError> {
    require_perm(&user, OPS_FILES_READ)?;
    let rows = state.files.list_stores()?;
    Ok(Json(ApiResponse::ok(rows.iter().map(store_public).collect())))
}

#[derive(Deserialize)]
pub struct StoreBody {
    name: String,
    provider: String,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    #[serde(default)]
    prefix: String,
    #[serde(default = "default_path_style")]
    path_style: bool,
}

fn default_path_style() -> bool {
    true
}

async fn create_store(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<StoreBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    let provider = body.provider.trim();
    if !matches!(provider, "aws" | "oss" | "r2") {
        return Err(AppError::bad_request("provider 只能是 aws、oss 或 r2"));
    }
    for (label, value) in [
        ("名称", body.name.trim()),
        ("endpoint", body.endpoint.trim()),
        ("region", body.region.trim()),
        ("bucket", body.bucket.trim()),
        ("access key", body.access_key.trim()),
        ("secret", body.secret_key.trim()),
    ] {
        if value.is_empty() {
            return Err(AppError::bad_request(format!("{label} 不能为空")));
        }
    }
    if body.bucket.contains('/') || body.bucket.contains(' ') {
        return Err(AppError::bad_request("bucket 不合法"));
    }
    let row = crate::infrastructure::db::ObjectStoreRow {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name.trim().to_string(),
        provider: provider.to_string(),
        endpoint: body.endpoint.trim().trim_end_matches('/').to_string(),
        region: body.region.trim().to_string(),
        bucket: body.bucket.trim().to_string(),
        access_key: body.access_key.trim().to_string(),
        secret_key: body.secret_key.trim().to_string(),
        prefix: body.prefix.trim().to_string(),
        path_style: body.path_style,
    };
    state.files.save_store(&row)?;
    Ok(Json(ApiResponse::ok(store_public(&row))))
}

#[derive(Deserialize)]
pub struct StoreIdBody {
    id: String,
}

async fn delete_store(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<StoreIdBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    state.files.delete_store(&body.id)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "ok": true }))))
}

#[derive(Deserialize)]
pub struct StoreUploadBody {
    id: String,
    path: String,
}

async fn upload_store(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<StoreUploadBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_FILES_WRITE)?;
    let files = state.files.clone();
    let key = tokio::task::spawn_blocking(move || files.upload_store(&body.id, &body.path))
        .await
        .map_err(|_| AppError::internal("上传任务异常"))??;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "key": key }))))
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
        .route("/stores", get(stores).post(create_store))
        .route("/stores/delete", post(delete_store))
        .route("/stores/upload", post(upload_store))
}
