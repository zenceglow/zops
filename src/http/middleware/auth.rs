use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, DecodingKey, Validation};

use crate::domain::auth::{AuthUser, Claims};
use crate::http::AppState;
use crate::shared::api_response::{ApiResponse, CODE_UNAUTHORIZED};
use crate::shared::AppError;

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Response {
    let token = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    let claims = match decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.auth.jwt_secret().as_bytes()),
        &Validation::default(),
    ) {
        Ok(data) => data.claims,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ApiResponse::<()>::fail(CODE_UNAUTHORIZED, "未授权")),
            )
                .into_response();
        }
    };

    let user = match state.auth.load_auth_user(claims.uid) {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ApiResponse::<()>::fail(CODE_UNAUTHORIZED, "未授权")),
            )
                .into_response();
        }
    };

    // Username mismatch / revoked user
    if user.username != claims.sub {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse::<()>::fail(CODE_UNAUTHORIZED, "未授权")),
        )
            .into_response();
    }

    req.extensions_mut().insert(user);
    next.run(req).await
}

/// Require a permission on the current AuthUser (from extensions).
pub fn require_perm(user: &AuthUser, permission: &str) -> Result<(), AppError> {
    if user.has(permission) {
        Ok(())
    } else {
        Err(AppError::forbidden(format!("缺少权限: {permission}")))
    }
}
