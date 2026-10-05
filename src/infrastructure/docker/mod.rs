pub mod client;

pub use client::{DockerClient, JunkSummary, PruneRequest, PruneResult};

/// 正在运行的容器名。
///
/// 同步的一条 `docker ps`。部署那边要拿目录名去对"这个服务是不是在跑"，
/// 走异步客户端反而绕远了。
pub fn running_names() -> Vec<String> {
    let Ok(out) = std::process::Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
