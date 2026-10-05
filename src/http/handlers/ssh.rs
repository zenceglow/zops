use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::domain::auth::Claims;
use crate::domain::permission::OPS_SSH_CONNECT;
use crate::http::AppState;
use crate::infrastructure::ssh::{
    is_local_host, run_bridge, ClientBridgeIn, ClientMsg, LocalSession, ServerMsg,
    Session, SshConnectParams, SshSession,
};

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
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
    if !user.has(OPS_SSH_CONNECT) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }

    ws.on_upgrade(handle_socket).into_response()
}

async fn send_json(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    msg: &ServerMsg,
) -> bool {
    let Ok(text) = serde_json::to_string(msg) else {
        return false;
    };
    sink.send(Message::Text(text.into())).await.is_ok()
}

async fn handle_socket(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    let connect = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Connect {
                    host,
                    port,
                    username,
                    password,
                    cols,
                    rows,
                }) => {
                    break SshConnectParams {
                        host,
                        port,
                        username,
                        password,
                        cols,
                        rows,
                    };
                }
                Ok(_) => {
                    let _ = send_json(
                        &mut sink,
                        &ServerMsg::Error {
                            message: "请先发送 connect 消息".into(),
                        },
                    )
                    .await;
                }
                Err(e) => {
                    let _ = send_json(
                        &mut sink,
                        &ServerMsg::Error {
                            message: format!("无效消息: {e}"),
                        },
                    )
                    .await;
                }
            },
            Some(Ok(Message::Close(_))) | None => return,
            Some(Ok(_)) => continue,
            Some(Err(_)) => return,
        }
    };

    // 目标是本机就直接开本地 PTY：面板本来就以 root 跑在这台机器上，让人再去
    // SSH 回自己、还得输密码，纯属绕路（而且很多机器根本不允许 root 密码登录）。
    let session = if is_local_host(&connect.host) {
        LocalSession::spawn(connect.cols, connect.rows).map(Session::Local)
    } else {
        SshSession::connect(connect).await.map(Session::Ssh)
    };

    let session = match session {
        Ok(s) => s,
        Err(e) => {
            let _ = send_json(
                &mut sink,
                &ServerMsg::Error {
                    message: e.to_string(),
                },
            )
            .await;
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    };

    if !send_json(&mut sink, &ServerMsg::Ready).await {
        return;
    }

    let (to_ssh_tx, to_ssh_rx) = mpsc::channel::<ClientBridgeIn>(256);
    let (from_ssh_tx, mut from_ssh_rx) = mpsc::channel::<ServerMsg>(256);

    tokio::spawn(run_bridge(session, to_ssh_rx, from_ssh_tx));

    loop {
        tokio::select! {
            from_client = stream.next() => {
                match from_client {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(ClientMsg::Input { data }) => {
                                if to_ssh_tx.send(ClientBridgeIn::Input(data)).await.is_err() {
                                    break;
                                }
                            }
                            Ok(ClientMsg::Resize { cols, rows }) => {
                                let _ = to_ssh_tx.send(ClientBridgeIn::Resize { cols, rows }).await;
                            }
                            Ok(ClientMsg::Connect { .. }) => {
                                let _ = send_json(&mut sink, &ServerMsg::Error {
                                    message: "已连接".into(),
                                }).await;
                            }
                            Err(e) => {
                                let _ = send_json(&mut sink, &ServerMsg::Error {
                                    message: format!("无效消息: {e}"),
                                }).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            from_ssh = from_ssh_rx.recv() => {
                match from_ssh {
                    Some(msg) => {
                        let closed = matches!(msg, ServerMsg::Closed);
                        if !send_json(&mut sink, &msg).await {
                            break;
                        }
                        if closed {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    let _ = sink.send(Message::Close(None)).await;
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/ws", get(ws_upgrade))
}
