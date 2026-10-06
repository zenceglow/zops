//! 部署任务：一个目录 + 一段脚本 + 若干产物，每次执行留一条记录。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct DeployJob {
    pub id: String,
    /// 同时是 `/opt/docker-apps/<name>/` 目录名和容器/镜像名。
    pub name: String,
    pub note: String,
    pub script: String,
    /// manual | agent
    pub source: String,
    /// draft | running | success | failed
    pub status: String,
    /// 谁建的：面板用户名，或 agent 令牌名。
    pub actor: String,
    /// user | agent
    pub actor_kind: String,
    /// 部署目录（绝对路径），界面上要显示给用户。
    pub dir: String,
    pub container_name: Option<String>,
    pub container_id: Option<String>,
    pub last_run_at: Option<String>,
    pub last_exit_code: Option<i64>,
    pub last_duration_ms: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub files: Vec<DeployFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeployFile {
    pub path: String,
    pub size: i64,
    pub uploaded_at: String,
    pub uploaded_by: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeployRun {
    pub id: String,
    pub job_id: String,
    pub status: String,
    pub actor: String,
    pub actor_kind: String,
    /// 末尾输出，够在列表里看一眼；全部内容走 `run_log`。
    pub output: String,
    pub exit_code: Option<i64>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunLog {
    pub status: String,
    pub output: String,
    /// 下一次从哪儿接着读。
    pub offset: u64,
    pub finished: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDeployJob {
    pub name: String,
    #[serde(default)]
    pub note: String,
    /// 面板传 manual，agent 走 MCP 时传 agent。
    #[serde(default)]
    pub source: String,
    /// frontend | backend。决定骨架里"发不发布宿主端口"。
    #[serde(default)]
    pub kind: Option<String>,
    /// 后端要发布的宿主端口。留空就从 8000-9999 里挑一个空着的。
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(Debug, Deserialize)]
pub struct SaveDeployScript {
    pub id: String,
    pub script: String,
}
