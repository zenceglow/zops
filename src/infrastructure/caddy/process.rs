use std::sync::Mutex;

use crate::shared::AppError;

use super::bin::{self, which_caddy};
use super::docker::{self, DockerCaddy};
use super::fmt;

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

    /// The Caddy container already fronting this host, if any.
    ///
    /// Detected on demand rather than cached: the panel is a low-traffic admin
    /// tool, and a container can be recreated underneath us at any time.
    pub fn detect_docker(&self) -> Option<DockerCaddy> {
        docker::detect()
    }

    /// Path the panel edits.
    ///
    /// When Caddy runs in Docker, the file that actually matters is the host
    /// side of its bind mount — `CADDYFILE_PATH` is only the fallback for
    /// hosts running the binary directly.
    pub fn effective_caddyfile_path(&self) -> String {
        self.detect_docker()
            .map(|d| d.host_config)
            .unwrap_or_else(|| self.caddyfile_path.clone())
    }

    pub fn status(&self) -> GatewayStatusSnapshot {
        if let Some(d) = self.detect_docker() {
            let version = docker::version(&d.container).unwrap_or_else(|| d.image.clone());
            return GatewayStatusSnapshot {
                installed: true,
                running: d.running,
                runtime: "docker".to_string(),
                container: Some(d.container.clone()),
                version,
                pid: None,
                bin_path: format!("docker:{}", d.container),
                caddyfile_path: d.host_config,
            };
        }

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
            runtime: if installed {
                "binary".to_string()
            } else {
                "none".to_string()
            },
            container: None,
            version,
            pid,
            bin_path: bin,
            caddyfile_path: self.caddyfile_path.clone(),
        }
    }

    pub fn install(&self) -> Result<String, AppError> {
        if let Some(d) = self.detect_docker() {
            return Err(AppError::bad_request(format!(
                "已检测到 Caddy 容器 `{}`，面板会自动接管它，无需安装",
                d.container
            )));
        }
        if which_caddy().is_some() {
            return Err(AppError::bad_request("接入网关已安装"));
        }

        // Prefer the container route on Linux: it keeps Caddy out of the host
        // package manager and matches the layout the panel already understands.
        if cfg!(target_os = "linux") && docker::available() {
            return docker::install_default().map_err(AppError::internal);
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
        if let Some(d) = self.detect_docker() {
            return docker::start(&d.container).map_err(AppError::internal);
        }

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
        if let Some(d) = self.detect_docker() {
            return docker::stop(&d.container).map_err(AppError::internal);
        }

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
        // `caddy reload` swaps config in place — no downtime, unlike restarting
        // the container, which is why docker mode uses exec rather than restart.
        if let Some(d) = self.detect_docker() {
            return docker::reload(&d.container, &d.container_config).map_err(AppError::internal);
        }

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

    /// Validate + format a Caddyfile with whichever Caddy is actually serving.
    /// Falls back to storing raw content when there is no Caddy to ask.
    pub async fn format_caddyfile(&self, raw: String) -> Result<String, AppError> {
        if let Some(d) = self.detect_docker() {
            return docker::fmt(&d.container, &raw).map_err(AppError::bad_request);
        }
        match self.cached_bin() {
            Some(bin) => fmt::fmt_caddyfile(&bin, raw).await,
            None => Ok(raw),
        }
    }
}

pub struct GatewayStatusSnapshot {
    pub installed: bool,
    pub running: bool,
    /// `docker` | `binary` | `none`.
    pub runtime: String,
    /// Container name when `runtime == "docker"`.
    pub container: Option<String>,
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
