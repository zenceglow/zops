//! 往外发通知。
//!
//! 五家国内外的机器人都长着同一张脸：一个 POST，一个 JSON 体，字段名各家不一样。
//! 所以这里只有"把一句话塞进各家的信封"这一件事，业务逻辑（谁该收到、什么时候
//! 发）在 service 层。
//!
//! 发请求走 `curl` 而不是进程内的 HTTP 客户端：机器人地址清一色是 https，而
//! hyper 的 `build_http()` 是**明文**连接器，不做 TLS 握手 —— 表现是每个渠道都
//! 连不上，还只回一句语焉不详的 `client error (Connect)`。geoip 和自更新那边
//! 早就换成 curl 了，这里是同一个坑。

pub mod sign;

use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

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
    let (url, payload) = (url.to_string(), body.to_string());
    let out = tokio::task::spawn_blocking(move || curl_post(&url, &payload)).await;

    let out = match out {
        Err(e) => {
            return Delivery {
                ok: false,
                status: 0,
                detail: format!("发送任务没能启动: {e}"),
            }
        }
        Ok(Err(e)) => {
            return Delivery {
                ok: false,
                status: 0,
                detail: format!("调不动 curl: {e}"),
            }
        }
        Ok(Ok(o)) => o,
    };

    // curl 自己失败（超时、DNS、连不上、证书）时 stderr 里那句才是真正有用的，
    // 原样带回去 —— 用户看到 "Could not resolve host" 就知道是网络，而不是"没配好"。
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Delivery {
            ok: false,
            status: 0,
            detail: if err.is_empty() {
                format!("curl 退出码 {:?}", out.status.code())
            } else {
                err
            },
        };
    }

    let raw = String::from_utf8_lossy(&out.stdout);
    let (text, status) = split_status(&raw);

    // 各家的"成功"不都写在 HTTP 状态码上：飞书和钉钉失败时照样回 200，
    // 真正的结果在响应体的 code / errcode 里。只看状态码会把"没发出去"报成成功。
    let ok = status == 200 && body_ok(&text);
    Delivery {
        ok,
        status,
        detail: truncate(&text, 300),
    }
}

/// 用 curl 发一个 JSON POST。正文从 stdin 进去，不放 argv —— 告警内容可能带主机名、
/// 路径这些信息，同机器上 `ps` 不该看得到。
fn curl_post(url: &str, payload: &str) -> std::io::Result<std::process::Output> {
    let mut child = std::process::Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            &TIMEOUT.as_secs().to_string(),
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            // 把状态码挂在正文后面（`-w`），不然 curl 不告诉我们 HTTP 码，
            // 而飞书/钉钉的失败信息只写在正文里，两个都要。
            "-w",
            "\n%{http_code}",
            url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(si) = child.stdin.as_mut() {
        si.write_all(payload.as_bytes())?;
    }
    child.wait_with_output()
}

/// 拆开 `-w "\n%{http_code}"` 拼出来的输出：最后一行是状态码，前面全是正文。
fn split_status(raw: &str) -> (String, u16) {
    match raw.rsplit_once('\n') {
        Some((body, code)) => (
            body.trim().to_string(),
            code.trim().parse::<u16>().unwrap_or(0),
        ),
        None => (raw.trim().to_string(), 0),
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
