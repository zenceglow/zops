use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_AUDIT_READ;
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::infrastructure::db::AuditRow;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default)]
    limit: Option<i64>,
    /// 只看人（user）或只看 agent。
    #[serde(default)]
    kind: Option<String>,
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<ApiResponse<Vec<AuditRow>>>, AppError> {
    require_perm(&user, OPS_AUDIT_READ)?;
    let kind = q.kind.as_deref().filter(|k| *k == "user" || *k == "agent");
    Ok(Json(ApiResponse::ok(
        state.audit.list(q.limit.unwrap_or(100), kind)?,
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/list", get(list))
}
