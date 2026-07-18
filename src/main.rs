mod api;
mod assets;
mod assets_router;
mod state;

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
    let state = std::sync::Arc::new(state::AppState::new().expect("初始化状态失败"));
    let router = api::build_router(state.clone());
    let app = assets_router::assets_router(router);

    let port: u16 = std::env::var("OPS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5000);
    let addr = format!("0.0.0.0:{port}");

    tracing::info!("Zenceglow Ops Panel listening on {addr}");
    axum::serve(
        tokio::net::TcpListener::bind(&addr).await.expect("bind"),
        app,
    )
    .await
    .expect("serve");
}
