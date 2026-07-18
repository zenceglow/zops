use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::Serialize;

use crate::state::{which_caddy, AppState};

type ApiError = (StatusCode, &'static str);

#[derive(Serialize)]
pub struct GatewayStatus {
    pub installed: bool,
    pub running: bool,
    pub version: String,
    pub pid: Option<i32>,
    pub bin_path: String,
    pub caddyfile_path: String,
}

async fn status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GatewayStatus>, ApiError> {
    // dynamically detect caddy binary every time
    let bin = which_caddy().unwrap_or_default();
    let installed = !bin.is_empty();

    let version = if installed {
        let out = std::process::Command::new(&bin)
            .arg("version")
            .output()
            .ok();
        out.and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default()
    } else {
        String::new()
    };

    let pid = std::process::Command::new("pgrep")
        .arg("-x")
        .arg("caddy")
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            s.lines().next().and_then(|l| l.parse::<i32>().ok())
        });

    Ok(Json(GatewayStatus {
        installed,
        running: pid.is_some(),
        version,
        pid,
        bin_path: bin,
        caddyfile_path: state.caddyfile_path.clone(),
    }))
}

async fn install(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // dynamically check — don't use cached state
    if which_caddy().is_some() {
        return Err((StatusCode::BAD_REQUEST, "接入网关已安装".to_string()));
    }

    let result = if cfg!(target_os = "macos") {
        let output = std::process::Command::new("brew")
            .args(["install", "caddy"])
            .output()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("无法执行 brew: {e}")))?;
        if output.status.success() {
            Ok("安装成功".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err((StatusCode::INTERNAL_SERVER_ERROR, format!("安装失败: {stderr}")))
        }
    } else if cfg!(target_os = "linux") {
        let status = std::process::Command::new("sh")
            .args(["-c", "curl -fsSL https://getcaddy.com | bash"])
            .status()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("无法执行安装脚本: {e}")))?;
        if status.success() {
            Ok("安装成功".to_string())
        } else {
            Err((StatusCode::INTERNAL_SERVER_ERROR, "安装失败，请手动安装 Caddy: https://caddyserver.com/docs/install".to_string()))
        }
    } else {
        Err((StatusCode::BAD_REQUEST, "不支持的操作系统，请手动安装 Caddy: https://caddyserver.com/docs/install".to_string()))
    }?;

    // update cached binary path after install
    *state.caddy_bin.lock().unwrap() = which_caddy();

    Ok(Json(serde_json::json!({"ok": true, "message": result})))
}

async fn caddy_start(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bin = state.caddy_bin.lock().unwrap().clone().ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "接入网关未安装".to_string())
    })?;

    let result = systemctl("start", "caddy")
        .or_else(|_| {
            std::process::Command::new(&bin)
                .arg("run")
                .arg("--config")
                .arg(&state.caddyfile_path)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        });

    match result {
        Ok(()) => Ok(Json(serde_json::json!({"ok": true}))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

async fn caddy_stop(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = systemctl("stop", "caddy")
        .or_else(|_| {
            std::process::Command::new("pkill")
                .arg("-x")
                .arg("caddy")
                .status()
                .map(|_| ())
                .map_err(|e| e.to_string())
        });

    match result {
        Ok(()) => Ok(Json(serde_json::json!({"ok": true}))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

async fn caddy_reload(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let bin = state.caddy_bin.lock().unwrap().clone().ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "接入网关未安装".to_string())
    })?;

    let result = std::process::Command::new(&bin)
        .arg("reload")
        .arg("--config")
        .arg(&state.caddyfile_path)
        .output()
        .map_err(|e| e.to_string())
        .and_then(|o| {
            if o.status.success() {
                Ok(())
            } else {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Err(msg)
            }
        })
        .or_else(|_| systemctl("restart", "caddy"));

    match result {
        Ok(()) => Ok(Json(serde_json::json!({"ok": true}))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

fn systemctl(action: &str, service: &str) -> Result<(), String> {
    let status = std::process::Command::new("systemctl")
        .arg(action)
        .arg(service)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("systemctl {action} {service} failed"))
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/install", axum::routing::post(install))
        .route("/start", axum::routing::post(caddy_start))
        .route("/stop", axum::routing::post(caddy_stop))
        .route("/reload", axum::routing::post(caddy_reload))
}
