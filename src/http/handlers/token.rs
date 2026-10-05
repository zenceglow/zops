//! Agent access tokens (used by MCP clients). Panel-authenticated management;
//! the agent-facing verification lives in `handlers::mcp`.

use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_AGENT_MANAGE;
use crate::domain::token::{ApiTokenCreated, ApiTokenInfo};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct CreateTokenRequest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    scope: String,
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: String,
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<ApiTokenInfo>>>, AppError> {
    require_perm(&user, OPS_AGENT_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.tokens.list()?)))
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateTokenRequest>,
) -> Result<Json<ApiResponse<ApiTokenCreated>>, AppError> {
    require_perm(&user, OPS_AGENT_MANAGE)?;
    Ok(Json(ApiResponse::ok(
        state.tokens.create(&body.name, &body.scope)?,
    )))
}

async fn revoke(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_AGENT_MANAGE)?;
    state.tokens.revoke(&q.id)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/list", get(list))
        .route("/create", post(create))
        .route("/", delete(revoke))
}
