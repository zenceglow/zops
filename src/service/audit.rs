//! 操作审计。
//!
//! 记的是"谁、什么时候、从哪、干了什么、成没成"。两个来源：
//!
//! - 面板自己的写接口（人在界面上操作）—— 走 `http::middleware::audit`，对所有
//!   写接口统一生效。挂在中间件上而不是让每个 handler 自己写，是因为"漏记"这种
//!   事只有在出事以后才会发现。
//! - MCP 工具调用（agent 操作）—— 在 mcp handler 里记，因为只有它知道调用的是
//!   哪个工具、参数是什么。

use std::sync::Arc;

use crate::infrastructure::db::{AuditRow, Database};
use crate::shared::AppError;

/// 请求体里最多记这么多字符。Caddyfile 那种整体替换的请求可能几 KB，
/// 全存进日志只会让表变胖、翻起来更难。
const MAX_DETAIL_CHARS: usize = 300;
/// 单个字符串参数最多记这么长。
const MAX_VALUE_CHARS: usize = 60;

pub struct AuditService {
    db: Arc<Database>,
}

impl AuditService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        actor: &str,
        actor_kind: &str,
        ip: &str,
        method: &str,
        path: &str,
        status: u16,
        summary: &str,
        detail: &str,
        duration_ms: i64,
    ) {
        let row = AuditRow {
            id: 0,
            // 用本地时间：运维看日志都是按"我这边的几点"对时间线，UTC 要多算一步。
            at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            actor: actor.to_string(),
            actor_kind: actor_kind.to_string(),
            ip: ip.to_string(),
            method: method.to_string(),
            path: path.to_string(),
            status: status as i64,
            summary: summary.to_string(),
            detail: detail.to_string(),
            duration_ms,
        };
        // 审计写失败不能让业务请求失败 —— 但也不能静默：打一条 warn 出去。
        if let Err(e) = self.db.add_audit_log(&row) {
            tracing::warn!("写审计日志失败: {e}");
        }
    }

    pub fn list(&self, limit: i64, kind: Option<&str>) -> Result<Vec<AuditRow>, AppError> {
        self.db
            .list_audit_logs(limit.clamp(1, 500), kind)
            .map_err(|e| AppError::internal(e.to_string()))
    }
}

/// 把接口路径翻译成一句人话。查表比按路径拼字符串稳：路径里带 id 的（比如
/// `/docker/containers/<id>`）也能对上。
pub fn summarize_path(method: &str, path: &str) -> String {
    let verb = match method {
        "POST" => "新建/触发",
        "PUT" => "修改",
        "DELETE" => "删除",
        _ => "操作",
    };
    let what = match path {
        p if p.ends_with("/files/trash") => "移到回收站",
        p if p.ends_with("/files/trash/restore") => "恢复回收站文件",
        p if p.ends_with("/files/trash/purge") => "彻底删除文件",
        p if p.ends_with("/files/trash/empty") => "清空回收站",
        p if p.ends_with("/files/move") => "移动文件",
        p if p.ends_with("/files/copy") => "复制文件",
        p if p.ends_with("/service/start") => "启动容器",
        p if p.ends_with("/service/stop") => "停止容器",
        p if p.ends_with("/service/restart") => "重启容器",
        p if p.ends_with("/service/prune") => "清理 Docker 垃圾",
        p if p.ends_with("/gateway/reload") => "重载 Caddy",
        p if p.ends_with("/gateway/file") => "改 Caddyfile",
        p if p.ends_with("/gateway/versions") || p.contains("/gateway/versions/") => "回滚 Caddyfile",
        p if p.ends_with("/system/updates/apply") => "安装系统补丁",
        p if p.ends_with("/system/updates/check") => "检查系统补丁",
        p if p.ends_with("/token/create") => "创建访问令牌",
        p if p.ends_with("/token") => "吊销访问令牌",
        p if p.ends_with("/member/create") => "新建成员",
        p if p.ends_with("/member") => "修改成员",
        p if p.ends_with("/automation/tasks") => "改定时任务",
        p if p.contains("/automation/tasks/") && p.ends_with("/run") => "手动跑定时任务",
        _ => "",
    };
    if what.is_empty() {
        format!("{verb} {path}")
    } else {
        what.to_string()
    }
}

/// 请求里哪些字段不能进日志。
fn is_secret(key: &str) -> bool {
    let k = key.to_lowercase();
    ["password", "token", "secret", "authorization", "apikey", "api_key"]
        .iter()
        .any(|s| k.contains(s))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

/// 从请求体里挑出关键参数，做成一行紧凑的 `键=值`。
///
/// 口令/token 一律写成 `***`：审计日志的读者可能比操作者还多，把密钥抄进日志
/// 等于把密钥多存了一份。
pub fn summarize_body(body: &[u8]) -> String {
    if body.is_empty() {
        return String::new();
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::new();
    };
    let Some(obj) = value.as_object() else {
        return clip(&value.to_string(), MAX_DETAIL_CHARS);
    };

    let mut parts: Vec<String> = Vec::new();
    for (k, v) in obj {
        if is_secret(k) {
            parts.push(format!("{k}=***"));
            continue;
        }
        let rendered = match v {
            serde_json::Value::String(s) => clip(s, MAX_VALUE_CHARS),
            serde_json::Value::Array(items) => {
                let shown: Vec<String> = items
                    .iter()
                    .take(3)
                    .map(|i| match i {
                        serde_json::Value::String(s) => clip(s, MAX_VALUE_CHARS),
                        other => clip(&other.to_string(), MAX_VALUE_CHARS),
                    })
                    .collect();
                let more = if items.len() > 3 {
                    format!(" 等 {} 项", items.len())
                } else {
                    String::new()
                };
                format!("[{}]{more}", shown.join(", "))
            }
            serde_json::Value::Null => continue,
            other => clip(&other.to_string(), MAX_VALUE_CHARS),
        };
        parts.push(format!("{k}={rendered}"));
    }

    clip(&parts.join("  "), MAX_DETAIL_CHARS)
}

/// 客户端 IP。面板通常挂在 Caddy 后面，所以要优先信任转发头；
/// 取不到就退回 socket 对端（中间件会把 ConnectInfo 塞进请求扩展）。
pub fn client_ip(headers: &axum::http::HeaderMap, fallback: Option<std::net::SocketAddr>) -> String {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        // XFF 是逗号分隔的链路，"最早的"在最前面。
        if let Some(first) = xff.split(',').next().map(str::trim).filter(|s| !s.is_empty()) {
            return first.to_string();
        }
    }
    if let Some(real) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if !real.trim().is_empty() {
            return real.trim().to_string();
        }
    }
    fallback.map(|a| a.ip().to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密钥类字段不落进日志() {
        let body = br#"{"username":"admin","password":"hunter2","paths":["/tmp/a","/tmp/b"]}"#;
        let out = summarize_body(body);
        assert!(out.contains("username=admin"));
        assert!(out.contains("password=***"), "口令必须被打码：{out}");
        assert!(!out.contains("hunter2"), "口令原文不能出现：{out}");
        assert!(out.contains("/tmp/a"));
    }

    #[test]
    fn 长数组只记前几项并标出总数() {
        let body = br#"{"paths":["/a","/b","/c","/d","/e"]}"#;
        let out = summarize_body(body);
        assert!(out.contains("等 5 项"), "{out}");
        assert!(!out.contains("/e"), "超过三项的不逐条记：{out}");
    }

    #[test]
    fn 非_json_请求体不会崩() {
        assert_eq!(summarize_body(b"not json"), "");
        assert_eq!(summarize_body(b""), "");
    }

    #[test]
    fn 路径能翻译成人话() {
        assert_eq!(summarize_path("POST", "/api/ops/files/trash"), "移到回收站");
        assert_eq!(summarize_path("POST", "/api/ops/service/restart"), "重启容器");
        assert_eq!(summarize_path("POST", "/api/ops/unknown/thing"), "新建/触发 /api/ops/unknown/thing");
    }
}
