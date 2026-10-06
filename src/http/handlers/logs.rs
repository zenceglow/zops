use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Extension, Path, Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::{delete, get},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::domain::auth::{AuthUser, Claims};
use crate::domain::logs::{LogSourceInfo, LogTailData};
use crate::domain::permission::OPS_LOG_READ;
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::infrastructure::fs::tail;
use crate::shared::{ApiResponse, AppError};

// ── REST: log sources ──

async fn list_sources(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<LogSourceInfo>>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    Ok(Json(ApiResponse::ok(state.logs.list_sources()?)))
}

#[derive(Deserialize)]
struct AddSourceBody {
    path: String,
    label: Option<String>,
}

async fn add_source(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<AddSourceBody>,
) -> Result<Json<ApiResponse<LogSourceInfo>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    let label = body.label.unwrap_or_default();
    Ok(Json(ApiResponse::ok(state.logs.add_source(&body.path, &label)?)))
}

/// 删除一个日志源。id 走路径（`DELETE /log/sources/{id}`）—— 以前这里读的是查询串，
/// 而路由给的是路径参数，两边对不上：删除请求根本到不了这个函数，卡片也就删不掉。
async fn remove_source(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    state.logs.remove_source(&id)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

// ── Tail endpoint ──

#[derive(Deserialize)]
pub struct TailQuery {
    pub path: String,
    pub tail: Option<usize>,
}

async fn tail_file(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<TailQuery>,
) -> Result<Json<ApiResponse<LogTailData>>, AppError> {
    require_perm(&user, OPS_LOG_READ)?;
    let data = state
        .logs
        .tail_file(&q.path, q.tail.unwrap_or(200))
        .await?;
    Ok(Json(ApiResponse::ok(data)))
}

// ── WebSocket streaming ──

#[derive(Deserialize)]
struct StreamQuery {
    ids: Option<String>,
    token: String,
}

async fn log_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<StreamQuery>,
) -> impl IntoResponse {
    let claims = match decode::<Claims>(
        &q.token,
        &DecodingKey::from_secret(state.auth.jwt_secret().as_bytes()),
        &Validation::default(),
    ) {
        Ok(data) => data.claims,
        Err(_) => return axum::http::StatusCode::UNAUTHORIZED.into_response(),
    };

    let Ok(user) = state.auth.load_auth_user(claims.uid) else {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    };
    if !user.has(OPS_LOG_READ) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }

    let source_ids: Vec<String> = q
        .ids
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let sources = match state.logs.get_source_paths(&source_ids) {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("{e:?}");
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                msg,
            )
                .into_response();
        }
    };

    ws.on_upgrade(move |socket| handle_log_stream(socket, sources))
        .into_response()
}

async fn handle_log_stream(socket: WebSocket, sources: Vec<LogSourceInfo>) {
    let (mut sink, _stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(256);

    let mut handles = Vec::new();
    for s in &sources {
        let path = s.path.clone();
        let tx_clone = tx.clone();
        handles.push(tokio::spawn(tail::follow_file(path, tx_clone)));
    }

    // Write source info as initial messages
    for s in &sources {
        let init = serde_json::json!({
            "sourceId": s.id,
            "sourceLabel": s.label,
            "line": format!("[connected] watching: {}", s.path)
        });
        if let Ok(text) = serde_json::to_string(&init) {
            if sink.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
    }

    loop {
        tokio::select! {
            line = rx.recv() => {
                match line {
                    Some(text) => {
                        let payload = serde_json::json!({
                            "sourceId": "",
                            "sourceLabel": "",
                            "line": text,
                        });
                        if let Ok(json) = serde_json::to_string(&payload) {
                            if sink.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    None => break,
                }
            }
        }
    }

    for h in handles {
        h.abort();
    }
    let _ = sink.send(Message::Close(None)).await;
}

pub fn protected_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/sources", get(list_sources).post(add_source))
        .route("/sources/{id}", delete(remove_source))
        .route("/tail", get(tail_file))
}

pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new().route("/stream", get(log_stream))
}
