//! 安全中心：暴露面 / 端口访问记录 / 预警。全部只读，外加一个"立刻采集一次"的动作。

use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_LOG_READ, OPS_SYSTEM_READ};
use crate::domain::security::{
    EventsQuery, Firewall, SecurityEvent, SecuritySummary, SshQuery, SshRecord, SshSummary,
};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct HoursQuery {
    #[serde(default)]
    pub hours: Option<u32>,
}

async fn firewall(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Firewall>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.security.firewall())))
}

async fn events(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<ApiResponse<Vec<SecurityEvent>>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    let kind = q.kind.trim();
    Ok(Json(ApiResponse::ok(state.security.events(
        if kind.is_empty() { None } else { Some(kind) },
        q.limit.unwrap_or(100),
        q.offset.unwrap_or(0),
    )?)))
}

async fn events_summary(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<HoursQuery>,
) -> Result<Json<ApiResponse<SecuritySummary>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    Ok(Json(ApiResponse::ok(
        state.security.summary(q.hours.unwrap_or(24))?,
    )))
}

async fn ssh_records(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<SshQuery>,
) -> Result<Json<ApiResponse<Vec<SshRecord>>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    let result = q.result.trim();
    Ok(Json(ApiResponse::ok(state.security.ssh_records(
        if result.is_empty() { None } else { Some(result) },
        q.limit.unwrap_or(200),
    )?)))
}

async fn ssh_summary(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<HoursQuery>,
) -> Result<Json<ApiResponse<SshSummary>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    Ok(Json(ApiResponse::ok(
        state.security.ssh_summary(q.hours.unwrap_or(24 * 7))?,
    )))
}

/// 立刻把 sshd 日志的增量读一遍。打开安全中心时顺手催一次，用户不用等采集周期。
async fn scan(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    let inserted = state.security.ingest_ssh()?;
    Ok(Json(ApiResponse::ok(
        serde_json::json!({ "inserted": inserted }),
    )))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/firewall", get(firewall))
        .route("/events", get(events))
        .route("/events/summary", get(events_summary))
        .route("/ssh", get(ssh_records))
        .route("/ssh/summary", get(ssh_summary))
        .route("/scan", post(scan))
}
