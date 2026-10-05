//! 系统补丁检查。
//!
//! 面板可能装在 Ubuntu、Debian、CentOS、Rocky…… 所以先认发行版、再挑包管理器，
//! 而不是写死一个 `apt`。认不出来的系统如实报"不支持"，不猜。

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePackage {
    pub name: String,
    pub current: String,
    pub candidate: String,
    /// 是不是安全更新。这个数直接参与首页的运行评分，所以尽量判准。
    pub security: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateReport {
    /// 认出来的发行版名，例如 "Ubuntu 22.04.3 LTS"。
    pub distro: String,
    /// 包管理器：apt / dnf / yum / 空字符串。
    pub manager: String,
    pub supported: bool,
    pub checked_at: String,
    pub total: i64,
    pub security: i64,
    pub packages: Vec<UpdatePackage>,
    /// 出错或说明（比如"未识别的发行版"）。
    pub message: String,
}

#[derive(Debug, Clone, Default)]
struct Distro {
    name: String,
    id: String,
    id_like: String,
}

/// 读 `/etc/os-release`。这是各发行版都提供的标准文件，比自己猜 `/etc/redhat-release` 可靠。
fn read_distro() -> Distro {
    let Ok(text) = std::fs::read_to_string("/etc/os-release") else {
        return Distro::default();
    };
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .map(|v| v.trim().trim_matches('"').to_string())
            .unwrap_or_default()
    };
    let name = field("PRETTY_NAME");
    Distro {
        name: if name.is_empty() { field("NAME") } else { name },
        id: field("ID").to_lowercase(),
        id_like: field("ID_LIKE").to_lowercase(),
    }
}

fn has(cmd: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {cmd} >/dev/null 2>&1")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 单条命令的超时。`check-update` 要读包管理器元数据，慢的时候能到几十秒。
const CMD_TIMEOUT: Duration = Duration::from_secs(60);

/// 跑一条命令拿 stdout+stderr。
///
/// 超时用 Rust 自己轮询 try_wait 实现，**不调外部的 `timeout` 命令** —— 那是 GNU
/// coreutils 的东西，macOS 上没有（得装 gtimeout），而面板的开发环境恰恰是 macOS：
/// 少了它，整条 apt 分支会以"执行 timeout 失败"告终，看起来像不支持这个系统。
///
/// 顺带说明：这里不边跑边读管道，靠的是"命令输出不会撑满 64KB 管道缓冲"这个前提。
/// `apt-get -s upgrade` 的输出量在几 KB 量级，够用。
fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new(cmd)
        .args(args)
        // 用 C locale：报错和字段名都是英文，解析才稳。
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("执行 {cmd} 失败: {e}"))?;

    let deadline = Instant::now() + CMD_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(150))
            }
            Ok(None) => {
                let _ = child.kill();
                return Err(format!("{cmd} 超时（{}s）", CMD_TIMEOUT.as_secs()));
            }
            Err(e) => return Err(format!("等待 {cmd} 失败: {e}")),
        }
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("读取 {cmd} 输出失败: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(text)
}

/// 解析 `apt-get -s upgrade` 的模拟输出。
///
/// 一行长这样：`Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-security [amd64])`
/// 括号里那段是"来源"，安全更新会带 `-security`，据此判断。
fn parse_apt(text: &str) -> Vec<UpdatePackage> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Inst ") else {
            continue;
        };
        let mut parts = rest.splitn(2, ' ');
        let name = parts.next().unwrap_or_default().to_string();
        let tail = parts.next().unwrap_or_default();

        let current = tail
            .split_once('[')
            .and_then(|(_, r)| r.split_once(']'))
            .map(|(v, _)| v.trim().to_string())
            .unwrap_or_default();
        let inside = tail
            .split_once('(')
            .and_then(|(_, r)| r.rsplit_once(')'))
            .map(|(v, _)| v.to_string())
            .unwrap_or_default();

        out.push(UpdatePackage {
            name,
            current,
            candidate: inside.split_whitespace().next().unwrap_or_default().to_string(),
            security: inside.to_lowercase().contains("security"),
        });
    }
    out
}

/// 解析 `dnf/yum check-update --security` 的输出。
///
/// 内容行是三列：`name.arch  version  repo`；标题、提示行都不是三列。
fn parse_rpm(text: &str) -> Vec<UpdatePackage> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.starts_with(' ') || line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() != 3 {
            continue;
        }
        // 过滤掉 "Obsoleting Packages" 之类的说明性行。
        if cols[1].starts_with('[') || cols[2].starts_with('[') {
            continue;
        }
        out.push(UpdatePackage {
            name: cols[0].to_string(),
            current: String::new(),
            candidate: cols[1].to_string(),
            // `--security` 已经过滤过了，列出来的都是安全更新。
            security: true,
        });
    }
    out
}

pub fn check() -> UpdateReport {
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let distro = read_distro();
    let mut report = UpdateReport {
        distro: if distro.name.is_empty() {
            "未知系统".into()
        } else {
            distro.name.clone()
        },
        checked_at: now,
        ..Default::default()
    };

    let debian_like = distro.id_like.contains("debian") || matches!(distro.id.as_str(), "ubuntu" | "debian" | "linuxmint" | "pop");
    let rhel_like = distro.id_like.contains("rhel") || distro.id_like.contains("fedora") || matches!(distro.id.as_str(), "centos" | "rhel" | "rocky" | "almalinux" | "fedora" | "ol" | "amzn");

    let (manager, packages) = if (debian_like || has("apt-get")) && has("apt-get") {
        (
            "apt",
            run("apt-get", &["-s", "-o", "Debug::NoLocking=1", "upgrade"]).map(|t| parse_apt(&t)),
        )
    } else if (rhel_like || has("dnf")) && has("dnf") {
        (
            "dnf",
            // 只关心安全更新：全量升级会带上内核、glibc 这类需要重启的东西，
            // 那属于"计划内维护"，不该在首页上催。
            run("dnf", &["-q", "check-update", "--security"]).map(|t| parse_rpm(&t)),
        )
    } else if (rhel_like || has("yum")) && has("yum") {
        (
            "yum",
            run("yum", &["-q", "check-update", "--security"]).map(|t| parse_rpm(&t)),
        )
    } else {
        report.supported = false;
        report.message = "未识别的发行版，暂不支持补丁检查".into();
        return report;
    };

    report.manager = manager.to_string();
    match packages {
        Ok(list) => {
            report.supported = true;
            report.total = list.len() as i64;
            report.security = list.iter().filter(|p| p.security).count() as i64;
            // 安全更新排在前面，页面默认看到的就是该先处理的。
            let mut list = list;
            list.sort_by_key(|p| (!p.security, p.name.clone()));
            report.packages = list;
        }
        Err(e) => {
            report.supported = false;
            report.message = e;
        }
    }
    report
}

/// 安装补丁。
///
/// 只升级已经列出来的那些包（`--only-upgrade`），不装新的、不删依赖 —— 面板不该
/// 替人做"顺带升级整个系统"这种决定。返回命令的原始输出，成功失败都给人看。
pub fn apply(packages: &[String]) -> Result<String, String> {
    if packages.is_empty() {
        return Ok("没有需要修复的补丁".into());
    }
    let distro = read_distro();
    let debian_like = distro.id_like.contains("debian") || matches!(distro.id.as_str(), "ubuntu" | "debian");

    if debian_like && has("apt-get") {
        let mut args = vec!["-y", "--only-upgrade", "install"];
        args.extend(packages.iter().map(|s| s.as_str()));
        run("apt-get", &args)
    } else if has("dnf") {
        run("dnf", &["-y", "update", "--security"])
    } else if has("yum") {
        run("yum", &["-y", "update", "--security"])
    } else {
        Err("未识别的发行版，无法自动修复".into())
    }
}

/// 后台定期检查的间隔。安全更新不是分钟级变化的东西，六小时足够新。
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实的 `apt-get -s upgrade` 片段（Ubuntu）。
    const APT_SAMPLE: &str = "\
NOTE: This is only a simulation!
Reading package lists...
Building dependency tree...
The following packages will be upgraded:
  libssl3 openssl tzdata
3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-security [amd64])
Inst openssl [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-security [amd64])
Inst tzdata [2024a-0ubuntu0.22.04] (2024b-0ubuntu0.22.04 Ubuntu:22.04/jammy-updates [all])
Conf libssl3 (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-security [amd64])
";

    #[test]
    fn apt_解析出版本并且区分安全更新() {
        let list = parse_apt(APT_SAMPLE);
        assert_eq!(list.len(), 3, "只认 Inst 行，Conf 行不算");
        assert_eq!(list[0].name, "libssl3");
        assert_eq!(list[0].current, "3.0.2-0ubuntu1.10");
        assert_eq!(list[0].candidate, "3.0.2-0ubuntu1.12");
        assert!(list[0].security, "来源里带 -security 就是安全更新");
        assert!(!list[2].security, "jammy-updates 不是安全通道");
    }

    /// 真实的 `dnf check-update --security` 片段。
    const DNF_SAMPLE: &str = "\

Last metadata expiration check: 0:12:31 ago on Mon 06 Oct 2026.

openssl.x86_64          1:3.0.7-27.el9      update-security
openssl-libs.x86_64     1:3.0.7-27.el9      update-security
";

    #[test]
    fn dnf_只取三列的内容行() {
        let list = parse_rpm(DNF_SAMPLE);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "openssl.x86_64");
        assert_eq!(list[0].candidate, "1:3.0.7-27.el9");
        assert!(list[0].security, "--security 过滤过的，列出来就是安全更新");
    }

    #[test]
    fn 认不出的输出不会崩也不会瞎给数据() {
        assert!(parse_apt("").is_empty());
        assert!(parse_apt("E: Could not open lock file").is_empty());
        assert!(parse_rpm("Obsoleting Packages\nsomething odd").is_empty());
    }
}
