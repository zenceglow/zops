use std::sync::Arc;

use crate::domain::caddy::{parse_caddyfile, CaddyfileData};
use crate::infrastructure::caddy::{fmt, CaddyProcess};
use crate::shared::AppError;

pub struct CaddyfileService {
    caddy: Arc<CaddyProcess>,
}

impl CaddyfileService {
    pub fn new(caddy: Arc<CaddyProcess>) -> Self {
        Self { caddy }
    }

    pub async fn get(&self) -> Result<CaddyfileData, AppError> {
        let raw = tokio::fs::read_to_string(&self.caddy.caddyfile_path)
            .await
            .map_err(|_| AppError::not_found("读取配置文件失败"))?;
        let parsed = parse_caddyfile(&raw);
        Ok(CaddyfileData { raw, parsed })
    }

    pub async fn update(&self, raw: String) -> Result<serde_json::Value, AppError> {
        let bin = self.caddy.cached_bin();
        let path = self.caddy.caddyfile_path.clone();

        let validated = if let Some(bin) = bin {
            fmt::fmt_caddyfile(&bin, raw).await?
        } else {
            raw
        };

        tokio::fs::write(&path, &validated)
            .await
            .map_err(|_| AppError::internal("写入配置文件失败"))?;

        Ok(serde_json::json!({ "ok": true, "formatted": validated }))
    }
}
