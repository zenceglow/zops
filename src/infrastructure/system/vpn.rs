//! WireGuard：看状态、导入一份配置、启停。
//!
//! 不在这里装软件包。机器上没有 `wg` 就如实说，不假装隧道已经起来了。

use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct WgStatus {
    pub installed: bool,
    pub interfaces: Vec<WgIface>,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WgIface {
    pub name: String,
    pub public_key: String,
    pub listen_port: String,
    pub peers: usize,
}

pub fn status() -> WgStatus {
    if !command_ok("wg", &["show"]) && !which("wg") {
        return WgStatus {
            installed: false,
            interfaces: vec![],
            message: "这台机器没有安装 WireGuard（找不到 wg）".into(),
        };
    }
    let out = Command::new("wg").arg("show").output();
    let Ok(out) = out else {
        return WgStatus {
            installed: true,
            interfaces: vec![],
            message: "wg 存在，但执行失败".into(),
        };
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    WgStatus {
        installed: true,
        interfaces: parse_show(&text),
        message: String::new(),
    }
}

pub fn import(name: &str, config: &str) -> Result<String, String> {
    let name = clean_name(name)?;
    let body = config.trim();
    if !body.contains("[Interface]") {
        return Err("配置里要有 [Interface]".into());
    }
    if body.len() > 64 * 1024 {
        return Err("配置太长".into());
    }
    let dir = PathBuf::from("/etc/wireguard");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    let path = dir.join(format!("{name}.conf"));
    std::fs::write(&path, body.to_string() + "\n").map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path.display().to_string())
}

pub fn up(name: &str) -> Result<(), String> {
    let name = clean_name(name)?;
    let path = PathBuf::from(format!("/etc/wireguard/{name}.conf"));
    if !path.exists() {
        return Err(format!("没有 {}", path.display()));
    }
    run("wg-quick", &["up", &name])
}

pub fn down(name: &str) -> Result<(), String> {
    let name = clean_name(name)?;
    run("wg-quick", &["down", &name])
}

pub fn parse_show(text: &str) -> Vec<WgIface> {
    let mut out = Vec::new();
    let mut cur: Option<WgIface> = None;
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("interface:") {
            if let Some(prev) = cur.take() {
                out.push(prev);
            }
            cur = Some(WgIface {
                name: name.trim().to_string(),
                public_key: String::new(),
                listen_port: String::new(),
                peers: 0,
            });
            continue;
        }
        let Some(iface) = cur.as_mut() else { continue };
        let t = line.trim();
        if let Some(v) = t.strip_prefix("public key:") {
            iface.public_key = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("listening port:") {
            iface.listen_port = v.trim().to_string();
        } else if t.starts_with("peer:") {
            iface.peers += 1;
        }
    }
    if let Some(prev) = cur {
        out.push(prev);
    }
    out
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err("接口名只能用字母、数字、下划线和连字符".into());
    }
    Ok(name.to_string())
}

fn which(bin: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {bin}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn command_ok(bin: &str, args: &[&str]) -> bool {
    Command::new(bin)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run(bin: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("{bin} 不可用：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if !err.is_empty() { err } else { stdout })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 能拆出接口和peer数() {
        let text = "\
interface: wg0
  public key: abc=
  listening port: 51820

peer: def=
  endpoint: 1.2.3.4:51820

peer: ghi=
  endpoint: 5.6.7.8:51820
";
        let ifaces = parse_show(text);
        assert_eq!(ifaces.len(), 1);
        assert_eq!(ifaces[0].name, "wg0");
        assert_eq!(ifaces[0].listen_port, "51820");
        assert_eq!(ifaces[0].peers, 2);
    }

    #[test]
    fn 接口名不接受路径() {
        assert!(clean_name("../etc").is_err());
        assert!(clean_name("wg0").is_ok());
    }
}
