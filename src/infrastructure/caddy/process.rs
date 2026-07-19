use std::sync::Mutex;

use crate::shared::AppError;

use super::bin::{self, which_caddy};

pub struct CaddyProcess {
    pub caddyfile_path: String,
    pub bin: Mutex<Option<String>>,
}

impl CaddyProcess {
    pub fn new(caddyfile_path: String) -> Self {
        Self {
            caddyfile_path,
            bin: Mutex::new(which_caddy()),
        }
    }

    pub fn refresh_bin(&self) -> Option<String> {
        let bin = which_caddy();
        *self.bin.lock().unwrap() = bin.clone();
        bin
    }

    pub fn cached_bin(&self) -> Option<String> {
        self.bin.lock().unwrap().clone()
    }

    pub fn status(&self) -> GatewayStatusSnapshot {
        let bin = which_caddy().unwrap_or_default();
        let installed = !bin.is_empty();
        let version = if installed {
            bin::version(&bin)
        } else {
            String::new()
        };
        let pid = bin::pid();
        GatewayStatusSnapshot {
            installed,
            running: pid.is_some(),
            version,
            pid,
            bin_path: bin,
            caddyfile_path: self.caddyfile_path.clone(),
        }
    }

    pub fn install(&self) -> Result<String, AppError> {
        if which_caddy().is_some() {
            return Err(AppError::bad_request("接入网关已安装"));
        }

        let result = if cfg!(target_os = "macos") {
            let output = std::process::Command::new("brew")
                .args(["install", "caddy"])
                .output()
                .map_err(|e| AppError::internal(format!("无法执行 brew: {e}")))?;
            if output.status.success() {
                Ok("安装成功".to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(AppError::internal(format!("安装失败: {stderr}")))
            }
        } else if cfg!(target_os = "linux") {
            let status = std::process::Command::new("sh")
                .args(["-c", "curl -fsSL https://getcaddy.com | bash"])
                .status()
                .map_err(|e| AppError::internal(format!("无法执行安装脚本: {e}")))?;
            if status.success() {
                Ok("安装成功".to_string())
            } else {
                Err(AppError::internal(
                    "安装失败，请手动安装 Caddy: https://caddyserver.com/docs/install",
                ))
            }
        } else {
            Err(AppError::bad_request(
                "不支持的操作系统，请手动安装 Caddy: https://caddyserver.com/docs/install",
            ))
        }?;

        self.refresh_bin();
        Ok(result)
    }

    pub fn start(&self) -> Result<(), AppError> {
        let bin = self
            .cached_bin()
            .ok_or_else(|| AppError::bad_request("接入网关未安装"))?;

        systemctl("start", "caddy").or_else(|_| {
            std::process::Command::new(&bin)
                .arg("run")
                .arg("--config")
                .arg(&self.caddyfile_path)
                .spawn()
                .map(|_| ())
                .map_err(|e| AppError::internal(e.to_string()))
        })
    }

    pub fn stop(&self) -> Result<(), AppError> {
        systemctl("stop", "caddy").or_else(|_| {
            std::process::Command::new("pkill")
                .arg("-x")
                .arg("caddy")
                .status()
                .map(|_| ())
                .map_err(|e| AppError::internal(e.to_string()))
        })
    }

    pub fn reload(&self) -> Result<(), AppError> {
        let bin = self
            .cached_bin()
            .ok_or_else(|| AppError::bad_request("接入网关未安装"))?;

        std::process::Command::new(&bin)
            .arg("reload")
            .arg("--config")
            .arg(&self.caddyfile_path)
            .output()
            .map_err(|e| AppError::internal(e.to_string()))
            .and_then(|o| {
                if o.status.success() {
                    Ok(())
                } else {
                    let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    Err(AppError::internal(msg))
                }
            })
            .or_else(|_| systemctl("restart", "caddy"))
    }
}

pub struct GatewayStatusSnapshot {
    pub installed: bool,
    pub running: bool,
    pub version: String,
    pub pid: Option<i32>,
    pub bin_path: String,
    pub caddyfile_path: String,
}

fn systemctl(action: &str, service: &str) -> Result<(), AppError> {
    let status = std::process::Command::new("systemctl")
        .arg(action)
        .arg(service)
        .status()
        .map_err(|e| AppError::internal(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "systemctl {action} {service} failed"
        )))
    }
}
