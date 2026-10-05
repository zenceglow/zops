mod assets;
mod config;
mod domain;
mod http;
mod infrastructure;
mod service;
mod shared;

use std::sync::Arc;

use config::Config;
use http::AppState;
use infrastructure::{
    caddy::CaddyProcess, db::Database, docker::DockerClient, system::SysInfoProvider,
};
use service::{
    audit::AuditService,
    auth::AuthService, automation::AutomationService, caddyfile::CaddyfileService,
    files::FilesService,
    container::ContainerService,
    gateway::GatewayService, logs::LogService, member::MemberService, setup::SetupService,
    system::SystemService,
    token::TokenService,
};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,zenceglow_ops=debug".into()),
        )
        .init();

    let rt = tokio::runtime::Runtime::new().expect("创建 runtime 失败");
    rt.block_on(async_main());
}

async fn async_main() {
    let cfg = Config::from_env();

    let db = Arc::new(Database::open(&cfg.db_path()).expect("打开数据库失败"));
    let jwt_secret = db.ensure_jwt_secret().expect("JWT secret");

    let setup = Arc::new(SetupService::new(db.clone(), cfg.port));
    setup.ensure_banner_if_needed().expect("setup banner");

    let sys = Arc::new(SysInfoProvider::new());
    let docker = Arc::new(DockerClient::connect());
    let caddy = Arc::new(CaddyProcess::new(cfg.caddyfile_path.clone()));

    let system = Arc::new(SystemService::new(sys, db.clone()));
    let updates_worker = system.clone();

    let state = Arc::new(AppState {
        audit: Arc::new(AuditService::new(db.clone())),
        auth: Arc::new(AuthService::new(db.clone(), jwt_secret)),
        setup: setup.clone(),
        system,
        containers: Arc::new(ContainerService::new(docker)),
        files: Arc::new(FilesService::new(db.clone(), cfg.data_dir.clone())),
        gateway: Arc::new(GatewayService::new(caddy.clone())),
        caddyfile: Arc::new(CaddyfileService::new(caddy, db.clone())),
        logs: Arc::new(LogService::new(db.clone())),
        members: Arc::new(MemberService::new(db.clone())),
        automation: Arc::new(AutomationService::new(db.clone())),
        tokens: Arc::new(TokenService::new(db.clone())),
    });

    let router = http::build_router(state);
    let app = http::assets_router(router);

    // 系统补丁定期自查。
    //
    // 放后台跑有两个原因：一是包管理器的元数据读取要几秒到几十秒，挂在启动路径上
    // 会让面板开机慢一大截；二是"待修复补丁数"要进首页的运行评分，得有个不依赖
    // 用户打开页面的刷新来源。开机先跑一次，之后每 6 小时一次 —— 安全更新不是
    // 分钟级变化的东西。
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        loop {
            let _ = updates_worker.check_updates().await;
            tokio::time::sleep(crate::infrastructure::system::updates::CHECK_INTERVAL).await;
        }
    });

    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("Zenceglow Ops Panel listening on {addr}");
    axum::serve(
        tokio::net::TcpListener::bind(&addr).await.expect("bind"),
        // 带 connect info：审计日志在拿不到转发头时，还能记下 socket 对端 IP。
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}
