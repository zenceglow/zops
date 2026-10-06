//! 本机 DNS。
//!
//! systemd-resolved 把 `/etc/resolv.conf` 做成指向 stub 的符号链接。直接覆盖
//! 那个链接，下次 resolved 一起来又盖回去，而且会把"谁在管 DNS"这件事弄丢。
//! 链接就用 `resolvectl`，普通文件才改文件本身。

use std::path::Path;

const RESOLV: &str = "/etc/resolv.conf";

#[derive(Debug, Clone, serde::Serialize)]
pub struct DnsStatus {
    pub nameservers: Vec<String>,
    /// `resolvectl`：符号链接，由 systemd-resolved 托管。`file`：普通文件。
    pub source: String,
    pub path: String,
    pub writable: bool,
}

pub fn status() -> DnsStatus {
    let managed = is_resolved_symlink(Path::new(RESOLV));
    let nameservers = read_nameservers(Path::new(RESOLV));
    DnsStatus {
        nameservers,
        source: if managed { "resolvectl" } else { "file" }.into(),
        path: RESOLV.into(),
        writable: true,
    }
}

pub fn apply(nameservers: &[String]) -> Result<String, String> {
    let clean = clean_servers(nameservers)?;
    if is_resolved_symlink(Path::new(RESOLV)) {
        apply_resolvectl(&clean)?;
        Ok("resolvectl".into())
    } else {
        write_resolv(&clean)?;
        Ok("file".into())
    }
}

pub fn parse_nameservers(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let t = l.trim();
            let rest = t.strip_prefix("nameserver")?;
            let ip = rest.split_whitespace().next()?.trim();
            if ip.is_empty() { None } else { Some(ip.to_string()) }
        })
        .collect()
}

fn read_nameservers(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|t| parse_nameservers(&t))
        .unwrap_or_default()
}

fn is_resolved_symlink(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.file_type().is_symlink() {
        return false;
    }
    let target = std::fs::read_link(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    target.contains("systemd") || target.contains("resolvconf")
}

fn clean_servers(nameservers: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in nameservers {
        let s = raw.trim();
        if s.is_empty() {
            continue;
        }
        if s.split_whitespace().count() != 1 || s.contains('/') || s.contains(';') {
            return Err(format!("不是合法的 DNS 地址：{s}"));
        }
        if s.parse::<std::net::IpAddr>().is_err() {
            return Err(format!("不是合法的 DNS 地址：{s}"));
        }
        if !out.iter().any(|x: &String| x == s) {
            out.push(s.to_string());
        }
    }
    if out.is_empty() {
        return Err("至少填一个 DNS".into());
    }
    if out.len() > 4 {
        return Err("最多 4 个 DNS".into());
    }
    Ok(out)
}

fn default_iface() -> Result<String, String> {
    let out = std::process::Command::new("ip")
        .args(["route", "show", "default"])
        .output()
        .map_err(|e| format!("读默认路由失败：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        while let Some(p) = parts.next() {
            if p == "dev" {
                if let Some(dev) = parts.next() {
                    return Ok(dev.to_string());
                }
            }
        }
    }
    Err("找不到默认网卡，没法用 resolvectl 改 DNS".into())
}

fn apply_resolvectl(servers: &[String]) -> Result<(), String> {
    let iface = default_iface()?;
    let mut args = vec!["dns".to_string(), iface.clone()];
    args.extend(servers.iter().cloned());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = std::process::Command::new("resolvectl")
        .args(&arg_refs)
        .output()
        .map_err(|e| format!("resolvectl 不可用：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "resolvectl dns 失败".into()
        } else {
            err
        });
    }
    // 链路级设置重启会丢。再写一份 drop-in，resolved 自己会读。
    let dir = Path::new("/etc/systemd/resolved.conf.d");
    if std::fs::create_dir_all(dir).is_ok() {
        let body = format!("[Resolve]\nDNS={}\n", servers.join(" "));
        let _ = std::fs::write(dir.join("zops-dns.conf"), body);
    }
    Ok(())
}

fn write_resolv(servers: &[String]) -> Result<(), String> {
    let path = Path::new(RESOLV);
    let old = std::fs::read_to_string(path).unwrap_or_default();
    let mut kept: Vec<String> = old
        .lines()
        .filter(|l| !l.trim_start().starts_with("nameserver"))
        .map(|l| l.to_string())
        .collect();
    for s in servers {
        kept.push(format!("nameserver {s}"));
    }
    if !kept.iter().any(|l| l.starts_with('#')) {
        kept.insert(0, "# written by ZOPS".into());
    }
    std::fs::write(path, kept.join("\n") + "\n").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只认nameserver行() {
        let got = parse_nameservers("# comment\nnameserver 1.1.1.1\nsearch example\nnameserver 8.8.8.8\n");
        assert_eq!(got, vec!["1.1.1.1", "8.8.8.8"]);
    }

    #[test]
    fn 拒绝带空格的地址() {
        assert!(clean_servers(&["1.1.1.1; rm".into()]).is_err());
        assert!(clean_servers(&["not-an-ip".into()]).is_err());
    }
}
