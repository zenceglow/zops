use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_LOG_READ;
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::service::analytics::{AnalyticsOverview, EventsPage};
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
struct RangeQuery {
    hours: Option<u32>,
}

async fn overview(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<RangeQuery>,
) -> Result<Json<ApiResponse<AnalyticsOverview>>, AppError> {
    // 访问流水和"读某个日志文件"是同一档敏感度：都能看到谁访问了什么。
    require_perm(&user, OPS_LOG_READ)?;
    Ok(Json(ApiResponse::ok(
        state.analytics.overview(q.hours.unwrap_or(24))?,
    )))
}

#[derive(Deserialize)]
struct EventsQuery {
    /// 只看比这个 id 新的。0 / 不传 = 给我最近的一批。
    after: Option<i64>,
    limit: Option<usize>,
}

async fn events(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<ApiResponse<EventsPage>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    Ok(Json(ApiResponse::ok(
        state
            .analytics
            .events(q.after.unwrap_or(0), q.limit.unwrap_or(40))?,
    )))
}

/// 立刻采一轮。平时靠后台定时采，这个接口是给"我刚发了一批请求，想马上看到"
/// 用的 —— 也顺便让用户能验证采集到底通不通。
async fn refresh(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    let ingested = state.analytics.ingest().await?;
    Ok(Json(ApiResponse::ok(
        serde_json::json!({ "ingested": ingested }),
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/overview", get(overview))
        .route("/events", get(events))
        .route("/refresh", post(refresh))
}
