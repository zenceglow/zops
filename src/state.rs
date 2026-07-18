use std::sync::Mutex;

use bollard::Docker;
use sysinfo::System;

pub const DEFAULT_USER: &str = "admin";
pub const DEFAULT_PASS: &str = "zenceglow";

pub struct AppState {
    pub sysinfo: Mutex<System>,
    pub docker: Option<Docker>,
    pub jwt_secret: String,
    pub caddyfile_path: String,
    /// Dynamically detected at each status check; updated after install
    pub caddy_bin: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let sys = System::new_all();
        let docker = Docker::connect_with_local_defaults().ok();
        let jwt_secret = uuid::Uuid::new_v4().to_string();

        let caddyfile_path = std::env::var("CADDYFILE_PATH")
            .unwrap_or_else(|_| "/etc/caddy/Caddyfile".into());

        let caddy_bin = Mutex::new(which_caddy());

        Ok(Self {
            sysinfo: Mutex::new(sys),
            docker,
            jwt_secret,
            caddyfile_path,
            caddy_bin,
        })
    }
}

pub fn which_caddy() -> Option<String> {
    let candidates = ["/usr/bin/caddy", "/usr/local/bin/caddy", "/opt/caddy/caddy"];
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
        .map(|s| s.to_string())
        .or_else(|| {
            std::process::Command::new("which")
                .arg("caddy")
                .output()
                .ok()
                .and_then(|o| {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() { None } else { Some(s) }
                })
        })
}

pub fn check_docker_available() -> bool {
    // check if docker binary exists and daemon responds
    let binary_found = std::process::Command::new("which")
        .arg("docker")
        .output()
        .ok()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    if !binary_found {
        return false;
    }

    std::process::Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .ok()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
