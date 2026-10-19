//! 存储体检的 HTTP 面。
//!
//! 只服务面板 UI，**不进 MCP**：压缩会独占写锁、清理不可逆，这两件事不该让 agent
//! 随手调。agent 要判断磁盘够不够，看 `ops_system_overview` 就够了。

use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_SYSTEM_READ, OPS_SYSTEM_WRITE};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::service::database::{PruneReport, StorageStats, VacuumReport};
use crate::shared::{ApiResponse, AppError};

/// 体检结果。文件大小、可回收空间、每张表多少行。
async fn stats(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<StorageStats>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.database.stats()?)))
}

#[derive(Debug, Deserialize)]
struct RetentionBody {
    days: i64,
}

/// 改保留期。只写配置，不立刻删数据 —— 删除是单独一个动作，别混在一起。
async fn set_retention(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<RetentionBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    state.database.set_retention(body.days)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "retention_days": body.days,
    }))))
}

#[derive(Debug, Deserialize, Default)]
struct PruneBody {
    /// 临时覆盖保留期；不传就用当前配置。
    days: Option<i64>,
}

/// 立刻清理一次过期行。
async fn prune(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    body: Option<Json<PruneBody>>,
) -> Result<Json<ApiResponse<PruneReport>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let days = match body.and_then(|b| b.0.days) {
        Some(d) => d,
        None => state.database.stats()?.retention_days,
    };
    Ok(Json(ApiResponse::ok(state.database.prune(days)?)))
}

/// 压缩数据库。会重写整个库，请求期间其他写操作排队。
async fn vacuum(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<VacuumReport>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    Ok(Json(ApiResponse::ok(state.database.vacuum()?)))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/database", get(stats))
        .route("/database/retention", post(set_retention))
        .route("/database/prune", post(prune))
        .route("/database/vacuum", post(vacuum))
}
