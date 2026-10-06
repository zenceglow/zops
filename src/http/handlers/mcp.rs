//! Agent-facing surface: an MCP server (Streamable HTTP over JSON-RPC 2.0)
//! plus the Codex skill pack that teaches an agent how to drive it.
//!
//! Auth is deliberately *not* the panel JWT group: MCP clients hold a long-lived
//! `ops_…` token, so these routes verify the token hash themselves. A panel JWT
//! is also accepted (that is what lets the browser-backed /skill preview work).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Extension, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::auth::{AuthUser, Claims};
use crate::domain::mcp::{self, Request as RpcRequest};
use crate::domain::permission::{
    OPS_AUTOMATION_MANAGE, OPS_GATEWAY_CONTROL, OPS_GATEWAY_READ, OPS_GATEWAY_WRITE, OPS_LOG_READ,
    OPS_DEPLOY, OPS_MEMBER_MANAGE, OPS_NOTIFY_MANAGE, OPS_SERVICE_CONTROL, OPS_SERVICE_LOG,
    OPS_SERVICE_READ,
    OPS_SYSTEM_READ,
};
use crate::domain::token::TOKEN_PREFIX;
use crate::http::handlers::automation::execute_command;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

// ─────────────────────────── principal ───────────────────────────

/// Who is calling: an agent token, or a signed-in operator.
pub enum Principal {
    Token {
        id: String,
        scope: String,
        permissions: Vec<String>,
    },
    User(Box<AuthUser>),
}

impl Principal {
    pub(crate) fn has(&self, permission: &str) -> bool {
        if permission.is_empty() {
            return true;
        }
        match self {
            Principal::Token { permissions, .. } => permissions.iter().any(|p| p == permission),
            Principal::User(user) => user.has(permission),
        }
    }

    fn scope(&self) -> String {
        match self {
            Principal::Token { scope, .. } => scope.clone(),
            Principal::User(user) => user.role.clone(),
        }
    }
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::trim)
        .unwrap_or("")
}

/// 调用者的身份：`ops_…` 令牌，或者面板登录后的 JWT。
///
/// 放在 handler 里而不是中间件里，是因为有些接口（MCP、产物上传）既要让 agent
/// 用令牌调，也要让面板 UI 用 JWT 调 —— 中间件只认其中一种。
pub(crate) fn resolve_principal(state: &AppState, headers: &HeaderMap) -> Result<Principal, AppError> {
    let presented = bearer(headers);
    if presented.is_empty() {
        return Err(AppError::unauthorized("缺少 Authorization: Bearer <token>"));
    }

    if presented.starts_with(TOKEN_PREFIX) {
        let row = state
            .tokens
            .verify(presented)?
            .ok_or_else(|| AppError::unauthorized("令牌无效或已撤销"))?;
        // Usage stamp is best-effort telemetry, not part of the check.
        state.tokens.touch(&row.id);
        return Ok(Principal::Token {
            id: row.id,
            scope: row.scope,
            permissions: serde_json::from_str(&row.permissions).unwrap_or_default(),
        });
    }

    let claims = decode::<Claims>(
        presented,
        &DecodingKey::from_secret(state.auth.jwt_secret().as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::unauthorized("令牌无效"))?
    .claims;
    let user = state.auth.load_auth_user(claims.uid)?;
    if user.username != claims.sub {
        return Err(AppError::unauthorized("令牌无效"));
    }
    Ok(Principal::User(Box::new(user)))
}

// ─────────────────────────── tool catalog ───────────────────────────

#[derive(Clone, Copy)]
enum ToolId {
    PanelInfo,
    SystemOverview,
    ContainerList,
    ContainerStatus,
    ContainerStart,
    ContainerStop,
    ContainerRestart,
    ContainerLogs,
    GatewayStatus,
    GatewayLogs,
    GatewayReload,
    CaddyfileGet,
    CaddyfilePut,
    LogSourceList,
    LogTail,
    AutomationTaskList,
    AutomationTaskRun,
    MemberList,
    PortList,
    NotifyChannels,
    NotifySend,
    DeployPlan,
    DeployApply,
    DeployList,
    DeployJobList,
    DeployJobGet,
    DeployJobCreate,
    DeployJobPutScript,
    DeployJobPutFile,
    DeployJobRun,
    DeployJobLog,
}

struct ToolDef {
    name: &'static str,
    description: &'static str,
    /// Permission required to even see the tool. Empty = always available.
    permission: &'static str,
    schema: fn() -> Value,
    id: ToolId,
}

/// 这个工具是"看"还是"改"。
///
/// 不能只看权限名结尾：`ops_container_logs` 用的是 `ops.service.log`、
/// `ops_member_list` 用的是 `ops.member.manage`，按 `.read` 判断会把两个只读工具
/// 标成可写。所以按工具本身的性质判断 —— 名字里带 list/get/status/info/logs/tail/overview
/// 的就是只读。
fn tool_level(t: &ToolDef) -> &'static str {
    if t.permission.is_empty() {
        return "read";
    }
    let readish = ["_list", "_get", "_status", "_info", "_logs", "_tail", "_overview"]
        .iter()
        .any(|s| t.name.ends_with(s));
    if readish {
        "read"
    } else {
        "write"
    }
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

/// 这次调用是谁发起的。部署记录里要落下"谁部署的"，所以令牌也翻成人能认的名字。
fn principal_actor(state: &AppState, principal: &Principal) -> (String, &'static str) {
    match principal {
        Principal::Token { id, .. } => {
            let name = state
                .tokens
                .list()
                .ok()
                .and_then(|list| list.into_iter().find(|t| &t.id == id).map(|t| t.name))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("token:{}", &id[..id.len().min(8)]));
            (name, "agent")
        }
        Principal::User(u) => (u.username.clone(), "user"),
    }
}

/// 记账用的名字：agent 令牌显示令牌名，面板用户显示用户名。
pub(crate) fn principal_label(state: &AppState, principal: &Principal) -> String {
    principal_actor(state, principal).0
}

fn deploy_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "服务名，同时是目录名和容器名，只能用 a-z 0-9 - _" },
            "compose": { "type": "string", "description": "完整的 docker-compose.yml 内容" },
            "files": {
                "type": "array",
                "description": "一起写进部署目录的文件（Dockerfile、configs 等）。路径必须是相对路径。",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["name", "compose"],
        "additionalProperties": false
    })
}

fn container_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "容器名或 ID，例如 caddy" }
        },
        "required": ["id"],
        "additionalProperties": false
    })
}

fn tool_catalog() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "ops_panel_info",
            description: "面板自身信息：版本、当前凭证的权限范围、可用工具数量。用于确认连通性与授权范围。",
            permission: "",
            schema: empty_schema,
            id: ToolId::PanelInfo,
        },
        ToolDef {
            name: "ops_system_overview",
            description: "服务器实时负载：CPU、内存、Swap、磁盘、网络、负载均值与进程数。排障第一步先看它。",
            permission: OPS_SYSTEM_READ,
            schema: empty_schema,
            id: ToolId::SystemOverview,
        },
        ToolDef {
            name: "ops_container_list",
            description: "列出全部 Docker 容器（名称、镜像、状态、端口）。",
            permission: OPS_SERVICE_READ,
            schema: empty_schema,
            id: ToolId::ContainerList,
        },
        ToolDef {
            name: "ops_container_status",
            description: "Docker 引擎是否可用及版本。",
            permission: OPS_SERVICE_READ,
            schema: empty_schema,
            id: ToolId::ContainerStatus,
        },
        ToolDef {
            name: "ops_container_start",
            description: "启动一个已停止的容器。会改变线上状态。",
            permission: OPS_SERVICE_CONTROL,
            schema: container_schema,
            id: ToolId::ContainerStart,
        },
        ToolDef {
            name: "ops_container_stop",
            description: "停止容器。会中断该容器提供的服务，执行前务必让用户确认。",
            permission: OPS_SERVICE_CONTROL,
            schema: container_schema,
            id: ToolId::ContainerStop,
        },
        ToolDef {
            name: "ops_container_restart",
            description: "重启容器。会短暂中断服务，执行前务必让用户确认。",
            permission: OPS_SERVICE_CONTROL,
            schema: container_schema,
            id: ToolId::ContainerRestart,
        },
        ToolDef {
            name: "ops_container_logs",
            description: "读取容器最近日志（默认 100 行），用于定位崩溃/报错。",
            permission: OPS_SERVICE_LOG,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "容器名或 ID" },
                        "tail": { "type": "integer", "description": "返回多少行，默认 100，上限 5000" }
                    },
                    "required": ["id"],
                    "additionalProperties": false
                })
            },
            id: ToolId::ContainerLogs,
        },
        ToolDef {
            name: "ops_gateway_status",
            description: "Caddy 网关状态（是否在跑、版本、配置文件路径）。",
            permission: OPS_GATEWAY_READ,
            schema: empty_schema,
            id: ToolId::GatewayStatus,
        },
        ToolDef {
            name: "ops_gateway_logs",
            description: "读 Caddy 网关自己的日志（默认 300 行）。站点 502、证书签发失败时先看这里。",
            permission: OPS_GATEWAY_READ,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "tail": { "type": "integer", "description": "返回多少行，默认 300，上限 5000" }
                    },
                    "additionalProperties": false
                })
            },
            id: ToolId::GatewayLogs,
        },
        ToolDef {
            name: "ops_gateway_reload",
            description: "重载 Caddy 配置。改完 Caddyfile 后调用；配置写错会导致站点 502。",
            permission: OPS_GATEWAY_CONTROL,
            schema: empty_schema,
            id: ToolId::GatewayReload,
        },
        ToolDef {
            name: "ops_caddyfile_get",
            description: "读取当前 Caddyfile 原文。改配置前先取一份做备份/对比。",
            permission: OPS_GATEWAY_READ,
            schema: empty_schema,
            id: ToolId::CaddyfileGet,
        },
        ToolDef {
            name: "ops_caddyfile_put",
            description: "用新内容整体替换 Caddyfile（不会自动重载）。影响所有域名，必须让用户确认后再调用。",
            permission: OPS_GATEWAY_WRITE,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "content": { "type": "string", "description": "完整的 Caddyfile 文本" }
                    },
                    "required": ["content"],
                    "additionalProperties": false
                })
            },
            id: ToolId::CaddyfilePut,
        },
        ToolDef {
            name: "ops_log_source_list",
            description: "已登记的应用日志文件列表（含路径），路径用于 ops_log_tail。",
            permission: OPS_LOG_READ,
            schema: empty_schema,
            id: ToolId::LogSourceList,
        },
        ToolDef {
            name: "ops_log_tail",
            description: "读取服务器上某个日志文件的末尾若干行。",
            permission: OPS_LOG_READ,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "日志文件的绝对路径" },
                        "lines": { "type": "integer", "description": "返回多少行，默认 200" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                })
            },
            id: ToolId::LogTail,
        },
        ToolDef {
            name: "ops_automation_task_list",
            description: "列出已配置的定时任务（名称、cron 表达式、最近/下次执行时间）。",
            permission: OPS_AUTOMATION_MANAGE,
            schema: empty_schema,
            id: ToolId::AutomationTaskList,
        },
        ToolDef {
            name: "ops_automation_task_run",
            description: "立刻执行某个定时任务（在服务器上跑它配置的 shell 命令）。属于破坏性操作，先确认。",
            permission: OPS_AUTOMATION_MANAGE,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "任务 ID，来自 ops_automation_task_list" }
                    },
                    "required": ["id"],
                    "additionalProperties": false
                })
            },
            id: ToolId::AutomationTaskRun,
        },
        ToolDef {
            name: "ops_member_list",
            description: "面板成员及其角色与权限。",
            permission: OPS_MEMBER_MANAGE,
            schema: empty_schema,
            id: ToolId::MemberList,
        },
        ToolDef {
            name: "ops_port_list",
            description: "宿主机上正在监听的 TCP 端口、占用它们的进程或容器，以及几个空出来的端口。部署新服务前先问这个，别撞端口。",
            permission: OPS_SYSTEM_READ,
            schema: empty_schema,
            id: ToolId::PortList,
        },
        ToolDef {
            name: "ops_notify_channel_list",
            description: "已配置的通知渠道（飞书 / 钉钉 / 企业微信 / Slack 等）及其订阅的事件。",
            permission: OPS_NOTIFY_MANAGE,
            schema: empty_schema,
            id: ToolId::NotifyChannels,
        },
        ToolDef {
            name: "ops_notify_send",
            description: "往订阅了该事件的渠道推一条通知（部署完成、故障处理完等）。事件取值见 ops_notify_channel_list。",
            permission: OPS_NOTIFY_MANAGE,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "event": { "type": "string", "description": "deploy / container / pressure / test" },
                        "title": { "type": "string", "description": "标题，一行" },
                        "text": { "type": "string", "description": "正文，说清做了什么、结果如何" }
                    },
                    "required": ["event", "title", "text"],
                    "additionalProperties": false
                })
            },
            id: ToolId::NotifySend,
        },
        ToolDef {
            name: "ops_deploy_list",
            description: "这台机器上已部署过哪些服务（部署目录 + 是否在运行）。部署前先看一眼，别重名。",
            permission: OPS_SYSTEM_READ,
            schema: empty_schema,
            id: ToolId::DeployList,
        },
        ToolDef {
            name: "ops_deploy_plan",
            description: "部署体检：端口是否被占、有没有重启策略/日志轮转/时区/网络、有没有明文凭据。只读，不落任何文件。apply 之前必须先跑这个。",
            permission: OPS_SYSTEM_READ,
            schema: deploy_schema,
            id: ToolId::DeployPlan,
        },
        ToolDef {
            name: "ops_deploy_apply",
            description: "把 compose 和附带文件写到部署目录并执行 docker compose up -d --build。会新增服务、占端口、落文件 —— 执行前要让用户确认。体检有 block 项时会被拒绝。",
            permission: OPS_DEPLOY,
            schema: deploy_schema,
            id: ToolId::DeployApply,
        },
        // ── 部署任务通道 ──
        //
        // 部署 = 一个目录 + 产物 + 脚本 + 记录。手动（面板三步走）和 agent 走的是
        // 同一批记录，agent 照这个顺序来：create → put_file → put_script → run → log。
        ToolDef {
            name: "ops_deploy_job_list",
            description: "列部署任务：服务名、部署目录、状态、绑定的容器、最近一次结果。",
            permission: OPS_SYSTEM_READ,
            schema: empty_schema,
            id: ToolId::DeployJobList,
        },
        ToolDef {
            name: "ops_deploy_job_get",
            description: "看一个部署任务的详情：部署脚本、已上传的产物、最近几次执行记录。",
            permission: OPS_SYSTEM_READ,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "服务名，例如 zenceglow-web" }
                    },
                    "required": ["name"],
                    "additionalProperties": false
                })
            },
            id: ToolId::DeployJobGet,
        },
        ToolDef {
            name: "ops_deploy_job_create",
            description: "建一个部署任务：创建 /opt/docker-apps/<name>/ 并**按规范写好骨架**——docker-compose.yml（网络 local、restart always、TZ、日志轮转；backend 发布一个宿主端口，frontend 不发布）、Dockerfile、deploy.sh（同时落库成这个任务的脚本）。目录里已有的文件不会覆盖。kind 传 backend（默认）或 frontend；port 留空会自动挑一个空着的（8000-9999）。",
            permission: OPS_DEPLOY,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "服务名，同时是目录名和容器名；只能用 a-z 0-9 - _" },
                "note": { "type": "string", "description": "这次部署是干什么的，一句话" }
                        ,
                        "kind": { "type": "string", "description": "frontend（静态站，不发布宿主端口）或 backend（发布一个宿主端口），默认 backend" },
                        "port": { "type": "integer", "description": "后端要发布的宿主端口；留空会自动从 8000-9999 里挑一个空着的" }
                    },
                    "required": ["name"],
                    "additionalProperties": false
                })
            },
            id: ToolId::DeployJobCreate,
        },
        ToolDef {
            name: "ops_deploy_job_put_script",
            description: "写这个部署任务的部署脚本（在 /opt/docker-apps/<name>/ 里以 sh -c 执行，脚本开头等于加了 set -e）。",
            permission: OPS_DEPLOY,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "script": { "type": "string", "description": "部署脚本正文" }
                    },
                    "required": ["name", "script"],
                    "additionalProperties": false
                })
            },
            id: ToolId::DeployJobPutScript,
        },
        ToolDef {
            name: "ops_deploy_job_put_file",
            description: "往部署目录里写一个文本产物（配置文件、小脚本、compose 等）。二进制产物（tgz/dmg/镜像包）走 HTTP：curl -T 文件 -H \"Authorization: Bearer <token>\" \"https://<面板>/api/ops/deploy/job/upload?id=<name>&path=<相对路径>\"。",
            permission: OPS_DEPLOY,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "path": { "type": "string", "description": "部署目录内的相对路径，例如 docker-compose.yml 或 conf/app.yaml" },
                        "content": { "type": "string", "description": "文件正文（文本）" }
                    },
                    "required": ["name", "path", "content"],
                    "additionalProperties": false
                })
            },
            id: ToolId::DeployJobPutFile,
        },
        ToolDef {
            name: "ops_deploy_job_run",
            description: "执行部署脚本。会改线上状态，执行前要让用户确认。返回 run_id 后用 ops_deploy_job_log 拉进度。",
            permission: OPS_DEPLOY,
            schema: || {
                json!({
                    "type": "object",
                    "properties": { "name": { "type": "string" } },
                    "required": ["name"],
                    "additionalProperties": false
                })
            },
            id: ToolId::DeployJobRun,
        },
        ToolDef {
            name: "ops_deploy_job_log",
            description: "增量拉一次部署的日志（部署进度）。传上一次返回的 offset 接着拉，finished=true 就是跑完了。",
            permission: OPS_SYSTEM_READ,
            schema: || {
                json!({
                    "type": "object",
                    "properties": {
                        "run_id": { "type": "string", "description": "ops_deploy_job_run 返回的 run_id" },
                        "offset": { "type": "integer", "description": "从哪个字节开始读，默认 0" }
                    },
                    "required": ["run_id"],
                    "additionalProperties": false
                })
            },
            id: ToolId::DeployJobLog,
        },
    ]
}

// ─────────────────────────── argument helpers ───────────────────────────

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少必填参数 `{key}`（字符串）"))
}

fn opt_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

/// deploy 系列工具的入参。compose 是一段文本，走 serde 反序列化最省事，
/// 也能让 `files` 缺省时自动为空。
fn deploy_input(args: &Value) -> Result<crate::service::deploy::DeployInput, AppError> {
    serde_json::from_value(args.clone())
        .map_err(|e| AppError::bad_request(format!("参数不对: {e}")))
}

// ─────────────────────────── tool dispatch ───────────────────────────

async fn call_tool(state: &AppState, principal: &Principal, name: &str, args: &Value) -> Value {
    let def = match tool_catalog().into_iter().find(|t| t.name == name) {
        Some(d) => d,
        None => return mcp::tool_error(format!("未知工具：{name}")),
    };

    if !principal.has(def.permission) {
        return mcp::tool_error(format!(
            "当前凭证没有权限调用 {name}（需要 {}）。只读令牌需要写权限时，请在面板「接入 Codex」里新建 write 令牌。",
            def.permission
        ));
    }

    // `?` inside the arms must land on this block, not on `call_tool` — the
    // function returns a tool payload, so failures become `isError` content.
    let out: Result<Value, AppError> = async {
        match def.id {
        ToolId::PanelInfo => Ok(json!({
            "name": mcp::SERVER_NAME,
            "version": mcp::SERVER_VERSION,
            "protocol_version": mcp::PROTOCOL_VERSION,
            "credential_scope": principal.scope(),
            "available_tools": tool_catalog()
                .iter()
                .filter(|t| principal.has(t.permission))
                .count(),
            // 身份指纹：agent 汇报任何"这台机器"的事实前，先把这几项说出来。
            // 版本不对 = 连的是另一个（旧的）面板；started_at 不对 = 不是同一个进程。
            "host": crate::shared::panel::identity(),
        })),
        ToolId::SystemOverview => Ok(serde_json::to_value(state.system.overview()).unwrap_or(Value::Null)),
        ToolId::ContainerList => Ok(
            serde_json::to_value(state.containers.list().await?).unwrap_or(Value::Null),
        ),
        ToolId::ContainerStatus => {
            Ok(serde_json::to_value(state.containers.status()).unwrap_or(Value::Null))
        }
        ToolId::ContainerStart => {
            let id = require_str(args, "id").map_err(AppError::bad_request)?;
            state.containers.start(&id).await?;
            Ok(json!({ "ok": true, "action": "start", "container": id }))
        }
        ToolId::ContainerStop => {
            let id = require_str(args, "id").map_err(AppError::bad_request)?;
            state.containers.stop(&id).await?;
            Ok(json!({ "ok": true, "action": "stop", "container": id }))
        }
        ToolId::ContainerRestart => {
            let id = require_str(args, "id").map_err(AppError::bad_request)?;
            state.containers.restart(&id).await?;
            Ok(json!({ "ok": true, "action": "restart", "container": id }))
        }
        ToolId::ContainerLogs => {
            let id = require_str(args, "id").map_err(AppError::bad_request)?;
            let tail = opt_usize(args, "tail", 100).min(5000);
            state.containers.logs(&id, tail).await
        }
        ToolId::GatewayStatus => {
            Ok(serde_json::to_value(state.gateway.status()).unwrap_or(Value::Null))
        }
        ToolId::GatewayLogs => {
            let tail = opt_usize(args, "tail", 300).min(5000);
            Ok(serde_json::to_value(state.gateway.logs(tail)).unwrap_or(Value::Null))
        }
        ToolId::GatewayReload => {
            state.gateway.reload()?;
            Ok(json!({ "ok": true, "action": "reload" }))
        }
        ToolId::CaddyfileGet => Ok(serde_json::to_value(state.caddyfile.get().await?).unwrap_or(Value::Null)),
        ToolId::CaddyfilePut => {
            let content = require_str(args, "content").map_err(AppError::bad_request)?;
            state.caddyfile.update(content).await
        }
        ToolId::LogSourceList => Ok(json!({ "sources": state.logs.list_sources()? })),
        ToolId::LogTail => {
            let path = require_str(args, "path").map_err(AppError::bad_request)?;
            let lines = opt_usize(args, "lines", 200).min(2000);
            Ok(serde_json::to_value(state.logs.tail_file(&path, lines).await?).unwrap_or(Value::Null))
        }
        ToolId::AutomationTaskList => Ok(json!({ "tasks": state.automation.list_tasks()? })),
        ToolId::AutomationTaskRun => {
            let id = require_str(args, "id").map_err(AppError::bad_request)?;
            let task = state.automation.get_task(&id)?;
            // Same execution bookkeeping the panel uses, including the
            // background shell run so the HTTP call returns immediately.
            let exec = state.automation.record_execution(&id, "", "running", 0)?;
            let exec_id = exec.id.clone();
            let svc = state.automation.clone();
            let command = task.command.clone();
            tokio::spawn(async move {
                let output = execute_command(&command).await;
                let status = if output.starts_with("[ERROR]") { "failed" } else { "success" };
                let _ = svc.update_execution(&exec_id, status, Some(&output));
            });
            state.automation.mark_task_run(&id, &task.cron_expr).ok();
            Ok(json!({
                "ok": true,
                "execution_id": exec.id,
                "task": task.name,
                "command": task.command,
                "note": "已在后台执行，可用面板「自动化」页查看输出"
            }))
        }
        ToolId::MemberList => Ok(json!({ "members": state.members.list()? })),
        ToolId::PortList => {
            let listeners = crate::infrastructure::system::listeners();
            let used: std::collections::HashSet<u16> = listeners.iter().map(|p| p.port).collect();
            Ok(json!({
                "listeners": listeners,
                "suggested": crate::infrastructure::system::suggest_free(&used, 8000, 9999, 8),
            }))
        }
        ToolId::NotifyChannels => Ok(json!({ "channels": state.notify.list()? })),
        ToolId::NotifySend => {
            let event = require_str(args, "event").map_err(AppError::bad_request)?;
            if !crate::service::notify::is_known_event(&event) {
                return Err(AppError::bad_request(format!("不认识的事件: {event}")));
            }
            let title = require_str(args, "title").map_err(AppError::bad_request)?;
            let text = require_str(args, "text").map_err(AppError::bad_request)?;
            let (sent, ok) = state.notify.broadcast(&event, &title, &text).await;
            Ok(json!({ "sent": sent, "delivered": ok }))
        }
        ToolId::DeployList => Ok(json!({ "services": state.deploy.list() })),
        ToolId::DeployPlan => {
            let input = deploy_input(args)?;
            Ok(serde_json::to_value(state.deploy.plan(&input)?).unwrap_or(Value::Null))
        }
        ToolId::DeployApply => {
            let input = deploy_input(args)?;
            Ok(serde_json::to_value(state.deploy.apply(input).await?).unwrap_or(Value::Null))
        }
        // ── 部署任务通道 ──
        ToolId::DeployJobList => {
            Ok(json!({ "jobs": state.deploy_jobs.list()? }))
        }
        ToolId::DeployJobGet => {
            let name = require_str(args, "name").map_err(AppError::bad_request)?;
            let job = state.deploy_jobs.get_by_ref(&name)?;
            let runs = state.deploy_jobs.runs(&job.id, 10)?;
            Ok(json!({ "job": job, "runs": runs }))
        }
        ToolId::DeployJobCreate => {
            let name = require_str(args, "name").map_err(AppError::bad_request)?;
            let note = args.get("note").and_then(Value::as_str).unwrap_or_default();
            let kind = args
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("backend");
            let port = args.get("port").and_then(Value::as_u64).map(|p| p as u16);
            let (actor, actor_kind) = principal_actor(state, principal);
            let job = state
                .deploy_jobs
                .create(&name, note, "agent", &actor, actor_kind, kind, port)?;
            Ok(json!({ "job": job }))
        }
        ToolId::DeployJobPutScript => {
            let name = require_str(args, "name").map_err(AppError::bad_request)?;
            let script = require_str(args, "script").map_err(AppError::bad_request)?;
            let job = state.deploy_jobs.get_by_ref(&name)?;
            Ok(json!({ "job": state.deploy_jobs.save_script(&job.id, &script)? }))
        }
        ToolId::DeployJobPutFile => {
            let name = require_str(args, "name").map_err(AppError::bad_request)?;
            let path = require_str(args, "path").map_err(AppError::bad_request)?;
            let content = args.get("content").and_then(Value::as_str).unwrap_or_default();
            let (actor, _) = principal_actor(state, principal);
            let job = state.deploy_jobs.get_by_ref(&name)?;
            Ok(json!({
                "job": state.deploy_jobs.upload(&job.id, &path, content.as_bytes(), &actor)?
            }))
        }
        ToolId::DeployJobRun => {
            let name = require_str(args, "name").map_err(AppError::bad_request)?;
            let (actor, kind) = principal_actor(state, principal);
            let job = state.deploy_jobs.get_by_ref(&name)?;
            let run = state.deploy_jobs.run(&job.id, &actor, kind).await?;
            Ok(json!({
                "run": run,
                "note": "脚本在后台跑，用 ops_deploy_job_log 带上 run_id 拉进度"
            }))
        }
        ToolId::DeployJobLog => {
            let run_id = require_str(args, "run_id").map_err(AppError::bad_request)?;
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
            Ok(serde_json::to_value(state.deploy_jobs.run_log(&run_id, offset).await?)
                .unwrap_or(Value::Null))
        }
        }
    }
    .await;

    match out {
        // 每个成功回包都带上身份指纹（只给对象结果附，数组/标量不硬塞）。
        // 数据自带出处 —— 谁读这份数据，都能说清它来自哪台机器、哪个版本、哪个进程。
        Ok(value) => {
            let mut value = value;
            if let Some(obj) = value.as_object_mut() {
                obj.insert("_host".into(), crate::shared::panel::identity());
            }
            mcp::tool_json(&value)
        }
        Err(err) => mcp::tool_error(err.message),
    }
}

// ─────────────────────────── JSON-RPC handling ───────────────────────────

fn json_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn rpc_error(status: StatusCode, id: Value, code: i64, message: impl Into<String>) -> Response {
    json_response(status, mcp::error(id, code, message))
}

/// 技能包作为 MCP `resources` 暴露。
///
/// 以前"技能"只能靠人在面板上复制一段 shell，把它写进 agent 的技能目录 —— 连接本身
/// 是哑的：client 读完 `initialize` + `tools/list` 就走了，永远不知道还有部署剧本和
/// 排障剧本。走 resources 之后，连接一建好 agent 就能自己读到，也不用担心技能里的
/// 工具名和 `tools/list` 对不上。
const SKILL_RESOURCES: &[(&str, &str, &str)] = &[
    (
        "skill://zops/SKILL.md",
        "ZOPS 技能",
        "怎么用这些工具干活：侦察顺序、哪些动作要先确认、输出怎么读",
    ),
    (
        "skill://zops/references/deploy",
        "部署剧本",
        "把项目部署到这台机器上的既有习惯：端口、网络、日志、反代",
    ),
    (
        "skill://zops/references/troubleshooting",
        "排障剧本",
        "磁盘满 / 容器反复重启 / 502 / 证书 / 内存 / Caddyfile 回滚",
    ),
];

fn skill_text(uri: &str) -> Option<&'static str> {
    match uri {
        "skill://zops/SKILL.md" => Some(crate::domain::mcp::SKILL_CONTENT),
        "skill://zops/references/deploy" => Some(crate::domain::mcp::SKILL_REF_DEPLOY),
        "skill://zops/references/troubleshooting" => {
            Some(crate::domain::mcp::SKILL_REF_TROUBLESHOOTING)
        }
        _ => None,
    }
}

async fn handle_rpc(state: &AppState, principal: &Principal, req: RpcRequest, ip: &str) -> Response {
    // Notifications carry no id and must not be answered.
    let Some(id) = req.id.clone() else {
        return StatusCode::ACCEPTED.into_response();
    };

    match req.method.as_str() {
        "initialize" => {
            let requested = req
                .params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(mcp::PROTOCOL_VERSION);
            json_response(
                StatusCode::OK,
                mcp::result(
                    id,
                    json!({
                        "protocolVersion": mcp::supported_protocol_version(requested),
                        "capabilities": {
                            "tools": { "listChanged": false },
                            // 技能包走 resources，连接建好就能读 —— 不用再让人复制一段
                            // shell 去装技能目录。subscribe 不开：技能是编译进二进制的。
                            "resources": { "subscribe": false, "listChanged": false }
                        },
                        "serverInfo": { "name": mcp::SERVER_NAME, "version": mcp::SERVER_VERSION },
                        // 一开口就报身份：客户端缓存了旧连接时，这一行会立刻露馅。
                        "host": crate::shared::panel::identity(),
                        "instructions": mcp::INSTRUCTIONS
                    }),
                ),
            )
        }
        "ping" => json_response(StatusCode::OK, mcp::result(id, json!({}))),
        "resources/list" => {
            let resources: Vec<Value> = SKILL_RESOURCES
                .iter()
                .map(|(uri, name, description)| {
                    json!({
                        "uri": uri,
                        "name": name,
                        "description": description,
                        "mimeType": "text/markdown"
                    })
                })
                .collect();
            json_response(
                StatusCode::OK,
                mcp::result(id, json!({ "resources": resources })),
            )
        }
        "resources/read" => {
            let uri = req
                .params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match skill_text(uri) {
                Some(text) => json_response(
                    StatusCode::OK,
                    mcp::result(
                        id,
                        json!({
                            "contents": [{
                                "uri": uri,
                                "mimeType": "text/markdown",
                                "text": text
                            }]
                        }),
                    ),
                ),
                None => rpc_error(
                    StatusCode::OK,
                    id,
                    mcp::INVALID_PARAMS,
                    format!("不认识的 resource：{uri}"),
                ),
            }
        }
        "tools/list" => {
            let tools: Vec<Value> = tool_catalog()
                .into_iter()
                // Hide what this credential cannot call: an agent that never
                // sees a tool cannot be tempted to misuse it.
                .filter(|t| principal.has(t.permission))
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": (t.schema)()
                    })
                })
                .collect();
            json_response(StatusCode::OK, mcp::result(id, json!({ "tools": tools })))
        }
        "tools/call" => {
            let name = match req.params.get("name").and_then(Value::as_str) {
                Some(n) => n.to_string(),
                None => {
                    return rpc_error(
                        StatusCode::OK,
                        id,
                        mcp::INVALID_PARAMS,
                        "tools/call 需要参数 name",
                    )
                }
            };
            let args = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = call_tool(state, principal, &name, &args).await;
            audit_tool_call(state, principal, &name, &args, &result, &ip);
            json_response(StatusCode::OK, mcp::result(id, result))
        }
        other => rpc_error(
            StatusCode::OK,
            id,
            mcp::METHOD_NOT_FOUND,
            format!("不支持的方法：{other}"),
        ),
    }
}

async fn mcp_post(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ip = crate::service::audit::client_ip(&headers, Some(addr));
    let principal = match resolve_principal(&state, &headers) {
        Ok(p) => p,
        Err(err) => {
            return json_response(
                StatusCode::UNAUTHORIZED,
                mcp::error(Value::Null, mcp::INVALID_REQUEST, err.message),
            )
        }
    };

    let req: RpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return rpc_error(
                StatusCode::BAD_REQUEST,
                Value::Null,
                mcp::PARSE_ERROR,
                format!("请求不是合法 JSON：{e}"),
            )
        }
    };

    handle_rpc(&state, &principal, req, &ip).await
}

/// agent 的工具调用留痕。
///
/// 只记会改状态的工具：`ops_system_overview` 这种只读的，一个 agent 一次排障能调
/// 十几次，全记下来会把"谁重启了容器"这类真正要紧的行淹掉。判断依据是 `tool_level()`
/// —— 它按工具名判断，比看权限名结尾靠谱（`ops_member_list` 用的就是 `.manage`）。
fn audit_tool_call(
    state: &AppState,
    principal: &Principal,
    tool: &str,
    args: &Value,
    result: &Value,
    ip: &str,
) {
    let Some(def) = tool_catalog().into_iter().find(|t| t.name == tool) else {
        return;
    };
    // 读调用也记。
    //
    // 以前只记写操作，理由是"一次排障能调十几次只读工具，会把要紧的行淹掉"。但
    // MCP 页上要的是"这个 agent 到底干了什么"的完整流水 —— 只记写操作，用户看到的
    // 是一段段断掉的历史。面板的审计接口照旧支持按 level 过滤，真嫌吵的时候过滤就行。
    let level = tool_level(&def);

    // 日志里写令牌的名字而不是 id：出事时看的是"哪个 agent 干的"。
    let (actor, kind) = principal_actor(state, principal);

    let failed = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let detail = crate::service::audit::summarize_body(&serde_json::to_vec(args).unwrap_or_default());
    state.audit.record(
        &actor,
        kind,
        ip,
        "MCP",
        tool,
        if failed { 500 } else { 200 },
        &format!(
            "MCP {} {tool}",
            if level == "write" { "写操作" } else { "只读查询" }
        ),
        &detail,
        0,
    );
}

/// MCP allows servers to skip the optional SSE stream. Answering 405 is
/// spec-compliant and keeps clients on the POST path.
async fn mcp_get() -> Response {
    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": -32600,
                "message": "本服务只支持 POST 的 JSON-RPC（未开 SSE 流）"
            }
        }),
    )
}

// ─────────────────────────── skill pack ───────────────────────────

async fn skill(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    // Any authenticated credential may read the skill pack. It is documentation
    // that ships in the repo, not a secret — gating it behind `ops.agent.manage`
    // would mean a read-only token could drive the MCP but not learn how to.
    let _ = resolve_principal(&state, &headers)?;
    Ok(Json(json!({
        "name": crate::domain::mcp::SKILL_NAME,
        "filename": "SKILL.md",
        "content": crate::domain::mcp::SKILL_CONTENT,
    })))
}

/// Raw markdown, so the install one-liner can pipe it straight into a file:
/// `curl -H "Authorization: Bearer ops_…" …/skill/raw > ~/.agents/skills/…`
async fn skill_raw(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let _ = resolve_principal(&state, &headers)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        crate::domain::mcp::SKILL_CONTENT,
    )
        .into_response())
}

/// 工具目录的面板视角。
///
/// MCP 自己的 `tools/list` 要 agent 令牌，面板页面用不了；而"这个技能能让 agent
/// 干什么"恰恰是用户最该看见的东西，所以单独开一个走面板 JWT 的只读接口。
async fn tool_list(
    State(_state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<crate::shared::ApiResponse<serde_json::Value>>, AppError> {
    let tools: Vec<serde_json::Value> = tool_catalog()
        .into_iter()
        .filter(|t| t.permission.is_empty() || user.has(t.permission))
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                // read 只读、write 要写权限：界面上用不同颜色区分，用户一眼知道
                // 哪些动作是 agent 能直接改服务器状态的。
                "level": tool_level(&t),
            })
        })
        .collect();
    // 必须套统一外壳：前端取的是 `{success, data}`，裸对象会让页面拿不到数据
    // —— /skill 就踩过一次同样的坑。
    Ok(Json(crate::shared::ApiResponse::ok(json!({ "tools": tools }))))
}

/// 挂在面板 JWT 组里（见 http/mod.rs），由鉴权中间件负责认证。
pub fn catalog_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/tools", get(tool_list))
        .route("/ops", get(agent_ops))
}

#[derive(Deserialize)]
pub struct AgentOpsQuery {
    #[serde(default)]
    limit: Option<i64>,
}

/// agent 在这个面板上干过什么 —— MCP 页的"操作日志"。
///
/// 数据就是审计日志里 `actor_kind = agent` 的那些行（MCP 是目前唯一的 agent 入口），
/// 这里额外把工具的读写级别算出来：一眼能看出哪几行动了服务器。
///
/// 要 `nav.agent`：这是看"agent 干了什么"的入口，能打开 MCP 页的人就该看得到它干过什么。
async fn agent_ops(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<AgentOpsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    if !user.has(crate::domain::permission::NAV_AGENT) {
        return Err(AppError::forbidden("没有权限查看 agent 的操作记录"));
    }
    let limit = q.limit.unwrap_or(120).clamp(1, 500);
    let catalog = tool_catalog();
    let ops: Vec<Value> = state
        .audit
        .list(limit, Some("agent"))?
        .into_iter()
        .filter(|r| r.method == "MCP")
        .map(|r| {
            let level = catalog
                .iter()
                .find(|t| t.name == r.path)
                .map(tool_level)
                .unwrap_or("write");
            json!({
                "id": r.id,
                "at": r.at,
                "actor": r.actor,
                "tool": r.path,
                "level": level,
                "ok": r.status < 400,
                "summary": r.summary,
                "detail": r.detail,
            })
        })
        .collect();
    Ok(Json(ApiResponse::ok(json!(ops))))
}

pub fn mcp_routes() -> Router<Arc<AppState>> {
    Router::new().route("/", post(mcp_post).get(mcp_get))
}

pub fn skill_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(skill))
        .route("/raw", get(skill_raw))
        .route("/references/troubleshooting", get(skill_troubleshooting))
        .route("/references/deploy", get(skill_deploy))
}

/// Referenced by SKILL.md, so the install one-liner has to fetch it too —
/// otherwise the agent gets a skill that points at a file nobody copied.
async fn skill_troubleshooting(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let _ = resolve_principal(&state, &headers)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        crate::domain::mcp::SKILL_REF_TROUBLESHOOTING,
    )
        .into_response())
}

/// 部署剧本，同样由安装命令一并抓下来。
async fn skill_deploy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let _ = resolve_principal(&state, &headers)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        crate::domain::mcp::SKILL_REF_DEPLOY,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `resources/list` 里报出来的每一条都必须真读得到 —— 报了一条读不出的，
    /// agent 就会拿着一份读不到的文件名去伸手。
    #[test]
    fn 列出来的技能资源都读得到() {
        for (uri, name, _) in SKILL_RESOURCES {
            assert!(!name.is_empty(), "{uri} 没有名字");
            assert!(skill_text(uri).is_some(), "{uri} 列了却读不到");
        }
        assert!(skill_text("skill://zops/nope").is_none());
    }
}
