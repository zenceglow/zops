use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_FILES_READ;
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

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/list", get(list))
        .route("/search", get(search))
        .route("/preview", get(preview))
}
