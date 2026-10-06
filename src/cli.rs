//! `zops` 命令行：装完之后不用翻 systemd 和配置文件，常用的几件事都能一条命令问清楚。
//!
//!   zops info                    面板信息：地址端口、账号、数据目录、服务状态
//!   zops update | upgrade        检查并自动更新（--check 只检查）
//!   zops resetpwd [用户名]       生成一个新的随机密码（交互确认）
//!   zops access [local|public]   关闭 / 开启对外访问（hide / open 是别名）
//!   zops uninstall [--purge]     卸载面板（交互确认）
//!
//! 为什么这些事不能"看文档自己敲"：端口和数据目录都写在 systemd 单元里，路径随
//! 安装时选的；账号在 SQLite 里；对外访问与否是个环境变量。让人去翻这三处，每次
//! 都要现场推理一遍 —— 这几条命令就是把推理固化下来。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config::Config;
use crate::infrastructure::db::Database;
use crate::service::selfupdate::SelfUpdateService;

const DEFAULT_UNIT: &str = "/etc/systemd/system/zenceglow-ops.service";
const SERVICE: &str = "zenceglow-ops";
/// 监听地址开关。存在 systemd 单元里，`access` 命令改的就是它。
const BIND_KEY: &str = "OPS_BIND";
const PUBLIC_BIND: &str = "0.0.0.0";
const LOCAL_BIND: &str = "127.0.0.1";

/// 从 systemd 单元里读出来的"这台机器上装的那一份"。
struct Installed {
    unit: PathBuf,
    found: bool,
    bin: PathBuf,
    port: u16,
    data_dir: PathBuf,
    caddyfile: String,
    bind: String,
    lang: String,
}

impl Installed {
    fn detect() -> Self {
        let unit = std::env::var("OPS_UNIT_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(DEFAULT_UNIT));
        let text = std::fs::read_to_string(&unit).unwrap_or_default();
        let env = |key: &str| -> Option<String> {
            text.lines()
                .find_map(|l| l.trim().strip_prefix(&format!("Environment={key}=")))
                .map(|v| v.trim().to_string())
        };
        let exec = text
            .lines()
            .find_map(|l| l.trim().strip_prefix("ExecStart="))
            .map(|v| v.split_whitespace().next().unwrap_or("").to_string());

        // 环境变量优先：在开发机上直接 `cargo run -- info` 时没有 systemd 单元。
        let bin = std::env::var("OPS_BIN_PATH")
            .ok()
            .or(exec)
            .map(PathBuf::from)
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("/usr/local/bin/zenceglow-ops"));
        let cfg = Config::from_env();

        Self {
            found: !text.is_empty(),
            unit,
            bin,
            port: env("OPS_PORT")
                .and_then(|p| p.parse().ok())
                .unwrap_or(cfg.port),
            data_dir: env("OPS_DATA_DIR").map(PathBuf::from).unwrap_or(cfg.data_dir),
            caddyfile: env("CADDYFILE_PATH").unwrap_or(cfg.caddyfile_path),
            // 单元里写了就用单元的（服务实际吃的是它）；没写才看当前环境变量 ——
            // 开发机上 `OPS_BIND=127.0.0.1 zops info` 也能如实反映。
            bind: env(BIND_KEY)
                .or_else(|| std::env::var(BIND_KEY).ok())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| PUBLIC_BIND.to_string()),
            lang: env("OPS_DEFAULT_LANG").unwrap_or_default(),
        }
    }

    fn config(&self) -> Config {
        let mut cfg = Config::from_env();
        cfg.port = self.port;
        cfg.data_dir = self.data_dir.clone();
        cfg.caddyfile_path = self.caddyfile.clone();
        cfg
    }

    fn is_public(&self) -> bool {
        self.bind != LOCAL_BIND
    }

    fn open_db(&self) -> Result<Arc<Database>, String> {
        let path = self.config().db_path();
        Database::open(&path).map(Arc::new).map_err(|e| {
            format!(
                "打不开数据库 {}：{e}\n（用 OPS_DATA_DIR 指定数据目录，或用 OPS_UNIT_PATH 指定 systemd 单元）",
                path.display()
            )
        })
    }
}

/// 这台机器自己的第一个非回环 IP —— `info` 里要能直接把访问地址给人抄。
fn primary_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

fn service_state() -> String {
    let out = std::process::Command::new("systemctl")
        .args(["is-active", SERVICE])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => "未知（这台机器上没有 systemctl）".into(),
    }
}

/// 交互确认。要人**打出 yes**，不是敲一下回车 —— 下面这几条命令都是不可逆的。
fn confirm(prompt: &str) -> bool {
    print!("{prompt}（输入 yes 继续，其它任何输入都取消）");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    line.trim() == "yes"
}

fn random_password() -> String {
    // 两段 UUIDv4 的十六进制 → 取 16 位，按 4 位分组。64 bit 熵，好读好抄。
    let raw = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let take = &raw[..16];
    take.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect::<Vec<_>>()
        .join("-")
}

/// 命令入口。返回 `Some(退出码)` = 这条命令已经处理完了，不要再起服务。
pub fn dispatch() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let rest: Vec<&str> = args.iter().skip(2).map(|s| s.as_str()).collect();

    match cmd {
        "info" => Some(info()),
        "update" | "upgrade" => Some(update(&rest)),
        "resetpwd" | "reset-password" => Some(resetpwd(&rest)),
        "access" | "hide" | "open" => Some(access(cmd, &rest)),
        "uninstall" => Some(uninstall(&rest)),
        "unlock" => Some(unlock(&rest)),
        "restart" => Some(restart()),
        "help" | "--help" | "-h" => {
            usage();
            Some(0)
        }
        _ => None,
    }
}

fn usage() {
    println!(
        "ZOPS {}\n\
         \n\
         用法：zops <命令>\n\
         \n\
           info                  面板信息：地址端口、账号、数据目录、服务状态\n\
           update | upgrade      检查并更新面板（--check 只检查）\n\
           resetpwd [用户名]     生成一个新的随机密码（交互确认）\n\
           access [local|public] 查看/切换对外访问（hide = local，open = public）\n\
           unlock [用户名]       解开登录锁定（连错 3 次会被锁 1 小时；不填=全部）\n\
           restart               重启面板服务\n\
           uninstall [--purge]   卸载面板（交互确认；--purge 连数据一起删）\n\
         \n\
         不带命令直接运行 = 启动面板服务（systemd 就是这么起的）。",
        env!("CARGO_PKG_VERSION")
    );
}

fn info() -> i32 {
    let ins = Installed::detect();
    println!("ZOPS {}", env!("CARGO_PKG_VERSION"));
    println!("服务状态  {}{}", service_state(), if ins.found { "" } else { "（没找到 systemd 单元）" });
    println!("监听端口  {}", ins.port);
    println!(
        "对外访问  {}",
        if ins.is_public() {
            format!("开启（监听 {}）", ins.bind)
        } else {
            "关闭（只监听 127.0.0.1）".to_string()
        }
    );
    let ip = primary_ip().unwrap_or_else(|| "127.0.0.1".into());
    println!("访问地址  http://{ip}:{}", ins.port);
    println!("MCP 地址  http://{ip}:{}/api/ops/mcp", ins.port);
    println!("安装位置  {}", ins.bin.display());
    let cfg = ins.config();
    println!("数据目录  {}", ins.data_dir.display());
    println!("数据库    {}", cfg.db_path().display());
    println!("网关配置  {}", ins.caddyfile);
    if !ins.lang.is_empty() {
        println!("默认语言  {}", ins.lang);
    }

    match ins.open_db() {
        Ok(db) => match db.list_members() {
            Ok(members) if members.is_empty() => println!("账号      还没有账号"),
            Ok(members) => {
                let list: Vec<String> = members
                    .iter()
                    .map(|m| format!("{}（{}）", m.username, m.role))
                    .collect();
                println!("账号      {}", list.join("、"));
            }
            Err(e) => println!("账号      读不出来：{e}"),
        },
        Err(e) => println!("账号      {e}"),
    }
    0
}

fn update(args: &[&str]) -> i32 {
    let ins = Installed::detect();
    let cfg = ins.config();
    let db = match ins.open_db() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let svc = SelfUpdateService::new(db, cfg.update_url.clone(), cfg.install_url.clone());
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("起 runtime 失败：{e}");
            return 1;
        }
    };

    // 手动执行时一定重新拉一次清单：`zops update` 的语义是"现在就去问"，
    // 不该拿上一次缓存糊弄人。
    let fetched = rt.block_on(svc.check()).is_some();
    let status = svc.status();
    if !fetched {
        eprintln!(
            "拉不到版本清单（{}）—— 检查这台机器的出网，或稍后再试。",
            cfg.update_url
        );
        return 1;
    }
    match (status.latest.clone(), status.has_update) {
        (Some(latest), true) => println!("当前 {} → 最新 {latest}", status.current),
        (Some(latest), false) => {
            println!("已经是最新版 {}", latest);
            return 0;
        }
        (None, _) => {
            eprintln!("清单里没有版本号");
            return 1;
        }
    }
    if args.contains(&"--check") {
        println!("（--check：只检查，没有更新）");
        return 0;
    }
    if !status.can_apply {
        eprintln!("这个实例不是安装脚本装的，不能自己换二进制。用同一行命令升级：{}", cfg.install_url);
        return 1;
    }

    println!("开始下载并替换…");
    match rt.block_on(svc.apply()) {
        Ok(out) => {
            println!("{}", out.message);
            0
        }
        Err(e) => {
            eprintln!("升级失败：{}", e.message);
            1
        }
    }
}

fn resetpwd(args: &[&str]) -> i32 {
    let ins = Installed::detect();
    let db = match ins.open_db() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let members = match db.list_members() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("读取账号失败：{e}");
            return 1;
        }
    };
    if members.is_empty() {
        eprintln!("这台机器上还没有账号（面板可能还没初始化）。");
        return 1;
    }

    let wanted = args
        .first()
        .map(|s| s.trim().to_string())
        .or_else(|| {
            members
                .iter()
                .find(|m| m.role == "super_admin")
                .map(|m| m.username.clone())
        })
        .unwrap_or_else(|| members[0].username.clone());

    let Some(member) = members.iter().find(|m| m.username == wanted) else {
        let names: Vec<&str> = members.iter().map(|m| m.username.as_str()).collect();
        eprintln!("没有这个账号：{wanted}（现有：{}）", names.join("、"));
        return 1;
    };

    if !confirm(&format!("为「{wanted}」生成一个新的随机密码，密钥旧的立即失效。确认？")) {
        println!("已取消。");
        return 0;
    }

    let password = random_password();
    if let Err(e) = db.update_member_password(member.id, &password) {
        eprintln!("改密码失败：{e}");
        return 1;
    }
    println!();
    println!("新密码：{password}");
    println!();
    println!("（只显示这一次，复制走。登录后可在面板里改。）");
    println!("数据库：{}", ins.config().db_path().display());
    0
}

fn access(cmd: &str, args: &[&str]) -> i32 {
    let ins = Installed::detect();
    // hide / open 是别名：hide = local，open = public。
    let want = match (cmd, args.first().copied()) {
        ("hide", _) => Some(LOCAL_BIND),
        ("open", _) => Some(PUBLIC_BIND),
        (_, Some("local")) | (_, Some("hide")) | (_, Some("off")) | (_, Some("close")) => {
            Some(LOCAL_BIND)
        }
        (_, Some("public")) | (_, Some("open")) | (_, Some("on")) => Some(PUBLIC_BIND),
        (_, Some("status")) | (_, None) => None,
        (_, Some(other)) => {
            eprintln!("不认识的用法：{other}（用 local 或 public）");
            return 2;
        }
    };

    // 只看状态的话不需要 systemd 单元；要改才需要。
    if want.is_some() && !ins.found {
        eprintln!(
            "找不到 systemd 单元 {}，改不了监听地址。\n\
             （在开发机上可以直接用环境变量 OPS_BIND={} 启动。）",
            ins.unit.display(),
            want.unwrap_or(PUBLIC_BIND),
        );
        return 1;
    }

    let Some(want) = want else {
        println!(
            "对外访问：{}（{}）",
            if ins.is_public() { "开启" } else { "关闭" },
            ins.bind
        );
        return 0;
    };
    if want == ins.bind {
        println!(
            "已经是这个状态了：{}（{}）",
            if ins.is_public() { "对外访问开启" } else { "只允许本机访问" },
            ins.bind
        );
        return 0;
    }

    let label = if want == LOCAL_BIND {
        "关闭对外访问（只监听 127.0.0.1，本机之外的浏览器/agent 都连不上）"
    } else {
        "开启对外访问（监听 0.0.0.0，同网络里谁能连到端口谁就能打开面板）"
    };
    if !confirm(&format!("{label}。确认？")) {
        println!("已取消。");
        return 0;
    }

    if let Err(e) = set_unit_env(&ins.unit, BIND_KEY, &want) {
        eprintln!("改 systemd 单元失败：{e}");
        return 1;
    }
    if let Err(e) = systemctl(&["daemon-reload"]) {
        eprintln!("daemon-reload 失败：{e}");
    }
    match systemctl(&["restart", SERVICE]) {
        Ok(()) => {
            println!("已生效：{}（{}）", label, want);
            0
        }
        Err(e) => {
            eprintln!("单元改好了，但重启服务失败：{e}\n手动执行：systemctl restart {SERVICE}");
            1
        }
    }
}

fn uninstall(args: &[&str]) -> i32 {
    let ins = Installed::detect();
    let purge = args.contains(&"--purge");
    if !ins.found {
        eprintln!(
            "找不到 systemd 单元 {}，不敢猜要删什么。\n\
             设置 OPS_UNIT_PATH / OPS_DATA_DIR 之后重试，或手动卸载。",
            ins.unit.display()
        );
        return 1;
    }

    println!("将要做的事：");
    println!("  · 停止并禁用服务 {SERVICE}");
    println!("  · 删除 systemd 单元 {}", ins.unit.display());
    println!("  · 删除程序 {}", ins.bin.display());
    println!("  · 删除命令 zops（同目录的软链）");
    if purge {
        println!("  · **删除数据目录 {}（账号、审计、配置都没了）**", ins.data_dir.display());
    } else {
        println!("  · 保留数据目录 {}（想一起删就加 --purge）", ins.data_dir.display());
    }
    println!("  · 不动 Caddy 网关的配置（站点规则请自己确认要不要清理）");
    if !confirm("确认卸载？") {
        println!("已取消。");
        return 0;
    }

    let mut failed = Vec::new();
    for args in [["disable", "--now", SERVICE].as_slice(), ["daemon-reload"].as_slice()] {
        if let Err(e) = systemctl(args) {
            failed.push(format!("systemctl {}：{e}", args.join(" ")));
        }
    }
    for path in [&ins.unit, &ins.bin, &ins.bin.with_file_name("zops")] {
        if path.exists() {
            if let Err(e) = std::fs::remove_file(path) {
                failed.push(format!("删除 {}：{e}", path.display()));
            }
        }
    }
    if purge {
        if let Err(e) = std::fs::remove_dir_all(&ins.data_dir) {
            failed.push(format!("删除 {}：{e}", ins.data_dir.display()));
        }
    }

    if failed.is_empty() {
        println!("已卸载。");
        if !purge {
            println!("数据留在 {}，要清掉直接删这个目录。", ins.data_dir.display());
        }
        0
    } else {
        eprintln!("有一部分没做成：");
        for f in failed {
            eprintln!("  · {f}");
        }
        1
    }
}

/// 解开登录锁定。
///
/// 连错 3 次锁 1 小时之后，面板本身是进不去的 —— 这条命令是唯一的出口，
/// 所以它只要求"能登进这台机器"（和 `--reset-password` 同一档权限）。
fn unlock(args: &[&str]) -> i32 {
    let ins = Installed::detect();
    let db = match ins.open_db() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let wanted = args.first().map(|s| s.trim()).filter(|s| !s.is_empty());
    match db.unlock(wanted) {
        Ok(list) if list.is_empty() => {
            match wanted {
                Some(w) => println!("「{w}」没有被锁定。"),
                None => println!("没有需要解锁的账号。"),
            }
            0
        }
        Ok(list) => {
            println!("已解锁：{}", list.join("、"));
            println!("失败计数已清零，重新登录即可。");
            0
        }
        Err(e) => {
            eprintln!("解锁失败：{e}");
            1
        }
    }
}

fn restart() -> i32 {
    let ins = Installed::detect();
    if !ins.found {
        eprintln!(
            "找不到 systemd 单元 {}。手动重启：systemctl restart {SERVICE}",
            ins.unit.display()
        );
        return 1;
    }
    if !confirm("现在重启面板服务？登录会话不受影响，但页面会短暂断开。") {
        println!("已取消。");
        return 0;
    }
    match systemctl(&["restart", SERVICE]) {
        Ok(()) => {
            println!("面板已重启。");
            0
        }
        Err(e) => {
            eprintln!("重启失败：{e}");
            1
        }
    }
}

/// 在 systemd 单元里设置 / 替换一个 `Environment=` 项。写前留一份 .bak。
fn set_unit_env(unit: &Path, key: &str, value: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(unit).map_err(|e| e.to_string())?;
    let line = format!("Environment={key}={value}");
    let prefix = format!("Environment={key}=");
    let mut replaced = false;
    let mut out: Vec<String> = text
        .lines()
        .map(|l| {
            if l.trim_start().starts_with(&prefix) {
                replaced = true;
                line.clone()
            } else {
                l.to_string()
            }
        })
        .collect();
    if !replaced {
        // 放在 [Service] 段的末尾之前不现实（要解析 ini），直接追加在最后：
        // systemd 允许 Environment 出现在 [Service] 段里的任意位置，而安装脚本
        // 写出来的单元里 [Service] 是最后一段。
        out.push(line);
    }
    std::fs::write(unit.with_extension("bak"), &text).map_err(|e| e.to_string())?;
    std::fs::write(unit, out.join("\n") + "\n").map_err(|e| e.to_string())
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("systemctl")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 随机密码够长且好抄() {
        let a = random_password();
        let b = random_password();
        assert_ne!(a, b);
        assert_eq!(a.len(), 19, "{a}"); // 4 组 × 4 位 + 3 个连字符
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[test]
    fn 改单元里的监听地址只动那一行() {
        let dir = std::env::temp_dir().join(format!("zops-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let unit = dir.join("zenceglow-ops.service");
        std::fs::write(
            &unit,
            "[Service]\nExecStart=/usr/local/bin/zenceglow-ops\nEnvironment=OPS_PORT=5200\n",
        )
        .unwrap();

        set_unit_env(&unit, BIND_KEY, LOCAL_BIND).unwrap();
        let text = std::fs::read_to_string(&unit).unwrap();
        assert!(text.contains("Environment=OPS_BIND=127.0.0.1"));
        assert!(text.contains("Environment=OPS_PORT=5200"));
        assert!(unit.with_extension("bak").exists(), "改之前要留一份备份");

        // 再改一次：应该替换而不是追加第二行
        set_unit_env(&unit, BIND_KEY, PUBLIC_BIND).unwrap();
        let text = std::fs::read_to_string(&unit).unwrap();
        assert_eq!(text.matches("OPS_BIND=").count(), 1);
        assert!(text.contains("Environment=OPS_BIND=0.0.0.0"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
