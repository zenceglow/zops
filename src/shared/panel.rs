//! 面板自身的身份：叫什么、哪个版本、起来多久了。
//!
//! 放一处是因为问这个问题的有两个地方：关于页（给人看）和 MCP 的
//! `ops_panel_info`（给 agent 看，用来确认连的是哪个面板、权限到哪一档）。
//! 两边各写一份迟早会不一致。

use std::sync::OnceLock;
use std::time::SystemTime;

pub const NAME: &str = "ZOPS";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GITHUB: &str = "https://github.com/zenceglow/zops";
pub const EMAIL: &str = "developer@zenceglow.com";

static STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

/// 进程起来的时候调一次。
pub fn mark_started() {
    let _ = STARTED_AT.set(SystemTime::now());
}

/// 已经跑了多少秒。没标记过就返回 0，不编一个数出来。
pub fn uptime_seconds() -> u64 {
    STARTED_AT
        .get()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── 身份指纹 ──
//
// 为什么要有这一段：面板可以装在很多台机器上，而 MCP 的地址长得都很像
// （`http://<ip>:<port>/api/ops/mcp`）。一旦客户端缓存了旧连接、或者两份 config
// 混在一起，agent 就会拿**另一台机器**的数据汇报"你这台机器怎么样" —— 这正是
// 踩过的坑：agent 报版本 0.2.9/8 个容器，而用户屏幕上的面板是 0.2.26/12 个服务。
//
// 所以身份要跟着数据走：hostname 说明是哪台机器，started_at 说明是不是同一个进程
// （升级/重启后必变），docker_id 说明连的是哪个 docker 守护进程。
static HOSTNAME: OnceLock<String> = OnceLock::new();
static MACHINE_ID: OnceLock<String> = OnceLock::new();
static DOCKER_ID: OnceLock<String> = OnceLock::new();

fn hostname() -> String {
    HOSTNAME
        .get_or_init(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "unknown".into())
        })
        .clone()
}

/// `/etc/machine-id` 的前 12 位。取前缀就够区分机器了，不必把整串抛出去。
fn machine_id() -> String {
    MACHINE_ID
        .get_or_init(|| {
            ["/etc/machine-id", "/var/lib/dbus/machine-id"]
                .iter()
                .find_map(|p| std::fs::read_to_string(p).ok())
                .map(|s| s.trim().chars().take(12).collect::<String>())
                .unwrap_or_default()
        })
        .clone()
}

/// Docker 守护进程的 ID。换了守护进程（重装/换机器）这个值就变 —— 容器名可以重名，
/// 守护进程 ID 不会。取不到就是空串，不编。
fn docker_id() -> String {
    DOCKER_ID
        .get_or_init(|| {
            std::process::Command::new("docker")
                .args(["info", "--format", "{{.ID}}"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .map(|s| s.chars().take(12).collect::<String>())
                .unwrap_or_default()
        })
        .clone()
}

/// 进程启动时刻（本地时间）。升级面板 = 重启进程 = 这个值必变。
fn started_at() -> String {
    STARTED_AT
        .get()
        .map(|t| {
            chrono::DateTime::<chrono::Local>::from(*t)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}

/// 这台面板的身份指纹。**每个 tools/call 的回包都会附上它**（见 mcp.rs）——
/// 数据自带出处，人和 agent 才可能对得上账。
pub fn identity() -> serde_json::Value {
    serde_json::json!({
        "version": VERSION,
        "hostname": hostname(),
        "machine_id": machine_id(),
        "docker_id": docker_id(),
        "started_at": started_at(),
        "port": std::env::var("OPS_PORT").unwrap_or_default(),
        "bin": std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 指纹至少要能回答"哪台机器、哪个版本、哪个进程" —— 空值等于没指纹。
    #[test]
    fn 身份指纹不为空() {
        mark_started();
        let id = identity();
        assert_eq!(id["version"], VERSION);
        assert!(!id["hostname"].as_str().unwrap_or_default().is_empty());
        assert!(!id["started_at"].as_str().unwrap_or_default().is_empty());
    }
}
