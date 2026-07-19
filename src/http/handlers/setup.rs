use std::sync::Arc;

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::setup::SetupStatus;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct CompleteSetupRequest {
    secret: String,
    username: String,
    password: String,
}

async fn status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<SetupStatus>>, AppError> {
    Ok(Json(ApiResponse::ok(state.setup.status()?)))
}

async fn complete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CompleteSetupRequest>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    state
        .setup
        .complete(&body.secret, &body.username, &body.password)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/complete", post(complete))
        .with_state(state)
}
