use std::sync::Arc;

use serde::Serialize;

use crate::infrastructure::caddy::{process::GatewayStatusSnapshot, CaddyProcess};
use crate::shared::AppError;

#[derive(Serialize)]
pub struct GatewayStatus {
    pub installed: bool,
    pub running: bool,
    pub version: String,
    pub pid: Option<i32>,
    pub bin_path: String,
    pub caddyfile_path: String,
}

impl From<GatewayStatusSnapshot> for GatewayStatus {
    fn from(s: GatewayStatusSnapshot) -> Self {
        Self {
            installed: s.installed,
            running: s.running,
            version: s.version,
            pid: s.pid,
            bin_path: s.bin_path,
            caddyfile_path: s.caddyfile_path,
        }
    }
}

pub struct GatewayService {
    caddy: Arc<CaddyProcess>,
}

impl GatewayService {
    pub fn new(caddy: Arc<CaddyProcess>) -> Self {
        Self { caddy }
    }

    pub fn status(&self) -> GatewayStatus {
        self.caddy.status().into()
    }

    pub fn install(&self) -> Result<serde_json::Value, AppError> {
        let message = self.caddy.install()?;
        Ok(serde_json::json!({ "ok": true, "message": message }))
    }

    pub fn start(&self) -> Result<(), AppError> {
        self.caddy.start()
    }

    pub fn stop(&self) -> Result<(), AppError> {
        self.caddy.stop()
    }

    pub fn reload(&self) -> Result<(), AppError> {
        self.caddy.reload()
    }
}
