//! Minimal MCP (Model Context Protocol) wire types over JSON-RPC 2.0.
//!
//! We implement the Streamable HTTP transport by hand instead of pulling in an
//! SDK: the surface we need is four methods (initialize / notifications/
//! initialized / tools/list / tools/call) and a JSON-RPC envelope, which is
//! less code than wiring an async MCP framework into the existing axum router.

use serde::Deserialize;
use serde_json::{json, Value};

/// Protocol revision we advertise. Clients send their own version in
/// `initialize`; we echo theirs back when we know it, and fall back to this.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

pub const SERVER_NAME: &str = "zops";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Name of the bundled Codex skill (folder name under `skills/`).
pub const SKILL_NAME: &str = "zops";

/// The skill pack, compiled into the binary. A host can hand the agent its own
/// onboarding doc over the API instead of asking the operator to copy files.
pub const SKILL_CONTENT: &str = include_str!("../../skills/zops/SKILL.md");

/// The troubleshooting playbook referenced by the skill.
pub const SKILL_REF_TROUBLESHOOTING: &str =
    include_str!("../../skills/zops/references/troubleshooting.md");

/// 部署剧本。用户说"把这个项目部署上去"时 agent 照着走 —— 把这台机器上的部署
/// 习惯（端口区间、网络、日志、反代）写死在文档里，就不用每个项目再手写一遍
/// Dockerfile 和 compose。
pub const SKILL_REF_DEPLOY: &str = include_str!("../../skills/zops/references/deploy.md");

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub jsonrpc: String,
    /// Absent on notifications — those must not get a JSON-RPC response.
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

/// Successful `tools/call` payload.
pub fn tool_text(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

/// Failed `tools/call` payload. Tool-level failures are still a successful
/// JSON-RPC response — `isError` is what tells the model the call failed.
pub fn tool_error(text: impl Into<String>) -> Value {
    json!({
        "content": [{ "type": "text", "text": text.into() }],
        "isError": true
    })
}

pub fn tool_json(value: &Value) -> Value {
    tool_text(serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into()))
}

/// Protocol versions we recognise. Echoing the client's version keeps us
/// compatible with clients that pin an older revision.
pub fn supported_protocol_version(requested: &str) -> String {
    match requested {
        "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25" => requested.to_string(),
        _ => PROTOCOL_VERSION.to_string(),
    }
}

/// Server instructions. Codex reads this from `initialize` and uses it as
/// server-wide guidance; the first 512 characters must stand alone, because
/// that is what survives into the tightest context budgets.
pub const INSTRUCTIONS: &str = "\
Zenceglow Ops 是这台服务器的运维面板。你可以用这些工具查看系统负载、Docker 容器、\
Caddy 网关、日志和计划任务，并在被授权时重启服务或改网关配置。

工作方式：
1. 先只读侦察再动手 —— ops_system_overview / ops_container_list / ops_container_logs / ops_log_tail 通常已经能定位问题。
2. 破坏性操作（container_stop / container_restart / gateway_reload / caddyfile_put / automation_task_run）执行前，先把「你打算做什么、影响哪些容器或域名、怎么回滚」讲清楚，得到用户明确同意再调用。
3. 重启容器会中断线上服务。caddyfile_put 会替换整份 Caddyfile 并可能让所有站点 502，改之前先 ops_caddyfile_get 备份原文。
4. 只读 token 调用写工具会返回权限错误，这不是故障，换只读思路或让用户在面板上授权。
5. 每个工具返回 JSON。容器用名字或 ID 都可以，优先用名字（可读性更好）。
6. 干活的细则在 resources 里，接上就能读，不用另外装技能包：skill://zops/SKILL.md 是技能正文，
   skill://zops/references/deploy 是部署剧本（部署新服务前先读它），
   skill://zops/references/troubleshooting 是排障剧本（磁盘满 / 502 / 证书 / 内存）。
7. 要部署东西走部署任务通道：ops_deploy_job_create（建目录）→ ops_deploy_job_put_file
   （文本产物；二进制用 curl -T 打 /api/ops/deploy/job/upload）→ ops_deploy_job_put_script
   （部署脚本）→ 用户确认后 ops_deploy_job_run → ops_deploy_job_log 拉进度。
   部署记录会自动落到 SQLite 并和容器绑定，面板「部署」页看到的是同一批记录。";
