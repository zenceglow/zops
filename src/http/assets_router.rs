use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};

use crate::assets::Assets;

pub fn assets_router(api_router: Router) -> Router {
    // 前端兜底只服务页面；API 的特殊情况在下面各自处理（见 static_handler）。
    
    api_router.fallback(static_handler)
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // 多了个尾斜杠的 API 路径：308 重定向到去掉斜杠的那份，让请求回到真正的路由上。
    // axum 的 nest 只把内层 "/" 挂在**不带**尾斜杠的路径上（`/api/ops/service` 能匹配，
    // `/api/ops/service/` 不能），而浏览器里缓存的旧 bundle 就是按带斜杠发的 —— 用户看到
    // 的是"删除没反应"。308 会保留方法（DELETE 还是 DELETE），浏览器和 fetch 都会自动跟。
    if path.starts_with("api/") && path.ends_with('/') {
        let trimmed = path.trim_end_matches('/');
        let location = match uri.query() {
            Some(q) => format!("/{trimmed}?{q}"),
            None => format!("/{trimmed}"),
        };
        return Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header(header::LOCATION, location)
            .body(Body::empty())
            .unwrap_or_default();
    }

    // /api/** 永远不该落到前端页面：以前任何没匹配上的 API 路径都会返回
    // index.html + **200**（路径里没有点号就走 SPA 兜底）。前端拿到 200 的 HTML，
    // JSON 解析失败后只当"响应不正常"，用户看到的是"点了没反应"，而真正的原因
    // ——路由不存在（比如少了/多了个斜杠）——被彻底吞掉。
    // 顺带把带尾斜杠的 API 路径也在这里说清楚：axum 的 nest 只把内层 "/" 挂在
    // 不带尾斜杠的路径上，`/api/ops/service/` 这种会落到这里。
    if path == "api" || path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            r#"{"success":false,"code":404,"message":"接口不存在（检查路径拼写，例如不要带多余斜杠）"}"#,
        )
            .into_response();
    }

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
