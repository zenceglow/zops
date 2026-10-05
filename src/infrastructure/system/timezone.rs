//! 服务器时区。
//!
//! Linux 上有两套写法：systemd 的系统用 `timedatectl`，容器或精简发行版里往往没有
//! systemd，那就退回老办法 —— 写 `/etc/timezone` 再把 `/etc/localtime` 指到
//! `/usr/share/zoneinfo/<zone>`。两条路都试，谁成算谁。

use std::process::Command;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct TimezoneInfo {
    pub current: String,
    pub supported: bool,
    /// 常用时区，够一个人选出来；真要冷门的，可以直接填名字。
    pub common: Vec<String>,
    pub message: String,
}

const COMMON: &[&str] = &[
    "UTC",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Asia/Dubai",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Moscow",
    "America/New_York",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "Australia/Sydney",
];

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 当前时区。先问 systemd，再读 `/etc/timezone`，最后看 `/etc/localtime` 指向哪。
fn detect() -> Option<String> {
    if let Some(tz) = run("timedatectl", &["show", "-p", "Timezone", "--value"]) {
        if !tz.is_empty() {
            return Some(tz);
        }
    }
    if let Ok(text) = std::fs::read_to_string("/etc/timezone") {
        let tz = text.trim();
        if !tz.is_empty() {
            return Some(tz.to_string());
        }
    }
    let link = std::fs::read_link("/etc/localtime").ok()?;
    let s = link.to_string_lossy().to_string();
    s.split("zoneinfo/").nth(1).map(|t| t.to_string())
}

pub fn info() -> TimezoneInfo {
    let current = detect().unwrap_or_default();
    let supported = !current.is_empty() || std::path::Path::new("/usr/share/zoneinfo").exists();
    TimezoneInfo {
        current: if current.is_empty() { "未知".into() } else { current },
        supported,
        common: COMMON.iter().map(|s| s.to_string()).collect(),
        message: if supported {
            String::new()
        } else {
            "这台主机没有时区数据库（/usr/share/zoneinfo），无法设置".into()
        },
    }
}

/// 设置时区。返回真正生效的那条路径，便于出错时判断。
pub fn set(zone: &str) -> Result<String, String> {
    let zone = zone.trim();
    if zone.is_empty() {
        return Err("时区名不能为空".into());
    }
    // 先校验名字：`../` 之类的东西不能拼进 zoneinfo 的路径里。
    let src = std::path::Path::new("/usr/share/zoneinfo").join(zone);
    if !src.is_file() || zone.contains("..") {
        return Err(format!("没有这个时区：{zone}"));
    }

    if run("timedatectl", &["set-timezone", zone]).is_some() {
        return Ok("timedatectl".into());
    }

    // systemd 不在（容器里很常见）：直接改文件。
    std::fs::write("/etc/timezone", format!("{zone}\n"))
        .map_err(|e| format!("写 /etc/timezone 失败：{e}"))?;
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file("/etc/localtime");
        std::os::unix::fs::symlink(&src, "/etc/localtime")
            .map_err(|e| format!("链接 /etc/localtime 失败：{e}"))?;
    }
    Ok("files".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 拒绝路径穿越式的时区名() {
        assert!(set("../etc/passwd").is_err());
        assert!(set("").is_err());
        assert!(set("Not/AZone").is_err());
    }

    #[test]
    fn 常用列表里有时区且不重复() {
        let list = COMMON.to_vec();
        assert!(list.contains(&"Asia/Shanghai"));
        let mut sorted = list.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), list.len(), "常用时区有重复项");
    }
}
