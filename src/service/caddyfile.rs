use std::sync::Arc;

use crate::domain::caddy::{parse_caddyfile, CaddyfileData};
use crate::infrastructure::caddy::CaddyProcess;
use crate::shared::AppError;

pub struct CaddyfileService {
    caddy: Arc<CaddyProcess>,
}

impl CaddyfileService {
    pub fn new(caddy: Arc<CaddyProcess>) -> Self {
        Self { caddy }
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
        let validated = self.caddy.format_caddyfile(raw).await?;
        let path = self.caddy.effective_caddyfile_path();

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
}
