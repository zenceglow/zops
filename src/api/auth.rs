use std::sync::Arc;

use axum::{
    extract::State,
    http::{StatusCode, Request},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::state::{AppState, DEFAULT_PASS, DEFAULT_USER};

// ---------- data types ----------

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    token: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Claims {
    sub: String,
    exp: usize,
}

// ---------- login handler ----------

async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, &'static str)> {
    if body.username != DEFAULT_USER || body.password != DEFAULT_PASS {
        return Err((StatusCode::UNAUTHORIZED, "用户名或密码错误"));
    }

    let claims = Claims {
        sub: body.username,
        exp: (chrono::Utc::now() + chrono::Duration::hours(24)).timestamp() as usize,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "token 生成失败"))?;

    Ok(Json(LoginResponse { token }))
}

// ---------- auth middleware ----------

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let token = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    match decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    ) {
        Ok(_data) => next.run(req).await,
        Err(_) => (StatusCode::UNAUTHORIZED, "未授权").into_response(),
    }
}

// ---------- routes ----------

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/login", post(login))
        .with_state(state)
}
