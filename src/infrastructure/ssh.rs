//! Interactive SSH session over WebSocket (russh PTY shell).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use russh::client::{self, Handle};
use russh::{Channel, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

struct AcceptAll;

impl client::Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Ops panel: host key verification can be added later (known_hosts).
        Ok(true)
    }
}

pub struct SshSession {
    session: Handle<AcceptAll>,
    channel: Channel<client::Msg>,
}

#[derive(Debug, Clone)]
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub cols: u32,
    pub rows: u32,
}

impl SshSession {
    pub async fn connect(params: SshConnectParams) -> Result<Self> {
        let config = client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        };

        let mut session = client::connect(
            Arc::new(config),
            (params.host.as_str(), params.port),
            AcceptAll,
        )
        .await
        .with_context(|| format!("连接 {}:{} 失败", params.host, params.port))?;

        let auth = session
            .authenticate_password(params.username.clone(), params.password)
            .await
            .context("SSH 认证失败")?;

        if !auth.success() {
            return Err(anyhow!("用户名或密码错误"));
        }

        let channel = session
            .channel_open_session()
            .await
            .context("打开 SSH channel 失败")?;

        channel
            .request_pty(
                false,
                "xterm-256color",
                params.cols,
                params.rows,
                0,
                0,
                &[],
            )
            .await
            .context("申请 PTY 失败")?;

        channel
            .request_shell(true)
            .await
            .context("启动 shell 失败")?;

        Ok(Self { session, channel })
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        self.channel.data(data).await.context("写入 SSH 失败")?;
        Ok(())
    }

    pub async fn resize(&mut self, cols: u32, rows: u32) -> Result<()> {
        self.channel
            .window_change(cols, rows, 0, 0)
            .await
            .context("调整终端大小失败")?;
        Ok(())
    }

    pub async fn recv(&mut self) -> Option<ChannelMsg> {
        self.channel.wait().await
    }

    pub async fn close(self) -> Result<()> {
        let _ = self
            .session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        Ok(())
    }
}

/// Client → server control messages (JSON text frames).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Connect {
        host: String,
        #[serde(default = "default_port")]
        port: u16,
        username: String,
        password: String,
        #[serde(default = "default_cols")]
        cols: u32,
        #[serde(default = "default_rows")]
        rows: u32,
    },
    Input {
        data: String,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
}

fn default_port() -> u16 {
    22
}
fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}

/// Server → client messages.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Ready,
    Output { data: String },
    Error { message: String },
    Closed,
}

pub enum ClientBridgeIn {
    Input(String),
    Resize { cols: u32, rows: u32 },
}

pub async fn run_bridge(
    mut ssh: SshSession,
    mut ws_rx: mpsc::Receiver<ClientBridgeIn>,
    ws_tx: mpsc::Sender<ServerMsg>,
) {
    loop {
        tokio::select! {
            biased;
            msg = ws_rx.recv() => {
                match msg {
                    Some(ClientBridgeIn::Input(data)) => {
                        if let Err(e) = ssh.write(data.as_bytes()).await {
                            let _ = ws_tx.send(ServerMsg::Error { message: e.to_string() }).await;
                            break;
                        }
                    }
                    Some(ClientBridgeIn::Resize { cols, rows }) => {
                        if let Err(e) = ssh.resize(cols, rows).await {
                            let _ = ws_tx.send(ServerMsg::Error { message: e.to_string() }).await;
                        }
                    }
                    None => break,
                }
            }
            msg = ssh.recv() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let text = String::from_utf8_lossy(data).into_owned();
                        if ws_tx.send(ServerMsg::Output { data: text }).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let text = String::from_utf8_lossy(data).into_owned();
                        if ws_tx.send(ServerMsg::Output { data: text }).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => {
                        let _ = ws_tx.send(ServerMsg::Closed).await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    let _ = ssh.close().await;
}
