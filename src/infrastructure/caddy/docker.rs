//! Docker-managed Caddy.
//!
//! Most of our hosts already run Caddy as a container that fronts every site,
//! mounted as `-v /opt/docker-apps/caddy/config:/etc/caddy`. The panel used to
//! only look for a *local* `caddy` binary, so on those hosts the gateway page
//! reported "未安装" and reload silently failed against a Caddy that was in fact
//! serving traffic. This module adopts the existing container instead.

use serde::Deserialize;
use std::process::{Command, Stdio};

/// Standard layout used when the panel has to create the gateway itself.
pub const DEFAULT_DIR: &str = "/opt/docker-apps/caddy";
pub const DEFAULT_IMAGE: &str = "caddy:2-alpine";

#[derive(Debug, Clone)]
pub struct DockerCaddy {
    pub container: String,
    pub image: String,
    pub running: bool,
    /// Host path of the Caddyfile — this is the file the panel edits.
    pub host_config: String,
    /// Path *inside* the container — what `caddy reload --config` wants.
    pub container_config: String,
}

#[derive(Deserialize)]
struct Mount {
    #[serde(rename = "Source")]
    source: String,
    #[serde(rename = "Destination")]
    destination: String,
}

fn run(args: &[&str]) -> Option<String> {
    let out = Command::new("docker").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Is the Docker daemon reachable at all?
pub fn available() -> bool {
    run(&["version", "--format", "{{.Server.Version}}"]).is_some()
}

/// Find the Caddy container fronting this host, if there is one.
pub fn detect() -> Option<DockerCaddy> {
    if !available() {
        return None;
    }
    let listing = run(&["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"])?;
    let mut candidates: Vec<(String, String)> = listing
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let name = parts.next()?.trim().to_string();
            let image = parts.next().unwrap_or("").trim().to_string();
            let ports = parts.next().unwrap_or("").trim();
            // 名字是「这就是网关」的强约定；只认镜像名会把拿 caddy 镜像当静态文件服务
            // 的应用容器也算进来（paober-web / paober-drive-oms-web 就是），那些容器
            // 的 443 只是 EXPOSE、并没有发布到宿主机 —— 面板一旦认错，站点配置就会被
            // 写到那个应用的 Caddyfile 上，访问日志也读错文件。
            let looks_like_caddy = name == "caddy"
                || name.starts_with("caddy-")
                || (image.starts_with("caddy") && publishes_web_port(ports));
            looks_like_caddy.then_some((name, image))
        })
        .collect();
    // A container literally named `caddy` is the convention; keep it first.
    candidates.sort_by_key(|(name, _)| if name == "caddy" { 0 } else { 1 });

    candidates
        .into_iter()
        .find_map(|(name, image)| inspect(&name, &image))
}

/// 容器的宿主机端口里有没有 80 / 443。
///
/// 只看镜像名不看端口是不够的：`docker ps` 里的 Ports 是
/// `443/tcp, 2019/tcp, 443/udp, 127.0.0.1:8085->80/tcp` 这种，箭头左边才是宿主机端口。
/// 应用容器发布的 8085 不代表它在当网关。
fn publishes_web_port(ports: &str) -> bool {
    ports.split(',').any(|mapping| {
        let Some((host_side, _)) = mapping.trim().split_once("->") else {
            return false;
        };
        let host_side = host_side.trim();
        let port = host_side.rsplit(':').next().unwrap_or(host_side).trim();
        matches!(port, "80" | "443")
    })
}

fn inspect(name: &str, image: &str) -> Option<DockerCaddy> {
    let raw = run(&["inspect", name, "--format", "{{json .Mounts}}"])?;
    let mounts: Vec<Mount> = serde_json::from_str(&raw).ok()?;
    // Prefer the exact Caddyfile bind, then a directory bind at /etc/caddy.
    let mount = mounts
        .iter()
        .find(|m| m.destination == "/etc/caddy/Caddyfile")
        .or_else(|| mounts.iter().find(|m| m.destination == "/etc/caddy"))?;

    let join_caddyfile = |p: &str| {
        if p.ends_with("Caddyfile") {
            p.to_string()
        } else {
            format!("{}/Caddyfile", p.trim_end_matches('/'))
        }
    };

    let running = run(&["inspect", name, "--format", "{{.State.Running}}"])
        .map(|s| s == "true")
        .unwrap_or(false);

    Some(DockerCaddy {
        container: name.to_string(),
        image: image.to_string(),
        running,
        host_config: join_caddyfile(&mount.source),
        container_config: join_caddyfile(&mount.destination),
    })
}

pub fn version(container: &str) -> Option<String> {
    run(&["exec", container, "caddy", "version"]).map(|s| {
        // `caddy version` prints e.g. "v2.11.0 h1:..." — keep the version only.
        s.lines().next().unwrap_or("").trim().to_string()
    })
}

fn exec(args: &[&str]) -> Result<String, String> {
    let out = Command::new("docker")
        .args(args)
        .output()
        .map_err(|e| format!("执行 docker 失败: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("docker {:?} 失败", args)
        } else {
            err
        })
    }
}

pub fn start(container: &str) -> Result<(), String> {
    exec(&["start", container]).map(|_| ())
}

pub fn stop(container: &str) -> Result<(), String> {
    exec(&["stop", container]).map(|_| ())
}

/// `caddy reload` re-reads the config in place — no downtime, which is why we
/// prefer it over restarting the container.
pub fn reload(container: &str, container_config: &str) -> Result<(), String> {
    exec(&[
        "exec",
        container,
        "caddy",
        "reload",
        "--config",
        container_config,
    ])
    .map(|_| ())
}

/// Validate + format a Caddyfile using the container's own binary, so the
/// syntax check matches the exact version that will serve it.
pub fn fmt(container: &str, raw: &str) -> Result<String, String> {
    use std::io::Write;

    let mut child = Command::new("docker")
        // 同上：`--parser` 不存在，stdin 需要显式用 `-` 当路径。
        .args(["exec", "-i", container, "caddy", "fmt", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("docker exec 启动失败: {e}"))?;

    {
        let stdin = child.stdin.as_mut().ok_or("无法写入 caddy fmt stdin")?;
        stdin
            .write_all(raw.as_bytes())
            .map_err(|e| format!("写入 stdin 失败: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("caddy fmt 执行失败: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Caddyfile 语法错误".into()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 让容器里的 Caddy 校验一份配置。
///
/// 和 `fmt` 一样走 stdin：容器里的路径和宿主机不一样，写临时文件还得先
/// `docker cp` 进去，多一步就多一个出错的地方。`--adapter caddyfile` 不能少，
/// 否则它会把输入当 JSON 解析，报一句让人误会的 "not valid JSON"。
pub fn validate(container: &str, raw: &str) -> Result<(), String> {
    use std::io::Write;

    let mut child = Command::new("docker")
        .args([
            "exec",
            "-i",
            container,
            "caddy",
            "validate",
            "--config",
            "-",
            "--adapter",
            "caddyfile",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("docker exec 启动失败: {e}"))?;

    {
        let stdin = child.stdin.as_mut().ok_or("无法写入 caddy validate stdin")?;
        stdin
            .write_all(raw.as_bytes())
            .map_err(|e| format!("写入 stdin 失败: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("caddy validate 执行失败: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let msg = stderr
        .lines()
        .rev()
        .find_map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).ok()?;
            (v.get("level")?.as_str()? == "error").then(|| v.get("msg")?.as_str().map(String::from))?
        })
        .unwrap_or_else(|| stderr.trim().to_string());
    Err(if msg.is_empty() {
        "Caddyfile 校验不通过".into()
    } else {
        msg
    })
}

/// Create the standard layout + container. Only used when nothing is fronting
/// the host yet; requires 80/443 to be free.
pub fn install_default() -> Result<String, String> {
    if !available() {
        return Err("未检测到 Docker，无法自动安装网关".into());
    }
    if detect().is_some() {
        return Ok("已存在 Caddy 容器，无需安装".into());
    }

    let config_dir = format!("{DEFAULT_DIR}/config");
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("创建 {config_dir} 失败: {e}"))?;
    for sub in ["data", "logs"] {
        std::fs::create_dir_all(format!("{DEFAULT_DIR}/{sub}"))
            .map_err(|e| format!("创建 {DEFAULT_DIR}/{sub} 失败: {e}"))?;
    }

    let caddyfile = format!("{config_dir}/Caddyfile");
    if !std::path::Path::new(&caddyfile).exists() {
        std::fs::write(
            &caddyfile,
            "# 由 Zenceglow Ops 创建\n{\n\tadmin 0.0.0.0:2019\n}\n",
        )
        .map_err(|e| format!("写入 {caddyfile} 失败: {e}"))?;
    }

    exec(&[
        "run",
        "-d",
        "--name",
        "caddy",
        "--restart",
        "unless-stopped",
        "-p",
        "80:80",
        "-p",
        "443:443",
        "-p",
        "2019:2019",
        "-v",
        &format!("{DEFAULT_DIR}/config:/etc/caddy"),
        "-v",
        &format!("{DEFAULT_DIR}/data:/data"),
        "-v",
        &format!("{DEFAULT_DIR}/logs:/var/log/caddy"),
        DEFAULT_IMAGE,
    ])?;

    Ok(format!("已启动 {DEFAULT_IMAGE}，配置目录 {DEFAULT_DIR}/config"))
}

#[cfg(test)]
mod tests {
    use super::publishes_web_port;

    #[test]
    fn published_web_ports_are_recognised() {
        assert!(publishes_web_port("0.0.0.0:80->80/tcp, :::80->80/tcp"));
        assert!(publishes_web_port("0.0.0.0:443->443/tcp"));
        assert!(publishes_web_port("127.0.0.1:80->8080/tcp"));
        assert!(publishes_web_port("80->80/tcp"));
    }

    #[test]
    fn app_containers_serving_static_files_are_not_gateways() {
        // paober-web / paober-drive-oms-web 的真实端口串：443 只是 EXPOSE，
        // 发布到宿主机的只有 8085 / 8086。
        assert!(!publishes_web_port(
            "443/tcp, 2019/tcp, 443/udp, 127.0.0.1:8085->80/tcp"
        ));
        assert!(!publishes_web_port("127.0.0.1:8086->80/tcp"));
        assert!(!publishes_web_port("127.0.0.1:8087->80/tcp"));
        // 前缀相同但不是 80/443 的宿主端口不能误判。
        assert!(!publishes_web_port("0.0.0.0:8080->80/tcp"));
        assert!(!publishes_web_port("0.0.0.0:4430->4430/tcp"));
        assert!(!publishes_web_port(""));
    }
}
