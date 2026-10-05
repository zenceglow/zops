use std::sync::Arc;

use crate::domain::caddy::{parse_caddyfile, CaddyfileData};
use crate::infrastructure::caddy::CaddyProcess;
use crate::infrastructure::db::{CaddyfileVersionRow, Database};
use crate::shared::AppError;

pub struct CaddyfileService {
    caddy: Arc<CaddyProcess>,
    db: Arc<Database>,
}

impl CaddyfileService {
    pub fn new(caddy: Arc<CaddyProcess>, db: Arc<Database>) -> Self {
        Self { caddy, db }
    }

    /// 落盘前先给"改之前"的样子留一份快照。
    ///
    /// 网关配置改坏 = 全站 502，而这份文件不像数据库那样有天然的旧版本，所以每次
    /// 写入前都把当前内容存进 SQLite。内容没变就不存 —— 否则连点两次保存会攒出
    /// 一堆一模一样的版本，翻历史时全是噪音。
    fn snapshot(&self, previous: &str, author: &str, note: &str) {
        if previous.trim().is_empty() {
            return;
        }
        let _ = self.db.add_caddyfile_version(previous, author, note);
    }

    pub async fn get(&self) -> Result<CaddyfileData, AppError> {
        // Docker mode edits the host side of the container's bind mount, so the
        // configured path is only a fallback.
        let path = self.caddy.effective_caddyfile_path();
        // 文件不存在不是错误 —— 新装的机器本来就是"还没有 Caddyfile"。以前这里
        // 返回 404，前端把整个配置置空，于是「配置文件」Tab 一片空白、连文件都建
        // 不出来（而空状态偏偏提示你去那个 Tab）。给个空文档，编辑器就能落笔。
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => return Err(AppError::not_found(format!("读取配置文件失败：{path}"))),
        };
        let parsed = parse_caddyfile(&raw);
        Ok(CaddyfileData { raw, parsed })
    }

    pub async fn update(&self, raw: String) -> Result<serde_json::Value, AppError> {
        self.update_as(raw, "", "保存配置").await
    }

    pub async fn update_as(
        &self,
        raw: String,
        author: &str,
        note: &str,
    ) -> Result<serde_json::Value, AppError> {
        let path = self.caddy.effective_caddyfile_path();
        let previous = tokio::fs::read_to_string(&path).await.unwrap_or_default();

        let validated = self.caddy.format_caddyfile(raw).await?;

        if previous.trim() != validated.trim() {
            self.snapshot(&previous, author, note);
        }

        // 目录可能还不存在（面板装到一半、或者路径是自定义的）。
        if let Some(dir) = std::path::Path::new(&path).parent() {
            if !dir.as_os_str().is_empty() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
        }
        tokio::fs::write(&path, &validated)
            .await
            .map_err(|_| AppError::internal(format!("写入配置文件失败：{path}")))?;

        Ok(serde_json::json!({ "ok": true, "formatted": validated }))
    }

    pub fn versions(&self, limit: i64) -> Result<Vec<CaddyfileVersionRow>, AppError> {
        self.db
            .list_caddyfile_versions(limit)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    pub fn version(&self, id: i64) -> Result<String, AppError> {
        self.db
            .get_caddyfile_version(id)
            .map_err(|e| AppError::internal(e.to_string()))?
            .ok_or_else(|| AppError::not_found("版本不存在"))
    }

    /// 回滚到某个历史版本。回滚本身也要留痕 —— 它同样会覆盖当前配置。
    pub async fn restore(&self, id: i64, author: &str) -> Result<serde_json::Value, AppError> {
        let content = self.version(id)?;
        self.update_as(content, author, &format!("回滚到版本 #{id}")).await
    }
}
