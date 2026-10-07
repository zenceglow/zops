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

    fn pack_meta() -> Value {
        serde_json::from_str(&read_pack("connector-meta.json"))
            .expect("连接器包的 connector-meta.json 不是合法 JSON")
    }

    fn pack_mcp() -> Value {
        serde_json::from_str(&read_pack("mcp.json")).expect("连接器包的 mcp.json 不是合法 JSON")
    }

    /// `mcp.json` 里那唯一一个 Server。规范明说「一个连接器只配置一个 MCP Server」，
    /// 配多了会怎么处理没人知道 —— 所以这里直接要求它只有一个。
    fn pack_server<'a>(mcp: &'a Value) -> &'a Value {
        let servers = mcp["mcpServers"]
            .as_object()
            .expect("mcp.json 缺 mcpServers");
        assert_eq!(
            servers.len(),
            1,
            "一个连接器只能配一个 MCP Server，现在有 {:?}",
            servers.keys().collect::<Vec<_>>()
        );
        servers.values().next().unwrap()
    }

    fn version_tuple(v: &str) -> (u32, u32, u32) {
        let mut parts = v.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
        (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        )
    }

    /// SKILL.md frontmatter 里的 `version`。平台会把它转成
    /// `metadata["ai.workbuddy.version"]`，所以它也是"这个包描述哪个版本"的一部分。
    fn skill_frontmatter_version() -> String {
        let skill = read_pack("skills/zops/SKILL.md");
        let after = skill
            .strip_prefix("---")
            .expect("SKILL.md 开头不是 frontmatter");
        let frontmatter = after.split("\n---").next().expect("frontmatter 没有闭合");
        frontmatter
            .lines()
            .find_map(|line| line.strip_prefix("version:"))
            .map(|v| v.trim().to_string())
            .expect("SKILL.md frontmatter 缺 version")
    }

    /// 包里所有 `mcp.json` 引用到的 `${VAR}`，按出现顺序去重。
    fn mcp_placeholders(mcp: &Value) -> Vec<String> {
        let text = serde_json::to_string(mcp).unwrap();
        let mut found = Vec::new();
        let mut rest = text.as_str();
        while let Some(start) = rest.find("${") {
            rest = &rest[start + 2..];
            let Some(end) = rest.find('}') else { break };
            let key = &rest[..end];
            if !found.iter().any(|k| k == key) {
                found.push(key.to_string());
            }
            rest = &rest[end..];
        }
        found
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

    /// 版本号跟 `Cargo.toml` 走：连接器描述的就是这个版本面板提供的工具集。
    ///
    /// 版本号写在两个地方（元信息和技能 frontmatter），漏掉哪一个都会让"这个包
    /// 对应哪个面板"说不清 —— 排查线上问题时先怀疑版本对不上，白绕一圈。
    #[test]
    fn connector_pack_versions_track_the_crate_version() {
        assert_eq!(
            pack_meta()["version"].as_str(),
            Some(SERVER_VERSION),
            "connector-meta.json 的 version 与 Cargo.toml 不一致，跑 `connectors/package.sh sync`"
        );
        assert_eq!(
            skill_frontmatter_version(),
            SERVER_VERSION,
            "SKILL.md frontmatter 的 version 与 Cargo.toml 不一致，跑 `connectors/package.sh sync`"
        );
    }

    /// `source` 是平台上的全局唯一标识，得等于包目录名、且是 kebab-case。
    /// 顺带把 `auth_mode: token` 和它要求的版本声明一起钉住。
    #[test]
    fn connector_pack_identity_matches_the_spec() {
        let meta = pack_meta();

        let root = pack_root();
        let dir = root
            .file_name()
            .and_then(|n| n.to_str())
            .expect("包目录名读不出来");

        let source = meta["source"].as_str().expect("connector-meta.json 缺 source");
        assert_eq!(source, dir, "source 必须等于包目录名（也是解压后的顶层目录名）");
        assert!(
            source
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "source 只能用小写字母、数字和连字符：{source}"
        );

        assert_eq!(meta["type"].as_str(), Some("mcp"));
        assert_eq!(
            meta["auth_mode"].as_str(),
            Some("token"),
            "ZOPS 用用户自填令牌，不是 OAuth"
        );

        // 官方规范的「版本兼容性」表：examples_zh/en 需要 4.24.0，
        // auth_mode: token 与 token-schema.json 需要 4.23.0。取其中最高的。
        let declared = version_tuple(
            meta["minWorkbuddyVersion"]
                .as_str()
                .expect("用了新字段就必须声明 minWorkbuddyVersion"),
        );
        assert!(
            declared >= (4, 23, 0),
            "auth_mode: token 需要 minWorkbuddyVersion ≥ 4.23.0，现在是 {declared:?}"
        );
        if meta["examples_zh"].is_array() {
            assert!(
                declared >= (4, 24, 0),
                "带中英文示例需要 minWorkbuddyVersion ≥ 4.24.0，现在是 {declared:?}"
            );
        }
    }

    /// `mcp.json` 的 url 必须落在真的在听的那条路径上。
    ///
    /// 路径写错不会提示"配置有误"，只会一直连不上，而排查方向会跑偏到网络和令牌上。
    /// 事实来源是 `http/mod.rs` 的 `.nest("/api/ops/mcp", …)`。
    #[test]
    fn connector_pack_points_at_the_real_mcp_route() {
        let mcp = pack_mcp();
        let server = pack_server(&mcp);

        let url = server["url"].as_str().expect("mcp.json 的 url 缺失");
        assert!(
            url.ends_with("/api/ops/mcp"),
            "url 没落在 MCP 路由上：{url}"
        );
        assert_eq!(
            server["type"].as_str(),
            Some("streamableHttp"),
            "提交格式的传输名是流式 HTTP（文档里的写法是这个大小写）"
        );

        // 面板只认 `Authorization: Bearer <token>`（见 handlers::mcp::bearer）。
        // 前缀少个空格是静默 401，最难查。
        let auth = server["headers"]["Authorization"]
            .as_str()
            .expect("mcp.json 缺 Authorization 头");
        assert!(
            auth.starts_with("Bearer "),
            "Authorization 必须以 `Bearer ` 开头 —— 注意尾随那个空格：{auth}"
        );
    }

    /// `mcp.json` 里的每一个 `${VAR}` 都必须在 `token-schema.json` 里有对应字段，
    /// 反过来也不能有问了不用的字段。
    ///
    /// 占位符和表单字段对不上，平台那一侧不会报"配置有误" —— 用户会拿到一张填完
    /// 也连不上的表单，而错误只在运行期以"地址拼错了"的形式出现。
    #[test]
    fn connector_pack_token_placeholders_match_the_form_fields() {
        let mcp = pack_mcp();
        let schema: Value = serde_json::from_str(&read_pack("token-schema.json"))
            .expect("连接器包的 token-schema.json 不是合法 JSON");

        let declared: Vec<String> = schema["fields"]
            .as_array()
            .expect("token-schema.json 缺 fields")
            .iter()
            .map(|field| {
                field["key"]
                    .as_str()
                    .expect("token-schema.json 的字段缺 key")
                    .to_string()
            })
            .collect();

        let wanted = mcp_placeholders(&mcp);
        assert!(!wanted.is_empty(), "mcp.json 里一个 ${{VAR}} 都没有");
        for key in &wanted {
            assert!(
                declared.contains(key),
                "mcp.json 引用了 ${{{key}}}，但 token-schema.json 只定义了 {declared:?}"
            );
        }
        for key in &declared {
            assert!(
                wanted.contains(key),
                "token-schema.json 问了 {key}，但 mcp.json 没用它 —— 用户填了也没用"
            );
        }

        // 敏感字段一律 password，规范里写死的。
        let token = schema["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "ZOPS_API_KEY")
            .expect("表单里没有令牌字段");
        assert_eq!(token["type"].as_str(), Some("password"));
    }
}
