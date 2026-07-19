use std::sync::Arc;

use crate::domain::logs::{assert_log_path_allowed, LogSourceInfo, LogTailData};
use crate::infrastructure::db::{Database, LogSourceRow};
use crate::infrastructure::fs::tail;
use crate::shared::AppError;

pub struct LogService {
    db: Arc<Database>,
}

impl LogService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ── Log Sources ──

    pub fn list_sources(&self) -> Result<Vec<LogSourceInfo>, AppError> {
        let rows = self.db.list_log_sources().map_err(AppError::from)?;
        Ok(rows.into_iter().map(|r| LogSourceInfo {
            id: r.id,
            path: r.path,
            label: r.label,
        }).collect())
    }

    pub fn add_source(&self, path: &str, label: &str) -> Result<LogSourceInfo, AppError> {
        assert_log_path_allowed(path)?;
        let id = uuid::Uuid::new_v4().to_string();
        let row: LogSourceRow = self.db.add_log_source(&id, path, label).map_err(AppError::from)?;
        Ok(LogSourceInfo {
            id: row.id,
            path: row.path,
            label: row.label,
        })
    }

    pub fn remove_source(&self, id: &str) -> Result<(), AppError> {
        let ok = self.db.remove_log_source(id).map_err(AppError::from)?;
        if !ok {
            return Err(AppError::not_found("日志源不存在"));
        }
        Ok(())
    }

    pub fn get_source_paths(&self, ids: &[String]) -> Result<Vec<LogSourceInfo>, AppError> {
        let all = self.list_sources()?;
        if ids.is_empty() {
            return Ok(all);
        }
        Ok(all.into_iter().filter(|s| ids.contains(&s.id)).collect())
    }

    // ── Tail ──

    pub async fn tail_file(&self, path: &str, tail_n: usize) -> Result<LogTailData, AppError> {
        assert_log_path_allowed(path)?;
        let tail_n = tail_n.min(2000);
        let (lines, truncated) = tail::read_tail(path, tail_n).await?;
        Ok(LogTailData {
            path: path.to_string(),
            lines,
            truncated,
        })
    }
}

impl Default for LogService {
    fn default() -> Self {
        Self::new(Arc::new(Database::open(std::path::Path::new(":memory:")).unwrap()))
    }
}