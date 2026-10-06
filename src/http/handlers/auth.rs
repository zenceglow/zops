use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::{AuthUser, LoginData, MeData};
use crate::http::AppState;
use crate::service::auth::{LoginOutcome, FAIL_LIMIT, LOCK_MINUTES};
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
    match state.auth.login(&body.username, &body.password)? {
        LoginOutcome::Ok(data) => Ok(Json(ApiResponse::ok(*data))),
        LoginOutcome::BadCredentials { left } => Err(AppError::unauthorized(format!(
            "用户名或密码错误（还可以试 {left} 次）"
        ))),
        LoginOutcome::Locked {
            minutes,
            just_locked,
        } => {
            // 只在**刚锁上的那一刻**推一次：被反复扫描时不该把群刷爆。
            if just_locked {
                let (sent, _) = state
                    .notify
                    .broadcast(
                        "security",
                        "面板登录被锁定",
                        &format!(
                            "账号「{}」连续 {FAIL_LIMIT} 次密码错误，已锁定 {LOCK_MINUTES} 分钟。\n\
                             解锁：在服务器上执行 `zops unlock {}`",
                            body.username, body.username
                        ),
                    )
                    .await;
                tracing::warn!(
                    "登录锁定：{}（通知已发往 {sent} 个渠道）",
                    body.username
                );
            }
            Err(AppError::forbidden(format!(
                "尝试次数过多，账号已锁定 {minutes} 分钟。\n解锁：在服务器上执行 `zops unlock {}`",
                body.username
            )))
        }
    }
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
