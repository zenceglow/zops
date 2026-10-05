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
    /// 面板界面默认用哪种语言。安装时选的那个 —— 空串表示"没指定，由浏览器
    /// 自己判断"（用户手动切过一次之后以他的选择为准，这里就管不着了）。
    pub default_lang: String,
    /// 正在跑的这版是什么版本。安装脚本靠它判断"这次是升级还是全新安装" ——
    /// 这个接口不需要登录，脚本在装之前就能问。
    pub version: String,
}
