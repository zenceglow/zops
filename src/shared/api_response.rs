use serde::{Deserialize, Serialize};

pub const CODE_OK: i32 = 200;
#[allow(dead_code)]
pub const CODE_FAIL: i32 = 0;
pub const MSG_OK: &str = "Successfully";

pub const CODE_BAD_REQUEST: i32 = 400;
pub const CODE_UNAUTHORIZED: i32 = 401;
pub const CODE_FORBIDDEN: i32 = 403;
pub const CODE_NOT_FOUND: i32 = 404;
pub const CODE_SERVER_ERROR: i32 = 500;
#[allow(dead_code)]
pub const CODE_BIZ_ERROR: i32 = 1000;

fn none_default<T>() -> Option<T> {
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub code: i32,
    #[serde(default)]
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default = "none_default")]
    pub data: Option<T>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            code: CODE_OK,
            message: MSG_OK.to_string(),
            data: Some(data),
        }
    }

    pub fn ok_empty() -> ApiResponse<()> {
        ApiResponse {
            success: true,
            code: CODE_OK,
            message: MSG_OK.to_string(),
            data: None,
        }
    }

    pub fn fail(code: i32, message: impl Into<String>) -> ApiResponse<()> {
        ApiResponse {
            success: false,
            code,
            message: message.into(),
            data: None,
        }
    }
}
