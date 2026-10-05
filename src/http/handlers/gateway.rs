use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_GATEWAY_CONTROL, OPS_GATEWAY_READ};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::infrastructure::caddy::logs::GatewayLog;
use crate::service::gateway::GatewayStatus;
use crate::shared::{ApiResponse, AppError};

async fn status(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<GatewayStatus>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(state.gateway.status())))
}

#[derive(Deserialize)]
struct LogQuery {
    tail: Option<usize>,
}

#[derive(Deserialize)]
struct IconQuery {
    host: String,
}

/// 站点自己的 favicon，包成 data URL 回给前端。
///
/// 走 JSON 而不是直接回图片：这个接口在 JWT 组里，而 `<img src>` 带不了
/// Authorization 头。用 data URL 就不用为它单开一条 query token 的口子。
async fn icon(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IconQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;

    // 只允许取"当前 Caddyfile 里真实存在的站点"。不然这个接口就成了一个
    // 让服务器去访问任意地址的跳板（SSRF）—— 内网的元数据地址、管理口都在射程内。
    let config = state.caddyfile.get().await?;
    let known = config
        .parsed
        .sites
        .iter()
        .filter_map(|s| crate::infrastructure::caddy::icon::host_of(&s.addr))
        .any(|h| h.eq_ignore_ascii_case(&q.host));
    if !known {
        return Ok(Json(ApiResponse::ok(serde_json::json!({ "data_url": null }))));
    }

    let found = crate::infrastructure::caddy::icon::fetch(&q.host).await;
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "data_url": found.map(|i| {
            use base64::Engine;
            format!(
                "data:{};base64,{}",
                i.content_type,
                base64::engine::general_purpose::STANDARD.encode(&i.bytes)
            )
        }),
    }))))
}

/// 网关自己的日志。读它和"读状态"是同一档权限 —— 都是看，不改。
async fn logs(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<LogQuery>,
) -> Result<Json<ApiResponse<GatewayLog>>, AppError> {
    require_perm(&user, OPS_GATEWAY_READ)?;
    Ok(Json(ApiResponse::ok(
        state.gateway.logs(q.tail.unwrap_or(300)),
    )))
}

async fn install(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    Ok(Json(ApiResponse::ok(state.gateway.install()?)))
}

async fn start(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    state.gateway.start()?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn stop(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    state.gateway.stop()?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn reload(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_GATEWAY_CONTROL)?;
    state.gateway.reload()?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/logs", get(logs))
        .route("/icon", get(icon))
        .route("/install", post(install))
        .route("/start", post(start))
        .route("/stop", post(stop))
        .route("/reload", post(reload))
}
