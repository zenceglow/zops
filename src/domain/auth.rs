use serde::{Deserialize, Serialize};

use super::permission::{all_permission_ids, ROLE_SUPER_ADMIN};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Username
    pub sub: String,
    /// User id
    pub uid: i64,
    /// `super_admin` | `member`
    pub role: String,
    pub exp: usize,
}

pub const TOKEN_TTL_HOURS: i64 = 24;

#[derive(Debug, Clone, Serialize)]
pub struct LoginData {
    pub access_token: String,
    pub username: String,
    pub role: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeData {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub permissions: Vec<String>,
    /// 加入时间。个人中心显示用。
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub permissions: Vec<String>,
}

impl AuthUser {
    pub fn is_super_admin(&self) -> bool {
        self.role == ROLE_SUPER_ADMIN
    }

    pub fn has(&self, permission: &str) -> bool {
        self.is_super_admin() || self.permissions.iter().any(|p| p == permission)
    }

    /// Effective permission list (super admin → all catalog ids).
    pub fn effective_permissions(&self) -> Vec<String> {
        if self.is_super_admin() {
            all_permission_ids()
                .into_iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            self.permissions.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberInfo {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub created_at: String,
    pub permissions: Vec<String>,
}
