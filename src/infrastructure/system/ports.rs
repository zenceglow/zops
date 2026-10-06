//! 谁占了哪些端口。
//!
//! 部署一个服务最先要回答的就是"用哪个端口" —— 而这台机器上可能已经有十几个
//! 容器、几个数据库、一个面板，端口早被分光了。以前是靠人记、靠翻 compose 文件，
//! 记漏一个就是 `bind: address already in use`。

use std::collections::HashSet;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PortUsage {
    pub port: u16,
    /// 监听地址，`0.0.0.0` / `127.0.0.1` / `*`。只绑回环的端口对外不算暴露。
    pub address: String,
    /// 进程名，容器端口是 `docker-proxy`。
    pub process: String,
    pub pid: Option<i32>,
    /// 反查出来的容器名（docker 发布的端口能对上）。
    pub container: Option<String>,
}

/// 读当前监听的 TCP 端口。
///
/// Linux 走 `ss`（iproute2 基本都在，比 netstat 快且输出规整），
/// macOS 走 `lsof`。两个都没有就返回空 —— 调用方看到空列表要当成"不知道"，
/// 不能当成"没有占用"。
pub fn listeners() -> Vec<PortUsage> {
    let raw = if cfg!(target_os = "macos") {
        run("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"])
    } else {
        run("ss", &["-tlnpH"])
    };
    let mut rows = match raw {
        Some(text) => {
            if cfg!(target_os = "macos") {
                parse_lsof(&text)
            } else {
                parse_ss(&text)
            }
        }
        None => Vec::new(),
    };
    let publishers = container_ports();
    for row in rows.iter_mut() {
        row.container = publishers
            .iter()
            .find(|(p, _)| *p == row.port)
            .map(|(_, name)| name.clone());
    }
    rows.sort_by_key(|r| r.port);
    rows.dedup_by_key(|r| r.port);
    rows
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `docker ps` 里发布的宿主机端口 → 容器名。
fn container_ports() -> Vec<(u16, String)> {
    let Some(text) = run("docker", &["ps", "--format", "{{.Names}}\t{{.Ports}}"]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((name, ports)) = line.split_once('\t') else {
            continue;
        };
        // 形如 `0.0.0.0:3307->3306/tcp, [::]:3307->3306/tcp`，只取箭头左边的宿主端口。
        for part in ports.split(',') {
            let Some((host, _)) = part.split_once("->") else {
                continue;
            };
            let Some((_, port)) = host.trim().rsplit_once(':') else {
                continue;
            };
            if let Ok(p) = port.parse::<u16>() {
                out.push((p, name.trim().to_string()));
            }
        }
    }
    out
}

/// `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))`
fn parse_ss(text: &str) -> Vec<PortUsage> {
    let mut rows = Vec::new();
    // 命令是带 `-H` 调的（不打表头），所以不能无条件 `skip(1)`：没有表头时那一跳
    // 会把第一条真实监听的整行吃掉，表现就是"端口明明在监听，面板上却没有"。
    // 按内容判断更稳 —— 表头第一列是 `State`，数据行才是 `LISTEN`。
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[0] != "LISTEN" {
            continue;
        }
        // 本地地址在第 4 列；`*:80` 和 `[::]:80` 都见过。
        let local = cols[3];
        let Some(port) = port_of(local) else { continue };
        let (process, pid) = cols
            .last()
            .and_then(|c| c.split_once("(("))
            .map(|(_, rest)| {
                let name = rest.split('"').nth(1).unwrap_or("").to_string();
                let pid = rest
                    .split("pid=")
                    .nth(1)
                    .and_then(|s| s.split(',').next())
                    .and_then(|s| s.parse::<i32>().ok());
                (name, pid)
            })
            .unwrap_or_default();
        rows.push(PortUsage {
            port,
            address: address_of(local),
            process,
            pid,
            container: None,
        });
    }
    rows
}

/// `caddy 19530 hou 8u IPv6 0x… 0t0 TCP *:8099 (LISTEN)`
fn parse_lsof(text: &str) -> Vec<PortUsage> {
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 {
            continue;
        }
        let Some(port) = port_of(cols[8]) else { continue };
        rows.push(PortUsage {
            port,
            address: address_of(cols[8]),
            process: cols[0].to_string(),
            pid: cols[1].parse::<i32>().ok(),
            container: None,
        });
    }
    rows
}

fn port_of(addr: &str) -> Option<u16> {
    addr.rsplit(':').next()?.parse::<u16>().ok()
}

fn address_of(addr: &str) -> String {
    addr.rsplit_once(':')
        .map(|(host, _)| host.trim_matches(['[', ']']).to_string())
        .unwrap_or_default()
}

/// 挑几个空端口。
///
/// 判断标准是"真的能绑上"：`ss`/`lsof` 只列得出本进程看得见的监听，而端口还可能
/// 被别的用户、被内核保留、被防火墙规则占着。绑一下是最诚实的检验 —— 绑得上才算
/// 空着，绑完立刻放掉。
pub fn suggest_free(used: &HashSet<u16>, from: u16, to: u16, count: usize) -> Vec<u16> {
    let mut out = Vec::new();
    for port in from..=to {
        if out.len() >= count {
            break;
        }
        if used.contains(&port) || !bindable(port) {
            continue;
        }
        out.push(port);
    }
    out
}

fn bindable(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得_ss_的输出() {
        let text = "\
State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      128    0.0.0.0:22         0.0.0.0:*         users:((\"sshd\",pid=812,fd=3))
LISTEN 0      511    *:80               *:*               users:((\"caddy\",pid=1234,fd=8))
LISTEN 0      244    127.0.0.1:2019     0.0.0.0:*         users:((\"caddy\",pid=1234,fd=9))";
        let rows = parse_ss(text);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].port, 22);
        assert_eq!(rows[0].process, "sshd");
        assert_eq!(rows[0].pid, Some(812));
        assert_eq!(rows[1].port, 80);
        assert_eq!(rows[1].address, "*");
        assert_eq!(rows[2].address, "127.0.0.1");
    }

    #[test]
    fn 没表头的_ss_输出也不丢第一条() {
        // `ss -tlnpH` 是不带表头的。以前这里 `skip(1)` 会把第一条监听整行吃掉，
        // 表现就是某个端口（例如 redis 的 6379）明明在监听，却从列表里消失。
        let text = "\
LISTEN 0      244    127.0.0.1:6379     0.0.0.0:*         users:((\"redis-server\",pid=900,fd=6))
LISTEN 0      128    0.0.0.0:22         0.0.0.0:*         users:((\"sshd\",pid=812,fd=3))";
        let rows = parse_ss(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].port, 6379);
        assert_eq!(rows[0].process, "redis-server");
        assert_eq!(rows[1].port, 22);
    }

    #[test]
    fn 认得_lsof_的输出() {
        let text = "\
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
caddy   19530  hou    8u  IPv6 0x8f5b93f93e726f00      0t0  TCP *:8099 (LISTEN)
node    60804  hou   27u  IPv6 0x12ef2a54fa890cc4      0t0  TCP [::1]:5173 (LISTEN)";
        let rows = parse_lsof(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].port, 8099);
        assert_eq!(rows[0].process, "caddy");
        assert_eq!(rows[0].pid, Some(19530));
        assert_eq!(rows[1].port, 5173);
        assert_eq!(rows[1].address, "::1");
    }

    #[test]
    fn 空端口建议跳过已占用的() {
        let mut used = HashSet::new();
        used.insert(8000);
        used.insert(8001);
        let free = suggest_free(&used, 8000, 8010, 3);
        assert!(!free.contains(&8000));
        assert!(!free.contains(&8001));
        // 能绑上的才回来；具体是哪几个取决于这台机器，只要求数量与唯一。
        assert!(free.len() <= 3);
        let unique: HashSet<_> = free.iter().collect();
        assert_eq!(unique.len(), free.len());
    }
}
