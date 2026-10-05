//! 给站点入口找一个图标。
//!
//! 静态站点的入口只有一行域名，看起来全一样；能显示它自己的 favicon，一眼就能
//! 认出"这是哪个站"。代理站点不需要 —— 它没有自己的页面，给一个地球反而更准。
//!
//! 由**服务端**去取，不是浏览器：面板常常通过 `http://IP:5200` 打开，站点的
//! favicon 可能在 https 上，也可能是内网域名只有服务器能解析。
//!
//! 取图片这一步走 `curl` 而不是 hyper：真实的站点几乎都在 https 上，而 hyper 的
//! 纯 HTTP 连接器不会 TLS 握手。为一个 favicon 引一套 rustls 不划算，curl 则
//! 每台机器上都有，顺带把跳转、压缩、超时都处理了。
//! （geoip 那边用 hyper 是因为它走 http，免费接口本身就是 http。）

use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const TIMEOUT_SECS: &str = "6";
/// 图标不该有这么大。超过就是取错了东西（比如首页 HTML）。
const MAX_BYTES: usize = 256 * 1024;
/// 找到了缓存 6 小时，没找到缓存半小时 —— favicon 不会天天换，但也不该记一辈子。
const HIT_TTL: Duration = Duration::from_secs(6 * 3600);
const MISS_TTL: Duration = Duration::from_secs(1800);

#[derive(Clone)]
pub struct SiteIcon {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, Option<SiteIcon>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Option<SiteIcon>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn fetch(host: &str) -> Option<SiteIcon> {
    let key = host.to_lowercase();
    if let Ok(map) = cache().lock() {
        if let Some((at, value)) = map.get(&key) {
            let ttl = if value.is_some() { HIT_TTL } else { MISS_TTL };
            if at.elapsed() < ttl {
                return value.clone();
            }
        }
    }

    let found = discover(host).await;
    if let Ok(mut map) = cache().lock() {
        // 缓存别无限长，顺手清掉过期的。
        map.retain(|_, (at, _)| at.elapsed() < HIT_TTL);
        map.insert(key, (Instant::now(), found.clone()));
    }
    found
}

async fn discover(host: &str) -> Option<SiteIcon> {
    for scheme in ["https", "http"] {
        // 1. 约定位置先试：大部分站点的 favicon 就在根上。
        if let Some(icon) = get_icon(&format!("{scheme}://{host}/favicon.ico")).await {
            return Some(icon);
        }
        // 2. 再看首页里声明的 <link rel="icon">。现代站点很多把图标放在
        //    /assets/xxx.png 上，光试 /favicon.ico 是找不到的。
        if let Some(html) = get_text(&format!("{scheme}://{host}/")).await {
            for href in declared_icons(&html) {
                let url = absolute(&href, scheme, host);
                if let Some(icon) = get_icon(&url).await {
                    return Some(icon);
                }
            }
        }
    }
    None
}

/// 从首页 HTML 里抠出 `<link rel="…icon…" href="…">`。
///
/// 两种属性顺序都认（rel 在前 / href 在前）—— 这一条不值得引一个 HTML 解析器。
fn declared_icons(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = html.to_lowercase();
    let mut cursor = 0usize;
    while let Some(pos) = lower[cursor..].find("<link") {
        let start = cursor + pos;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + end_rel];
        cursor = start + end_rel + 1;
        let tag_lower = tag.to_lowercase();
        if !tag_lower.contains("icon") {
            continue;
        }
        if let Some(href) = attr(tag, "href") {
            if !href.starts_with("data:") {
                out.push(href);
            }
        }
    }
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let idx = lower.find(&format!("{name}="))?;
    let rest = &tag[idx + name.len() + 1..];
    let rest = rest.trim_start();
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let body = &rest[1..];
        let end = body.find(quote)?;
        Some(body[..end].trim().to_string())
    } else {
        Some(rest.split_whitespace().next()?.to_string())
    }
}

fn absolute(href: &str, scheme: &str, host: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        href.to_string()
    } else if let Some(rest) = href.strip_prefix("//") {
        format!("{scheme}://{rest}")
    } else if href.starts_with('/') {
        format!("{scheme}://{host}{href}")
    } else {
        format!("{scheme}://{host}/{href}")
    }
}

async fn get_icon(url: &str) -> Option<SiteIcon> {
    let (content_type, bytes) = get(url, MAX_BYTES).await?;
    let looks_like_image = content_type.starts_with("image/") || sniff(&bytes);
    looks_like_image.then_some(SiteIcon {
        content_type: if content_type.starts_with("image/") {
            content_type
        } else {
            sniff_type(&bytes).to_string()
        },
        bytes,
    })
}

/// 有的服务器把图标当 `application/octet-stream` 发，只能看字节头。
fn sniff(b: &[u8]) -> bool {
    b.starts_with(b"\x89PNG") || b.starts_with(b"\xff\xd8\xff") || b.starts_with(b"GIF8")
        || b.starts_with(b"\x00\x00\x01\x00") || b.windows(4).any(|w| w == b"<svg")
        || (b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP")
}

fn sniff_type(b: &[u8]) -> &'static str {
    if b.starts_with(b"\x89PNG") {
        "image/png"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.starts_with(b"\x00\x00\x01\x00") {
        "image/x-icon"
    } else if b.len() > 12 && b.starts_with(b"RIFF") {
        "image/webp"
    } else if b.windows(4).any(|w| w == b"<svg") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

async fn get_text(url: &str) -> Option<String> {
    let (_, bytes) = get(url, 512 * 1024).await?;
    String::from_utf8(bytes).ok()
}

async fn get(url: &str, max: usize) -> Option<(String, Vec<u8>)> {
    let marker = "\u{1}ZOPS\u{1}";
    let out = tokio::task::spawn_blocking({
        let url = url.to_string();
        let marker = marker.to_string();
        move || {
            Command::new("curl")
                .args([
                    "-sSL", // 静默、跟随跳转
                    "--compressed",
                    "--max-time",
                    TIMEOUT_SECS,
                    "--max-filesize",
                    &max.to_string(),
                    "-A",
                    "ZOPS/1.0 (+site icon)",
                    // 结果码和类型跟在正文后面，用一个正文里不会出现的分隔符隔开。
                    "-w",
                    &format!("{marker}%{{http_code}}\t%{{content_type}}"),
                    &url,
                ])
                .output()
                .ok()
        }
    })
    .await
    .ok()??;

    let sep = out.stdout.windows(marker.len()).rposition(|w| w == marker.as_bytes())?;
    let meta = String::from_utf8_lossy(&out.stdout[sep + marker.len()..]);
    let bytes = out.stdout[..sep].to_vec();
    let mut parts = meta.trim().split('\t');
    let code = parts.next().unwrap_or("");
    let content_type = parts
        .next()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();

    // curl 找不到命令、超时、超大小、非 200 —— 都当作"这个站点没有可用的图标"。
    if code != "200" || bytes.is_empty() || bytes.len() > max {
        return None;
    }
    Some((content_type, bytes))
}

/// 站点地址里能不能取出一个可访问的主机名。
///
/// `:443`、`*.example.com` 这种取不出来 —— 要么没域名，要么指一片域名，别猜。
pub fn host_of(addr: &str) -> Option<String> {
    let addr = addr.trim();
    if addr.starts_with(':') || addr.contains('*') || addr.is_empty() {
        return None;
    }
    // 去 scheme、去端口、去路径，只留主机名。
    let without_scheme = addr.split("://").last().unwrap_or(addr);
    let host = without_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    // 至少得像一个域名：有点，且没有空格。
    if host.contains('.') && !host.contains(' ') && host.len() <= 253 {
        Some(host.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 从站点地址里取主机名() {
        assert_eq!(host_of("example.com").as_deref(), Some("example.com"));
        assert_eq!(host_of("https://shop.example.com/").as_deref(), Some("shop.example.com"));
        assert_eq!(host_of("example.com:8443").as_deref(), Some("example.com"));
        assert_eq!(host_of(":443"), None);
        assert_eq!(host_of("*.example.com"), None);
        assert_eq!(host_of("localhost"), None);
    }

    #[test]
    fn 认得出首页里声明的图标() {
        let html = r#"
        <html><head>
          <link rel="icon" href="/assets/logo.png">
          <link href="/icon-32.png" rel="shortcut icon" type="image/png">
          <link rel="stylesheet" href="/a.css">
        </head></html>"#;
        let icons = declared_icons(html);
        assert_eq!(icons, vec!["/assets/logo.png", "/icon-32.png"]);
    }

    #[test]
    fn 相对路径补成绝对地址() {
        assert_eq!(
            absolute("/x.png", "https", "a.com"),
            "https://a.com/x.png"
        );
        assert_eq!(
            absolute("//cdn.a.com/x.png", "https", "a.com"),
            "https://cdn.a.com/x.png"
        );
        assert_eq!(
            absolute("http://b.com/x.png", "https", "a.com"),
            "http://b.com/x.png"
        );
    }
}
