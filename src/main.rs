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
    analytics::AnalyticsService,
    audit::AuditService,
    auth::AuthService, automation::AutomationService, caddyfile::CaddyfileService,
    files::FilesService,
    container::ContainerService,
    deploy::DeployService,
    gateway::GatewayService, logs::LogService, member::MemberService,
    notify::NotifyService,
    setup::SetupService, watch::Watcher,
    system::SystemService,
    token::TokenService,
};

fn main() {
    // `--version` 要能在**没装、没跑、没有数据库**的情况下回答"我这一版是多少"：
    // 安装脚本先下载新二进制，再问它一句，才好判断这次是升级还是全新安装。
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("ZOPS {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // 忘了管理员密码时的后门。
    //
    // 密码存的是 argon2 哈希，**恢复不了**，只能重设。所以给一个命令行入口：
    // 能登进这台机器的人就能改 —— 这跟"能不能直接改数据库"是同一档权限，
    // 而面板本身不该提供这个入口（那等于给出一条绕过登录的路）。
    //
    //   zenceglow-ops --list-users
    //   zenceglow-ops --reset-password <用户名> <新密码>
    if let Some(code) = cli_accounts() {
        std::process::exit(code);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,zenceglow_ops=debug".into()),
        )
        .init();

    let rt = tokio::runtime::Runtime::new().expect("创建 runtime 失败");
    rt.block_on(async_main());
}

/// 处理账号相关的命令行开关。返回 `Some(退出码)` 表示"这条命令已经处理完了"。
fn cli_accounts() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let list = args.iter().any(|a| a == "--list-users");
    let reset_at = args.iter().position(|a| a == "--reset-password");
    if !list && reset_at.is_none() {
        return None;
    }

    let cfg = Config::from_env();
    let db = match Database::open(&cfg.db_path()) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("打不开数据库 {}：{e}", cfg.db_path().display());
            return Some(1);
        }
    };

    if list {
        match db.list_members() {
            Ok(members) if members.is_empty() => println!("还没有任何账号"),
            Ok(members) => {
                for m in members {
                    println!("{}\t{}", m.username, m.role);
                }
            }
            Err(e) => {
                eprintln!("读取失败：{e}");
                return Some(1);
            }
        }
        return Some(0);
    }

    let at = reset_at.unwrap();
    let (Some(username), Some(password)) = (args.get(at + 1), args.get(at + 2)) else {
        eprintln!("用法：zenceglow-ops --reset-password <用户名> <新密码>");
        eprintln!("      zenceglow-ops --list-users   # 先看看有哪些账号");
        return Some(2);
    };
    if password.chars().count() < 6 {
        eprintln!("密码至少 6 位");
        return Some(2);
    }

    let user = match db.find_user_by_username(username.trim()) {
        Ok(Some(u)) => u,
        Ok(None) => {
            eprintln!("没有这个账号：{username}（用 --list-users 看看有哪些）");
            return Some(1);
        }
        Err(e) => {
            eprintln!("查询失败：{e}");
            return Some(1);
        }
    };
    if let Err(e) = db.update_member_password(user.id, password) {
        eprintln!("改密码失败：{e}");
        return Some(1);
    }
    // 数据库路径一并打出来：这台机器上可能有好几个 ZOPS 的数据目录，
    // 不写清楚改的是哪一份，人下次就找不着了。
    println!("已重设 {username} 的密码（数据库：{}）", cfg.db_path().display());
    println!("重新登录面板即可，已登录的会话不受影响。");
    Some(0)
}

async fn async_main() {
    crate::shared::panel::mark_started();
    let cfg = Config::from_env();

    let db = Arc::new(Database::open(&cfg.db_path()).expect("打开数据库失败"));
    let jwt_secret = db.ensure_jwt_secret().expect("JWT secret");

    let setup = Arc::new(SetupService::new(db.clone(), cfg.port, cfg.default_lang.clone()));
    setup.ensure_banner_if_needed().expect("setup banner");

    let sys = Arc::new(SysInfoProvider::new());
    let docker = Arc::new(DockerClient::connect());
    let caddy = Arc::new(CaddyProcess::new(cfg.caddyfile_path.clone()));

    let system = Arc::new(SystemService::new(sys, db.clone()));
    let updates_worker = system.clone();

    let analytics = Arc::new(AnalyticsService::new(db.clone(), caddy.clone()));
    let analytics_worker = analytics.clone();

    let state = Arc::new(AppState {
        analytics,
        audit: Arc::new(AuditService::new(db.clone())),
        auth: Arc::new(AuthService::new(db.clone(), jwt_secret)),
        setup: setup.clone(),
        system,
        containers: Arc::new(ContainerService::new(docker)),
        deploy: Arc::new(DeployService::new(db.clone(), cfg.deploy_dir.clone())),
        files: Arc::new(FilesService::new(db.clone(), cfg.data_dir.clone())),
        gateway: Arc::new(GatewayService::new(caddy.clone())),
        caddyfile: Arc::new(CaddyfileService::new(caddy, db.clone())),
        logs: Arc::new(LogService::new(db.clone())),
        members: Arc::new(MemberService::new(db.clone())),
        notify: Arc::new(NotifyService::new(db.clone())),
        automation: Arc::new(AutomationService::new(db.clone())),
        tokens: Arc::new(TokenService::new(db.clone())),
    });

    // 盯压力与容器掉线。每 60 秒看一次，越线且没在冷却期里就推通知。
    let watcher = Watcher::new(
        state.notify.clone(),
        state.system.clone(),
        state.containers.clone(),
    );
    tokio::spawn(watcher.run());

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

    // 访问流水采集。
    //
    // 每 15 秒读一次访问日志的增量，顺便把没查过归属地的 IP 补上。放后台而不是
    // 等页面来问：大屏的"实时"要的是"已经采好了"，不是"打开页面才开始读盘"；
    // 而且归属地查询要走外网，放在请求路径里会让页面卡住。
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        loop {
            let _ = analytics_worker.ingest().await;
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
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
