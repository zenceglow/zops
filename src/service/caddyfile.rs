use std::sync::Arc;

use crate::domain::caddy::{duplicate_addrs, mark_block, parse_caddyfile, remove_site, CaddyfileData};
use crate::infrastructure::caddy::CaddyProcess;
use crate::infrastructure::db::{CaddyfileVersionRow, Database};
use crate::shared::AppError;

pub struct CaddyfileService {
    caddy: Arc<CaddyProcess>,
    db: Arc<Database>,
}

impl CaddyfileService {
    pub fn new(caddy: Arc<CaddyProcess>, db: Arc<Database>) -> Self {
        Self { caddy, db }
    }

    /// 落盘前先给"改之前"的样子留一份快照。
    ///
    /// 网关配置改坏 = 全站 502，而这份文件不像数据库那样有天然的旧版本，所以每次
    /// 写入前都把当前内容存进 SQLite。内容没变就不存 —— 否则连点两次保存会攒出
    /// 一堆一模一样的版本，翻历史时全是噪音。
    fn snapshot(&self, previous: &str, author: &str, note: &str) {
        if previous.trim().is_empty() {
            return;
        }
        let _ = self.db.add_caddyfile_version(previous, author, note);
    }

    pub async fn get(&self) -> Result<CaddyfileData, AppError> {
        // Docker mode edits the host side of the container's bind mount, so the
        // configured path is only a fallback.
        let path = self.caddy.effective_caddyfile_path();
        // 文件不存在不是错误 —— 新装的机器本来就是"还没有 Caddyfile"。以前这里
        // 返回 404，前端把整个配置置空，于是「配置文件」Tab 一片空白、连文件都建
        // 不出来（而空状态偏偏提示你去那个 Tab）。给个空文档，编辑器就能落笔。
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => return Err(AppError::not_found(format!("读取配置文件失败：{path}"))),
        };
        let parsed = parse_caddyfile(&raw);
        Ok(CaddyfileData { raw, parsed })
    }

    pub async fn update(&self, raw: String) -> Result<serde_json::Value, AppError> {
        self.update_as(raw, "", "保存配置").await
    }

    pub async fn update_as(
        &self,
        raw: String,
        author: &str,
        note: &str,
    ) -> Result<serde_json::Value, AppError> {
        let path = self.caddy.effective_caddyfile_path();
        let previous = tokio::fs::read_to_string(&path).await.unwrap_or_default();

        // 先校验，一个字都不写。顺序很重要：以前只跑 `caddy fmt`，而 fmt 只管
        // 排版不管对错 —— `reverse_proxy` 少打一个字母照样排版得整整齐齐，写进
        // 文件之后下一次 Caddy 重启就再也起不来，**全站一起下线**。
        // 一份配置是一个整体，Caddy 不给你"只坏一个站点"的余地，所以唯一的
        // 办法是让坏配置根本落不了盘。
        let validated = self.caddy.format_caddyfile(raw).await?;

        // 重复的站点地址：Caddy 加载时会直接拒绝，同样是全站下线。
        // 放在校验之前，是为了给出比 Caddy 那句 "ambiguous site definition"
        // 更好懂的话 —— 它不会告诉你"面板里已经有一条了，先去删掉"。
        let dupes = duplicate_addrs(&parse_caddyfile(&validated));
        if !dupes.is_empty() {
            return Err(AppError::bad_request(format!(
                "同一份配置里出现了重复的入口：{}。Caddy 会拒绝加载整份配置（不只是那一个站点），所以先删掉一个再保存。",
                dupes.join("、")
            )));
        }

        // 先校验，一个字都不写。顺序很重要：以前只跑 `caddy fmt`，而 fmt 只管
        // 排版不管对错 —— `reverse_proxy` 少打一个字母照样排版得整整齐齐，写进
        // 文件之后下一次 Caddy 重启就再也起不来，**全站一起下线**。
        // 一份配置是一个整体，Caddy 不给"只坏一个站点"的余地，所以唯一的办法
        // 是让坏配置根本落不了盘。
        self.caddy
            .validate_caddyfile(&validated)
            .await
            .map_err(|e| {
                AppError::bad_request(format!("Caddyfile 校验不通过，没有保存：\n{e}"))
            })?;

        if previous.trim() != validated.trim() {
            self.snapshot(&previous, author, note);
        }

        // 目录可能还不存在（面板装到一半、或者路径是自定义的）。
        if let Some(dir) = std::path::Path::new(&path).parent() {
            if !dir.as_os_str().is_empty() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
        }
        tokio::fs::write(&path, &validated)
            .await
            .map_err(|_| AppError::internal(format!("写入配置文件失败：{path}")))?;

        Ok(serde_json::json!({ "ok": true, "formatted": validated }))
    }

    /// 加一个站点：先查重，再包上标记追加，最后走统一的校验 + 落盘。
    ///
    /// 标记（`# ZOPS:BEGIN/END`）是为了以后能准确地删掉**这一段** —— Caddyfile
    /// 是纯文本，没有标记就只能靠正则猜边界，猜错一次就是改坏别人的配置。
    pub async fn add_site(
        &self,
        addr: String,
        block: String,
        author: &str,
    ) -> Result<serde_json::Value, AppError> {
        let addr = addr.trim().to_string();
        if addr.is_empty() {
            return Err(AppError::bad_request("域名不能为空"));
        }
        let raw = self.get().await?.raw;
        let parsed = parse_caddyfile(&raw);

        // 已经有的直接拦下来，别写进去等着 Caddy 拒绝加载。
        if let Some(existing) = parsed
            .sites
            .iter()
            .find(|s| s.addr.eq_ignore_ascii_case(&addr))
        {
            return Err(AppError::bad_request(format!(
                "`{}` 已经有一个入口了（{}）。要改就编辑它，要重来就先删掉。",
                addr,
                if existing.managed {
                    "面板添加的"
                } else {
                    "手写的，面板不会动它"
                }
            )));
        }

        let marked = mark_block(&addr, &block);
        let next = format!("{}\n\n{marked}\n", raw.trim_end());
        self.update_as(next, author, &format!("添加站点 {addr}"))
            .await
    }

    /// 删掉一个站点。
    ///
    /// 按行范围切（有标记就带标记一起切），不是靠正则找字符串 —— 后者在
    /// "两个站点有相近的域名"时会切错。
    pub async fn delete_site(
        &self,
        addr: &str,
        author: &str,
    ) -> Result<serde_json::Value, AppError> {
        let raw = self.get().await?.raw;
        let next = remove_site(&raw, addr).map_err(AppError::bad_request)?;
        self.update_as(next, author, &format!("删除站点 {addr}"))
            .await
    }

    pub fn versions(&self, limit: i64) -> Result<Vec<CaddyfileVersionRow>, AppError> {
        self.db
            .list_caddyfile_versions(limit)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    pub fn version(&self, id: i64) -> Result<String, AppError> {
        self.db
            .get_caddyfile_version(id)
            .map_err(|e| AppError::internal(e.to_string()))?
            .ok_or_else(|| AppError::not_found("版本不存在"))
    }

    /// 回滚到某个历史版本。回滚本身也要留痕 —— 它同样会覆盖当前配置。
    pub async fn restore(&self, id: i64, author: &str) -> Result<serde_json::Value, AppError> {
        let content = self.version(id)?;
        self.update_as(content, author, &format!("回滚到版本 #{id}")).await
    }
}
