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
        let raw = tokio::fs::read_to_string(&path)
            .await
            .map_err(|_| AppError::not_found(format!("读取配置文件失败：{path}")))?;
        let parsed = parse_caddyfile(&raw);
        Ok(CaddyfileData { raw, parsed })
    }

    pub async fn update(&self, raw: String) -> Result<serde_json::Value, AppError> {
        let validated = self.caddy.format_caddyfile(raw).await?;
        let path = self.caddy.effective_caddyfile_path();

        tokio::fs::write(&path, &validated)
            .await
            .map_err(|_| AppError::internal(format!("写入配置文件失败：{path}")))?;

        Ok(serde_json::json!({ "ok": true, "formatted": validated }))
    }
}
