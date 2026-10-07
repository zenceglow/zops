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
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })
        })
}

pub fn version(bin: &str) -> String {
    std::process::Command::new(bin)
        .arg("version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default()
}

pub fn pid() -> Option<i32> {
    pids().into_iter().next()
}

/// 宿主机上的 caddy 进程；跑在容器里的不算。
///
/// 宿主机的 PID 命名空间能看到容器里的进程，所以 `pgrep -x caddy` 会把
/// `paober-web` 这种"用 caddy 镜像做静态文件服务"的容器也算进来。它们是应用的
/// 一部分，不是这台机器的网关 —— 认错了，界面上的「网关 pid」会指向别的容器，
/// 「正在使用的配置路径」也会变成那个容器的 Caddyfile。
///
/// 判断依据是 cgroup：容器进程在宿主这边看是 `.../docker-<id>.scope`。
/// 读不到 cgroup（非 Linux）时不作过滤，退回老行为。
pub fn pids() -> Vec<i32> {
    let out = match std::process::Command::new("pgrep").arg("-x").arg("caddy").output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    let all: Vec<i32> = raw
        .lines()
        .filter_map(|l| l.trim().parse::<i32>().ok())
        .collect();
    all.into_iter().filter(|p| !in_container(*p)).collect()
}

fn in_container(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/cgroup")) {
        Ok(s) => {
            s.contains("docker-") || s.contains("/docker/") || s.contains("containerd")
        }
        // 读不到就当成"不在容器里"，宁可保留旧行为也不要凭空少认一个进程。
        Err(_) => false,
    }
}

/// 正在跑的那个 Caddy 实际加载的是哪份 Caddyfile。
///
/// 宿主机模式下 Caddy 由 systemd（或手工）拉起，`--config` 是启动命令决定的，
/// 未必等于面板自己的 `CADDYFILE_PATH` 环境变量 —— 把网关从容器迁到宿主机时，
/// 这两者一定不一致。与其要求用户去改 systemd 单元，不如直接问进程要。
///
/// 读不到（macOS 没有 /proc、进程不是二进制方式跑的）就返回 None，调用方退回
/// 原来的配置路径。
pub fn running_config_path() -> Option<String> {
    let pid = pid()?;
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args: Vec<String> = raw
        .split(|b| *b == 0)
        .map(|s| String::from_utf8_lossy(s).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let i = args.iter().position(|a| a == "--config")?;
    args.get(i + 1).cloned()
}
