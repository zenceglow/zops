use crate::shared::AppError;

pub fn validate_admin_credentials(username: &str, password: &str) -> Result<(), AppError> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AppError::bad_request("用户名不能为空"));
    }
    if password.len() < 6 {
        return Err(AppError::bad_request("密码至少 6 位"));
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SetupStatus {
    pub initialized: bool,
    pub port: u16,
}
