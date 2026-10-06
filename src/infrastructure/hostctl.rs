//! 面板在这台机器上怎么装的：systemd 单元、监听地址、卸载。
//!
//! `zops access` / `zops uninstall` 和面板里的同名设置必须改同一处，不然命令行
//! 关了外网、页面上还显示开着。确认（输入 yes、页面上的二次确认）留在调用方，
//! 这里只做改文件和叫 systemd。

use std::path::{Path, PathBuf};
use std::process::Command;

pub const SERVICE: &str = "zenceglow-ops";
pub const BIND_KEY: &str = "OPS_BIND";
pub const PUBLIC_BIND: &str = "0.0.0.0";
pub const LOCAL_BIND: &str = "127.0.0.1";

const DEFAULT_UNIT: &str = "/etc/systemd/system/zenceglow-ops.service";

#[derive(Debug, Clone)]
pub struct InstallState {
    pub unit: PathBuf,
    pub found: bool,
    pub bin: PathBuf,
    pub data_dir: PathBuf,
    pub bind: String,
}

impl InstallState {
    pub fn is_public(&self) -> bool {
        self.bind != LOCAL_BIND
    }
}

pub fn detect() -> InstallState {
    let unit = std::env::var("OPS_UNIT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_UNIT));
    let text = std::fs::read_to_string(&unit).unwrap_or_default();
    let env = |key: &str| -> Option<String> {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(&format!("Environment={key}=")))
            .map(|v| v.trim().to_string())
    };
    let exec = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("ExecStart="))
        .map(|v| v.split_whitespace().next().unwrap_or("").to_string());
    let bin = std::env::var("OPS_BIN_PATH")
        .ok()
        .or(exec)
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_else(|| PathBuf::from("/usr/local/bin/zenceglow-ops"));
    let cfg = crate::config::Config::from_env();
    InstallState {
        found: !text.is_empty(),
        unit,
        data_dir: env("OPS_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(cfg.data_dir),
        bind: env(BIND_KEY)
            .or_else(|| std::env::var(BIND_KEY).ok())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| PUBLIC_BIND.to_string()),
        bin,
    }
}

/// 在 systemd 单元里设置 / 替换一个 `Environment=` 项。写前留一份 .bak。
pub fn set_unit_env(unit: &Path, key: &str, value: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(unit).map_err(|e| e.to_string())?;
    let line = format!("Environment={key}={value}");
    let prefix = format!("Environment={key}=");
    let mut replaced = false;
    let mut out: Vec<String> = text
        .lines()
        .map(|l| {
            if l.trim_start().starts_with(&prefix) {
                replaced = true;
                line.clone()
            } else {
                l.to_string()
            }
        })
        .collect();
    if !replaced {
        // 安装脚本写出来的单元里 [Service] 是最后一段，追加在文件末尾即可。
        out.push(line);
    }
    std::fs::write(unit.with_extension("bak"), &text).map_err(|e| e.to_string())?;
    std::fs::write(unit, out.join("\n") + "\n").map_err(|e| e.to_string())
}

pub fn systemctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("systemctl")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("systemctl {} 失败", args.join(" "))
        } else {
            err
        })
    }
}

/// 改监听地址并立刻重启。给命令行用：`zops` 自己不在服务进程里，同步等重启没问题。
pub fn apply_bind(bind: &str) -> Result<(), String> {
    let ins = detect();
    if !ins.found {
        return Err(format!(
            "找不到 systemd 单元 {}，改不了监听地址",
            ins.unit.display()
        ));
    }
    set_unit_env(&ins.unit, BIND_KEY, bind)?;
    let _ = systemctl(&["daemon-reload"]);
    systemctl(&["restart", SERVICE])
}

/// 只改单元并 reload，不在当前进程里等重启。
///
/// 面板进程自己调用 `systemctl restart` 会死锁：systemctl 要等服务停掉，
/// 服务又在等 systemctl 返回。重启丢给一个独立的 transient unit。
pub fn prepare_bind(bind: &str) -> Result<(), String> {
    let ins = detect();
    if !ins.found {
        return Err(format!(
            "找不到 systemd 单元 {}，改不了监听地址",
            ins.unit.display()
        ));
    }
    set_unit_env(&ins.unit, BIND_KEY, bind)?;
    let _ = systemctl(&["daemon-reload"]);
    schedule("zops-access-restart", &format!("systemctl restart {SERVICE}"))
}

/// 停服务、删单元和二进制。数据目录默认留下。Docker 和 Caddy 不动。
pub fn uninstall_now(purge: bool) -> Result<(), String> {
    let ins = detect();
    if !ins.found {
        return Err(format!("找不到 systemd 单元 {}", ins.unit.display()));
    }
    let mut failed = Vec::new();
    for args in [["disable", "--now", SERVICE].as_slice(), ["daemon-reload"].as_slice()] {
        if let Err(e) = systemctl(args) {
            failed.push(format!("systemctl {}：{e}", args.join(" ")));
        }
    }
    for path in [&ins.unit, &ins.bin, &ins.bin.with_file_name("zops")] {
        if path.exists() {
            if let Err(e) = std::fs::remove_file(path) {
                failed.push(format!("删除 {}：{e}", path.display()));
            }
        }
    }
    if purge {
        if let Err(e) = std::fs::remove_dir_all(&ins.data_dir) {
            failed.push(format!("删除 {}：{e}", ins.data_dir.display()));
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("\n"))
    }
}

/// 从面板进程里卸载：当前进程马上会被停掉，删除文件的事交给另一个 unit。
pub fn schedule_uninstall() -> Result<(), String> {
    let ins = detect();
    if !ins.found {
        return Err(format!("找不到 systemd 单元 {}", ins.unit.display()));
    }
    let unit = ins.unit.display();
    let bin = ins.bin.display();
    let link = ins.bin.with_file_name("zops");
    let script = format!(
        "sleep 1; systemctl disable --now {SERVICE} || true; systemctl daemon-reload || true; rm -f '{unit}' '{bin}' '{}'",
        link.display()
    );
    schedule("zops-uninstall", &script)
}

fn schedule(unit: &str, script: &str) -> Result<(), String> {
    let unit_arg = format!("--unit={unit}");
    let out = Command::new("systemd-run")
        .args(["--no-block", "--collect", &unit_arg, "/bin/sh", "-c", script])
        .output()
        .map_err(|e| format!("systemd-run 不可用：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 改单元里的监听地址只动那一行() {
        let dir = std::env::temp_dir().join(format!("zops-hostctl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let unit = dir.join("zenceglow-ops.service");
        std::fs::write(
            &unit,
            "[Service]\nExecStart=/usr/local/bin/zenceglow-ops\nEnvironment=OPS_PORT=5200\n",
        )
        .unwrap();

        set_unit_env(&unit, BIND_KEY, LOCAL_BIND).unwrap();
        let text = std::fs::read_to_string(&unit).unwrap();
        assert!(text.contains("Environment=OPS_BIND=127.0.0.1"));
        assert!(text.contains("Environment=OPS_PORT=5200"));
        assert!(unit.with_extension("bak").exists());

        set_unit_env(&unit, BIND_KEY, PUBLIC_BIND).unwrap();
        let text = std::fs::read_to_string(&unit).unwrap();
        assert_eq!(text.matches("OPS_BIND=").count(), 1);
        assert!(text.contains("Environment=OPS_BIND=0.0.0.0"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
