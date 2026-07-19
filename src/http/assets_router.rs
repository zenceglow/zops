use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};

use crate::assets::Assets;

pub fn assets_router(api_router: Router) -> Router {
    api_router.fallback(static_handler)
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    let serve_index = || -> Response {
        match Assets::get("index.html") {
            Some(content) => Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Body::from(content.data))
                .unwrap_or_default()
                .into_response(),
            None => (StatusCode::NOT_FOUND, "前端未构建").into_response(),
        }
    };

    if path.is_empty() || !path.contains('.') {
        return serve_index();
    }

    match Assets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(content.data))
                .unwrap_or_default()
                .into_response()
        }
        None => serve_index(),
    }
}
