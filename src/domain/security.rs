//! 安全中心：暴露面、端口访问记录、预警。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct SecurityEvent {
    pub id: i64,
    pub ip: String,
    /// blocked（被网关拦下）| bot（扫描器/工具 UA）| probe（探测常见敏感路径）
    pub kind: String,
    pub reason: String,
    pub host: String,
    pub method: String,
    pub uri: String,
    pub status: i64,
    pub ua: String,
    /// 同一个 IP 在同一个小时里打同一个路径的次数。
    pub hits: i64,
    /// 本地时间字符串，省得前端再算一遍时区。
    pub first_seen: String,
    pub last_seen: String,
    pub last_seen_ts: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecuritySummary {
    pub blocked: i64,
    pub bot: i64,
    pub probe: i64,
    pub ips: i64,
    pub window_hours: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshRecord {
    pub id: i64,
    pub ts: f64,
    pub time: String,
    pub ip: String,
    pub user: String,
    /// accepted | failed | invalid
    pub result: String,
    pub method: String,
    pub port: i64,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshSummary {
    pub accepted: i64,
    pub failed: i64,
    pub invalid: i64,
    pub ips: i64,
    pub window_hours: u32,
    /// 敲门最多的几个 IP。
    pub top_failed: Vec<IpCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IpCount {
    pub ip: String,
    pub count: i64,
}

/// 对一个端口本机暴露面的描述。
#[derive(Debug, Clone, Serialize)]
pub struct ExposedPort {
    pub port: u16,
    pub address: String,
    pub process: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    /// 只绑回环的不算对外暴露。
    pub public: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Firewall {
    /// firewalld | ufw | nftables | iptables | 空串（没检测到）
    pub tool: String,
    pub active: bool,
    pub summary: String,
    /// 规则原文（截断过），空数组表示没读到。
    pub rules: Vec<String>,
    /// 本机对外监听的端口。
    pub exposed: Vec<ExposedPort>,
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SshQuery {
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub limit: Option<i64>,
}
