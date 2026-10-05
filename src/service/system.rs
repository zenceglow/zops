use std::sync::Arc;

use crate::domain::system::SystemOverview;
use crate::infrastructure::db::Database;
use crate::infrastructure::system::{timezone, updates, SysInfoProvider, TimezoneInfo, UpdateReport};
use crate::shared::AppError;

/// 缓存上一次补丁检查结果的键。
const UPDATES_KEY: &str = "updates_report";

pub struct SystemService {
    sys: Arc<SysInfoProvider>,
    db: Arc<Database>,
}

impl SystemService {
    pub fn new(sys: Arc<SysInfoProvider>, db: Arc<Database>) -> Self {
        Self { sys, db }
    }

    pub fn overview(&self) -> SystemOverview {
        self.sys.overview()
    }

    /// 最近一次检查的结果。
    ///
    /// 优先读缓存：补丁检查要读包管理器的元数据，动辄几秒到几十秒，不可能每次
    /// 打开首页都跑一遍。缓存由后台定时任务刷新，也可以手动触发。
    pub fn updates(&self) -> UpdateReport {
        self.db
            .get_config(UPDATES_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<UpdateReport>(&raw).ok())
            .unwrap_or_else(|| UpdateReport {
                message: "还没有检查过".into(),
                ..Default::default()
            })
    }

    /// 立刻检查并写缓存。检查是阻塞命令，放到阻塞线程池里跑。
    pub async fn check_updates(&self) -> Result<UpdateReport, AppError> {
        let report = tokio::task::spawn_blocking(updates::check)
            .await
            .map_err(|_| AppError::internal("检查任务异常"))?;
        if let Ok(json) = serde_json::to_string(&report) {
            let _ = self.db.set_config(UPDATES_KEY, &json);
        }
        Ok(report)
    }

    pub fn timezone(&self) -> TimezoneInfo {
        timezone::info()
    }

    /// 设置服务器时区。会改主机上的 /etc/localtime，属于"写"级操作。
    pub async fn set_timezone(&self, zone: String) -> Result<String, AppError> {
        tokio::task::spawn_blocking(move || timezone::set(&zone))
            .await
            .map_err(|_| AppError::internal("时区任务异常"))?
            .map_err(AppError::bad_request)
    }

    /// 修复指定的补丁包。动作本身有破坏性（装包、重启服务），所以由调用方负责确认。
    pub async fn apply_updates(&self, packages: Vec<String>) -> Result<String, AppError> {
        let out = tokio::task::spawn_blocking(move || updates::apply(&packages))
            .await
            .map_err(|_| AppError::internal("修复任务异常"))?
            .map_err(AppError::internal)?;
        // 修完立刻重新检查：页面上的数字要跟上，否则用户刚修完还看到"3 个待修复"。
        let _ = self.check_updates().await;
        Ok(out)
    }
}
