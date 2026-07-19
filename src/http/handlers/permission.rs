use std::sync::Arc;

use axum::{routing::get, Json, Router};

use crate::domain::permission::{all_permissions, PermissionDef};
use crate::http::AppState;
use crate::shared::ApiResponse;

async fn list() -> Json<ApiResponse<Vec<PermissionDef>>> {
    Json(ApiResponse::ok(all_permissions()))
}

pub fn routes() -> Router<Arc<AppState>> {
    // Catalog is readable by any authenticated user (needed for UI / self-service awareness).
    // Nested under protected router.
    Router::new().route("/list", get(list))
}
