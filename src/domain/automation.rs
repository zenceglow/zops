use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationTask {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cron_expr: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecution {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub output: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub retry_count: i64,
}
