//! 往外发通知。
//!
//! 五家国内外的机器人都长着同一张脸：一个 POST，一个 JSON 体，字段名各家不一样。
//! 所以这里只有"把一句话塞进各家的信封"这一件事，业务逻辑（谁该收到、什么时候
//! 发）在 service 层。
//!
//! 用 hyper 而不是再引一个 HTTP 客户端：geoip 那边已经把它提成直接依赖了。

pub mod sign;

use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{json, Value};

use sign::{hmac_sha256, to_base64};

const TIMEOUT: Duration = Duration::from_secs(10);

/// 一次投递的结果。失败原因原样带回去 —— 机器人配错了，用户需要看到对方说的话，
/// 而不是一句"发送失败"。
#[derive(Debug, Clone)]
pub struct Delivery {
    pub ok: bool,
    pub status: u16,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Feishu,
    DingTalk,
    WeCom,
    Slack,
    Discord,
    Telegram,
    /// 自家或别人的通用 webhook，收 JSON。
    Generic,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "feishu" => Self::Feishu,
            "dingtalk" => Self::DingTalk,
            "wecom" => Self::WeCom,
            "slack" => Self::Slack,
            "discord" => Self::Discord,
            "telegram" => Self::Telegram,
            "generic" => Self::Generic,
            _ => return None,
        })
    }
}

/// 消息正文。各家都用得上同样的几行，差别只在信封。
pub struct Message<'a> {
    pub title: &'a str,
    pub text: &'a str,
    pub event: &'a str,
    pub host: &'a str,
}

pub async fn send(kind: Kind, url: &str, secret: &str, msg: &Message<'_>) -> Delivery {
    let body = match kind {
        Kind::Feishu => feishu_body(msg),
        Kind::DingTalk => dingtalk_body(msg),
        Kind::WeCom => wecom_body(msg),
        Kind::Slack => json!({ "text": format!("*{}*\n{}", msg.title, msg.text) }),
        Kind::Discord => json!({ "content": format!("**{}**\n{}", msg.title, msg.text) }),
        Kind::Telegram => json!({ "chat_id": chat_id(url), "text": format!("{}\n{}", msg.title, msg.text) }),
        Kind::Generic => json!({
            "event": msg.event,
            "title": msg.title,
            "text": msg.text,
            "host": msg.host,
        }),
    };
    post(kind, url, secret, body).await
}

/// 飞书：`msg_type=text` 最省事，也最不容易因为卡片 schema 改动而失效。
fn feishu_body(msg: &Message<'_>) -> Value {
    json!({
        "msg_type": "text",
        "content": { "text": format!("{}\n\n{}", msg.title, msg.text) }
    })
}

fn dingtalk_body(msg: &Message<'_>) -> Value {
    json!({
        "msgtype": "text",
        "text": { "content": format!("{}\n\n{}", msg.title, msg.text) }
    })
}

fn wecom_body(msg: &Message<'_>) -> Value {
    json!({
        "msgtype": "text",
        "text": { "content": format!("{}\n\n{}", msg.title, msg.text) }
    })
}

/// Telegram 的 webhook 地址就是 `https://api.telegram.org/bot<token>/sendMessage`，
/// chat_id 得单独给。放在 URL 的 query 里最省事：`…?chat_id=123`。
fn chat_id(url: &str) -> String {
    url.split_once('?')
        .and_then(|(_, q)| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("chat_id="))
                .map(|v| v.to_string())
        })
        .unwrap_or_default()
}

/// 去掉 query 上的额外参数，只留真正的接口地址。
fn endpoint(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

async fn post(kind: Kind, url: &str, secret: &str, body: Value) -> Delivery {
    let mut target = endpoint(url).to_string();
    let mut payload = body;

    // 钉钉和飞书都支持"加签"：URL 泄漏了，光有地址也发不出消息。两家的放法还不一样
    // —— 钉钉把 timestamp/sign 拼在 query 上，飞书塞在 body 里。
    match kind {
        Kind::DingTalk if !secret.is_empty() => {
            let ts = now_millis();
            let sign = dingtalk_sign(secret, ts);
            let sep = if target.contains('?') { '&' } else { '?' };
            target = format!("{target}{sep}timestamp={ts}&sign={}", url_encode(&sign));
        }
        Kind::Feishu if !secret.is_empty() => {
            let ts = now_secs();
            // 飞书的签名内容是 `{timestamp}\n{secret}`，把它当 HMAC 的密钥、消息留空。
            let string_to_sign = format!("{ts}\n{secret}");
            payload["timestamp"] = json!(ts.to_string());
            payload["sign"] = json!(to_base64(&hmac_sha256(string_to_sign.as_bytes(), b"")));
        }
        _ => {}
    }

    post_to(&target, &payload).await
}

async fn post_to(url: &str, body: &Value) -> Delivery {
    let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let req = match Request::builder()
        .method("POST")
        .uri(url)
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
    {
        Ok(r) => r,
        Err(e) => {
            return Delivery {
                ok: false,
                status: 0,
                detail: format!("地址不合法: {e}"),
            }
        }
    };

    let res = match tokio::time::timeout(TIMEOUT, client.request(req)).await {
        Err(_) => {
            return Delivery {
                ok: false,
                status: 0,
                detail: "请求超时".into(),
            }
        }
        Ok(Err(e)) => {
            return Delivery {
                ok: false,
                status: 0,
                detail: format!("请求失败: {e}"),
            }
        }
        Ok(Ok(r)) => r,
    };

    let status = res.status();
    let bytes = match res.into_body().collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => {
            return Delivery {
                ok: false,
                status: status.as_u16(),
                detail: format!("读取响应失败: {e}"),
            }
        }
    };
    let text = String::from_utf8_lossy(&bytes).trim().to_string();

    // 各家的"成功"不都写在 HTTP 状态码上：飞书和钉钉失败时照样回 200，
    // 真正的结果在响应体的 code / errcode 里。只看状态码会把"没发出去"报成成功。
    let ok = status == StatusCode::OK && body_ok(&text);
    Delivery {
        ok,
        status: status.as_u16(),
        detail: truncate(&text, 300),
    }
}

fn body_ok(text: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        // 不是 JSON（比如 Discord 的 204 空响应）就认状态码。
        return true;
    };
    for key in ["code", "errcode", "StatusCode", "status_code"] {
        if let Some(n) = v.get(key).and_then(Value::as_i64) {
            return n == 0;
        }
    }
    v.get("ok").and_then(Value::as_bool).unwrap_or(true)
}

fn dingtalk_sign(secret: &str, ts: i64) -> String {
    let string_to_sign = format!("{ts}\n{secret}");
    let digest = hmac_sha256(secret.as_bytes(), string_to_sign.as_bytes());
    to_base64(&digest)
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
