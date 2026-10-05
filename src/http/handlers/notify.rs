use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_NOTIFY_MANAGE;
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::infrastructure::db::NotifyLogRow;
use crate::service::notify::{Channel, ChannelInput};
use crate::shared::{ApiResponse, AppError};

async fn list(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<Channel>>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.notify.list()?)))
}

async fn log(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<NotifyLogRow>>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.notify.log(60)?)))
}

async fn save(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ChannelInput>,
) -> Result<Json<ApiResponse<Channel>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.notify.save(body)?)))
}

#[derive(Deserialize)]
struct IdQuery {
    id: String,
}

#[derive(Deserialize)]
struct ToggleBody {
    id: String,
    enabled: bool,
}

async fn toggle(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ToggleBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    state.notify.set_enabled(&body.id, body.enabled)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<IdQuery>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    state.notify.remove(&q.id)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

/// 试发一条。
///
/// 失败时把对方回的原话带回去（"sign not match" / "invalid webhook"）—— 配置
/// 通知最费时间的就是这一步，一句"发送失败"等于把人退回去猜。
async fn test(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<IdQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    let channel = state.notify.channel(&body.id)?;
    let delivery = state
        .notify
        .send_to(&channel, "test", "ZOPS 测试消息", "这条是面板发出来的测试消息，收到就说明配好了。")
        .await?;
    if !delivery.ok {
        return Err(AppError::bad_request(format!(
            "对方拒绝了这条消息（HTTP {}）：{}",
            delivery.status, delivery.detail
        )));
    }
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "status": delivery.status,
        "detail": delivery.detail,
    }))))
}

/// 有哪些事件可以订阅。前端不用把这份列表抄一遍。
async fn events(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<serde_json::Value>>>, AppError> {
    require_perm(&user, OPS_NOTIFY_MANAGE)?;
    Ok(Json(ApiResponse::ok(
        crate::service::notify::EVENTS
            .iter()
            .map(|(k, label)| serde_json::json!({ "key": k, "label": label }))
            .collect(),
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/channels", get(list).post(save))
        .route("/channels/toggle", post(toggle))
        .route("/channels/remove", delete(remove))
        .route("/test", post(test))
        .route("/log", get(log))
        .route("/events", get(events))
}
