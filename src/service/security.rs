//! 安全中心。
//!
//! 三件事：
//! 1. **预警** —— 从接入日志里挑出可疑访问（被拦下的、扫描器、探测路径），聚合后
//!    存进 SQLite。大屏上只是几个数字，这里能点开看是谁、在打什么、打了几次。
//! 2. **端口访问记录** —— 22 端口上的 sshd：谁从哪儿来、用什么身份、成没成。
//!    这些原本只躺在 /var/log/secure 里，翻起来全靠 grep。
//! 3. **暴露面** —— 检测到的防火墙工具 + 本机对外监听的端口。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{Datelike, Local, TimeZone};

use crate::domain::security::{
    ExposedPort, Firewall, IpCount, SecurityEvent, SecuritySummary, SshRecord, SshSummary,
};
use crate::infrastructure::db::sqlite::{Database, NewSshEvent, SecurityEventRow, SshEventRow};
use crate::shared::AppError;

/// 预警留多久。和访问流水一个尺度，够回溯一次扫描潮。
const SECURITY_RETENTION_DAYS: i64 = 30;
/// 安全事件列表最多回多少条。
const MAX_EVENTS: i64 = 500;
/// 首次见到 auth 日志时，只回读末尾这么多字节 —— 直接从几百兆的历史里灌库没意义。
const SSH_BOOTSTRAP_TAIL: u64 = 512 * 1024;
const SSH_READ_CHUNK: u64 = 256 * 1024;
/// 防火墙规则最多回这么多行，免得把界面撑爆。
const MAX_RULE_LINES: usize = 60;

/// 探测类路径的特征。扫描器最爱敲这些：拿到 .env 等于拿到数据库口令。
const PROBE_HINTS: &[&str] = &[
    "/.env",
    "/.git",
    "/wp-login",
    "/wp-admin",
    "/xmlrpc.php",
    "/phpmyadmin",
    "/.aws",
    "/.ssh",
    "/config.json",
    "/docker-compose",
    "/actuator",
    "/.well-known/../",
];

pub struct SecurityService {
    db: Arc<Database>,
}

impl SecurityService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ── 预警 ──

    /// 判定一条访问是不是可疑；可疑就返回 (类型, 原因)。
    ///
    /// 正常业务里 403 也可能是"没登录去看了受保护页面"，但接在这台机器上的站点
    /// 基本都是公开站，403 就是被规则拦了 —— 加上路径特征一起判断，别把噪声当攻击。
    pub fn classify(
        uri: &str,
        status: i64,
        ua: &str,
        bot_hints: &[&str],
        tool_hints: &[&str],
    ) -> Option<(&'static str, String)> {
        let lower = uri.to_lowercase();
        if let Some(hit) = PROBE_HINTS.iter().find(|h| lower.contains(**h)) {
            return Some(("probe", format!("探测敏感路径 {hit}")));
        }
        let ua_lower = ua.to_lowercase();
        if let Some(hit) = tool_hints.iter().find(|h| ua_lower.contains(**h)) {
            return Some(("bot", format!("扫描/采集工具：{hit}")));
        }
        if let Some(hit) = bot_hints.iter().find(|h| ua_lower.contains(**h)) {
            return Some(("bot", format!("爬虫 UA：{hit}")));
        }
        if status == 403 {
            return Some(("blocked", "被网关规则拦下".to_string()));
        }
        None
    }

    pub fn events(
        &self,
        kind: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<SecurityEvent>, AppError> {
        let rows = self
            .db
            .list_security_events(kind, limit.clamp(1, MAX_EVENTS), offset.max(0))
            .map_err(AppError::from)?;
        Ok(rows.into_iter().map(to_event).collect())
    }

    pub fn summary(&self, hours: u32) -> Result<SecuritySummary, AppError> {
        let since = now_secs() - f64::from(hours) * 3600.0;
        let (blocked, bot, probe, ips) = self.db.security_counts(since).map_err(AppError::from)?;
        Ok(SecuritySummary {
            blocked,
            bot,
            probe,
            ips,
            window_hours: hours,
        })
    }

    /// 清理过期的预警。和访问流水一起在采集循环里做。
    pub fn prune(&self) -> Result<(), AppError> {
        let cutoff = now_secs() - (SECURITY_RETENTION_DAYS * 86_400) as f64;
        self.db.prune_security_events(cutoff).map_err(AppError::from)?;
        self.db.prune_ssh_events(cutoff).map_err(AppError::from)?;
        Ok(())
    }

    // ── 端口（22）访问记录 ──

    /// 增量读 sshd 的认证日志。
    ///
    /// 游标复用访问日志那套 `ingest_cursor`（键是"文件路径#ssh"）：轮转/截断时
    /// 自动从头读，不需要另建一套水位表。
    pub fn ingest_ssh(&self) -> Result<usize, AppError> {
        let Some(path) = ssh_log_path() else {
            return Ok(0);
        };
        let source = format!("{}#ssh", path.display());
        let Ok(meta) = std::fs::metadata(&path) else {
            return Ok(0);
        };
        let size = meta.len();
        let mut offset = match self.db.ingest_cursor(&source).unwrap_or(None) {
            Some(o) => (o as u64).min(size),
            // 第一次见到：只回读末尾一段。整份 ssh 日志可能有几百兆，
            // 而且我们关心的是"最近谁在敲门"。
            None => size.saturating_sub(SSH_BOOTSTRAP_TAIL),
        };
        if offset >= size {
            return Ok(0);
        }

        let mut buf = vec![0u8; SSH_READ_CHUNK as usize];
        let mut next = offset;
        let mut text = String::new();
        {
            use std::io::{Read, Seek, SeekFrom};
            let Ok(mut file) = std::fs::File::open(&path) else {
                return Ok(0);
            };
            if file.seek(SeekFrom::Start(offset)).is_err() {
                return Ok(0);
            }
            let n = file.read(&mut buf).unwrap_or(0);
            next = offset + n as u64;
            text = String::from_utf8_lossy(&buf[..n]).to_string();
        }
        // 最后一行可能只读到一半，留给下一轮 —— 不然会把一截残行当成新记录。
        let complete = match text.rfind('\n') {
            Some(i) => {
                next -= (text.len() - i - 1) as u64;
                &text[..i]
            }
            None => "",
        };

        let mut rows = Vec::new();
        for line in complete.lines() {
            if let Some(rec) = parse_ssh_line(line) {
                rows.push(rec);
            }
        }
        let n = self.db.insert_ssh_events(&rows).map_err(AppError::from)?;
        self.db.set_ingest_cursor(&source, next as i64).map_err(AppError::from)?;
        Ok(n)
    }

    pub fn ssh_records(&self, result: Option<&str>, limit: i64) -> Result<Vec<SshRecord>, AppError> {
        let rows = self
            .db
            .list_ssh_events(result, limit.clamp(1, 500))
            .map_err(AppError::from)?;
        Ok(rows.into_iter().map(to_ssh).collect())
    }

    pub fn ssh_summary(&self, hours: u32) -> Result<SshSummary, AppError> {
        let since = now_secs() - f64::from(hours) * 3600.0;
        let (accepted, failed, invalid, ips) =
            self.db.ssh_counts(since).map_err(AppError::from)?;
        let top = self
            .db
            .ssh_top_failed_ips(since, 8)
            .map_err(AppError::from)?
            .into_iter()
            .map(|(ip, count)| IpCount { ip, count })
            .collect();
        Ok(SshSummary {
            accepted,
            failed,
            invalid,
            ips,
            window_hours: hours,
            top_failed: top,
        })
    }

    // ── 防火墙 / 暴露面 ──

    pub fn firewall(&self) -> Firewall {
        let (tool, active, summary, rules) = detect_firewall();
        let exposed = crate::infrastructure::system::listeners()
            .into_iter()
            .map(|l| {
                let loopback = l.address == "127.0.0.1" || l.address == "::1" || l.address == "[::1]";
                ExposedPort {
                    port: l.port,
                    address: l.address.clone(),
                    process: l.process,
                    container: l.container,
                    public: !loopback,
                }
            })
            .collect();
        Firewall {
            tool,
            active,
            summary,
            rules,
            exposed,
        }
    }
}

fn to_event(r: SecurityEventRow) -> SecurityEvent {
    SecurityEvent {
        id: r.id,
        ip: r.ip,
        kind: r.kind,
        reason: r.reason,
        host: r.host,
        method: r.method,
        uri: r.uri,
        status: r.status,
        ua: r.ua,
        hits: r.hits,
        first_seen: local_time(r.first_seen),
        last_seen: local_time(r.last_seen),
        last_seen_ts: r.last_seen,
    }
}

fn to_ssh(r: SshEventRow) -> SshRecord {
    SshRecord {
        id: r.id,
        ts: r.ts,
        time: local_time(r.ts),
        ip: r.ip,
        user: r.user,
        result: r.result,
        method: r.method,
        port: r.port,
        raw: r.raw,
    }
}

fn local_time(ts: f64) -> String {
    chrono::DateTime::from_timestamp(ts as i64, 0)
        .map(|d| d.with_timezone(&Local).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// sshd 的认证日志在哪儿。不同发行版名字不一样：RHEL 系是 secure，Debian 系是 auth.log。
fn ssh_log_path() -> Option<PathBuf> {
    ["/var/log/secure", "/var/log/auth.log", "/var/log/messages"]
        .iter()
        .map(PathBuf::from)
        .find(|p| Path::new(p).is_file())
}

/// 解析一行 sshd 记录。认不出来就返回 None —— 日志里大半是别的行。
fn parse_ssh_line(line: &str) -> Option<NewSshEvent> {
    if line.len() < 16 {
        return None;
    }
    let ts = parse_syslog_ts(&line[..15])?;
    let (result, method, user, ip, port) = if let Some(idx) = line.find("Accepted ") {
        let tail = &line[idx + "Accepted ".len()..];
        let mut it = tail.split_whitespace();
        let method = it.next()?.to_string();
        if it.next()? != "for" {
            return None;
        }
        let user = it.next()?.to_string();
        if it.next()? != "from" {
            return None;
        }
        let ip = it.next()?.to_string();
        let port = ssh_port(&mut it);
        ("accepted", method, user, ip, port)
    } else if let Some(idx) = line.find("Failed ") {
        let tail = &line[idx + "Failed ".len()..];
        let mut it = tail.split_whitespace();
        let method = it.next()?.to_string();
        if it.next()? != "for" {
            return None;
        }
        let mut user = it.next()?;
        // "Failed password for invalid user admin from ..."
        if user == "invalid" {
            if it.next()? != "user" {
                return None;
            }
            user = it.next()?;
        }
        if it.next()? != "from" {
            return None;
        }
        let ip = it.next()?.to_string();
        let port = ssh_port(&mut it);
        ("failed", method, user.to_string(), ip, port)
    } else if let Some(idx) = line.find("Invalid user ") {
        let tail = &line[idx + "Invalid user ".len()..];
        let mut it = tail.split_whitespace();
        let user = it.next()?.to_string();
        if it.next()? != "from" {
            return None;
        }
        let ip = it.next()?.to_string();
        let port = ssh_port(&mut it);
        ("invalid", String::new(), user, ip, port)
    } else {
        return None;
    };

    if ip.is_empty() {
        return None;
    }
    Some(NewSshEvent {
        ts,
        ip,
        user,
        result: result.to_string(),
        method,
        port,
        raw: line.trim().to_string(),
    })
}

/// 从 "port 51234 ssh2" 里把端口挑出来。
fn ssh_port<'a, I: Iterator<Item = &'a str>>(it: &mut I) -> i64 {
    if it.next() != Some("port") {
        return 0;
    }
    it.next().and_then(|p| p.parse().ok()).unwrap_or(0)
}

/// syslog 的时间戳没有年份（`Oct  6 12:34:56`），按今年算。
///
/// 自己拆而不是丢给格式串：日期是空格填充的（`Oct  6`），`%e` / `%d` 在不同
/// chrono 版本上对连续空格的容忍度不一样 —— 这种"能不能解析"依赖版本的事，
/// 在日志采集里踩一次就是静默丢数据。分开拆成 token 最稳。
fn parse_syslog_ts(s: &str) -> Option<f64> {
    let mut it = s.split_whitespace();
    let month = match it.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let day: u32 = it.next()?.parse().ok()?;
    let mut hms = it.next()?.split(':');
    let hour: u32 = hms.next()?.parse().ok()?;
    let minute: u32 = hms.next()?.parse().ok()?;
    let second: u32 = hms.next()?.parse().ok()?;

    let date = chrono::NaiveDate::from_ymd_opt(Local::now().year(), month, day)?;
    let dt = date.and_hms_opt(hour, minute, second)?;
    Local.from_local_datetime(&dt).single().map(|d| d.timestamp() as f64)
}

/// 认出这台机器在用哪套防火墙，并拿一份规则原文。
///
/// 只读：改规则要按发行版选后端，还要防着把自己锁在门外，那是另一个话题。
fn detect_firewall() -> (String, bool, String, Vec<String>) {
    // firewalld / ufw 都有"自己在不在"的命令，先问它们。
    if let Some(out) = run("systemctl", &["is-active", "firewalld"]) {
        if out.trim() == "active" {
            let zones = run("firewall-cmd", &["--list-all"]).unwrap_or_default();
            return (
                "firewalld".into(),
                true,
                "firewalld 正在运行".into(),
                tail_lines(&zones, MAX_RULE_LINES),
            );
        }
    }
    if let Some(out) = run("ufw", &["status"]) {
        let active = out.contains("Status: active");
        return (
            "ufw".into(),
            active,
            if active { "ufw 已启用".into() } else { "ufw 已安装但没启用".into() },
            tail_lines(&out, MAX_RULE_LINES),
        );
    }
    if let Some(out) = run("nft", &["list", "ruleset"]) {
        if !out.trim().is_empty() {
            let active = !out.contains("No such file or directory");
            return (
                "nftables".into(),
                active,
                "nftables 规则集".into(),
                tail_lines(&out, MAX_RULE_LINES),
            );
        }
    }
    if let Some(out) = run("iptables", &["-S"]) {
        if !out.trim().is_empty() {
            return (
                "iptables".into(),
                true,
                "iptables 规则集".into(),
                tail_lines(&out, MAX_RULE_LINES),
            );
        }
    }
    (String::new(), false, "没有检测到防火墙工具".into(), Vec::new())
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn tail_lines(text: &str, max: usize) -> Vec<String> {
    let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    if lines.len() <= max {
        lines
    } else {
        lines[lines.len() - max..].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得出_sshd_的几种记录() {
        let ok = parse_ssh_line(
            "Oct  6 12:34:56 host sshd[123]: Accepted publickey for root from 1.2.3.4 port 51234 ssh2: RSA",
        )
        .expect("accepted 应该认出来");
        assert_eq!(ok.result, "accepted");
        assert_eq!(ok.user, "root");
        assert_eq!(ok.ip, "1.2.3.4");
        assert_eq!(ok.port, 51234);
        assert_eq!(ok.method, "publickey");

        let bad = parse_ssh_line(
            "Oct  6 12:34:57 host sshd[124]: Failed password for invalid user admin from 5.6.7.8 port 40000 ssh2",
        )
        .expect("failed 应该认出来");
        assert_eq!(bad.result, "failed");
        assert_eq!(bad.user, "admin");
        assert_eq!(bad.ip, "5.6.7.8");

        let invalid = parse_ssh_line(
            "Oct  6 12:34:58 host sshd[125]: Invalid user oracle from 9.9.9.9 port 2222",
        )
        .expect("invalid 应该认出来");
        assert_eq!(invalid.result, "invalid");
        assert_eq!(invalid.user, "oracle");

        assert!(parse_ssh_line("Oct  6 12:34:59 host systemd[1]: Started something").is_none());
    }

    #[test]
    fn 可疑访问才判成预警() {
        let bots = ["bot", "spider"];
        let tools = ["sqlmap", "curl"];
        // 探测路径
        assert_eq!(
            SecurityService::classify("/.env", 404, "Mozilla/5.0", &bots, &tools)
                .map(|(k, _)| k),
            Some("probe")
        );
        // 扫描工具 UA
        assert_eq!(
            SecurityService::classify("/", 200, "sqlmap/1.7", &bots, &tools).map(|(k, _)| k),
            Some("bot")
        );
        // 被拦下的
        assert_eq!(
            SecurityService::classify("/admin", 403, "Mozilla/5.0", &bots, &tools).map(|(k, _)| k),
            Some("blocked")
        );
        // 正常访问不该进预警
        assert!(SecurityService::classify("/", 200, "Mozilla/5.0", &bots, &tools).is_none());
        assert!(SecurityService::classify("/pricing", 404, "Mozilla/5.0", &bots, &tools).is_none());
    }

    #[test]
    fn 预警按_ip_路径_小时聚合() {
        let db = Arc::new(Database::open(Path::new(":memory:")).unwrap());
        let svc = SecurityService::new(db.clone());
        let ts = 1_800_000_000.0;
        for _ in 0..3 {
            db.upsert_security_event(
                "1.2.3.4", "probe", "探测敏感路径 /.env", "a.com", "GET", "/.env", 404,
                "curl", ts,
            )
            .unwrap();
        }
        // 同一个 IP 下一小时打同一个路径 → 另起一条
        db.upsert_security_event(
            "1.2.3.4", "probe", "探测敏感路径 /.env", "a.com", "GET", "/.env", 404, "curl",
            ts + 3600.0,
        )
        .unwrap();

        let events = svc.events(None, 50, 0).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events.iter().map(|e| e.hits).sum::<i64>(), 4);

        let summary = svc.summary(24 * 365 * 100).unwrap();
        assert_eq!(summary.probe, 2);
        assert_eq!(summary.ips, 1);
    }
}
