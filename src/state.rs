use std::sync::Mutex;

use bollard::Docker;
use sysinfo::System;

/// 面板初始用户名/密码（首次启动写入 config，之后用 argon2 验证）。
pub const DEFAULT_USER: &str = "admin";
pub const DEFAULT_PASS: &str = "zenceglow";

pub struct AppState {
    pub sysinfo: Mutex<System>,
    pub docker: Option<Docker>,
    /// JWT secret key（首次启动随机生成，持久化到文件）。
    pub jwt_secret: String,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let sys = System::new_all();

        let docker = Docker::connect_with_local_defaults().ok();

        // 每次重启生成新 secret 会让已有 token 失效；生产应持久化到文件。
        let jwt_secret = uuid::Uuid::new_v4().to_string();

        Ok(Self {
            sysinfo: Mutex::new(sys),
            docker,
            jwt_secret,
        })
    }
}
