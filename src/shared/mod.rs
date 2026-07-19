//! Shared types: API envelope and errors. No business logic.

pub mod api_response;
pub mod error;

pub use api_response::ApiResponse;
pub use error::AppError;
