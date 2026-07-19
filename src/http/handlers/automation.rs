use std::sync::Arc;

use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::automation::{AutomationTask, TaskExecution};
use crate::domain::auth::AuthUser;
use crate::domain::permission::OPS_AUTOMATION_MANAGE;
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

// ── Request DTOs ──

#[derive(Deserialize)]
struct CreateTaskBody {
    name: String,
    command: String,
    cron_expr: String,
    #[serde(default)]
    enabled: Option<bool>,
}

#[derive(Deserialize)]
struct UpdateTaskBody {
    name: Option<String>,
    command: Option<String>,
    cron_expr: Option<String>,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
struct TaskIdParam {
    id: String,
}

#[derive(Deserialize)]
struct ExecutionsQuery {
    limit: Option<i64>,
}

// ── Handlers ──

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<Vec<AutomationTask>>>, AppError> {
    require_perm(&user, OPS_AUTOMATION_MANAGE)?;
    Ok(Json(ApiResponse::ok(state.automation.list_tasks()?)))
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateTaskBody>,
) -> Result<Json<ApiResponse<AutomationTask>>, AppError> {
    require_perm(&user, OPS_AUTOMATION_MANAGE)?;
    let mut task = state.automation.create_task(
        &body.name,
        &body.command,
        &body.cron_expr,
    )?;
    if let Some(enabled) = body.enabled {
        task = state.automation.update_task(&task.id, None, None, None, Some(enabled))?;
    }
    Ok(Json(ApiResponse::ok(task)))
}

async fn update_task(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<TaskIdParam>,
    Json(body): Json<UpdateTaskBody>,
) -> Result<Json<ApiResponse<AutomationTask>>, AppError> {
    require_perm(&user, OPS_AUTOMATION_MANAGE)?;
    let task = state.automation.update_task(
        &q.id,
        body.name.as_deref(),
        body.command.as_deref(),
        body.cron_expr.as_deref(),
        body.enabled,
    )?;
    Ok(Json(ApiResponse::ok(task)))
}

async fn delete_task(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<TaskIdParam>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    require_perm(&user, OPS_AUTOMATION_MANAGE)?;
    state.automation.delete_task(&q.id)?;
    Ok(Json(ApiResponse::<()>::ok_empty()))
}

async fn run_task_now(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<TaskIdParam>,
) -> Result<Json<ApiResponse<TaskExecution>>, AppError> {
    require_perm(&user, OPS_AUTOMATION_MANAGE)?;
    // Execute in background
    let exec = state.automation.record_execution(&q.id, "", "running", 0)?;
    let exec_id = exec.id.clone();

    let task = state.automation.get_task(&q.id)?;
    let svc = state.automation.clone();

    tokio::spawn(async move {
        let output = execute_command(&task.command).await;
        let status = if output.starts_with("[ERROR]") {
            "failed"
        } else {
            "success"
        };
        let _ = svc.update_execution(&exec_id, status, Some(&output));
    });

    // Return the initial running execution
    state.automation.mark_task_run(&q.id, &task.cron_expr).ok();
    Ok(Json(ApiResponse::ok(exec)))
}

async fn list_executions(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<TaskIdParam>,
    Query(eq): Query<ExecutionsQuery>,
) -> Result<Json<ApiResponse<Vec<TaskExecution>>>, AppError> {
    require_perm(&user, OPS_AUTOMATION_MANAGE)?;
    Ok(Json(ApiResponse::ok(
        state.automation.list_executions(&q.id, eq.limit)?
    )))
}

async fn execute_command(cmd: &str) -> String {
    let output = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !out.status.success() {
                format!("[ERROR] exit={}\nSTDOUT:\n{}\nSTDERR:\n{}", out.status.code().unwrap_or(-1), stdout, stderr)
            } else if stderr.is_empty() {
                stdout.to_string()
            } else {
                format!("{}\nSTDERR:\n{}", stdout, stderr)
            }
        }
        Err(e) => format!("[ERROR] failed to spawn: {e}"),
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{id}", get(update_task).put(update_task).delete(delete_task))
        .route("/tasks/{id}/run", post(run_task_now))
        .route("/tasks/{id}/executions", get(list_executions))
}
