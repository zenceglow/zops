//! 通知渠道与投递。
//!
//! 面板上发生的事（部署完成、容器挂了、磁盘告急）要能主动推给人，而不是等人来
//! 打开面板。这一层管三件事：渠道的增删改查、按事件筛选该发给谁、把结果记下来。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::infrastructure::db::{Database, NotifyChannelRow, NotifyLogRow};
use crate::infrastructure::notify::{self, Kind, Message};
use crate::shared::AppError;

/// 内置事件。用字符串而不是枚举，是为了以后加事件不用改库里的数据。
pub const EVENTS: &[(&str, &str)] = &[
    ("deploy", "部署完成"),
    ("container", "容器掉线"),
    ("pressure", "压力告警"),
    ("test", "测试消息"),
];

pub fn is_known_event(e: &str) -> bool {
    EVENTS.iter().any(|(k, _)| *k == e)
}

#[derive(Serialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub events: Vec<String>,
    pub enabled: bool,
    pub created_at: String,
    pub last_at: Option<String>,
    pub last_ok: Option<bool>,
    pub last_error: String,
    /// 打码后的地址 + 配置时的原始明文（前端「显示」按钮用）。
    pub url_masked: String,
    pub url: String,
    pub has_secret: bool,
    pub secret: String,
}

#[derive(Deserialize)]
pub struct ChannelInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub url: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

pub struct NotifyService {
    db: Arc<Database>,
}

impl NotifyService {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Result<Vec<Channel>, AppError> {
        Ok(self
            .db
            .list_notify_channels()
            .map_err(|e| AppError::internal(e.to_string()))?
            .into_iter()
            .map(Channel::from)
            .collect())
    }

    pub fn log(&self, limit: i64) -> Result<Vec<NotifyLogRow>, AppError> {
        self.db
            .list_notify_log(limit)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    pub fn save(&self, input: ChannelInput) -> Result<Channel, AppError> {
        if input.name.trim().is_empty() {
            return Err(AppError::bad_request("给这个渠道起个名字"));
        }
        if Kind::parse(&input.kind).is_none() {
            return Err(AppError::bad_request(format!("不认识的通知类型: {}", input.kind)));
        }
        if !input.url.starts_with("http://") && !input.url.starts_with("https://") {
            return Err(AppError::bad_request("webhook 地址要以 http(s):// 开头"));
        }
        let events: Vec<String> = input
            .events
            .into_iter()
            .filter(|e| is_known_event(e))
            .collect();
        if events.is_empty() {
            return Err(AppError::bad_request("至少要订阅一个事件"));
        }

        let row = NotifyChannelRow {
            id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: input.name.trim().to_string(),
            kind: input.kind,
            url: input.url.trim().to_string(),
            secret: input.secret.trim().to_string(),
            events: serde_json::to_string(&events).unwrap_or_else(|_| "[]".into()),
            enabled: input.enabled,
            created_at: String::new(),
            last_at: None,
            last_ok: None,
            last_error: String::new(),
        };
        self.db
            .upsert_notify_channel(&row)
            .map_err(|e| AppError::internal(e.to_string()))?;
        // 取回刚存的（连带 created_at / 上次状态），不然前端列表要自己拼。
        self.list()?
            .into_iter()
            .find(|c| c.id == row.id)
            .ok_or_else(|| AppError::internal("保存后读不到这个渠道"))
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), AppError> {
        let hit = self
            .db
            .set_notify_enabled(id, enabled)
            .map_err(|e| AppError::internal(e.to_string()))?;
        if !hit {
            return Err(AppError::not_found("没有这个渠道"));
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let hit = self
            .db
            .delete_notify_channel(id)
            .map_err(|e| AppError::internal(e.to_string()))?;
        if !hit {
            return Err(AppError::not_found("没有这个渠道"));
        }
        Ok(())
    }

    /// 给一个渠道发一条，并把结果记下来。
    pub async fn send_to(
        &self,
        channel: &NotifyChannelRow,
        event: &str,
        title: &str,
        text: &str,
    ) -> Result<notify::Delivery, AppError> {
        let Some(kind) = Kind::parse(&channel.kind) else {
            return Err(AppError::bad_request("渠道类型不对"));
        };
        let host = hostname();
        let delivery = notify::send(
            kind,
            &channel.url,
            &channel.secret,
            &Message {
                title,
                text,
                event,
                host: &host,
            },
        )
        .await;

        let _ = self.db.touch_notify_channel(
            &channel.id,
            delivery.ok,
            if delivery.ok { "" } else { &delivery.detail },
        );
        let _ = self.db.add_notify_log(
            &channel.name,
            &channel.kind,
            event,
            delivery.ok,
            delivery.status as i64,
            &delivery.detail,
        );
        Ok(delivery)
    }

    /// 按事件推给所有订阅了它的渠道。返回"发出去几条、成功几条"。
    ///
    /// 单个渠道失败不影响其它渠道：一个群里机器人被踢了，不该让别的群也收不到。
    pub async fn broadcast(&self, event: &str, title: &str, text: &str) -> (usize, usize) {
        let Ok(channels) = self.db.list_notify_channels() else {
            return (0, 0);
        };
        let mut sent = 0;
        let mut ok = 0;
        for c in channels.iter().filter(|c| c.enabled && subscribes(c, event)) {
            sent += 1;
            if let Ok(d) = self.send_to(c, event, title, text).await {
                if d.ok {
                    ok += 1;
                }
            }
        }
        (sent, ok)
    }

    pub fn channel(&self, id: &str) -> Result<NotifyChannelRow, AppError> {
        self.db
            .list_notify_channels()
            .map_err(|e| AppError::internal(e.to_string()))?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::not_found("没有这个渠道"))
    }
}

fn subscribes(c: &NotifyChannelRow, event: &str) -> bool {
    serde_json::from_str::<Vec<String>>(&c.events)
        .map(|list| list.iter().any(|e| e == event))
        .unwrap_or(false)
}

pub(crate) fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "ZOPS".to_string())
}

impl From<NotifyChannelRow> for Channel {
    fn from(r: NotifyChannelRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            kind: r.kind,
            events: serde_json::from_str(&r.events).unwrap_or_default(),
            enabled: r.enabled,
            created_at: r.created_at,
            last_at: r.last_at,
            last_ok: r.last_ok,
            last_error: r.last_error,
            url_masked: mask(&r.url),
            url: r.url,
            has_secret: !r.secret.is_empty(),
            secret: r.secret,
        }
    }
}

/// webhook 地址里藏着 token，列表上默认打码；这是**防肩窥**，不是加密 ——
/// 点「显示」就能看到，因为要不要改它得看得见。
fn mask(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return "***".into();
    };
    let (scheme, rest) = url.split_at(scheme_end + 3);
    let (host, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    if path.len() <= 8 {
        format!("{scheme}{host}{path}")
    } else {
        format!("{scheme}{host}{}…{}", &path[..5], &path[path.len() - 4..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 打码保留主机名但遮住_token() {
        let m = mask("https://open.feishu.cn/open-apis/bot/v2/hook/abc123def456");
        assert!(m.starts_with("https://open.feishu.cn/"));
        assert!(!m.contains("abc123def456"));
    }

    #[test]
    fn 事件订阅按数组匹配() {
        let c = NotifyChannelRow {
            id: "1".into(),
            name: "x".into(),
            kind: "feishu".into(),
            url: "https://x".into(),
            secret: "".into(),
            events: "[\"deploy\",\"pressure\"]".into(),
            enabled: true,
            created_at: "".into(),
            last_at: None,
            last_ok: None,
            last_error: "".into(),
        };
        assert!(subscribes(&c, "deploy"));
        assert!(!subscribes(&c, "container"));
    }
}
