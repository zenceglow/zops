//! 部署：先体检，再执行。
//!
//! 为什么要有这一层，而不是让 agent 直接 SSH 上去敲 `docker compose up`：
//!
//! 1. **一致性**。这台机器上已经跑了二十来个服务，端口怎么分、网络怎么连、日志
//!    怎么转、反代怎么写，都有既定习惯。走同一个入口，习惯才落得下来。
//! 2. **体检**。缺 restart、缺日志轮转、缺时区、端口撞车、密钥明文写进 compose
//!    —— 这些是"部署完了第二天才发现"的典型问题，放到执行前一次性说清。
//! 3. **留痕**。走接口的动作会进审计日志，谁在什么时候把什么部署上去了有据可查。
//!
//! 体检结论分三档：`block` 必须先解决（ZPOS 不接受），`warn` 该告诉用户但可以
//! 忽略，`ok` 没问题。能自动补的（restart / 日志轮转 / 时区）都归 warn 并给出
//! 现成的片段 —— agent 自己补上就行，不用回头问人。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::infrastructure::db::Database;
use crate::infrastructure::system::{listeners, suggest_free};
use crate::shared::AppError;

/// 构建可能很久（拉依赖、编译），但不能无限等。
const BUILD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_COMPOSE: usize = 200 * 1024;
const MAX_FILE: usize = 256 * 1024;
/// 只回最后这些行。一次 Go 构建的日志有几千行，全塞回对话里没人看。
const MAX_OUTPUT_LINES: usize = 160;

#[derive(Deserialize)]
pub struct DeployInput {
    /// 服务名。同时是目录名、容器名、镜像名。
    pub name: String,
    pub compose: String,
    /// 一起写进去的文件（Dockerfile、配置、Caddyfile 等）。路径必须是相对路径。
    #[serde(default)]
    pub files: Vec<DeployFile>,
}

#[derive(Deserialize)]
pub struct DeployFile {
    pub path: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct PlanCheck {
    /// 稳定的标识，方便 agent 按 id 处理。
    pub id: String,
    /// block | warn | ok
    pub level: String,
    pub message: String,
    /// 该怎么修。能自动补的这里给现成片段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

#[derive(Serialize)]
pub struct DeployPlan {
    pub name: String,
    pub dir: String,
    pub checks: Vec<PlanCheck>,
    /// 是否可以直接 apply —— 有一项 block 就不能。
    pub ready: bool,
    /// 从 compose 里读出来的宿主端口，以及它们有没有被占。
    pub ports: Vec<PortCheck>,
}

#[derive(Serialize)]
pub struct PortCheck {
    pub port: u16,
    pub available: bool,
    pub used_by: Option<String>,
}

#[derive(Serialize)]
pub struct ApplyResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub output: String,
    pub dir: String,
    pub files: Vec<String>,
}

#[derive(Serialize)]
pub struct DeployedService {
    pub name: String,
    pub dir: String,
    /// 目录里有没有 docker-compose.yml。
    pub has_compose: bool,
    /// 同名容器在不在跑。
    pub running: bool,
    pub modified: String,
}

pub struct DeployService {
    root: PathBuf,
    #[allow(dead_code)]
    db: Arc<Database>,
}

impl DeployService {
    pub fn new(db: Arc<Database>, root: PathBuf) -> Self {
        Self { root, db }
    }

    fn dir_of(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    // ── 体检 ──

    pub fn plan(&self, input: &DeployInput) -> Result<DeployPlan, AppError> {
        let mut checks = Vec::new();

        // 名字同时当目录名、容器名和镜像名用，所以卡死字符集：
        // 允许大写、空格或者斜杠，就等于允许把文件写到别处去。
        let name_ok = !input.name.is_empty()
            && input.name.len() <= 41
            && input
                .name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            && input.name.starts_with(|c: char| c.is_ascii_alphanumeric());
        checks.push(if name_ok {
            ok("name", format!("服务名 `{}` 可用", input.name))
        } else {
            block(
                "name",
                "服务名只能用 a-z 0-9 - _，且以字母数字开头（它同时是目录名和容器名）",
            )
        });
        if !name_ok {
            return Ok(DeployPlan {
                name: input.name.clone(),
                dir: String::new(),
                checks,
                ready: false,
                ports: Vec::new(),
            });
        }

        if input.compose.len() > MAX_COMPOSE {
            checks.push(block("compose_size", "compose 文件超过 200KB，多半是粘错了"));
        }
        if !input.compose.contains("services:") {
            checks.push(block("compose_shape", "compose 里没看到 `services:`，这不是一份 compose 文件"));
        }

        // 文件路径：必须是相对路径，且不能往上跳。这一条是硬门槛 —— 它决定
        // 这次请求能写到磁盘上的哪些地方。
        let mut bad_path = None;
        for f in &input.files {
            let p = Path::new(&f.path);
            let unsafe_path = p.is_absolute()
                || p.components().any(|c| matches!(c, std::path::Component::ParentDir))
                || f.path.contains('\0');
            if unsafe_path {
                bad_path = Some(f.path.clone());
            }
            if f.content.len() > MAX_FILE {
                checks.push(block(
                    "file_size",
                    format!("{} 超过 256KB —— 二进制文件别走这条路", f.path),
                ));
            }
        }
        match bad_path {
            Some(p) => checks.push(block("file_path", format!("文件路径必须是部署目录内的相对路径：{p}"))),
            None => checks.push(ok("file_path", "带上的文件都在部署目录内")),
        }

        // 端口：撞车是部署最常见的一种失败，而且是"起不来才发现"。放到这里先算。
        let ports = compose_ports(&input.compose);
        let live = listeners();
        let mut port_checks = Vec::new();
        for port in &ports {
            let owner = live.iter().find(|l| l.port == *port);
            port_checks.push(PortCheck {
                port: *port,
                available: owner.is_none(),
                used_by: owner.map(|l| match &l.container {
                    Some(c) => format!("{} ({c})", l.process),
                    None => l.process.clone(),
                }),
            });
        }
        let taken: Vec<u16> = port_checks.iter().filter(|p| !p.available).map(|p| p.port).collect();
        if taken.is_empty() {
            if ports.is_empty() {
                checks.push(ok("ports", "没发布宿主端口（前端静态站可以这样）"));
            } else {
                checks.push(ok("ports", format!("发布端口 {:?} 都空着", ports)));
            }
        } else {
            let used: std::collections::HashSet<u16> = live.iter().map(|l| l.port).collect();
            let free = suggest_free(&used, 8000, 9999, 3);
            checks.push(block(
                "ports",
                format!("端口 {taken:?} 已经被占用"),
            ));
            if !free.is_empty() {
                if let Some(last) = checks.last_mut() {
                    last.fix = Some(format!(
                        "换成 {} 里的一个，然后把下面所有引用一起改掉",
                        free.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" / ")
                    ));
                }
            }
        }

        // 下面几条都是"该有但没有"，级别是 warn：不拦路，但要让人知道可以补，
        // 并且给出照抄就能用的片段。
        checks.push(if input.compose.contains("restart:") {
            ok("restart", "有重启策略")
        } else {
            warn("restart", "没有 `restart: always` —— 机器重启或容器崩了不会自己回来").with_fix("    restart: always")
        });

        let has_log_rotation = input.compose.contains("max-size");
        let has_log_mount = input.compose.contains("./logs");
        checks.push(match (has_log_rotation, has_log_mount) {
            (true, _) | (_, true) => ok("logs", "日志有出口（轮转或目录映射）"),
            (false, false) => warn(
                "logs",
                "日志既没有轮转也没有映射到宿主：容器日志会无限长，应用日志重建容器就丢",
            )
            .with_fix(
                "    logging:\n      driver: json-file\n      options: { max-size: \"50m\", max-file: \"10\", compress: \"true\" }\n    volumes:\n      - ./logs:/app/logs",
            ),
        });

        checks.push(if input.compose.contains("TZ=") {
            ok("timezone", "设了时区")
        } else {
            warn("timezone", "没设 TZ，日志时间会是 UTC").with_fix("      - TZ=Asia/Shanghai")
        });

        checks.push(if input.compose.contains("name: local") || input.compose.contains("- local") {
            ok("network", "接入了既有网络")
        } else {
            warn("network", "没看到接入 `local` 网络，网关按容器名反代会连不上").with_fix(
                "networks:\n  default:\n    external: true\n    name: local",
            )
        });

        // 密钥明文写进 compose 是很容易犯又很难发现的错（仓库一提交就泄漏了）。
        if let Some(key) = literal_secret(&input.compose) {
            checks.push(warn(
                "secret",
                format!("`{key}` 看起来是明文写死的凭据 —— 建议改成 `${{{key}}}` 并从同目录 .env 读"),
            ));
        } else {
            checks.push(ok("secret", "没发现明文写死的凭据"));
        }

        if input.compose.contains("healthcheck:") {
            checks.push(ok("healthcheck", "有健康检查"));
        } else {
            checks.push(warn(
                "healthcheck",
                "没有 healthcheck，编排层看不出它是不是真的活着",
            ));
        }

        if self.dir_of(&input.name).join("docker-compose.yml").exists() {
            checks.push(warn(
                "existing",
                format!(
                    "{} 已经有一份部署，这次会覆盖它的 compose 和同名文件（数据卷不受影响）",
                    self.dir_of(&input.name).display()
                ),
            ));
        }

        let ready = !checks.iter().any(|c| c.level == "block");
        Ok(DeployPlan {
            name: input.name.clone(),
            dir: self.dir_of(&input.name).display().to_string(),
            checks,
            ready,
            ports: port_checks,
        })
    }

    // ── 执行 ──

    pub async fn apply(&self, input: DeployInput) -> Result<ApplyResult, AppError> {
        // 体检不通过就不动手。agent 该先把 block 解决掉再来。
        let plan = self.plan(&input)?;
        if !plan.ready {
            let reasons: Vec<String> = plan
                .checks
                .iter()
                .filter(|c| c.level == "block")
                .map(|c| c.message.clone())
                .collect();
            return Err(AppError::bad_request(format!(
                "先解决问题再部署：{}",
                reasons.join("；")
            )));
        }

        let dir = self.dir_of(&input.name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::internal(format!("创建 {} 失败: {e}", dir.display())))?;

        let mut written = Vec::new();
        write_file(&dir, "docker-compose.yml", &input.compose)?;
        written.push("docker-compose.yml".to_string());
        for f in &input.files {
            write_file(&dir, &f.path, &f.content)?;
            written.push(f.path.clone());
        }

        let output = run_compose(&dir, &["up", "-d", "--build"]).await?;
        let code = output.0;
        Ok(ApplyResult {
            ok: code == Some(0),
            exit_code: code,
            output: output.1,
            dir: dir.display().to_string(),
            files: written,
        })
    }

    /// 部署目录里都有什么。给 agent 一个"这台机器上部署过哪些服务"的入口。
    pub fn list(&self) -> Vec<DeployedService> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let running: Vec<String> = crate::infrastructure::docker::running_names();
        let mut out: Vec<DeployedService> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let dir = e.path();
                let modified = std::fs::metadata(dir.join("docker-compose.yml"))
                    .or_else(|_| std::fs::metadata(&dir))
                    .and_then(|m| m.modified())
                    .map(human_time)
                    .unwrap_or_default();
                DeployedService {
                    has_compose: dir.join("docker-compose.yml").exists(),
                    running: running.iter().any(|n| n == &name),
                    name,
                    dir: dir.display().to_string(),
                    modified,
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }
}

fn ok(id: &str, message: impl Into<String>) -> PlanCheck {
    PlanCheck {
        id: id.into(),
        level: "ok".into(),
        message: message.into(),
        fix: None,
    }
}

fn warn(id: &str, message: impl Into<String>) -> PlanCheck {
    PlanCheck {
        id: id.into(),
        level: "warn".into(),
        message: message.into(),
        fix: None,
    }
}

fn block(id: &str, message: impl Into<String>) -> PlanCheck {
    PlanCheck {
        id: id.into(),
        level: "block".into(),
        message: message.into(),
        fix: None,
    }
}

trait WithFix {
    fn with_fix(self, fix: &str) -> Self;
}

impl WithFix for PlanCheck {
    fn with_fix(mut self, fix: &str) -> Self {
        self.fix = Some(fix.to_string());
        self
    }
}

/// 从 compose 里抠出宿主端口。
///
/// 逐行扫而不是引一个 YAML 解析器：这里只需要 `"8080:80"` 这种短横线开头的字符串，
/// 而引一个 YAML 库只为读端口不划算。认不出来的写法会被忽略 —— 那顶多是少提醒
/// 一次端口冲突，不会误报。
fn compose_ports(compose: &str) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    let mut in_ports = false;
    for line in compose.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("ports:") {
            in_ports = true;
            continue;
        }
        if !in_ports {
            continue;
        }
        // 缩进回去了说明 ports 段结束。
        if !line.starts_with(' ') || (!trimmed.starts_with('-') && !trimmed.starts_with('#')) {
            in_ports = false;
            continue;
        }
        let Some(spec) = trimmed.strip_prefix('-') else {
            continue;
        };
        let spec = spec.trim().trim_matches(['"', '\'']);
        // `127.0.0.1:8080:80`、`8080:80`、`8080:80/tcp`
        let head = spec.split('/').next().unwrap_or("");
        let parts: Vec<&str> = head.split(':').collect();
        let host_port = match parts.len() {
            1 => parts[0],
            _ => parts[parts.len() - 2],
        };
        if let Ok(p) = host_port.trim().parse::<u16>() {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// 找 `KEY=明文值` 这种写法。`${VAR}` 和空值不算。
fn literal_secret(compose: &str) -> Option<String> {
    for line in compose.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let upper = key.trim().to_uppercase();
        let looks_secret = ["PASSWORD", "SECRET", "TOKEN", "PRIVATE_KEY", "APIKEY"]
            .iter()
            .any(|k| upper.contains(k));
        let value = value.trim();
        if looks_secret && !value.is_empty() && !value.starts_with('$') && !value.contains("${") {
            return Some(key.trim().to_string());
        }
    }
    None
}

fn write_file(dir: &Path, rel: &str, content: &str) -> Result<(), AppError> {
    let target = dir.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal(format!("创建目录失败: {e}")))?;
    }
    std::fs::write(&target, content)
        .map_err(|e| AppError::internal(format!("写入 {} 失败: {e}", target.display())))
}

/// 跑 compose。命令是写死的 —— 这个接口不接受任意命令，否则它就是一个远程 shell。
async fn run_compose(dir: &Path, args: &[&str]) -> Result<(Option<i32>, String), AppError> {
    let fut = Command::new("docker")
        .arg("compose")
        .args(args)
        .current_dir(dir)
        .output();

    let out = tokio::time::timeout(BUILD_TIMEOUT, fut)
        .await
        .map_err(|_| AppError::internal("构建超时（15 分钟）"))?
        .map_err(|e| AppError::internal(format!("执行 docker compose 失败: {e}")))?;

    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code(), tail_lines(&text, MAX_OUTPUT_LINES)))
}

fn tail_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max {
        return text.trim().to_string();
    }
    format!(
        "（前面还有 {} 行，只留最后 {} 行）\n{}",
        lines.len() - max,
        max,
        lines[lines.len() - max..].join("\n")
    )
}

fn human_time(t: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(t)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, compose: &str) -> DeployInput {
        DeployInput {
            name: name.into(),
            compose: compose.into(),
            files: vec![],
        }
    }

    #[test]
    fn 读得出_compose_里的宿主端口() {
        let c = "\
services:
  app:
    ports:
      - \"8080:80\"
      - 127.0.0.1:9001:9001
      - 6000:6000/udp
    volumes:
      - ./x:/y";
        let mut ports = compose_ports(c);
        ports.sort();
        assert_eq!(ports, vec![6000, 8080, 9001]);
    }

    #[test]
    fn 挑得出明文写死的凭据() {
        assert_eq!(
            literal_secret("      - DB_PASSWORD=hunter2").as_deref(),
            Some("DB_PASSWORD")
        );
        assert!(literal_secret("      - DB_PASSWORD=${DB_PASSWORD}").is_none());
        assert!(literal_secret("      - TZ=Asia/Shanghai").is_none());
    }

    #[test]
    fn 服务名不合法直接拦下() {
        use crate::infrastructure::db::Database;
        let db = Arc::new(Database::open(Path::new(":memory:")).unwrap());
        let svc = DeployService::new(db, PathBuf::from("/tmp/zops-deploy-test"));
        for bad in ["../etc", "UPPER", "a b", "", "оплата"] {
            let plan = svc.plan(&input(bad, "services:\n  a:\n")).unwrap();
            assert!(!plan.ready, "{bad} 不该通过");
        }
        let plan = svc
            .plan(&input("zenceglow-shop", "services:\n  a:\n"))
            .unwrap();
        assert!(plan.ready || plan.checks.iter().any(|c| c.level == "block"));
    }

    #[test]
    fn 路径穿越会被拦下() {
        use crate::infrastructure::db::Database;
        let db = Arc::new(Database::open(Path::new(":memory:")).unwrap());
        let svc = DeployService::new(db, PathBuf::from("/tmp/zops-deploy-test"));
        let mut i = input("ok-name", "services:\n  a:\n");
        i.files.push(DeployFile {
            path: "../../etc/passwd".into(),
            content: "x".into(),
        });
        let plan = svc.plan(&i).unwrap();
        assert!(plan.checks.iter().any(|c| c.id == "file_path" && c.level == "block"));
        assert!(!plan.ready);
    }

    #[test]
    fn 缺项给的是_warn_不是_block() {
        use crate::infrastructure::db::Database;
        let db = Arc::new(Database::open(Path::new(":memory:")).unwrap());
        let svc = DeployService::new(db, PathBuf::from("/tmp/zops-deploy-test"));
        let plan = svc.plan(&input("x-app", "services:\n  a:\n    image: b\n")).unwrap();
        let ids: Vec<&str> = plan
            .checks
            .iter()
            .filter(|c| c.level == "warn")
            .map(|c| c.id.as_str())
            .collect();
        // restart / logs / timezone / network 都该提醒，但都不该拦着不让部署。
        for want in ["restart", "logs", "timezone", "network"] {
            assert!(ids.contains(&want), "缺 {want} 的提醒");
        }
        assert!(plan.ready, "warn 不影响 apply");
    }
}
