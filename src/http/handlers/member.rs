use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::{AuthUser, MemberInfo};
use crate::domain::permission::{OPS_MEMBER_MANAGE, ROLE_MEMBER};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct CreateMemberRequest {
    username: String,
    password: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
}

#[derive(Deserialize)]
pub struct UpdateMemberRequest {
    id: i64,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    permissions: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: i64,
}

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<MemberInfo>>>, AppError> {
    require_perm(&user, OPS_MEMBER_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.members.list()?)))
}

async fn get_one(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<MemberInfo>>, AppError> {
    require_perm(&user, OPS_MEMBER_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.members.get(q.id)?)))
}

async fn create(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateMemberRequest>,
) -> Result<Json<ApiResponse<MemberInfo>>, AppError> {
    require_perm(&user, OPS_MEMBER_MANAGE)?;
    let role = body.role.as_deref().unwrap_or(ROLE_MEMBER);
    let member = state
        .members
        .create(&body.username, &body.password, Some(role), &body.permissions)?;
    Ok(Json(ApiResponse::ok(member)))
}

async fn update(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<ApiResponse<MemberInfo>>, AppError> {
    require_perm(&user, OPS_MEMBER_MANAGE)?;
    let member = state.members.update(
        body.id,
        body.password.as_deref(),
        body.permissions.as_deref(),
        user.id,
    )?;
    Ok(Json(ApiResponse::ok(member)))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_MEMBER_MANAGE)?;
    state.members.delete(q.id, user.id)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/list", get(list))
        .route("/create", post(create))
        .route("/", get(get_one).put(update).delete(remove))
}
