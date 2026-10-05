use std::net::{IpAddr, UdpSocket};
use std::sync::Arc;

use crate::domain::setup::{validate_admin_credentials, SetupStatus};
use crate::infrastructure::db::Database;
use crate::shared::AppError;

pub struct SetupService {
    db: Arc<Database>,
    port: u16,
    default_lang: String,
}

impl SetupService {
    pub fn new(db: Arc<Database>, port: u16, default_lang: String) -> Self {
        Self {
            db,
            port,
            default_lang,
        }
    }

    pub fn ensure_banner_if_needed(&self) -> Result<(), AppError> {
        if !self.db.is_initialized().map_err(AppError::from)? {
            let secret = self.db.rotate_setup_secret().map_err(AppError::from)?;
            print_setup_banner(self.port, &secret);
        }
        Ok(())
    }

    pub fn status(&self) -> Result<SetupStatus, AppError> {
        Ok(SetupStatus {
            initialized: self.db.is_initialized().map_err(AppError::from)?,
            port: self.port,
            default_lang: self.default_lang.clone(),
        })
    }

    pub fn complete(&self, secret: &str, username: &str, password: &str) -> Result<(), AppError> {
        validate_admin_credentials(username, password)?;
        self.db
            .complete_setup(secret, username.trim(), password)
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("密钥") || msg.contains("已完成") {
                    AppError::bad_request(msg)
                } else {
                    AppError::internal(msg)
                }
            })
    }
}

fn print_setup_banner(port: u16, secret: &str) {
    let host_hint = local_ip_hint().unwrap_or_else(|| "<服务器IP>".into());
    eprintln!();
    eprintln!("=========================================");
    eprintln!(" ZOPS — 尚未初始化");
    eprintln!("=========================================");
    eprintln!(" 初始化地址: http://{host_hint}:{port}/setup");
    eprintln!("             http://127.0.0.1:{port}/setup");
    eprintln!(" 初始化密钥: {secret}");
    eprintln!();
    eprintln!(" 请在服务器/主机防火墙放行 TCP 端口 {port}");
    eprintln!(" 例如:");
    eprintln!("   ufw allow {port}/tcp && ufw reload");
    eprintln!("   firewall-cmd --add-port={port}/tcp --permanent && firewall-cmd --reload");
    eprintln!("=========================================");
    eprintln!();
}

fn local_ip_hint() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    match ip {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
            Some(v4.to_string())
        }
        IpAddr::V6(v6) if !v6.is_loopback() && !v6.is_unspecified() => Some(v6.to_string()),
        _ => None,
    }
}
