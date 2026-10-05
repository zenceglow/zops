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
    auth::AuthService, automation::AutomationService, caddyfile::CaddyfileService,
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

    let state = Arc::new(AppState {
        auth: Arc::new(AuthService::new(db.clone(), jwt_secret)),
        setup: setup.clone(),
        system: Arc::new(SystemService::new(sys)),
        containers: Arc::new(ContainerService::new(docker)),
        gateway: Arc::new(GatewayService::new(caddy.clone())),
        caddyfile: Arc::new(CaddyfileService::new(caddy, db.clone())),
        logs: Arc::new(LogService::new(db.clone())),
        members: Arc::new(MemberService::new(db.clone())),
        automation: Arc::new(AutomationService::new(db.clone())),
        tokens: Arc::new(TokenService::new(db.clone())),
    });

    let router = http::build_router(state);
    let app = http::assets_router(router);

    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("Zenceglow Ops Panel listening on {addr}");
    axum::serve(
        tokio::net::TcpListener::bind(&addr).await.expect("bind"),
        app,
    )
    .await
    .expect("serve");
}
