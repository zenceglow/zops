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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 上架用的连接器包。它需要一份自己的 `skills/zops/` 拷贝，而 `include_str!`
    /// 让仓库根的 `skills/zops/` 成了唯一真源 —— 所以这里几道校验，防的是同一件事：
    /// **包和实现各说各话**。
    fn pack_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("connectors/zops")
    }

    fn read_pack(relative: &str) -> String {
        let path = pack_root().join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "读不到连接器包里的 {}：{e}\n跑 `connectors/package.sh sync` 把包补齐。",
                path.display()
            )
        })
    }

    fn pack_plugin() -> Value {
        serde_json::from_str(&read_pack(".codebuddy-plugin/plugin.json"))
            .expect("连接器包的 plugin.json 不是合法 JSON")
    }

    fn pack_server<'a>(plugin: &'a Value) -> &'a Value {
        &plugin["extensions"]["ai.workbuddy"]["urlTemplatedMcpServers"]["zops"]
    }

    /// 包里的技能正文必须和编进二进制的那份逐字节一致。
    ///
    /// 分叉了不会报任何错，只会让 agent 从 MCP resources 读到一份剧本、照着另一份
    /// 过期剧本操作线上服务器。这种错必须在 `cargo test` 里挡住。
    #[test]
    fn connector_pack_skills_are_byte_identical_to_the_bundled_ones() {
        for (relative, bundled) in [
            ("skills/zops/SKILL.md", SKILL_CONTENT),
            ("skills/zops/references/deploy.md", SKILL_REF_DEPLOY),
            (
                "skills/zops/references/troubleshooting.md",
                SKILL_REF_TROUBLESHOOTING,
            ),
        ] {
            assert_eq!(
                read_pack(relative),
                bundled,
                "包里的 {relative} 和编进二进制的那份不一致，跑 `connectors/package.sh sync`"
            );
        }
    }

    /// 连接器版本跟 `Cargo.toml` 走：它描述的就是这个版本面板提供的工具集。
    /// 两个版本号各说各话，排查问题时会先怀疑版本对不上，白绕一圈。
    #[test]
    fn connector_pack_version_tracks_the_crate_version() {
        assert_eq!(
            pack_plugin()["version"].as_str(),
            Some(SERVER_VERSION),
            "plugin.json 的 version 与 Cargo.toml 不一致，跑 `connectors/package.sh sync`"
        );
    }

    /// `urlTemplate` 必须落在真的在听的那条路径上。
    ///
    /// 路径写错不会提示"配置有误"，只会一直连不上，而排查方向会跑偏到网络和令牌上。
    /// 事实来源是 `http/mod.rs` 的 `.nest("/api/ops/mcp", …)`。
    #[test]
    fn connector_pack_points_at_the_real_mcp_route() {
        let plugin = pack_plugin();
        let server = pack_server(&plugin);

        let template = server["urlTemplate"]
            .as_str()
            .expect("urlTemplate 缺失或不是字符串");
        assert!(
            template.ends_with("/api/ops/mcp"),
            "urlTemplate 没落在 MCP 路由上：{template}"
        );

        assert_eq!(
            server["type"].as_str(),
            Some("streamable-http"),
            "ZOPS 的 MCP 只实现 Streamable HTTP 一种传输"
        );

        // 面板只认 `Authorization: Bearer <token>`（见 handlers::mcp::bearer）。
        // 前缀少个空格是静默 401，最难查。
        assert_eq!(
            server["auth"]["headers"]["Authorization"]["prefix"].as_str(),
            Some("Bearer "),
            "Authorization 的前缀必须是 `Bearer ` —— 注意尾随那个空格"
        );
    }

    /// `urlTemplate` 和 auth 里引用到的每个字段，都必须在 `token-schema.json` 里
    /// 真的有定义。否则用户拿到一张填完也连不上的表单，而错误只会在运行期以
    /// "地址拼错了"的形式出现。
    #[test]
    fn connector_pack_token_placeholders_are_all_askable() {
        let plugin = pack_plugin();
        let schema: Value = serde_json::from_str(&read_pack("ai.workbuddy/token-schema.json"))
            .expect("连接器包的 token-schema.json 不是合法 JSON");

        let declared: Vec<&str> = schema["fields"]
            .as_array()
            .expect("token-schema.json 缺 fields")
            .iter()
            .filter_map(|field| field["key"].as_str())
            .collect();

        let server = pack_server(&plugin);
        let template = server["urlTemplate"].as_str().unwrap();
        let mut wanted: Vec<&str> = template
            .split("${")
            .skip(1)
            .filter_map(|chunk| chunk.split('}').next())
            .collect();
        wanted.push(
            server["auth"]["headers"]["Authorization"]["field"]
                .as_str()
                .expect("auth.headers.Authorization.field 缺失"),
        );

        for key in wanted {
            assert!(
                declared.contains(&key),
                "plugin.json 引用了 ${{{key}}}，但 token-schema.json 只定义了 {declared:?}"
            );
        }
    }
}
