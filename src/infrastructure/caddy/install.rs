//! 把 Caddy 装成宿主机的常驻服务。
//!
//! 面板以前只会「起一个 caddy 容器」——省事，但网关待在容器里有三个绕不开的代价，
//! 而这三个正是面板自己最依赖的能力：
//!
//! 1. **拿不到真实 IP**。容器内看到的对端地址已经过 docker 的 NAT，全是 `172.17.x.x`，
//!    访问统计里的来源城市、攻击来源无从判断。
//! 2. **读不到访问日志**。日志在容器里或 docker 的 volume 下，面板要么读不到，要么
//!    读到的是另一份。
//! 3. **配置归属说不清**。改坏一份是所有站点一起 502，而且面板连当前生效的是哪份
//!    Caddyfile 都不一定认得出。
//!
//! 所以网关统一装在宿主机上。这里只负责「装」：拉官方发布的静态二进制、落一份
//! systemd 单元、把配置目录建好。启停重载都在 `CaddyProcess` 里，不在这儿做。

use std::process::Command;

/// 和面板其它部分约定好的位置，改这里等于改全站契约。
pub const BIN_PATH: &str = "/usr/local/bin/caddy";
pub const CONFIG_DIR: &str = "/etc/caddy";
pub const CADDYFILE: &str = "/etc/caddy/Caddyfile";
const UNIT_PATH: &str = "/etc/systemd/system/caddy.service";

/// 开机自启用的 systemd 单元。
///
/// 字段照着 Caddy 官方打包的那份来：`Type=notify` 少了会让 systemd 以为进程没起完，
/// `LimitNOFILE` 少了在高连接数下会以很难查的方式失败。
///
/// 用 root 而不是官方的 `caddy` 用户：这台机器上不一定有那个用户，而面板要能在任何
/// 一台干净机器上把网关立起来。`AmbientCapabilities` 保留着，换成非 root 用户时也能绑
/// 80/443。
const UNIT: &str = "\
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
";

/// 新建配置目录时写的那份空 Caddyfile。
///
/// admin 显式绑 `localhost`：默认值本来就是它，但写出来才能表达「管理接口不外露」是
/// 有意的 —— 以前容器那份绑的是 `0.0.0.0:2019`，谁都能改你的网关配置。
const EMPTY_CADDYFILE: &str = "\
# 由 ZOPS 创建。站点配置由面板「网关」页写入。
{
\tadmin localhost:2019
}
";

pub fn install_host() -> Result<String, String> {
    if !is_root() {
        return Err("装宿主机网关需要 root（要写 /usr/local/bin 与 systemd 单元）".into());
    }

    let tag = latest_tag()?;
    let version = tag.trim_start_matches('v').to_string();
    let arch = arch()?;
    let url = asset_url(&tag, arch);

    let dir = std::env::temp_dir().join(format!("zops-caddy-{version}-{arch}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let tarball = dir.join("caddy.tar.gz");

    // 先写同目录的临时文件再 rename：直接往正在运行的二进制上写会 EBUSY，
    // 而这个函数被调用时未必就没有别的 caddy 在用 BIN_PATH。
    let staging = format!("{BIN_PATH}.new");
    let fetched = (|| -> Result<(), String> {
        run(
            &format!("下载 Caddy {version}"),
            Command::new("curl").args([
                "-fsSL",
                "--retry",
                "2",
                "-o",
                &tarball.to_string_lossy(),
                &url,
            ]),
        )?;
        run(
            "解压 Caddy",
            Command::new("tar").args([
                "xzf",
                &tarball.to_string_lossy(),
                "-C",
                &dir.to_string_lossy(),
                "caddy",
            ]),
        )?;

        let extracted = dir.join("caddy");
        if !extracted.is_file() {
            return Err(format!("发布包里没有 caddy 可执行文件（{url}）"));
        }
        std::fs::copy(&extracted, &staging).map_err(|e| format!("写入 {staging} 失败: {e}"))?;
        set_executable(&staging)
    })();

    // 无论成不成，解压出来的临时目录都不留；失败时连半截的临时二进制一起扫掉，
    // 免得下次 `which_caddy` 之外的东西把它当成一个"已安装"的 caddy。
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = fetched {
        let _ = std::fs::remove_file(&staging);
        return Err(e);
    }

    std::fs::rename(&staging, BIN_PATH).map_err(|e| format!("安装到 {BIN_PATH} 失败: {e}"))?;

    let installed = run("校验 caddy", Command::new(BIN_PATH).arg("version"))?;
    if installed.trim().is_empty() {
        return Err("装好的 caddy 跑不起来（version 没有输出），拒绝启用".into());
    }

    std::fs::create_dir_all(CONFIG_DIR).map_err(|e| format!("创建 {CONFIG_DIR} 失败: {e}"))?;
    let mut notes = Vec::new();
    if !std::path::Path::new(CADDYFILE).exists() {
        std::fs::write(CADDYFILE, EMPTY_CADDYFILE).map_err(|e| format!("写入 {CADDYFILE} 失败: {e}"))?;
        notes.push(format!("新建了空的 {CADDYFILE}"));
    }

    // 已经有单元就不覆盖：那可能是用户改过 ExecStart 的产物，盖掉等于把人家改回去。
    let unit_written = if !std::path::Path::new(UNIT_PATH).exists() {
        std::fs::write(UNIT_PATH, UNIT).map_err(|e| format!("写入 {UNIT_PATH} 失败: {e}"))?;
        run("systemctl daemon-reload", Command::new("systemctl").arg("daemon-reload"))?;
        true
    } else {
        false
    };
    run("systemctl enable caddy", Command::new("systemctl").args(["enable", "caddy"]))?;

    let mut msg = format!(
        "已把 Caddy {} 装到 {BIN_PATH}，并设为开机自启。",
        installed.trim()
    );
    if unit_written {
        msg.push_str(&format!("\n写入 systemd 单元 {UNIT_PATH}。"));
    } else {
        msg.push_str(&format!("\n沿用已有的 {UNIT_PATH}。"));
    }
    for n in notes {
        msg.push_str(&format!("\n{n}。"));
    }
    msg.push_str("\n点「启动」即可让它接管 80/443。");
    Ok(msg)
}

/// 发布包的下载地址。
///
/// 官方资产名是 `caddy_<版本>_linux_<架构>.tar.gz`，版本号不带前缀 `v` —— 这两个
/// 细节都是发布脚本定的，写错了会 404，所以单独拎出来测。
fn asset_url(tag: &str, arch: &str) -> String {
    let version = tag.trim_start_matches('v');
    format!(
        "https://github.com/caddyserver/caddy/releases/download/{tag}/caddy_{version}_linux_{arch}.tar.gz"
    )
}

/// 取最新发布的 tag（形如 `v2.11.7`）。
///
/// 问 GitHub API 而不是写死版本号：写死的那个迟早会过期，而"装网关"是一年也用不了
/// 一次的操作，犯不上为了省一次请求而留一个必然腐坏的常量。
fn latest_tag() -> Result<String, String> {
    let out = Command::new("curl")
        .args([
            "-fsSL",
            "https://api.github.com/repos/caddyserver/caddy/releases/latest",
        ])
        .output()
        .map_err(|e| format!("无法执行 curl: {e}"))?;
    if !out.status.success() {
        return Err("取 Caddy 最新版本失败（GitHub 不可达或被限流）".into());
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("解析 GitHub 响应失败: {e}"))?;
    v.get("tag_name")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .ok_or_else(|| "GitHub 响应里没有 tag_name".to_string())
}

fn arch() -> Result<&'static str, String> {
    let out = Command::new("uname")
        .arg("-m")
        .output()
        .map_err(|e| format!("无法执行 uname: {e}"))?;
    arch_for(&String::from_utf8_lossy(&out.stdout))
}

fn arch_for(uname_m: &str) -> Result<&'static str, String> {
    match uname_m.trim() {
        "x86_64" | "amd64" => Ok("amd64"),
        "aarch64" | "arm64" => Ok("arm64"),
        other => Err(format!("不支持的架构 {other}，请手动安装 Caddy")),
    }
}

fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

fn set_executable(path: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("给 {path} 加执行权限失败: {e}"))
}

fn run(what: &str, cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{what} 失败：无法执行命令（{e}）"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let err: String = String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect();
    Err(if err.is_empty() {
        format!("{what} 失败（退出码 {:?}）", out.status.code())
    } else {
        format!("{what} 失败：{err}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_url_strips_the_v_prefix() {
        // 版本号带 `v`、资产名不带 —— 混了就是 404。
        assert_eq!(
            asset_url("v2.11.7", "amd64"),
            "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz"
        );
    }

    #[test]
    fn arch_names_match_go_style() {
        assert_eq!(arch_for("x86_64\n").unwrap(), "amd64");
        assert_eq!(arch_for("amd64").unwrap(), "amd64");
        assert_eq!(arch_for("aarch64\n").unwrap(), "arm64");
        assert_eq!(arch_for("arm64").unwrap(), "arm64");
        assert!(arch_for("mips").is_err());
    }

    #[test]
    fn unit_points_at_our_paths() {
        // 单元里写的是绝对路径；和常量对不上就会起不来，而且报错很难指向这里。
        assert!(UNIT.contains(&format!("ExecStart={BIN_PATH} run --environ --config {CADDYFILE}")));
        assert!(UNIT.contains(&format!("ExecReload={BIN_PATH} reload --config {CADDYFILE} --force")));
        assert!(UNIT.contains("Type=notify"));
    }

    #[test]
    fn empty_caddyfile_keeps_admin_off_the_public_interface() {
        assert!(EMPTY_CADDYFILE.contains("admin localhost:2019"));
        assert!(!EMPTY_CADDYFILE.contains("0.0.0.0:2019"));
    }
}
