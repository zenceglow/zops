use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use super::api_response::{
    ApiResponse, CODE_BAD_REQUEST, CODE_BIZ_ERROR, CODE_FORBIDDEN, CODE_NOT_FOUND,
    CODE_SERVER_ERROR, CODE_UNAUTHORIZED,
};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: i32,
    pub message: String,
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: CODE_BAD_REQUEST,
            message: msg.into(),
        }
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: CODE_UNAUTHORIZED,
            message: msg.into(),
        }
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: CODE_FORBIDDEN,
            message: msg.into(),
        }
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: CODE_NOT_FOUND,
            message: msg.into(),
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: CODE_SERVER_ERROR,
            message: msg.into(),
        }
    }

    #[allow(dead_code)]
    pub fn biz(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::OK,
            code: CODE_BIZ_ERROR,
            message: msg.into(),
        }
    }

    pub fn unavailable(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: CODE_SERVER_ERROR,
            message: msg.into(),
        }
    }

    pub fn bad_gateway(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: CODE_SERVER_ERROR,
            message: msg.into(),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self::internal(err.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = ApiResponse::<()>::fail(self.code, self.message);
        (self.status, Json(body)).into_response()
    }
}
