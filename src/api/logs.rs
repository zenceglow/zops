use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Json, Router};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

type ApiError = (StatusCode, &'static str);

#[derive(Deserialize)]
pub struct LogFileQuery {
    path: String,
    tail: Option<usize>,
}

#[derive(Serialize)]
pub struct LogResponse {
    path: String,
    lines: Vec<String>,
    truncated: bool,
}

async fn tail_file(Query(q): Query<LogFileQuery>) -> Result<Json<LogResponse>, ApiError> {
    let path = std::path::Path::new(&q.path);
    let allowed = [
        "/opt/docker-apps/",
        "/var/log/",
        "./logs/",
        "/app/logs/",
    ];
    let path_str = path.display().to_string();
    if !allowed.iter().any(|p| path_str.starts_with(p)) {
        return Err((StatusCode::FORBIDDEN, "路径不在白名单内"));
    }

    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "读取文件失败"))?;

    let tail = q.tail.unwrap_or(200).min(2000);
    let all_lines: Vec<&str> = content.lines().collect();
    let total = all_lines.len();
    let lines: Vec<String> = all_lines
        .into_iter()
        .skip(total.saturating_sub(tail))
        .map(|s| s.to_string())
        .collect();

    Ok(Json(LogResponse {
        path: path_str,
        lines,
        truncated: total > tail,
    }))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/tail", axum::routing::get(tail_file))
}
