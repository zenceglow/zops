use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::domain::auth::AuthUser;
use crate::domain::permission::{OPS_SYSTEM_READ, OPS_SYSTEM_WRITE};
use crate::domain::system::SystemOverview;
use crate::infrastructure::system::{TimezoneInfo, UpdateReport};
use crate::http::middleware::auth::require_perm;
use crate::http::AppState;
use crate::shared::{ApiResponse, AppError};

/// 端口占用 + 建议的空端口。
///
/// 部署一个服务最先要回答的就是"用哪个端口"，而这台机器上可能已经堆了十几个
/// 容器和几个数据库。给 agent 用的价值更大：它可以先问这一嘴，再挑一个没人用
/// 的端口把服务起起来，不用人肉翻 compose 文件。
async fn ports(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    let listeners = crate::infrastructure::system::listeners();
    let used: std::collections::HashSet<u16> = listeners.iter().map(|p| p.port).collect();
    // 8000-9999 是这套项目一直在用的区间（8000 系列给应用，9000 系列给工具），
    // 顺着这个习惯找，别把新服务扔到 30000 上面去。
    let suggested = crate::infrastructure::system::suggest_free(&used, 8000, 9999, 8);
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "listeners": listeners,
        "suggested": suggested,
    }))))
}

/// 面板自身的信息。关于页用。
///
/// 故意**不**要 `ops.system.read`：这是"这个软件是什么、去哪提问题"，任何登录
/// 用户都该看得到。主机的负载、补丁那些才是要权限的东西。
async fn panel(
    State(state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Json<ApiResponse<serde_json::Value>> {
    Json(ApiResponse::ok(serde_json::json!({
        "name": crate::shared::panel::NAME,
        "version": crate::shared::panel::VERSION,
        "github": crate::shared::panel::GITHUB,
        "email": crate::shared::panel::EMAIL,
        "uptime_seconds": crate::shared::panel::uptime_seconds(),
        // 和 MCP 报的是同一份指纹：人和 agent 各看一边就能对上号。
        "host": crate::shared::panel::identity(),
        "title": state.system.panel_title(),
        "domain": state.system.panel_domain(),
    })))
}

/// 无鉴权的身份端点：`GET /api/ops/version` → 版本 + 主机名 + 启动时刻。
///
/// 只回这三样（外加 machine/docker 指纹），不含任何账号、容器、路径信息 ——
/// 用途是"对面是谁、什么版本"，脚本和 agent 一句话就能核对，不必先拿令牌。
pub async fn version() -> Json<ApiResponse<serde_json::Value>> {
    Json(ApiResponse::ok(crate::shared::panel::identity()))
}

/// 有没有新版本。
///
/// 只要求登录，不要额外权限：这只是"厂里出新的了"，任何能进面板的人都该看得到。
/// 返回值来自后台任务的缓存 —— 顺手发现缓存过期就催一次，但不在这里等它，
/// 免得磁盘上没网时把页面拖死。
async fn release(
    State(state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Json<ApiResponse<crate::service::selfupdate::UpdateStatus>> {
    if state.selfupdate.is_stale() {
        let worker = state.selfupdate.clone();
        tokio::spawn(async move {
            let _ = worker.check().await;
        });
    }
    Json(ApiResponse::ok(state.selfupdate.status()))
}

/// 手动"检查更新"。
///
/// 和 `/release` 的区别是**等这次拉完再返回**：用户点了按钮就该拿到一个确定答案
/// （已是最新 / 有新版本 / 拉不到清单），而不是一个还要再等一会儿的旧状态。
/// `fetched: false` 表示这次没拉到清单，界面上要如实说"检查不了"，别报"已是最新"。
async fn check_release(
    State(state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Json<ApiResponse<serde_json::Value>> {
    let fetched = state.selfupdate.check().await.is_some();
    Json(ApiResponse::ok(serde_json::json!({
        "fetched": fetched,
        "status": state.selfupdate.status(),
    })))
}

/// 就地升级面板自己：下载新版本、换掉二进制、重启服务。
///
/// 要 `OPS_SYSTEM_WRITE`：这一步会覆盖磁盘上的可执行文件，是真正会改主机的动作。
///
/// **任务丢到后台跑，请求立刻返回。** 这一步要下载十几兆，慢线路上好几分钟 ——
/// 如果把它挂在请求上，"用户的浏览器/代理先超时断开"就会被 axum 当成取消，
/// 后面的校验和替换再也不会执行：文件下完了，却没换上，面板停在旧版本上，
/// 还留下一个十几兆的残骸。升级这种动作不该由"连接还在不在"决定。
async fn apply_release(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let worker = state.selfupdate.clone();
    if worker.is_applying() {
        return Err(AppError::bad_request("已经在升级了，等一下"));
    }
    worker.preflight()?;
    tokio::spawn(async move {
        if let Err(e) = worker.apply().await {
            tracing::warn!("面板自升级失败：{}", e.message);
        }
    });
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "started": true,
    }))))
}

async fn overview(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<SystemOverview>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.overview())))
}

/// 系统补丁情况（读缓存）。
async fn updates(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<UpdateReport>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.updates())))
}

/// 立刻检查一次（会读包管理器元数据，慢）。
async fn check_updates(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<UpdateReport>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.check_updates().await?)))
}

#[derive(Deserialize)]
pub struct ApplyUpdatesBody {
    packages: Vec<String>,
}

/// 装补丁。要 OPS_SYSTEM_WRITE —— 这是会上主机改软件包的动作。
async fn apply_updates(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ApplyUpdatesBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let output = state.system.apply_updates(body.packages).await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "output": output }))))
}

#[derive(Deserialize)]
pub struct TimezoneBody {
    zone: String,
}

async fn timezone(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<TimezoneInfo>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(state.system.timezone())))
}

async fn set_timezone(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<TimezoneBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let via = state.system.set_timezone(body.zone).await?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "via": via }))))
}

#[derive(Deserialize)]
pub struct PanelPrefsBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    domain: Option<String>,
}

async fn set_prefs(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<PanelPrefsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    if let Some(title) = body.title {
        state.system.set_panel_title(&title)?;
    }
    if let Some(domain) = body.domain {
        state.system.set_panel_domain(&domain)?;
    }
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "title": state.system.panel_title(),
        "domain": state.system.panel_domain(),
    }))))
}

async fn access_state(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    let ins = crate::infrastructure::hostctl::detect();
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "public": ins.is_public(),
        "bind": ins.bind,
        "manageable": ins.found,
    }))))
}

#[derive(Deserialize)]
pub struct AccessBody {
    public: bool,
}

async fn set_access(
    Extension(user): Extension<AuthUser>,
    Json(body): Json<AccessBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let bind = if body.public {
        crate::infrastructure::hostctl::PUBLIC_BIND
    } else {
        crate::infrastructure::hostctl::LOCAL_BIND
    };
    let ins = crate::infrastructure::hostctl::detect();
    if ins.bind == bind {
        return Ok(Json(ApiResponse::ok(serde_json::json!({
            "public": body.public,
            "restarting": false,
        }))));
    }
    crate::infrastructure::hostctl::prepare_bind(bind).map_err(AppError::bad_request)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({
        "public": body.public,
        "restarting": true,
    }))))
}

async fn uninstall_panel(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    crate::infrastructure::hostctl::schedule_uninstall().map_err(AppError::bad_request)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "started": true }))))
}

async fn dns_state(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<crate::infrastructure::system::dns::DnsStatus>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(crate::infrastructure::system::dns::status())))
}

#[derive(Deserialize)]
pub struct DnsBody {
    nameservers: Vec<String>,
}

async fn set_dns(
    Extension(user): Extension<AuthUser>,
    Json(body): Json<DnsBody>,
) -> Result<Json<ApiResponse<crate::infrastructure::system::dns::DnsStatus>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    crate::infrastructure::system::dns::apply(&body.nameservers).map_err(AppError::bad_request)?;
    Ok(Json(ApiResponse::ok(crate::infrastructure::system::dns::status())))
}

async fn vpn_state(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ApiResponse<crate::infrastructure::system::vpn::WgStatus>>, AppError> {
    require_perm(&user, OPS_SYSTEM_READ)?;
    Ok(Json(ApiResponse::ok(
        tokio::task::spawn_blocking(crate::infrastructure::system::vpn::status)
            .await
            .map_err(|_| AppError::internal("vpn 任务异常"))?,
    )))
}

#[derive(Deserialize)]
pub struct VpnImportBody {
    name: String,
    config: String,
}

async fn vpn_import(
    Extension(user): Extension<AuthUser>,
    Json(body): Json<VpnImportBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let path = crate::infrastructure::system::vpn::import(&body.name, &body.config)
        .map_err(AppError::bad_request)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "path": path }))))
}

#[derive(Deserialize)]
pub struct VpnNameBody {
    name: String,
}

async fn vpn_up(
    Extension(user): Extension<AuthUser>,
    Json(body): Json<VpnNameBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let name = body.name;
    tokio::task::spawn_blocking(move || crate::infrastructure::system::vpn::up(&name))
        .await
        .map_err(|_| AppError::internal("vpn 任务异常"))?
        .map_err(AppError::bad_request)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "ok": true }))))
}

async fn vpn_down(
    Extension(user): Extension<AuthUser>,
    Json(body): Json<VpnNameBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    require_perm(&user, OPS_SYSTEM_WRITE)?;
    let name = body.name;
    tokio::task::spawn_blocking(move || crate::infrastructure::system::vpn::down(&name))
        .await
        .map_err(|_| AppError::internal("vpn 任务异常"))?
        .map_err(AppError::bad_request)?;
    Ok(Json(ApiResponse::ok(serde_json::json!({ "ok": true }))))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/panel", get(panel))
        .route("/panel/prefs", post(set_prefs))
        .route("/access", get(access_state).post(set_access))
        .route("/uninstall", post(uninstall_panel))
        .route("/dns", get(dns_state).post(set_dns))
        .route("/vpn", get(vpn_state))
        .route("/vpn/import", post(vpn_import))
        .route("/vpn/up", post(vpn_up))
        .route("/vpn/down", post(vpn_down))
        .route("/release", get(release))
        .route("/release/check", post(check_release))
        .route("/release/apply", post(apply_release))
        .route("/ports", get(ports))
        .route("/overview", get(overview))
        .route("/updates", get(updates))
        .route("/updates/check", post(check_updates))
        .route("/updates/apply", post(apply_updates))
        .route("/timezone", get(timezone).post(set_timezone))
}
