//! 读 Caddy 的**访问日志**并拆成一条条记录。
//!
//! 和 `logs` 模块的区别：那个模块回答"网关刚才说了什么"（运行时日志，排障用），
//! 这个模块回答"谁在什么时候访问了什么"（访问流水，统计用）。两者格式不同、
//! 关心的字段也不同，所以分开。
//!
//! 我们生成的站点模板写的是 `format json`，一行一条 JSON；也兼容 `format console`
//! 那种"时间戳 + 制表符 + JSON 尾巴"的形态，因为有人会自己改成 console 去读。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

use super::process::CaddyProcess;

/// 一条访问记录。字段名对齐 Caddy 的 JSON 日志，省得读代码的人还要来回翻译。
#[derive(Debug, Clone, Serialize)]
pub struct AccessEvent {
    /// Unix 秒（带小数）。
    pub ts: f64,
    pub ip: String,
    pub method: String,
    pub host: String,
    pub uri: String,
    pub status: u16,
    pub bytes: u64,
    /// 毫秒，日志里是秒。
    pub duration_ms: f64,
    pub ua: String,
}

/// 可能装着访问日志的地方。
///
/// 三种来源都认，因为 Caddy 的部署方式就这三种：容器里挂出来的目录、本机装的
/// `/var/log/caddy`、以及 Caddyfile 里自己写的 `output file` 路径。
pub fn access_log_files(process: &CaddyProcess) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = std::env::var("CADDY_ACCESS_LOG_DIR") {
        push_dir(&mut files, Path::new(dir.trim()));
    }

    // Caddyfile 里显式写了路径的，最可信。
    if let Ok(raw) = std::fs::read_to_string(process.effective_caddyfile_path()) {
        for path in super::logs::log_paths_from_caddyfile(&raw) {
            let p = PathBuf::from(&path);
            if is_access_log(&p) || path.contains("/caddy/") {
                files.push(p);
            }
        }
    }

    for dir in [
        "/opt/docker-apps/caddy/logs",
        "/var/log/caddy",
        "/var/log/caddy/access",
    ] {
        push_dir(&mut files, Path::new(dir));
    }

    // 去重（同一个文件可能既被 Caddyfile 提到、又在约定目录里），再按"最近写过"
    // 排序 —— 最近在写的才是当前这份。
    let mut seen = std::collections::HashSet::new();
    let mut found: Vec<(PathBuf, SystemTime)> = files
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .filter_map(|p| {
            let modified = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
            Some((p, modified))
        })
        .collect();
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.into_iter().map(|(p, _)| p).collect()
}

fn push_dir(files: &mut Vec<PathBuf>, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_access_log(&path) {
            files.push(path);
        }
    }
}

fn is_access_log(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.contains("access"))
}

/// 解析一行。不是访问记录就返回 `None` —— 日志里混着运行时日志是常态，
/// 认不出来直接跳过，不要猜。
pub fn parse_line(line: &str) -> Option<AccessEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    if line.starts_with('{') {
        return from_json(serde_json::from_str::<Value>(line).ok()?);
    }

    // console 格式：`2026/10/05 20:54:09.766\tINFO\thttp.log.access.log0\thandled request\t{…}`
    let brace = line.find('{')?;
    let (head, tail) = line.split_at(brace);
    let mut event = from_json(serde_json::from_str::<Value>(tail).ok()?)?;
    if event.ts == 0.0 {
        event.ts = parse_console_ts(head)?;
    }
    Some(event)
}

/// `2026/10/05 20:54:09.766` → Unix 秒。按本地时区解释，和 Caddy 写日志的
/// 习惯一致（console 格式用的是本地时间）。
fn parse_console_ts(head: &str) -> Option<f64> {
    let stamp = head.split('\t').next()?.trim();
    let parsed = chrono::NaiveDateTime::parse_from_str(stamp, "%Y/%m/%d %H:%M:%S%.f").ok()?;
    let local = parsed.and_local_timezone(chrono::Local).single()?;
    Some(local.timestamp_millis() as f64 / 1000.0)
}

fn from_json(value: Value) -> Option<AccessEvent> {
    let request = value.get("request")?;
    // 只看访问记录：运行时日志的 msg 是 `server running` 之类，没有 request 字段，
    // 上面那行 get 已经把它们挡掉了。
    let logger = value.get("logger").and_then(Value::as_str).unwrap_or("");
    if !logger.is_empty() && !logger.contains("access") {
        return None;
    }

    let pick_str = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();

    // `client_ip` 是 Caddy 在配了 trusted_proxies 时算出来的真实客户端；
    // 没配就用 remote_ip（此时它是直连方）。
    let mut ip = pick_str(request, "client_ip");
    if ip.is_empty() {
        ip = pick_str(request, "remote_ip");
    }
    if ip.is_empty() {
        return None;
    }

    let ua = request
        .get("headers")
        .and_then(|h| h.get("User-Agent"))
        .and_then(|u| u.as_array())
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Some(AccessEvent {
        ts: value.get("ts").and_then(Value::as_f64).unwrap_or(0.0),
        ip,
        method: pick_str(request, "method"),
        host: pick_str(request, "host"),
        uri: pick_str(request, "uri"),
        status: value.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
        bytes: value.get("size").and_then(Value::as_u64).unwrap_or(0),
        duration_ms: value
            .get("duration")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            * 1000.0,
        ua,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析_json_格式的一条访问记录() {
        let line = r#"{"level":"info","ts":1791233651.82,"logger":"http.log.access.log0","msg":"handled request","request":{"remote_ip":"203.0.113.9","remote_port":"55402","client_ip":"203.0.113.9","proto":"HTTP/1.1","method":"GET","host":"shop.example.com","uri":"/console/products","headers":{"User-Agent":["Mozilla/5.0"]}},"bytes_read":0,"duration":0.00028675,"size":11,"status":200}"#;
        let e = parse_line(line).unwrap();
        assert_eq!(e.ip, "203.0.113.9");
        assert_eq!(e.method, "GET");
        assert_eq!(e.host, "shop.example.com");
        assert_eq!(e.uri, "/console/products");
        assert_eq!(e.status, 200);
        assert_eq!(e.ua, "Mozilla/5.0");
        assert!((e.duration_ms - 0.28675).abs() < 1e-6);
    }

    #[test]
    fn client_ip_优先于_remote_ip() {
        let line = r#"{"ts":1.0,"logger":"http.log.access","request":{"remote_ip":"10.0.0.1","client_ip":"1.2.3.4","method":"GET","host":"a.com","uri":"/"},"status":200}"#;
        assert_eq!(parse_line(line).unwrap().ip, "1.2.3.4");
    }

    #[test]
    fn 运行时日志不会被当成访问记录() {
        let line = r#"{"level":"info","ts":1791233649.075,"logger":"http.log","msg":"server running","name":"srv0"}"#;
        assert!(parse_line(line).is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("随便一行不是日志的文本").is_none());
    }

    #[test]
    fn 解析_console_格式() {
        let line = "2026/10/05 20:54:09.766\tINFO\thttp.log.access.log0\thandled request\t{\"request\":{\"remote_ip\":\"8.8.4.4\",\"method\":\"POST\",\"host\":\"api.example.com\",\"uri\":\"/v1/x\"},\"status\":404,\"size\":0}";
        let e = parse_line(line).unwrap();
        assert_eq!(e.ip, "8.8.4.4");
        assert_eq!(e.status, 404);
        assert!(e.ts > 1_700_000_000.0, "console 格式要从行首补出时间");
    }
}
