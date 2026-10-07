use std::sync::Mutex;
use std::time::Duration;

use crate::shared::AppError;

use super::bin::{self, which_caddy};
use super::docker::{self, DockerCaddy};
use super::fmt;
use super::install;
use super::logs::GatewayLog;

pub struct CaddyProcess {
    pub caddyfile_path: String,
    pub bin: Mutex<Option<String>>,
}

impl CaddyProcess {
    pub fn new(caddyfile_path: String) -> Self {
        Self {
            caddyfile_path,
            bin: Mutex::new(which_caddy()),
        }
    }

    pub fn refresh_bin(&self) -> Option<String> {
        let bin = which_caddy();
        *self.bin.lock().unwrap() = bin.clone();
        bin
    }

    pub fn cached_bin(&self) -> Option<String> {
        self.bin.lock().unwrap().clone()
    }

    /// The Caddy container already fronting this host, if any.
    ///
    /// Detected on demand rather than cached: the panel is a low-traffic admin
    /// tool, and a container can be recreated underneath us at any time.
    pub fn detect_docker(&self) -> Option<DockerCaddy> {
        docker::detect()
    }

    /// Path the panel edits.
    ///
    /// When Caddy runs in Docker, the file that actually matters is the host
    /// side of its bind mount — `CADDYFILE_PATH` is only the fallback for
    /// hosts running the binary directly.
    pub fn effective_caddyfile_path(&self) -> String {
        self.detect_docker()
            .map(|d| d.host_config)
            .or_else(bin::running_config_path)
            .unwrap_or_else(|| self.caddyfile_path.clone())
    }

    pub fn status(&self) -> GatewayStatusSnapshot {
        if let Some(d) = self.detect_docker() {
            let version = docker::version(&d.container).unwrap_or_else(|| d.image.clone());
            let caddyfile_path = d.host_config.clone();
            return GatewayStatusSnapshot {
                installed: true,
                running: d.running,
                runtime: "docker".to_string(),
                container: Some(d.container.clone()),
                version,
                pid: None,
                bin_path: format!("docker:{}", d.container),
                config_modified: modified_ms(&caddyfile_path),
                caddyfile_path,
            };
        }

        let bin = which_caddy().unwrap_or_default();
        let installed = !bin.is_empty();
        let version = if installed {
            bin::version(&bin)
        } else {
            String::new()
        };
        let pid = bin::pid();
        // 二进制模式下，正在跑的进程用的是哪份配置就以它为准 —— `CADDYFILE_PATH`
        // 是部署时写进 systemd 单元里的，从容器迁到宿主机之后必然过期。
        let caddyfile_path = bin::running_config_path().unwrap_or_else(|| self.caddyfile_path.clone());
        GatewayStatusSnapshot {
            installed,
            running: pid.is_some(),
            runtime: if installed {
                "binary".to_string()
            } else {
                "none".to_string()
            },
            container: None,
            version,
            pid,
            bin_path: bin,
            config_modified: modified_ms(&caddyfile_path),
            caddyfile_path,
        }
    }

    /// Caddy 自己的输出。找不到时返回值里会说明为什么，见 `logs` 模块。
    pub fn logs(&self, tail: usize) -> GatewayLog {
        super::logs::tail(self, tail)
    }

    pub fn install(&self) -> Result<String, AppError> {
        if let Some(d) = self.detect_docker() {
            return Err(AppError::bad_request(format!(
                "已检测到 Caddy 容器 `{}`，面板会自动接管它，无需安装",
                d.container
            )));
        }
        if which_caddy().is_some() {
            return Err(AppError::bad_request("接入网关已安装"));
        }

        // 网关装在宿主机上，不装成容器。原因见 `install` 模块开头：容器里拿不到真实
        // IP、读不到访问日志、也说不清当前生效的是哪份配置 —— 而这正是面板的网络监控
        // 和访问统计赖以工作的三样东西。以前这里"在 Linux 上优先走容器"是为了把 Caddy
        // 挡在宿主机包管理之外，代价太大，不值。
        let result = if cfg!(target_os = "macos") {
            // macOS 上装网关只是为了本地开发，brew 最省事，也不用 root 之外的东西。
            let output = std::process::Command::new("brew")
                .args(["install", "caddy"])
                .output()
                .map_err(|e| AppError::internal(format!("无法执行 brew: {e}")))?;
            if output.status.success() {
                Ok("安装成功".to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(AppError::internal(format!("安装失败: {stderr}")))
            }
        } else if cfg!(target_os = "linux") {
            install::install_host().map_err(|e| {
                // 宿主机装不上（没有 curl、GitHub 不可达、不是 root……）时还能退回容器，
                // 否则用户面对的是一个连按钮都点不动的网关页。把代价写在返回值里，别让
                // 它变成一次静悄悄的降级。
                if docker::available() {
                    match docker::install_default() {
                        Ok(m) => AppError::internal(format!(
                            "宿主机部署失败（{e}），已退回 Docker 容器部署：{m}\n\
                             注意：容器网关拿不到真实 IP 也读不到访问日志，网络监控与访问统计会不准；\
                             建议修好上面的问题后换成宿主机部署。"
                        )),
                        Err(d) => AppError::internal(format!("宿主机部署失败（{e}），退回容器也失败了（{d}）")),
                    }
                } else {
                    AppError::internal(e)
                }
            })
        } else {
            Err(AppError::bad_request(
                "不支持的操作系统，请手动安装 Caddy: https://caddyserver.com/docs/install",
            ))
        }?;

        self.refresh_bin();
        Ok(result)
    }

    pub fn start(&self) -> Result<(), AppError> {
        if let Some(d) = self.detect_docker() {
            return docker::start(&d.container).map_err(AppError::internal);
        }

        let bin = self
            .cached_bin()
            .ok_or_else(|| AppError::bad_request("接入网关未安装"))?;

        systemctl("start", "caddy").or_else(|_| {
            std::process::Command::new(&bin)
                .arg("run")
                .arg("--config")
                // 启动时别写 `self.caddyfile_path`：那是部署时写进环境里的一份，从容器
                // 迁到宿主机之后已经过期。别的路径上（reload / 状态）都已经以"正在跑的
                // 那份"为准，这里跟着走，否则会出现"重载改了 A 文件、重启却按 B 文件起"。
                .arg(self.effective_caddyfile_path())
                .spawn()
                .map_err(|e| AppError::internal(e.to_string()))?;

            // 光 spawn 成功不等于起来了：配置文件不存在或语法有错时，caddy 会立刻
            // 退出，而父进程拿到的仍然是"成功"。等一小会儿看进程还在不在 ——
            // 界面上弹出"启动成功"、状态却还是"已停止"，比直接报错更让人不信任。
            std::thread::sleep(Duration::from_millis(900));
            if crate::infrastructure::caddy::bin::pid().is_none() {
                return Err(AppError::internal(
                    "Caddy 启动后立即退出，多半是配置文件不存在或有语法错误（面板日志里有它的输出）",
                ));
            }
            Ok(())
        })
    }

    pub fn stop(&self) -> Result<(), AppError> {
        if let Some(d) = self.detect_docker() {
            return docker::stop(&d.container).map_err(AppError::internal);
        }

        systemctl("stop", "caddy").or_else(|_| {
            // 这里以前是 `pkill -x caddy`，在只有宿主机 Caddy 的年代没问题。现在不行了：
            // 宿主机的 PID 命名空间看得见容器里的进程，`paober-web` / `paober-drive-oms-web`
            // 这类「拿 caddy 镜像做静态文件服务」的应用容器会被一起杀掉 —— 点一下「停止
            // 网关」，别人的网站跟着下线。`bin::pids()` 按 cgroup 把容器里的滤掉了。
            let pids = bin::pids();
            if pids.is_empty() {
                return Ok(());
            }
            for pid in &pids {
                std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .status()
                    .map_err(|e| AppError::internal(format!("结束 Caddy 进程 {pid} 失败: {e}")))?;
            }

            // 发完信号不等于停下来了：Caddy 收到 TERM 会先把在飞的请求收完，站多的时候
            // 要几秒。等一等再看，不然界面显示"已停止"、它其实还在 80 上跑着。
            for _ in 0..30 {
                if bin::pids().is_empty() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(AppError::internal(
                "Caddy 没有退出 —— 它可能是被 systemd 拉起来的（`systemctl stop caddy`），\
                 停掉之后会被自动重启。先看 `systemctl status caddy`。",
            ))
        })
    }

    pub fn reload(&self) -> Result<(), AppError> {
        // `caddy reload` swaps config in place — no downtime, unlike restarting
        // the container, which is why docker mode uses exec rather than restart.
        if let Some(d) = self.detect_docker() {
            return docker::reload(&d.container, &d.container_config).map_err(AppError::internal);
        }

        let bin = self
            .cached_bin()
            .ok_or_else(|| AppError::bad_request("接入网关未安装"))?;
        let cfg = self.effective_caddyfile_path();

        std::process::Command::new(&bin)
            .arg("reload")
            .arg("--config")
            .arg(&cfg)
            .output()
            .map_err(|e| AppError::internal(e.to_string()))
            .and_then(|o| {
                if o.status.success() {
                    Ok(())
                } else {
                    let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    Err(AppError::internal(msg))
                }
            })
            .or_else(|_| self.restart_with_rollback())
    }

    /// 重启 Caddy，并确认它**真的**起来了；起不来就退回上一版配置再重启一次。
    ///
    /// `caddy validate` 只能挡住语法错，挡不住"加载时才失败"的配置。最典型的是
    /// 新加的 `log` 指向一个 Caddy 进程写不了的路径：配置合情合理，重启后 Caddy
    /// 立刻退出 —— 本来只是想改一个站点，结果是全站 502。这里把那种事故降级成
    /// "这次改动没生效，配置回滚了"。
    fn restart_with_rollback(&self) -> Result<(), AppError> {
        let cfg = self.effective_caddyfile_path();
        systemctl("restart", "caddy")?;
        std::thread::sleep(Duration::from_millis(1200));
        if bin::pid().is_some() {
            return Ok(());
        }

        let bak = format!("{}.zops-bak", cfg);
        if !std::path::Path::new(&bak).exists() {
            return Err(AppError::internal(
                "Caddy 重启后没有起来，而且没找到上一版配置，无法自动回滚 —— 先看网关日志（journalctl -u caddy）",
            ));
        }
        let previous = std::fs::read_to_string(&bak)
            .map_err(|e| AppError::internal(format!("读取上一版配置失败：{e}")))?;
        std::fs::write(&cfg, previous)
            .map_err(|e| AppError::internal(format!("写回上一版配置失败：{e}")))?;
        systemctl("restart", "caddy")?;
        std::thread::sleep(Duration::from_millis(1200));
        if bin::pid().is_none() {
            return Err(AppError::internal(
                "配置回滚后 Caddy 仍然起不来，需要人工介入：journalctl -u caddy",
            ));
        }
        Err(AppError::internal(
            "新配置 Caddy 加载失败（进程起不来），已自动回滚到上一版并重启，改动没有生效。先看网关日志再改。",
        ))
    }

    /// Validate + format a Caddyfile with whichever Caddy is actually serving.
    /// Falls back to storing raw content when there is no Caddy to ask.
    pub async fn format_caddyfile(&self, raw: String) -> Result<String, AppError> {
        if let Some(d) = self.detect_docker() {
            return docker::fmt(&d.container, &raw).map_err(AppError::bad_request);
        }
        match self.cached_bin() {
            Some(bin) => fmt::fmt_caddyfile(&bin, raw).await,
            None => Ok(raw),
        }
    }

    /// 真正的校验：让 Caddy 自己解析一遍配置。
    ///
    /// 和 `format_caddyfile` 的区别很关键 —— **`caddy fmt` 只做格式，不做校验**：
    /// 把 `reverse_proxy` 敲成 `reverse_prox`，fmt 照样排版得整整齐齐。这种错误
    /// 写进文件之后，下次 Caddy 重启就再也起不来，全站一起下线。
    /// `caddy validate` 会真的去 adapt 一遍，认不出的指令直接报错。
    ///
    /// 没有 Caddy 可问（既不在容器里也没装二进制）时跳过校验：不能因为查不了
    /// 就拒绝保存。
    pub async fn validate_caddyfile(&self, raw: &str) -> Result<(), String> {
        if let Some(d) = self.detect_docker() {
            return docker::validate(&d.container, raw);
        }
        match self.cached_bin() {
            Some(bin) => fmt::validate_caddyfile(&bin, raw).await,
            None => Ok(()),
        }
    }
}

pub struct GatewayStatusSnapshot {
    pub installed: bool,
    pub running: bool,
    /// `docker` | `binary` | `none`.
    pub runtime: String,
    /// Container name when `runtime == "docker"`.
    pub container: Option<String>,
    pub version: String,
    pub pid: Option<i32>,
    pub bin_path: String,
    /// 配置文件的最后修改时间（Unix 毫秒）。界面拿它回答"我改的那份到底生效了没"。
    pub config_modified: Option<u64>,
    pub caddyfile_path: String,
}

fn modified_ms(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn systemctl(action: &str, service: &str) -> Result<(), AppError> {
    let status = std::process::Command::new("systemctl")
        .arg(action)
        .arg(service)
        .status()
        .map_err(|e| AppError::internal(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "systemctl {action} {service} failed"
        )))
    }
}
