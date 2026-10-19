//! 存储体检：`ops.db` 有多大、谁在长、能不能缩回去。
//!
//! 面板只有一个 SQLite 文件，所有流水都写进去。它不会像日志文件那样被 logrotate
//! 切走，所以「磁盘被面板吃掉」这件事只能在这里看清：文件本体多少、WAL 多少、
//! 空闲页多少（= VACUUM 能还回去的）、每张表多少行。
//!
//! 只有两件事允许在这里做：按保留期删过期行、手动 VACUUM。都不可逆或会短暂锁库，
//! 所以不经 MCP 暴露，只留给面板 UI。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use crate::infrastructure::db::sqlite::{Database, DbFileStats, TableStat};
use crate::shared::AppError;

/// 一张表的说明，给 UI 标出「这张表会不会自己变小」。
#[derive(Debug, Clone, Serialize)]
pub struct TableNote {
    pub name: String,
    pub rows: i64,
    /// 由保留期清理 / 按条数封顶 / 无界（需要人工关注）。
    pub bounded: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageStats {
    pub file: DbFileStats,
    /// 生效中的保留天数；0 = 不自动清理。
    pub retention_days: i64,
    pub default_retention_days: i64,
    /// 审计日志的条数上限（按条数封顶，不按天）。
    pub audit_keep: i64,
    pub tables: Vec<TableNote>,
    /// 数据库总字节数（本体 + WAL + SHM），给「占了多少盘」一个数。
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PruneReport {
    pub days: i64,
    /// 每张表删掉的行数，只列删了东西的。
    pub deleted: Vec<(String, usize)>,
    pub total_deleted: usize,
    pub freed_bytes_estimate: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VacuumReport {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub freed_bytes: u64,
    pub duration_ms: u64,
}

pub struct DatabaseService {
    db: Arc<Database>,
    path: PathBuf,
}

impl DatabaseService {
    pub fn new(db: Arc<Database>, path: PathBuf) -> Self {
        Self { db, path }
    }

    pub fn stats(&self) -> Result<StorageStats, AppError> {
        let file = self.db.file_stats(&self.path)?;
        let retention_days = self.db.retention_days();
        let tables = self
            .db
            .table_stats()?
            .into_iter()
            .map(note_for)
            .collect::<Vec<_>>();

        Ok(StorageStats {
            total_bytes: file.db_bytes + file.wal_bytes + file.shm_bytes,
            file,
            retention_days,
            default_retention_days: crate::infrastructure::db::sqlite::DEFAULT_RETENTION_DAYS,
            audit_keep: crate::infrastructure::db::sqlite::AUDIT_KEEP,
            tables,
        })
    }

    pub fn set_retention(&self, days: i64) -> Result<(), AppError> {
        self.db.set_retention_days(days)?;
        Ok(())
    }

    /// 当前生效的保留天数（`0` = 不清理）。后台 worker 靠它决定清不清。
    pub fn retention_days(&self) -> i64 {
        self.db.retention_days()
    }

    /// 立刻按保留期清一次。`days = 0` 时直接返回，不动库。
    pub fn prune(&self, days: i64) -> Result<PruneReport, AppError> {
        let days = if days <= 0 { 0 } else { days };
        let deleted: Vec<(String, usize)> = self
            .db
            .prune_all(days)?
            .into_iter()
            .filter(|(_, n)| *n > 0)
            .collect();
        let total_deleted = deleted.iter().map(|(_, n)| *n).sum();
        // 删完只是标记空闲页，文件不会当场变小 —— 把「要点压缩才释放」写在返回值里，
        // 免得用户以为按钮没生效。
        let freed = self.db.file_stats(&self.path)?.reclaimable_bytes;
        Ok(PruneReport {
            days,
            deleted,
            total_deleted,
            freed_bytes_estimate: freed,
        })
    }

    pub fn vacuum(&self) -> Result<VacuumReport, AppError> {
        let before = self.db.file_stats(&self.path)?;
        let started = std::time::Instant::now();
        self.db.vacuum()?;
        let duration_ms = started.elapsed().as_millis() as u64;
        let after = self.db.file_stats(&self.path)?;
        let before_bytes = before.db_bytes + before.wal_bytes;
        let after_bytes = after.db_bytes + after.wal_bytes;

        Ok(VacuumReport {
            before_bytes,
            after_bytes,
            freed_bytes: before_bytes.saturating_sub(after_bytes),
            duration_ms,
        })
    }
}

/// 从 `sqlite.rs` 借来的常量：审计日志按条数封顶，这里只用于展示。
/// 给每张表标一个「会不会自己变小」。
///
/// 这个标注比行数更有用：`access_events` 有 80 万行但 30 天会清，不用管；
/// `task_executions` 如果没被清理，会一直往上堆，那才是要看的地方。
fn note_for(t: TableStat) -> TableNote {
    let bounded = match t.name.as_str() {
        "access_events" | "security_events" | "ssh_events" | "task_executions" | "deploy_runs" => {
            "retention"
        }
        "audit_logs" | "notify_log" | "caddyfile_versions" => "capped",
        _ => "fixed",
    };
    TableNote {
        name: t.name,
        rows: t.rows,
        bounded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::sqlite::NewAccessEvent;

    /// 每个用例一个独立目录：SQLite 文件落在真磁盘上，压缩/文件大小才是真的。
    fn tmp(tag: &str) -> (Arc<Database>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "zops-store-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("ops.db");
        let db = Arc::new(Database::open(&path).expect("建库"));
        (db, path)
    }

    fn event(ts: f64) -> NewAccessEvent {
        NewAccessEvent {
            ts,
            ip: "1.2.3.4".into(),
            host: "example.com".into(),
            method: "GET".into(),
            uri: "/".into(),
            status: 200,
            bytes: 10,
            duration_ms: 1.0,
            ua: "test".into(),
            source: "test.log".into(),
        }
    }

    fn now() -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    }

    #[test]
    fn retention_defaults_then_clamps() {
        let (db, _) = tmp("retention");
        assert_eq!(
            db.retention_days(),
            crate::infrastructure::db::sqlite::DEFAULT_RETENTION_DAYS
        );
        db.set_retention_days(7).unwrap();
        assert_eq!(db.retention_days(), 7);
        // 超出范围直接拒绝，别悄悄截断成 3650 让人以为设成了 9999 天。
        assert!(db.set_retention_days(-1).is_err());
        assert!(db.set_retention_days(3651).is_err());
    }

    #[test]
    fn prune_removes_only_expired_rows() {
        let (db, path) = tmp("prune");
        let svc = DatabaseService::new(db.clone(), path);
        let n = now();
        db.insert_access_events(&[
            event(n - 40.0 * 86_400.0),
            event(n - 31.0 * 86_400.0),
            event(n - 60.0),
        ])
        .unwrap();

        let report = svc.prune(30).unwrap();
        assert_eq!(report.total_deleted, 2, "只该删掉两条过期访问流水");
        assert_eq!(report.deleted.len(), 1, "只有 access_events 有东西可删");

        let left = svc
            .stats()
            .unwrap()
            .tables
            .into_iter()
            .find(|t| t.name == "access_events")
            .unwrap();
        assert_eq!(left.rows, 1);
        assert_eq!(left.bounded, "retention");
    }

    #[test]
    fn prune_zero_is_a_noop() {
        let (db, path) = tmp("noop");
        let svc = DatabaseService::new(db.clone(), path);
        db.insert_access_events(&[event(now() - 999.0 * 86_400.0)])
            .unwrap();
        let report = svc.prune(0).unwrap();
        assert_eq!(report.total_deleted, 0, "保留期 0 = 不清理，一行都不该动");
    }

    #[test]
    fn vacuum_shrinks_the_file_after_a_delete() {
        let (db, path) = tmp("vacuum");
        let svc = DatabaseService::new(db.clone(), path);
        let n = now();
        // 灌一批带正文的行，删掉之后再压缩，文件该明显变小。时间要比 1 天更老，
        // 否则 prune 什么都不会删 —— 那时候测的就不是压缩，是"没删也变大了"。
        let batch: Vec<_> = (0..5000)
            .map(|i| event(n - 100.0 * 86_400.0 - i as f64))
            .collect();
        db.insert_access_events(&batch).unwrap();
        let before = svc.stats().unwrap();
        assert!(before.file.db_bytes > 0);
        assert!(before.total_bytes >= before.file.db_bytes);

        svc.prune(1).unwrap();
        let after_delete = svc.stats().unwrap();
        // 删了行文件不会自己缩 —— 这正是要 VACUUM 的理由。
        assert_eq!(after_delete.tables.iter().find(|t| t.name == "access_events").unwrap().rows, 0);
        assert!(
            after_delete.file.reclaimable_bytes > 0,
            "删完应该留下空闲页，否则这条用例根本没测到压缩"
        );

        let freed = svc.vacuum().unwrap();
        assert!(
            freed.after_bytes <= before.total_bytes,
            "压缩后（本体 + WAL）不该比压缩前更大"
        );
        assert!(freed.freed_bytes > 0, "删空表之后压缩应该能释放空间");
    }
}
