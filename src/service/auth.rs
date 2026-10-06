use std::sync::Arc;

use jsonwebtoken::{encode, EncodingKey, Header};

use crate::domain::auth::{AuthUser, Claims, LoginData, MeData, TOKEN_TTL_HOURS};
use crate::domain::permission::ROLE_SUPER_ADMIN;
use crate::infrastructure::db::Database;
use crate::shared::AppError;

/// 连续失败几次就锁。
pub const FAIL_LIMIT: i64 = 3;
/// 锁多久（分钟）。
pub const LOCK_MINUTES: i64 = 60;

/// 登录结果。
///
/// 撞库防护要区分"密码不对（还剩几次）"和"已经被锁"，还要告诉调用方**这一次是不是
/// 刚触发的锁定** —— 只有刚锁上才发通知，不能每次被撞都刷一遍群。
pub enum LoginOutcome {
    Ok(Box<LoginData>),
    BadCredentials { left: i64 },
    Locked { minutes: i64, just_locked: bool },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 撞库防护的机械部分：计数、锁定、剩余时间、解锁。
    ///
    /// 阈值判断（3 次 → 锁 1 小时、锁定期间不再累加）在 `login()` 里，这里把底层
    /// 那几步钉住 —— 它们错了，防护就是假的。
    #[test]
    fn 撞库锁定的计数与解锁() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        db.create_member("admin", "correct-horse", ROLE_SUPER_ADMIN, &[])
            .unwrap();

        // 没锁之前查不出剩余时间
        assert_eq!(db.lock_minutes_left("admin").unwrap(), None);
        // 失败计数一次一次涨
        assert_eq!(db.bump_login_failure("admin").unwrap(), 1);
        assert_eq!(db.bump_login_failure("admin").unwrap(), 2);
        // 不存在的用户名：计数不动，也不报错（不泄露账号是否存在）
        assert_eq!(db.bump_login_failure("nobody").unwrap(), 0);

        // 上锁：查得到剩余分钟，且失败计数清零（重新计数）
        db.lock_user_for("admin", LOCK_MINUTES).unwrap();
        assert!(db.lock_minutes_left("admin").unwrap().unwrap() <= LOCK_MINUTES);
        assert_eq!(db.bump_login_failure("admin").unwrap(), 1);

        // 解锁：锁定清掉
        assert_eq!(db.unlock(Some("admin")).unwrap(), vec!["admin".to_string()]);
        assert_eq!(db.lock_minutes_left("admin").unwrap(), None);
        // 再解一次就没人可解了
        assert!(db.unlock(None).unwrap().is_empty());
    }
}

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

    pub fn login(&self, username: &str, password: &str) -> Result<LoginOutcome, AppError> {
        if !self.db.is_initialized().map_err(AppError::from)? {
            return Err(AppError::unavailable("系统尚未初始化"));
        }

        // 在锁定窗口里：直接拒绝，不再累加计数（否则一直扫就永远解不开）。
        if let Some(minutes) = self.db.lock_minutes_left(username).map_err(AppError::from)? {
            return Ok(LoginOutcome::Locked {
                minutes,
                just_locked: false,
            });
        }

        let Some(user) = self.db.verify_user(username, password).map_err(AppError::from)? else {
            let attempts = self.db.bump_login_failure(username).unwrap_or(0);
            if attempts >= FAIL_LIMIT {
                let _ = self.db.lock_user_for(username, LOCK_MINUTES);
                return Ok(LoginOutcome::Locked {
                    minutes: LOCK_MINUTES,
                    just_locked: true,
                });
            }
            return Ok(LoginOutcome::BadCredentials {
                left: (FAIL_LIMIT - attempts).max(0),
            });
        };
        // 登录成功顺手清掉失败计数：之前那几次不该攒着。
        let _ = self.db.clear_login_state(username);

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

        Ok(LoginOutcome::Ok(Box::new(LoginData {
            access_token,
            username: user.username,
            role: user.role,
            permissions: auth.effective_permissions(),
        })))
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
