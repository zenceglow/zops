use std::sync::Arc;

use crate::domain::token::{
    generate_token, hash_token, is_valid_scope, permissions_for_scope, token_prefix,
    ApiTokenCreated, ApiTokenInfo, SCOPE_READ,
};
use crate::infrastructure::db::sqlite::{ApiTokenRow, Database};
use crate::shared::AppError;

pub struct TokenService {
    db: Arc<Database>,
}

impl TokenService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Result<Vec<ApiTokenInfo>, AppError> {
        let rows = self.db.list_api_tokens().map_err(AppError::from)?;
        Ok(rows.iter().map(to_info).collect())
    }

    /// Creates a token and returns the plaintext **once**. After this call the
    /// secret exists nowhere on the server — only its SHA-256 hash.
    pub fn create(&self, name: &str, scope: &str) -> Result<ApiTokenCreated, AppError> {
        let scope = if scope.trim().is_empty() {
            SCOPE_READ
        } else {
            scope.trim()
        };
        if !is_valid_scope(scope) {
            return Err(AppError::bad_request("scope 只能是 read 或 write"));
        }
        let name = name.trim();
        let name = if name.is_empty() { "未命名令牌" } else { name };
        if name.chars().count() > 64 {
            return Err(AppError::bad_request("令牌名称不能超过 64 个字符"));
        }

        let plain = generate_token();
        let permissions = permissions_for_scope(scope);
        let permissions_json = serde_json::to_string(&permissions).unwrap_or_else(|_| "[]".into());
        let id = uuid::Uuid::new_v4().to_string();

        let row = self
            .db
            .create_api_token(
                &id,
                name,
                &token_prefix(&plain),
                &hash_token(&plain),
                scope,
                &permissions_json,
            )
            .map_err(AppError::from)?;

        Ok(ApiTokenCreated {
            token: plain,
            info: to_info(&row),
        })
    }

    pub fn revoke(&self, id: &str) -> Result<(), AppError> {
        let removed = self.db.revoke_api_token(id).map_err(AppError::from)?;
        if !removed {
            return Err(AppError::not_found("令牌不存在或已删除"));
        }
        Ok(())
    }

    /// Resolves a presented bearer token. Returns `None` when the token is
    /// unknown — callers turn that into a 401.
    pub fn verify(&self, plain: &str) -> Result<Option<ApiTokenRow>, AppError> {
        if plain.trim().is_empty() {
            return Ok(None);
        }
        let row = self
            .db
            .find_api_token_by_hash(&hash_token(plain))
            .map_err(AppError::from)?;
        Ok(row)
    }

    /// Fire-and-forget usage stamp; never fails the request.
    pub fn touch(&self, id: &str) {
        let _ = self.db.touch_api_token(id);
    }
}

pub fn to_info(row: &ApiTokenRow) -> ApiTokenInfo {
    ApiTokenInfo {
        id: row.id.clone(),
        name: row.name.clone(),
        prefix: row.prefix.clone(),
        scope: row.scope.clone(),
        permissions: serde_json::from_str(&row.permissions).unwrap_or_default(),
        created_at: row.created_at.clone(),
        last_used_at: row.last_used_at.clone(),
    }
}
