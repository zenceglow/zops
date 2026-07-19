use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::{AuthUser, LoginData, MeData};
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<ApiResponse<LoginData>>, AppError> {
    let data = state.auth.login(&body.username, &body.password)?;
    Ok(Json(ApiResponse::ok(data)))
}

async fn me(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<MeData>>, AppError> {
    Ok(Json(ApiResponse::ok(state.auth.me(user.id)?)))
}

pub fn public_routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/login", post(login))
        .with_state(state)
}

pub fn protected_routes() -> Router<Arc<AppState>> {
    Router::new().route("/me", get(me))
}
