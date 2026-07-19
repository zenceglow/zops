use std::sync::Arc;

use chrono::Utc;
use cron::Schedule;
use std::str::FromStr;

use crate::domain::automation::{AutomationTask, TaskExecution};
use crate::infrastructure::db::Database;
use crate::shared::AppError;

pub struct AutomationService {
    db: Arc<Database>,
}

impl Clone for AutomationService {
    fn clone(&self) -> Self {
        Self { db: self.db.clone() }
    }
}

impl AutomationService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ── Tasks ──

    pub fn list_tasks(&self) -> Result<Vec<AutomationTask>, AppError> {
        let rows = self.db.list_automation_tasks().map_err(AppError::from)?;
        Ok(rows.into_iter().map(|r| AutomationTask {
            id: r.id,
            name: r.name,
            command: r.command,
            cron_expr: r.cron_expr,
            enabled: r.enabled,
            last_run_at: r.last_run_at,
            next_run_at: r.next_run_at,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }).collect())
    }

    pub fn create_task(
        &self,
        name: &str,
        command: &str,
        cron_expr: &str,
    ) -> Result<AutomationTask, AppError> {
        if name.trim().is_empty() {
            return Err(AppError::bad_request("名称不能为空"));
        }
        if command.trim().is_empty() {
            return Err(AppError::bad_request("命令不能为空"));
        }
        if Schedule::from_str(cron_expr).is_err() {
            return Err(AppError::bad_request("无效的 cron 表达式"));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let next = compute_next_run(cron_expr, now);

        self.db
            .create_automation_task(&id, name.trim(), command.trim(), cron_expr.trim())
            .map_err(AppError::from)?;

        // Set the initial next_run_at
        let row = self.db
            .update_automation_task(&id, None, None, None, None, None, Some(&next))
            .map_err(AppError::from)?;

        Ok(AutomationTask {
            id: row.id,
            name: row.name,
            command: row.command,
            cron_expr: row.cron_expr,
            enabled: row.enabled,
            last_run_at: row.last_run_at,
            next_run_at: row.next_run_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    pub fn update_task(
        &self,
        id: &str,
        name: Option<&str>,
        command: Option<&str>,
        cron_expr: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<AutomationTask, AppError> {
        if let Some(c) = cron_expr {
            if Schedule::from_str(c).is_err() {
                return Err(AppError::bad_request("无效的 cron 表达式"));
            }
        }

        let row = self.db
            .update_automation_task(id, name, command, cron_expr, enabled, None, None)
            .map_err(AppError::from)?;

        // Recompute next_run if cron changed
        let effective_cron = cron_expr.unwrap_or(&row.cron_expr);
        if cron_expr.is_some() || enabled.is_some() {
            let now = Utc::now();
            let next = if row.enabled {
                compute_next_run(effective_cron, now)
            } else {
                "Paused".to_string()
            };
            let _ = self.db.update_automation_task(id, None, None, None, None, None, Some(&next));
        }

        self.get_task(id)
    }

    pub fn get_task(&self, id: &str) -> Result<AutomationTask, AppError> {
        let row = self.db
            .get_automation_task(id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::not_found("任务不存在"))?;
        Ok(AutomationTask {
            id: row.id,
            name: row.name,
            command: row.command,
            cron_expr: row.cron_expr,
            enabled: row.enabled,
            last_run_at: row.last_run_at,
            next_run_at: row.next_run_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    pub fn delete_task(&self, id: &str) -> Result<(), AppError> {
        let ok = self.db.delete_automation_task(id).map_err(AppError::from)?;
        if !ok {
            return Err(AppError::not_found("任务不存在"));
        }
        Ok(())
    }

    // ── Execution ──

    pub fn list_executions(&self, task_id: &str, limit: Option<i64>) -> Result<Vec<TaskExecution>, AppError> {
        let rows = self.db
            .list_executions_for_task(task_id, limit.unwrap_or(50))
            .map_err(AppError::from)?;
        Ok(rows.into_iter().map(|r| TaskExecution {
            id: r.id,
            task_id: r.task_id,
            status: r.status,
            output: r.output,
            started_at: r.started_at,
            finished_at: r.finished_at,
            retry_count: r.retry_count,
        }).collect())
    }

    pub fn record_execution(
        &self,
        task_id: &str,
        output: &str,
        status: &str,
        retry_count: i64,
    ) -> Result<TaskExecution, AppError> {
        let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let finished = if status != "running" {
            Some(now.clone())
        } else {
            None
        };

        let row = self.db.add_task_execution(
            &uuid::Uuid::new_v4().to_string(),
            task_id,
            output,
            status,
            &now,
            finished.as_deref(),
            retry_count,
        ).map_err(AppError::from)?;

        Ok(TaskExecution {
            id: row.id,
            task_id: row.task_id,
            status: row.status,
            output: row.output,
            started_at: row.started_at,
            finished_at: row.finished_at,
            retry_count: row.retry_count,
        })
    }

    pub fn update_execution(&self, id: &str, status: &str, output: Option<&str>) -> Result<(), AppError> {
        self.db.update_execution_status(id, status, output).map_err(AppError::from)
    }

    // ── Scheduler helper ──

    pub fn get_due_tasks(&self) -> Result<Vec<AutomationTask>, AppError> {
        let now = Utc::now();
        let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();
        let all = self.list_tasks()?;
        Ok(all.into_iter().filter(|t| {
            t.enabled && t.next_run_at.as_deref().unwrap_or("9999") <= now_str.as_str()
        }).collect())
    }

    pub fn mark_task_run(&self, id: &str, cron_expr: &str) -> Result<(), AppError> {
        let now = Utc::now();
        let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();
        let next = compute_next_run(cron_expr, now);
        let _ = self.db.update_automation_task(
            id, None, None, None, None,
            Some(&now_str),
            Some(&next),
        );
        Ok(())
    }
}

fn compute_next_run(cron_expr: &str, after: chrono::DateTime<Utc>) -> String {
    Schedule::from_str(cron_expr)
        .ok()
        .and_then(|s| s.after(&after).next())
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "—".to_string())
}
