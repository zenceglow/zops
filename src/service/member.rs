use std::sync::Arc;

use crate::domain::auth::MemberInfo;
use crate::domain::permission::{
    is_known_permission, is_valid_role, ROLE_MEMBER, ROLE_SUPER_ADMIN,
};
use crate::domain::setup::validate_admin_credentials;
use crate::infrastructure::db::Database;
use crate::shared::AppError;

pub struct MemberService {
    db: Arc<Database>,
}

impl MemberService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Result<Vec<MemberInfo>, AppError> {
        self.db.list_members().map_err(AppError::from)
    }

    pub fn get(&self, id: i64) -> Result<MemberInfo, AppError> {
        self.list()?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| AppError::not_found("用户不存在"))
    }

    pub fn create(
        &self,
        username: &str,
        password: &str,
        role: Option<&str>,
        permissions: &[String],
    ) -> Result<MemberInfo, AppError> {
        validate_admin_credentials(username, password)?;
        let role = role.unwrap_or(ROLE_MEMBER);
        if !is_valid_role(role) {
            return Err(AppError::bad_request("无效角色"));
        }
        if role == ROLE_SUPER_ADMIN {
            return Err(AppError::bad_request("不能通过成员接口创建超级管理员"));
        }
        self.validate_permissions(permissions)?;

        if self
            .db
            .find_user_by_username(username.trim())
            .map_err(AppError::from)?
            .is_some()
        {
            return Err(AppError::bad_request("用户名已存在"));
        }

        let id = self
            .db
            .create_member(username.trim(), password, role, permissions)
            .map_err(AppError::from)?;
        self.get(id)
    }

    pub fn update(
        &self,
        id: i64,
        password: Option<&str>,
        permissions: Option<&[String]>,
        actor_id: i64,
    ) -> Result<MemberInfo, AppError> {
        let user = self
            .db
            .find_user_by_id(id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::not_found("用户不存在"))?;

        if user.role == ROLE_SUPER_ADMIN && id != actor_id {
            // Allow password reset of another super admin only by super admin (caller already checked manage)
            // But permission assignment is N/A for super admin
        }

        if let Some(pw) = password {
            if pw.len() < 6 {
                return Err(AppError::bad_request("密码至少 6 位"));
            }
            self.db
                .update_member_password(id, pw)
                .map_err(AppError::from)?;
        }

        if let Some(perms) = permissions {
            if user.role == ROLE_SUPER_ADMIN {
                return Err(AppError::bad_request("超级管理员拥有全部权限，无需分配"));
            }
            self.validate_permissions(perms)?;
            self.db
                .set_user_permissions(id, perms)
                .map_err(AppError::from)?;
        }

        self.get(id)
    }

    pub fn delete(&self, id: i64, actor_id: i64) -> Result<(), AppError> {
        if id == actor_id {
            return Err(AppError::bad_request("不能删除自己"));
        }
        let user = self
            .db
            .find_user_by_id(id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::not_found("用户不存在"))?;

        if user.role == ROLE_SUPER_ADMIN {
            let count = self.db.count_super_admins().map_err(AppError::from)?;
            if count <= 1 {
                return Err(AppError::bad_request("不能删除最后一个超级管理员"));
            }
        }

        self.db.delete_member(id).map_err(AppError::from)
    }

    fn validate_permissions(&self, permissions: &[String]) -> Result<(), AppError> {
        for p in permissions {
            if !is_known_permission(p) {
                return Err(AppError::bad_request(format!("未知权限: {p}")));
            }
        }
        Ok(())
    }
}
