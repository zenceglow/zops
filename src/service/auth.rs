use std::sync::Arc;

use jsonwebtoken::{encode, EncodingKey, Header};

use crate::domain::auth::{AuthUser, Claims, LoginData, MeData, TOKEN_TTL_HOURS};
use crate::domain::permission::ROLE_SUPER_ADMIN;
use crate::infrastructure::db::Database;
use crate::shared::AppError;

pub struct AuthService {
    db: Arc<Database>,
    jwt_secret: String,
}

impl AuthService {
    pub fn new(db: Arc<Database>, jwt_secret: String) -> Self {
        Self { db, jwt_secret }
    }

    pub fn jwt_secret(&self) -> &str {
        &self.jwt_secret
    }

    pub fn login(&self, username: &str, password: &str) -> Result<LoginData, AppError> {
        if !self.db.is_initialized().map_err(AppError::from)? {
            return Err(AppError::unavailable("系统尚未初始化"));
        }

        let user = self
            .db
            .verify_user(username, password)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::unauthorized("用户名或密码错误"))?;

        let permissions = self.load_permissions(user.id, &user.role)?;
        let claims = Claims {
            sub: user.username.clone(),
            uid: user.id,
            role: user.role.clone(),
            exp: (chrono::Utc::now() + chrono::Duration::hours(TOKEN_TTL_HOURS)).timestamp()
                as usize,
        };
        let access_token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(self.jwt_secret.as_bytes()),
        )
        .map_err(|_| AppError::internal("token 生成失败"))?;

        let auth = AuthUser {
            id: user.id,
            username: user.username.clone(),
            role: user.role.clone(),
            permissions: permissions.clone(),
        };

        Ok(LoginData {
            access_token,
            username: user.username,
            role: user.role,
            permissions: auth.effective_permissions(),
        })
    }

    pub fn load_auth_user(&self, uid: i64) -> Result<AuthUser, AppError> {
        let user = self
            .db
            .find_user_by_id(uid)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::unauthorized("用户不存在"))?;
        let permissions = self.load_permissions(user.id, &user.role)?;
        Ok(AuthUser {
            id: user.id,
            username: user.username,
            role: user.role,
            permissions,
        })
    }

    pub fn me(&self, uid: i64) -> Result<MeData, AppError> {
        let user = self.load_auth_user(uid)?;
        let permissions = user.effective_permissions();
        let created_at = self.db.user_created_at(user.id).ok().flatten().unwrap_or_default();
        Ok(MeData {
            id: user.id,
            username: user.username,
            role: user.role,
            permissions,
            created_at,
        })
    }

    fn load_permissions(&self, user_id: i64, role: &str) -> Result<Vec<String>, AppError> {
        if role == ROLE_SUPER_ADMIN {
            return Ok(Vec::new());
        }
        self.db
            .list_user_permissions(user_id)
            .map_err(AppError::from)
    }
}
