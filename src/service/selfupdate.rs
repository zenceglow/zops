//! 面板自己有没有新版本。
//
// 版本清单是发布时一起传到 CDN 的一个小 JSON（deploy.sh 生成）。面板定期去拉
// 一次，比自己版本新就在界面上弹一下。
//
// 为什么由**服务端**去拉，而不是让浏览器直连 CDN：面板常常装在内网机器上，
// 只有服务器自己能出网；而且"有没有新版本"是这台机器的事，不该跟着谁的浏览器走。

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::infrastructure::db::Database;

/// 缓存键：最近一次拉到的清单 + 拉取时间。
const CACHE_KEY: &str = "selfupdate.latest";
const CHECKED_KEY: &str = "selfupdate.checked_at";

/// 多久查一次。发布是周级别的事，查太勤只是白费流量。
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// 缓存多久算过期（手动打开页面时用来决定要不要顺手刷一次）。
const STALE_AFTER: i64 = 6 * 3600;

/// 版本清单。发布脚本写什么就读什么，字段都给了默认值 —— 少一个字段不该让
/// "有新版本"这件事整个丢掉。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub current: String,
    /// 拉不到清单时是 null —— 界面据此显示"检查不了"，而不是"已是最新"。
    pub latest: Option<String>,
    pub has_update: bool,
    pub notes: String,
    pub published_at: String,
    pub checked_at: Option<String>,
    /// 一行升级命令，弹窗里直接给用户复制。
    pub install_command: String,
}

pub struct SelfUpdateService {
    db: Arc<Database>,
    manifest_url: String,
    install_url: String,
    current: String,
}

impl SelfUpdateService {
    pub fn new(db: Arc<Database>, manifest_url: String, install_url: String) -> Self {
        Self {
            db,
            manifest_url,
            install_url,
            current: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        let release = self.cached();
        let checked_at = self.db.get_config(CHECKED_KEY).ok().flatten();
        let has_update = release
            .as_ref()
            .map(|r| version_gt(&r.version, &self.current))
            .unwrap_or(false);
        UpdateStatus {
            current: self.current.clone(),
            latest: release.as_ref().map(|r| r.version.clone()),
            has_update,
            notes: release.as_ref().map(|r| r.notes.clone()).unwrap_or_default(),
            published_at: release
                .as_ref()
                .map(|r| r.published_at.clone())
                .unwrap_or_default(),
            checked_at,
            install_command: format!("curl -fsSL {} | bash", self.install_url),
        }
    }

    /// 缓存是不是该刷新了。界面每次打开都会问一次，但真正出门拉清单要隔 6 小时。
    pub fn is_stale(&self) -> bool {
        let Ok(Some(checked)) = self.db.get_config(CHECKED_KEY) else {
            return true;
        };
        chrono::NaiveDateTime::parse_from_str(&checked, "%Y-%m-%d %H:%M:%S")
            .map(|t| {
                (chrono::Local::now().naive_local() - t).num_seconds() > STALE_AFTER
            })
            .unwrap_or(true)
    }

    /// 拉一次清单并缓存。失败就保留上一次的结果 —— 网络抖一下不该让"有新版本"
    /// 的提示消失。
    pub async fn check(&self) -> Option<Release> {
        let release = fetch(&self.manifest_url).await?;
        if let Ok(json) = serde_json::to_string(&release) {
            let _ = self.db.set_config(CACHE_KEY, &json);
        }
        let _ = self.db.set_config(
            CHECKED_KEY,
            &chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        );
        Some(release)
    }

    fn cached(&self) -> Option<Release> {
        self.db
            .get_config(CACHE_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
    }
}

/// 拉清单。走 curl 而不是 hyper：这个地址是 https，而 hyper 的纯 HTTP 连接器
/// 不会 TLS 握手（图标那边踩过同一个坑）。
async fn fetch(url: &str) -> Option<Release> {
    let url = url.to_string();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("curl")
            .args(["-fsSL", "--max-time", "8", "-A", "ZOPS/self-update", &url])
            .output()
            .ok()
    })
    .await
    .ok()??;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// 版本比大小：按点分段逐段比数字。跟安装脚本里那段保持一致 —— 同一件事
/// 在两个地方给出不同答案，比不支持预发布后缀糟糕得多。
pub fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| {
                // `1-rc2` 这种，数字部分照收，后缀忽略。
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let (xi, yi) = (
            x.get(i).copied().unwrap_or(0),
            y.get(i).copied().unwrap_or(0),
        );
        if xi != yi {
            return xi > yi;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版本比较按段比数字() {
        assert!(version_gt("0.3.0", "0.2.0"));
        assert!(version_gt("0.2.1", "0.2.0"));
        assert!(version_gt("1.0.0", "0.99.99"));
        // 段数不同时短的按 0 补齐：0.2 和 0.2.0 是同一个版本，谁都不比谁大。
        assert!(!version_gt("0.2.0", "0.2"));
        assert!(!version_gt("0.2", "0.2.0"));
        assert!(!version_gt("0.2.0", "0.2.0"));
        assert!(!version_gt("0.1.9", "0.2.0"));
        // 预发布后缀按它前面的数字算，不当成字符串比
        assert!(version_gt("0.3.0-rc1", "0.2.0"));
    }
}
