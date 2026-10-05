use std::sync::Arc;
use std::time::Instant;

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::Method,
    middleware::Next,
    response::Response,
};
use std::net::SocketAddr;

use crate::domain::auth::AuthUser;
use crate::http::AppState;
use crate::service::audit::{client_ip, summarize_body, summarize_path};

/// 读请求体的上限。面板的写接口都是小 JSON，最大的也就是一份 Caddyfile；
/// 超过这个量说明请求不对劲，直接拒掉比悄悄截断安全。
const MAX_BODY: usize = 1024 * 1024;

/// 只有会改状态的方法才记。
///
/// GET 占了流量的大头（列表页每十秒轮询一次），把它们记进来只会让真正要紧的
/// "谁重启了容器""谁改了配置"淹没在噪音里。
fn is_mutation(m: &Method) -> bool {
    matches!(
        *m,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// 操作审计中间件。
///
/// 挂在鉴权之后，所以能直接拿到 `AuthUser`；挂在 handler 之前，所以能看到请求体
/// 和最终状态码 —— 记"做了什么"需要前者，记"成没成"需要后者。
pub async fn audit_middleware(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if !is_mutation(req.method()) {
        return next.run(req).await;
    }

    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let ip = client_ip(req.headers(), Some(addr));
    let actor = req
        .extensions()
        .get::<AuthUser>()
        .map(|u| u.username.clone())
        .unwrap_or_else(|| "unknown".into());

    // 把请求体读出来看一眼再原样放回去，handler 那边不受影响。
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => return next.run(Request::from_parts(parts, Body::empty())).await,
    };
    let detail = summarize_body(&bytes);
    let req = Request::from_parts(parts, Body::from(bytes.clone()));

    let started = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16();

    state.audit.record(
        &actor,
        "user",
        &ip,
        method.as_str(),
        &path,
        status,
        &summarize_path(method.as_str(), &path),
        &detail,
        started.elapsed().as_millis() as i64,
    );

    res
}
