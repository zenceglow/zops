//! IP → 归属地。
//!
//! 访问日志里只有 IP，但"访客从哪来"才是人看得懂的信息。这里不引 GeoIP 数据库：
//! Geolite2 要注册账号才能下、还有 license 约束，装到别人的服务器上不合适。
//! 改成查一次、缓存一次 —— 每个 IP 只问一次外网，之后都从 SQLite 里读。
//!
//! 两件事必须先说清楚，不然结果会骗人：
//! 1. 内网、本机地址根本不查，直接标出来。127.0.0.1 落到"某个城市"只会更糊涂。
//! 2. 查不到就是"未知"，不要拿一个看似合理的城市糊上去。反代、CDN、运营商出口
//!    都会让归属地偏移，这一列本来就是**参考**，不是事实。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// ip-api 的批量接口：一次最多 100 个 IP，返回里带 `query` 字段好回填。
const DEFAULT_ENDPOINT: &str =
    "http://ip-api.com/batch?lang=zh-CN&fields=status,message,country,regionName,city,isp,lat,lon,query";
/// 不带参数问它，返回的就是"我自己"在哪。用来把地球上的访问点连到这台服务器。
const SELF_ENDPOINT: &str =
    "http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,isp,lat,lon,query";

pub const MAX_BATCH: usize = 100;
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Geo {
    /// 给界面直接显示的短标签：城市名，或者"内网"/"本机"。
    pub label: String,
    pub country: String,
    pub city: String,
    pub isp: String,
    /// 经纬度，给地球动画定位用。查不到就是 0/0（几内亚湾），别画。
    pub lat: f64,
    pub lon: f64,
}

/// 一眼能认出来的地址就不用出门问了。
pub fn classify(ip: &str) -> Option<Geo> {
    let parsed: IpAddr = ip.parse().ok()?;
    let label = match parsed {
        IpAddr::V4(v4) => {
            if v4.is_loopback() || v4.is_unspecified() {
                "本机"
            } else if v4.is_private() || v4.is_link_local() || is_cgnat(v4) {
                "内网"
            } else {
                return None;
            }
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                "本机"
            } else {
                // fc00::/7 唯一本地地址、fe80::/10 链路本地地址。
                let head = v6.segments()[0];
                if (head & 0xfe00) == 0xfc00 || (head & 0xffc0) == 0xfe80 {
                    "内网"
                } else {
                    return None;
                }
            }
        }
    };
    Some(Geo {
        label: label.to_string(),
        ..Default::default()
    })
}

/// 100.64.0.0/10 —— 运营商级 NAT。标准库的 `is_private` 不含它，但对这台机器
/// 来说它和 10.x 一样都是"内网来的"。
fn is_cgnat(v4: Ipv4Addr) -> bool {
    let [a, b, ..] = v4.octets();
    a == 100 && (64..128).contains(&b)
}

/// 查询开关。运维面板默认开，不想让面板往外发请求的可以关掉。
fn enabled() -> bool {
    !matches!(
        std::env::var("GEOIP_DISABLED").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn endpoint() -> String {
    std::env::var("GEOIP_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string())
}

/// 批量查询。查不到的直接不在返回里 —— 调用方下次还能再试，不会把"未知"写死。
pub async fn lookup(ips: &[String]) -> HashMap<String, Geo> {
    let mut out = HashMap::new();
    if !enabled() || ips.is_empty() {
        return out;
    }
    for chunk in ips.chunks(MAX_BATCH) {
        match query(chunk).await {
            Ok(map) => out.extend(map),
            // 外网不通只是这一轮查不到，不影响采集本身，界面上显示"未知"就够了。
            Err(_) => {}
        }
    }
    out
}

/// 这台服务器自己在外面的位置。
///
/// 地球动画要一条"从访客到我这台机器"的弧线才讲得通 —— 没有终点的话，那些点
/// 只是散在地图上。ip-api 不带参数问就是问调用方自己的出口 IP。
pub async fn lookup_self() -> Option<Geo> {
    if !enabled() {
        return None;
    }
    let out = get(SELF_ENDPOINT).await.ok()?;
    parse_one(&out)
}

async fn query(ips: &[String]) -> Result<HashMap<String, Geo>, String> {
    let body = serde_json::to_vec(ips).map_err(|e| e.to_string())?;
    let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let req = Request::builder()
        .method("POST")
        .uri(endpoint())
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body)))
        .map_err(|e| e.to_string())?;

    let body = send(client, req).await?;
    parse_response(&body)
}

async fn get(url: &str) -> Result<String, String> {
    let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let req = Request::builder()
        .method("GET")
        .uri(url)
        .body(Full::new(Bytes::new()))
        .map_err(|e| e.to_string())?;
    send(client, req).await
}

async fn send(
    client: Client<hyper_util::client::legacy::connect::HttpConnector, Full<Bytes>>,
    req: Request<Full<Bytes>>,
) -> Result<String, String> {
    let res = tokio::time::timeout(TIMEOUT, client.request(req))
        .await
        .map_err(|_| "查询超时".to_string())?
        .map_err(|e| e.to_string())?;
    if res.status() != StatusCode::OK {
        return Err(format!("查询返回 {}", res.status()));
    }
    let bytes = res
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Deserialize)]
struct Row {
    #[serde(default)]
    status: String,
    #[serde(default)]
    query: String,
    #[serde(default)]
    country: String,
    #[serde(default, rename = "regionName")]
    region: String,
    #[serde(default)]
    city: String,
    #[serde(default)]
    isp: String,
    #[serde(default)]
    lat: f64,
    #[serde(default)]
    lon: f64,
}

fn parse_response(raw: &str) -> Result<HashMap<String, Geo>, String> {
    let rows: Vec<Row> = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        if row.status != "success" || row.query.is_empty() {
            continue;
        }
        // 「省 · 市」比只给一个市有用；直辖市两者同名，别写成"北京 · 北京"。
        let label = if row.city.is_empty() {
            row.region.clone()
        } else if row.region.is_empty() || row.region.starts_with(&row.city) {
            row.city.clone()
        } else {
            format!("{} · {}", row.region, row.city)
        };
        out.insert(
            row.query,
            Geo {
                label,
                country: row.country,
                city: row.city,
                isp: row.isp,
                lat: row.lat,
                lon: row.lon,
            },
        );
    }
    Ok(out)
}

fn parse_one(raw: &str) -> Option<Geo> {
    let row: Row = serde_json::from_str(raw).ok()?;
    if row.status != "success" {
        return None;
    }
    let label = if row.city.is_empty() { row.region } else { row.city.clone() };
    Some(Geo {
        label,
        country: row.country,
        city: row.city,
        isp: row.isp,
        lat: row.lat,
        lon: row.lon,
    })
}

/// 给界面看的说明，说清楚这个数字是怎么来的。
pub fn resolver_hint() -> serde_json::Value {
    json!({
        "enabled": enabled(),
        "endpoint": if enabled() { endpoint() } else { String::new() },
        "note": "内网与本机地址不查询，直接标注；其余 IP 每个只查一次并缓存。归属地来自 IP 库，反代与运营商出口会让它偏移，只作参考。"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 内网与公网地址分得开() {
        assert_eq!(classify("127.0.0.1").unwrap().label, "本机");
        assert_eq!(classify("::1").unwrap().label, "本机");
        assert_eq!(classify("192.168.1.10").unwrap().label, "内网");
        assert_eq!(classify("10.0.0.5").unwrap().label, "内网");
        assert_eq!(classify("172.16.3.4").unwrap().label, "内网");
        assert_eq!(classify("100.64.0.1").unwrap().label, "内网");
        assert_eq!(classify("fd00::1").unwrap().label, "内网");
        assert!(classify("8.8.8.8").is_none());
        assert!(classify("不合法").is_none());
    }

    #[test]
    fn 只取成功的记录并且拼出短标签() {
        let raw = r#"[
            {"status":"success","query":"1.2.3.4","country":"中国","regionName":"浙江省","city":"杭州","isp":"电信"},
            {"status":"fail","query":"5.6.7.8","message":"reserved range"}
        ]"#;
        let map = parse_response(raw).unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map["1.2.3.4"].label, "浙江省 · 杭州");
        assert_eq!(map["1.2.3.4"].isp, "电信");
    }
}
