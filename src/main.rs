mod assets;
mod cli;
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
    deploy_job::DeployJobService,
    gateway::GatewayService, logs::LogService, member::MemberService,
    notify::NotifyService,
    security::SecurityService,
    selfupdate::SelfUpdateService,
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

    // `zops info / update / resetpwd / access / uninstall`：装完之后常用的几件事。
    // 不带子命令就是正常起服务（systemd 就是这么起的）。
    if let Some(code) = cli::dispatch() {
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

    let security = Arc::new(SecurityService::new(db.clone()));
    let security_worker = security.clone();

    let state = Arc::new(AppState {
        analytics,
        audit: Arc::new(AuditService::new(db.clone())),
        auth: Arc::new(AuthService::new(db.clone(), jwt_secret)),
        setup: setup.clone(),
        system,
        containers: Arc::new(ContainerService::new(docker)),
        deploy: Arc::new(DeployService::new(db.clone(), cfg.deploy_dir.clone())),
        deploy_jobs: Arc::new(DeployJobService::new(db.clone(), cfg.deploy_dir.clone())),
        files: Arc::new(FilesService::new(db.clone(), cfg.data_dir.clone())),
        gateway: Arc::new(GatewayService::new(caddy.clone())),
        caddyfile: Arc::new(CaddyfileService::new(caddy, db.clone())),
        logs: Arc::new(LogService::new(db.clone())),
        members: Arc::new(MemberService::new(db.clone())),
        notify: Arc::new(NotifyService::new(db.clone())),
        security,
        selfupdate: Arc::new(SelfUpdateService::new(
            db.clone(),
            cfg.update_url.clone(),
            cfg.install_url.clone(),
        )),
        automation: Arc::new(AutomationService::new(db.clone())),
        tokens: Arc::new(TokenService::new(db.clone())),
    });

    // 盯压力与容器掉线。每 60 秒看一次，越线且没在冷却期里就推通知。
    let watcher = Watcher::new(
        state.notify.clone(),
        state.system.clone(),
        state.containers.clone(),
    );
    // 也在 build_router 之前取出来：state 随后就被交出去了。
    let update_worker = state.selfupdate.clone();
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
        let mut round = 0u32;
        loop {
            let _ = analytics_worker.ingest().await;
            // 同一个循环顺手读 sshd 的增量：预警和端口访问记录是同一类"最近发生了什么"，
            // 没必要再起一个定时器。清理一天做一次就够。
            let _ = security_worker.ingest_ssh();
            round = round.wrapping_add(1);
            if round % 5760 == 0 {
                let _ = security_worker.prune();
            }
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    });

    // 查面板自己有没有新版本。
    //
    // 开机 30 秒后先查一次（别和别的一起挤在启动那几秒），之后每 6 小时一次。
    // 拉的是 CDN 上的 latest.json —— 发布脚本会跟着二进制一起传。
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            let _ = update_worker.check().await;
            tokio::time::sleep(crate::service::selfupdate::CHECK_INTERVAL).await;
        }
    });

    // 对外访问开关：`zops access local` 会把 OPS_BIND 写成 127.0.0.1（只允许本机），
    // 默认 0.0.0.0。改完要重启服务才生效 —— CLI 那边会顺手重启。
    let bind = std::env::var("OPS_BIND").unwrap_or_else(|_| "0.0.0.0".to_string());
    let addr = format!("{bind}:{}", cfg.port);
    tracing::info!("Zenceglow Ops Panel listening on {addr}");
    axum::serve(
        tokio::net::TcpListener::bind(&addr).await.expect("bind"),
        // 带 connect info：审计日志在拿不到转发头时，还能记下 socket 对端 IP。
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}
