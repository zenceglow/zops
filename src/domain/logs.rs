use crate::shared::AppError;

const ALLOWED_PREFIXES: &[&str] = &["/opt/docker-apps/", "/var/log/", "./logs/", "/app/logs/"];

pub fn assert_log_path_allowed(path: &str) -> Result<(), AppError> {
    if ALLOWED_PREFIXES.iter().any(|p| path.starts_with(p)) {
        Ok(())
    } else {
        Err(AppError::forbidden("路径不在白名单内"))
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct LogSourceInfo {
    pub id: String,
    pub path: String,
    pub label: String,
}

#[derive(serde::Serialize)]
pub struct LogTailData {
    pub path: String,
    pub lines: Vec<String>,
    pub truncated: bool,
}
