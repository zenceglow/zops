//! 访问统计：把 Caddy 的访问日志采进库，再聚合成大屏要的数字。
//!
//! 为什么不每次请求都现读日志：日志是几百万行的文本文件，每次打开大屏都从头
//! 扫一遍既慢又浪费；而且日志会被轮转、被删掉，历史数据跟着一起没了。采到库里
//! 之后，统计是 SQL 的事，日志文件怎么转都不影响已经看过的数据。

use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

use serde::Serialize;

use crate::infrastructure::caddy::{access, process::CaddyProcess};
use crate::infrastructure::db::{
    AccessEventRow, Database, GeoPointRow, GeoRow, NewAccessEvent,
};
use crate::infrastructure::geoip;
use crate::shared::AppError;

/// 一次最多读多少字节。积压很多时宁可分几轮，也不要把几十兆日志读进内存。
const READ_CHUNK: u64 = 2 << 20;
/// 第一次见到某个日志文件时，从尾部往前这么多字节开始读。
const BOOTSTRAP_TAIL: u64 = 1 << 20;
/// 一轮最多查多少个 IP 的归属地（ip-api 批量接口一次 100 个）。
const GEO_PER_ROUND: i64 = 300;
/// 访问流水保留天数。
const RETENTION_DAYS: i64 = 30;
/// 这台服务器自己位置的缓存键。
const SELF_LOCATION_KEY: &str = "geo.self";

/// 自己声明是机器人的 UA。都是各爬虫的自报名，误判概率低。
const BOT_HINTS: &[&str] = &[
    "bot",
    "spider",
    "crawl",
    "slurp",
    "semrush",
    "ahrefs",
    "facebookexternalhit",
    "headlesschrome",
];

/// 扫描器与脚本工具。出现在生产站点的正常流量里基本只有两种可能：监控探活，
/// 或者有人在扫。所以这一档单独算，不混进"机器人"里 —— 前者是规矩的访客，
/// 后者不是一回事。
const TOOL_HINTS: &[&str] = &[
    "sqlmap",
    "nmap",
    "nikto",
    "masscan",
    "zgrab",
    "nuclei",
    "gobuster",
    "dirbuster",
    "wpscan",
    "python-requests",
    "go-http-client",
    "curl/",
    "wget",
    "libwww",
    "scrapy",
    "okhttp",
    "java/",
    "axios/",
];

#[derive(Serialize)]
pub struct AnalyticsOverview {
    /// 统计窗口的小时数（24 / 168 / 720）。
    pub hours: u32,
    pub total: i64,
    pub unique_ips: i64,
    /// 每分钟请求数，给大屏的"当前速率"用。
    pub per_minute: f64,
    pub locations: Vec<Count>,
    pub hosts: Vec<Count>,
    pub paths: Vec<Count>,
    pub statuses: Vec<Count>,
    pub hourly: Vec<HourPoint>,
    /// 库里最新一条记录的 id，前端拿它当增量游标。
    pub cursor: i64,
    /// 采集在跑、采到几条日志文件 —— 空数据时要能解释"为什么是 0"。
    pub sources: Vec<String>,
    pub geo: serde_json::Value,
    /// 这台服务器自己在地球上的位置（拿不到就是 null，动画只在有点时才连线）。
    pub self_location: Option<GeoPointRow>,
    /// 地图上的落点。
    pub points: Vec<GeoPointRow>,
    pub security: Security,
}

#[derive(Serialize, Default)]
pub struct Security {
    /// 被接入网关规则拦下的（403）。
    pub blocked: i64,
    pub bots: i64,
    pub tools: i64,
    pub attackers: Vec<Attacker>,
    pub blocked_paths: Vec<Count>,
}

#[derive(Serialize)]
pub struct Attacker {
    pub ip: String,
    pub location: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct Count {
    pub key: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct HourPoint {
    pub hour: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct EventsPage {
    pub events: Vec<EventOut>,
    /// 下次轮询带回来的游标。
    pub cursor: i64,
}

#[derive(Serialize)]
pub struct EventOut {
    pub id: i64,
    pub ts: f64,
    /// 本地时间 HH:MM:SS，避免前端再算时区。
    pub time: String,
    pub ip: String,
    pub location: String,
    pub isp: String,
    pub host: String,
    pub method: String,
    pub uri: String,
    pub status: i64,
    pub bytes: i64,
    pub ua: String,
    /// 被网关拦下 / UA 像机器人。前端据此把这行标红，不用再自己判断一遍。
    pub blocked: bool,
    pub bot: bool,
}

pub struct AnalyticsService {
    db: Arc<Database>,
    caddy: Arc<CaddyProcess>,
}

impl AnalyticsService {
    pub fn new(db: Arc<Database>, caddy: Arc<CaddyProcess>) -> Self {
        Self { db, caddy }
    }

    /// 采一轮。返回新入库的条数。
    ///
    /// 每一步失败都不算致命：文件被删、被轮转、格式变了，都只是这一轮少读一点，
    /// 下一轮接着来。统计功能不该因为一个日志文件出问题就把整个面板拖下水。
    pub async fn ingest(&self) -> Result<usize, AppError> {
        let files = access::access_log_files(&self.caddy);
        let mut inserted = 0usize;

        for path in &files {
            let source = path.to_string_lossy().to_string();
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            let size = meta.len();
            let mut offset = match self.db.ingest_cursor(&source).unwrap_or(None) {
                Some(o) => o as u64,
                // 第一次见到这个文件，从**尾部**起读。
                //
                // 从头读会把整份历史日志灌进库里：真实的站点访问日志动辄几百兆，
                // 那是几十万条记录 —— 大屏看的是"最近"，几天前的流水进库只是
                // 白白占地方，还拖慢第一次统计。起点切在半行中间也没关系，那半行
                // 解析不出来会被跳过。
                None => size.saturating_sub(BOOTSTRAP_TAIL),
            };
            // 文件比游标短 = 被轮转或截断了，从头读。宁可重读一遍，也不要从此
            // 一直卡在一个再也读不到的位置上。
            if offset > size {
                offset = 0;
            }
            if offset >= size {
                continue;
            }

            let Ok((lines, next)) = read_new_lines(path, offset, READ_CHUNK) else {
                continue;
            };
            let mut batch = Vec::new();
            for line in &lines {
                if let Some(e) = access::parse_line(line) {
                    batch.push(NewAccessEvent {
                        ts: e.ts,
                        ip: e.ip,
                        host: e.host,
                        method: e.method,
                        uri: e.uri,
                        status: e.status as i64,
                        bytes: e.bytes as i64,
                        duration_ms: e.duration_ms,
                        ua: e.ua,
                        source: source.clone(),
                    });
                }
            }
            if !batch.is_empty() {
                inserted += self.db.insert_access_events(&batch)?;
            }
            self.db.set_ingest_cursor(&source, next as i64)?;
        }

        self.resolve_locations().await;
        self.ensure_self_location().await;
        // 清理一天做一次就够了，但多做几次也无害（DELETE 走索引）。
        let cutoff = now_secs() - (RETENTION_DAYS * 86_400) as f64;
        let _ = self.db.prune_access_events(cutoff);

        Ok(inserted)
    }

    /// 这台服务器自己在外面的位置。只查一次，之后从配置表读。
    ///
    /// 地球动画要一条"从访客落点连到这台机器"的弧线才讲得通，不然那些点只是
    /// 散在地图上。查不到就不画连线，不编一个坐标出来。
    async fn ensure_self_location(&self) {
        if self
            .db
            .get_config(SELF_LOCATION_KEY)
            .ok()
            .flatten()
            .is_some()
        {
            return;
        }
        let Some(geo) = geoip::lookup_self().await else {
            return;
        };
        let value = serde_json::json!({
            "label": geo.label,
            "lat": geo.lat,
            "lon": geo.lon,
            "count": 0,
        });
        let _ = self.db.set_config(SELF_LOCATION_KEY, &value.to_string());
    }

    /// 把还没归属地的 IP 补上。内网地址本地就能判定，不用发请求。
    async fn resolve_locations(&self) {
        let unknown = match self.db.access_unknown_ips(GEO_PER_ROUND) {
            Ok(list) => list,
            Err(_) => return,
        };
        if unknown.is_empty() {
            return;
        }

        let mut rows = Vec::new();
        let mut ask = Vec::new();
        for ip in unknown {
            match geoip::classify(&ip) {
                Some(geo) => rows.push(GeoRow {
                    ip,
                    label: geo.label,
                    country: geo.country,
                    city: geo.city,
                    isp: geo.isp,
                    lat: geo.lat,
                    lon: geo.lon,
                }),
                None => ask.push(ip),
            }
        }

        if !ask.is_empty() {
            let found = geoip::lookup(&ask).await;
            for (ip, geo) in found {
                rows.push(GeoRow {
                    ip,
                    label: geo.label,
                    country: geo.country,
                    city: geo.city,
                    isp: geo.isp,
                    lat: geo.lat,
                    lon: geo.lon,
                });
            }
        }

        let _ = self.db.upsert_geo(&rows);
    }

    pub fn overview(&self, hours: u32) -> Result<AnalyticsOverview, AppError> {
        let hours = hours.clamp(1, 24 * 90);
        let since = now_secs() - (hours as f64) * 3600.0;

        let (total, unique_ips) = self.db.access_totals(since)?;
        let map = |rows: Vec<(String, i64)>| -> Vec<Count> {
            rows.into_iter()
                .map(|(key, count)| Count {
                    key: if key.is_empty() { "—".into() } else { key },
                    count,
                })
                .collect()
        };

        Ok(AnalyticsOverview {
            hours,
            total,
            unique_ips,
            per_minute: if hours == 0 {
                0.0
            } else {
                total as f64 / (hours as f64 * 60.0)
            },
            locations: map(self.db.access_top_locations(since, 8)?),
            hosts: map(self.db.access_top_hosts(since, 6)?),
            paths: map(self.db.access_top_uris(since, 8)?),
            statuses: map(self.db.access_status_buckets(since)?),
            hourly: self.db.access_hourly(since)?.into_iter().map(|(hour, count)| HourPoint { hour, count }).collect(),
            cursor: self.db.access_last_id()?,
            sources: access::access_log_files(&self.caddy)
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            geo: geoip::resolver_hint(),
            self_location: self
                .db
                .get_config(SELF_LOCATION_KEY)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str::<GeoPointRow>(&raw).ok()),
            points: self.db.access_geo_points(since, 60)?,
            security: self.security(since)?,
        })
    }

    fn security(&self, since: f64) -> Result<Security, AppError> {
        Ok(Security {
            blocked: self.db.access_count_blocked(since)?,
            bots: self.db.access_count_ua(since, BOT_HINTS)?,
            tools: self.db.access_count_ua(since, TOOL_HINTS)?,
            attackers: self
                .db
                .access_top_attackers(since, TOOL_HINTS, 8)?
                .into_iter()
                .map(|(ip, location, count)| Attacker {
                    ip,
                    location,
                    count,
                })
                .collect(),
            blocked_paths: self
                .db
                .access_blocked_paths(since, 6)?
                .into_iter()
                .map(|(key, count)| Count { key, count })
                .collect(),
        })
    }

    /// 增量取。`after_id = 0` 表示"给我最近这批"，用来铺满首屏。
    pub fn events(&self, after_id: i64, limit: usize) -> Result<EventsPage, AppError> {
        let limit = limit.clamp(1, 500) as i64;
        let seed = after_id <= 0;
        let rows = if seed {
            // 首屏要的是"最新的"那几条。走 SQL 的 `ORDER BY id DESC LIMIT n`，
            // 别先把整表拉进内存再截断 —— 表大起来那是几百兆。
            self.db.access_latest(limit)?
        } else {
            self.db.access_recent(after_id, limit)?
        };
        let cursor = rows
            .last()
            .map(|r| r.id)
            .unwrap_or_else(|| self.db.access_last_id().unwrap_or(after_id));
        Ok(EventsPage {
            events: rows.into_iter().map(EventOut::from).collect(),
            cursor,
        })
    }
}

impl From<AccessEventRow> for EventOut {
    fn from(r: AccessEventRow) -> Self {
        let time = chrono::DateTime::from_timestamp(r.ts as i64, 0)
            .map(|t| {
                t.with_timezone(&chrono::Local)
                    .format("%H:%M:%S")
                    .to_string()
            })
            .unwrap_or_else(|| "—".to_string());
        let bot = !is_browser(&r.ua);
        Self {
            id: r.id,
            ts: r.ts,
            time,
            ip: r.ip,
            location: if r.label.is_empty() { "未知".into() } else { r.label },
            isp: r.isp,
            host: r.host,
            method: r.method,
            uri: r.uri,
            status: r.status,
            bytes: r.bytes,
            ua: r.ua,
            blocked: r.status == 403,
            bot,
        }
    }
}

/// UA 看着像人还是像机器。
///
/// 分成"自报的机器人"和"脚本工具"两批，但在这个标记上合并成一件事：**这条不是
/// 人点出来的**。大屏上只需要一眼分出来，分得太细反而没人看。
fn is_browser(ua: &str) -> bool {
    if ua.trim().is_empty() {
        return false;
    }
    let lower = ua.to_lowercase();
    !BOT_HINTS
        .iter()
        .chain(TOOL_HINTS.iter())
        .any(|h| lower.contains(h))
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 从 `offset` 往后读一段，只返回**完整的行**，并给出下一轮的起点。
///
/// 尾部那半行不能要：Caddy 可能正写到这里，切一半的 JSON 解析出来是错的，
/// 而且下次还会从同一位置再读，等于把它吃掉一半。
fn read_new_lines(
    path: &std::path::Path,
    offset: u64,
    max: u64,
) -> std::io::Result<(Vec<String>, u64)> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let end = (offset + max).min(size);
    file.seek(SeekFrom::Start(offset))?;

    let mut buf = vec![0u8; (end - offset) as usize];
    file.read_exact(&mut buf)?;

    let last_newline = buf.iter().rposition(|b| *b == b'\n');
    let Some(last_newline) = last_newline else {
        // 整个缓冲里没有换行：要么是一行超长的记录，要么文件还没写完这一行。
        // 两种情况都先不动游标，等下一轮。
        return Ok((Vec::new(), offset));
    };

    let text = String::from_utf8_lossy(&buf[..=last_newline]);
    let lines = text.lines().map(|s| s.to_string()).collect();
    Ok((lines, offset + last_newline as u64 + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 读到半行时不会把它吃掉() {
        let dir = std::env::temp_dir().join(format!("zops-access-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a_access.log");
        std::fs::write(&path, "one\ntwo\nthr").unwrap();

        let (lines, next) = read_new_lines(&path, 0, 1 << 20).unwrap();
        assert_eq!(lines, vec!["one", "two"]);
        assert_eq!(next, 8, "游标要停在完整的最后一行之后");

        // 接着写完后半行，下一轮就能读到。
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let (lines, next) = read_new_lines(&path, next, 1 << 20).unwrap();
        assert_eq!(lines, vec!["three"]);
        assert_eq!(next, 14);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn 没换行时原地不动() {
        let dir = std::env::temp_dir().join(format!("zops-access2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("b_access.log");
        std::fs::write(&path, "half-written-json").unwrap();
        let (lines, next) = read_new_lines(&path, 0, 1 << 20).unwrap();
        assert!(lines.is_empty());
        assert_eq!(next, 0);
        std::fs::remove_file(&path).ok();
    }
}
