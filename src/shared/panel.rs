//! 面板自身的身份：叫什么、哪个版本、起来多久了。
//!
//! 放一处是因为问这个问题的有两个地方：关于页（给人看）和 MCP 的
//! `ops_panel_info`（给 agent 看，用来确认连的是哪个面板、权限到哪一档）。
//! 两边各写一份迟早会不一致。

use std::sync::OnceLock;
use std::time::SystemTime;

pub const NAME: &str = "ZOPS";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GITHUB: &str = "https://github.com/zenceglow/zops";
pub const EMAIL: &str = "developer@zenceglow.com";

static STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

/// 进程起来的时候调一次。
pub fn mark_started() {
    let _ = STARTED_AT.set(SystemTime::now());
}

/// 已经跑了多少秒。没标记过就返回 0，不编一个数出来。
pub fn uptime_seconds() -> u64 {
    STARTED_AT
        .get()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
