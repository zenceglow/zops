//! Reading Caddy's own output.
//!
//! "网关在跑吗"和"网关刚才说了什么"是两个问题。状态接口能回答前者，但排查 502、
//! 证书签发失败、上游连不上时，真正有用的是后者 —— 以前面板只能让用户自己想办法
//! 去 `docker logs` 或翻 `/var/log`，等于把最需要的那条信息挡在门外。
//!
//! 日志落在哪儿取决于 Caddy 是怎么被拉起来的：容器里归 Docker 管，systemd 里归
//! journald 管，裸二进制则只能靠 Caddyfile 里的 `log` 指令写到文件。这里按这个顺序
//! 找，并把"用的是哪一路"一并返回；一条都找不到时说清楚为什么 —— 回一个空列表
//! 会让人以为"Caddy 什么都没输出"，而实际上只是我们没找到。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::process::CaddyProcess;

/// 日志界面上限。再多也不会有人看，而把它塞进 HTTP 响应里只会拖慢页面。
const MAX_TAIL: usize = 5000;
/// 只从文件尾部读一小段。access log 能涨到几百 MB，整个读进内存不合适。
const READ_WINDOW: u64 = 1 << 20;

#[derive(Debug, Clone, Serialize)]
pub struct GatewayLog {
    /// 日志来源，直接给用户看：`docker:caddy` / `journald` / `/var/log/caddy/access.log`
    pub source: String,
    pub lines: Vec<String>,
    /// 是否真的找到了日志。false 时 `hint` 说明该怎么办。
    pub available: bool,
    pub hint: Option<String>,
}

impl GatewayLog {
    fn found(source: String, lines: Vec<String>) -> Self {
        Self {
            source,
            lines: lines.iter().map(|l| strip_ansi(l)).collect(),
            available: true,
            hint: None,
        }
    }

    fn missing(source: String, hint: impl Into<String>) -> Self {
        Self {
            source,
            lines: Vec::new(),
            available: false,
            hint: Some(hint.into()),
        }
    }
}

/// 剥掉 ANSI 颜色码。
///
/// Caddy 的 console 格式会往日志里写 `\x1b[34m` 这种转义 —— 在终端里是颜色，在
/// 网页上就是一串乱码。终端面板不做完整的 ANSI 渲染，直接去掉最干净。
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI 序列：ESC [ 后面跟到某个 @-~ 为止的参数/终止符。
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // 其它两字符转义（ESC ] 之类）极少见，跳过它的下一个字符即可。
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

pub fn tail(process: &CaddyProcess, tail: usize) -> GatewayLog {
    let tail = tail.clamp(1, MAX_TAIL);

    if let Some(d) = process.detect_docker() {
        let source = format!("docker:{}", d.container);
        return match docker_logs(&d.container, tail) {
            Ok(lines) => GatewayLog::found(source, lines),
            Err(e) => GatewayLog::missing(source, e),
        };
    }

    if let Some(lines) = journald_logs(tail) {
        return GatewayLog::found("journald (caddy.service)".to_string(), lines);
    }

    match newest_log_file(process) {
        Some(path) => match read_last_lines(&path, tail) {
            Ok(lines) => GatewayLog::found(path.display().to_string(), lines),
            Err(e) => GatewayLog::missing(path.display().to_string(), e),
        },
        None => GatewayLog::missing(
            "none".to_string(),
            "没找到 Caddy 的日志。它是以二进制方式启动的，既不在 Docker 里也没有接入 \
             systemd，输出没有落到任何文件。可以在 Caddyfile 里加一段 \
             `log { output file /var/log/caddy/access.log }`，然后重载网关。",
        ),
    }
}

fn docker_logs(container: &str, tail: usize) -> Result<Vec<String>, String> {
    let out = Command::new("docker")
        .args(["logs", "--tail", &tail.to_string(), container])
        .output()
        .map_err(|e| format!("执行 docker logs 失败: {e}"))?;

    // 容器日志分两路：正常输出在 stdout，报错在 stderr。只看一路会漏掉关键的那半。
    let mut lines: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    lines.extend(
        String::from_utf8_lossy(&out.stderr)
            .lines()
            .map(str::to_string),
    );

    if lines.is_empty() && !out.status.success() {
        return Err(format!("docker logs {container} 读取失败"));
    }
    Ok(lines)
}

/// journald 里有没有 caddy.service 的记录。
///
/// 返回 `None` 表示"这条路走不通"（没有 journalctl、或 unit 压根不存在），调用方
/// 应该继续往下找文件日志 —— 不能因为 journalctl 装了就认定 Caddy 归它管。
fn journald_logs(tail: usize) -> Option<Vec<String>> {
    let out = Command::new("journalctl")
        .args([
            "-u",
            "caddy",
            "-n",
            &tail.to_string(),
            "--no-pager",
            "--output",
            "short-iso",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }

    // journalctl 对不存在的 unit 也可能返回 0，只吐一句 "-- No entries --"。
    let lines: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    (!lines.is_empty()).then_some(lines)
}

/// 候选日志文件，按"可信度"排：显式配置 > Caddyfile 里写的 > 约定俗成的路径。
///
/// 多个都存在时挑一个：
/// 1. 不是 access.log 的优先。`access.log` 是每个站点的请求流水，而"网关日志"要回答的
///    是 502、证书签发失败这类运行时问题 —— 那在 Caddy 自己的日志里，不在访问流水里。
/// 2. 同档内取最近改动的那个。真正的日志一直在写，停更的基本是历史遗留。
fn newest_log_file(process: &CaddyProcess) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var("CADDY_LOG_PATH") {
        if !p.trim().is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }

    if let Ok(raw) = std::fs::read_to_string(process.effective_caddyfile_path()) {
        candidates.extend(log_paths_from_caddyfile(&raw).into_iter().map(PathBuf::from));
    }

    for p in [
        "/var/log/caddy/access.log",
        "/var/log/caddy/caddy.log",
        "/opt/docker-apps/caddy/logs/access.log",
        "/opt/docker-apps/caddy/logs/caddy.log",
        "/var/log/caddy.log",
    ] {
        candidates.push(PathBuf::from(p));
    }

    let mut existing: Vec<(PathBuf, std::time::SystemTime)> = candidates
        .into_iter()
        .filter_map(|p| {
            let modified = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
            Some((p, modified))
        })
        .collect();
    existing.sort_by(|a, b| {
        is_access_log(&a.0)
            .cmp(&is_access_log(&b.0))
            .then(b.1.cmp(&a.1))
    });
    existing.into_iter().next().map(|(p, _)| p)
}

fn is_access_log(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.contains("access"))
}

/// 从 Caddyfile 里抠出 `log { output file <path> }` 的目标路径。
///
/// 故意用逐行扫描而不是真正的解析器：漏掉一个路径的代价只是退回到约定路径，而且
/// 候选路径最后都要过一遍 `stat`，猜错了也不会误报。
pub(super) fn log_paths_from_caddyfile(raw: &str) -> Vec<String> {
    raw.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("output file ")?;
            let path = rest
                .split(['{', ' ', '\t'])
                .next()
                .unwrap_or("")
                .trim();
            // `output stdout` / `output discard` 之类的没有路径，天然被这里挡掉。
            path.starts_with('/').then(|| path.to_string())
        })
        .collect()
}

fn read_last_lines(path: &Path, tail: usize) -> Result<Vec<String>, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| format!("打开日志失败: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("读取日志信息失败: {e}"))?
        .len();
    let start = len.saturating_sub(READ_WINDOW);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位日志失败: {e}"))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("读取日志失败: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();

    // 窗口起点可能切在半行中间，第一行是残的，丢掉。
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(tail);
    Ok(lines.split_off(skip))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_file_output_paths_only() {
        let raw = "\
:80 {
\tlog {
\t\toutput file /var/log/caddy/access.log
\t\tformat json
\t}
}
:443 {
\tlog {
\t\toutput stdout
\t}
}";
        assert_eq!(
            log_paths_from_caddyfile(raw),
            vec!["/var/log/caddy/access.log".to_string()]
        );
    }

    #[test]
    fn reads_only_the_tail() {
        let dir = std::env::temp_dir().join(format!("zops-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("access.log");
        let body: String = (0..50).map(|i| format!("line-{i}\n")).collect();
        std::fs::write(&path, body).unwrap();

        let lines = read_last_lines(&path, 3).unwrap();
        assert_eq!(lines, vec!["line-47", "line-48", "line-49"]);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn ansi_colors_do_not_reach_the_panel() {
        assert_eq!(
            strip_ansi("\u{1b}[34mINFO\u{1b}[0m\tserver running"),
            "INFO\tserver running"
        );
        assert_eq!(strip_ansi("no escapes here"), "no escapes here");
    }
}
