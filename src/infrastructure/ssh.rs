//! Interactive SSH session over WebSocket (russh PTY shell).

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
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

/// 目标是不是"这台机器自己"。
///
/// 面板本身就跑在这台机器上，要一个 shell 却先 SSH 回自己纯属绕路：得有 sshd 在
/// 监听、还得允许 root 用密码登录（不少发行版默认就是禁止的）。这几个写法一律
/// 走本地 shell，不碰网络。
pub fn is_local_host(host: &str) -> bool {
    let h = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    matches!(h.as_str(), "" | "local" | "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
}

/// 本机 shell。
///
/// portable-pty 给的读写端是阻塞的 `std::io`，所以各配一个 OS 线程搬运，线程与
/// 异步侧之间用 mpsc 连起来。resize 是 ioctl、不阻塞，直接在异步侧调。
pub struct LocalSession {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    input_tx: mpsc::Sender<Vec<u8>>,
    output_rx: mpsc::Receiver<Vec<u8>>,
}

impl LocalSession {
    pub fn spawn(cols: u32, rows: u32) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("创建 PTY 失败")?;

        // 登录 shell：不然 .bashrc / .zshrc 里那套 PATH、别名、提示符都没有，
        // 拿到的会是一个"像没登录过"的裸 shell。
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).context("启动 shell 失败")?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("读取 PTY 失败")?;
        let mut writer = pair.master.take_writer().context("写入 PTY 失败")?;

        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(256);

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    // 读到 0 或者报错都意味着 PTY 那头没了（shell 退出）。
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if output_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
            // 线程结束、sender 释放 → 接收端拿到 None，桥接据此判定会话结束。
        });

        std::thread::spawn(move || {
            while let Some(data) = input_rx.blocking_recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        Ok(Self {
            child,
            master: pair.master,
            input_tx,
            output_rx,
        })
    }
}

/// 会话产出的一帧。
pub enum SessionEvent {
    Data(Vec<u8>),
    Closed,
}

/// 本机 shell 与远端 SSH 的统一接口，桥接层不用关心底下是哪种。
pub enum Session {
    Local(LocalSession),
    Ssh(SshSession),
}

impl Session {
    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        match self {
            Session::Local(s) => s
                .input_tx
                .send(data.to_vec())
                .await
                .map_err(|_| anyhow!("shell 已退出")),
            Session::Ssh(s) => s.write(data).await,
        }
    }

    pub async fn resize(&mut self, cols: u32, rows: u32) -> Result<()> {
        match self {
            Session::Local(s) => s
                .master
                .resize(PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .context("调整终端大小失败"),
            Session::Ssh(s) => s.resize(cols, rows).await,
        }
    }

    pub async fn next(&mut self) -> SessionEvent {
        match self {
            Session::Local(s) => match s.output_rx.recv().await {
                Some(data) => SessionEvent::Data(data),
                None => SessionEvent::Closed,
            },
            Session::Ssh(s) => loop {
                match s.recv().await {
                    Some(ChannelMsg::Data { data }) => return SessionEvent::Data(data.to_vec()),
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        return SessionEvent::Data(data.to_vec())
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => {
                        return SessionEvent::Closed
                    }
                    // 窗口调整之类的控制消息，对终端没有可显示的内容。
                    Some(_) => continue,
                }
            },
        }
    }

    pub async fn close(self) {
        match self {
            // 用户可能是直接关掉页面/断网的，shell 不会自己退，得动手收掉。
            Session::Local(mut s) => {
                let _ = s.child.kill();
            }
            Session::Ssh(s) => {
                let _ = s.close().await;
            }
        }
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
    mut session: Session,
    mut ws_rx: mpsc::Receiver<ClientBridgeIn>,
    ws_tx: mpsc::Sender<ServerMsg>,
) {
    loop {
        tokio::select! {
            biased;
            msg = ws_rx.recv() => {
                match msg {
                    Some(ClientBridgeIn::Input(data)) => {
                        if let Err(e) = session.write(data.as_bytes()).await {
                            let _ = ws_tx.send(ServerMsg::Error { message: e.to_string() }).await;
                            break;
                        }
                    }
                    Some(ClientBridgeIn::Resize { cols, rows }) => {
                        if let Err(e) = session.resize(cols, rows).await {
                            let _ = ws_tx.send(ServerMsg::Error { message: e.to_string() }).await;
                        }
                    }
                    None => break,
                }
            }
            event = session.next() => {
                match event {
                    SessionEvent::Data(bytes) => {
                        // 终端字节流不保证是合法 UTF-8（中文被切一半、光标控制序列
                        // 都常见），有损转换是这里的正确做法，不能直接 unwrap。
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        if ws_tx.send(ServerMsg::Output { data: text }).await.is_err() {
                            break;
                        }
                    }
                    SessionEvent::Closed => {
                        let _ = ws_tx.send(ServerMsg::Closed).await;
                        break;
                    }
                }
            }
        }
    }
    session.close().await;
}
