use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::get,
    Json, Router,
};

use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_SYSTEM_READ;
use crate::domain::system::SystemOverview;
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

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/overview", get(overview))
}
