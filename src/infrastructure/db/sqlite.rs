use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::password::{hash_password, verify_password};
use crate::domain::auth::MemberInfo;
use crate::domain::permission::ROLE_SUPER_ADMIN;

const META_INITIALIZED: &str = "initialized";
const META_SETUP_SECRET_HASH: &str = "setup_secret_hash";
const META_JWT_SECRET: &str = "jwt_secret";
/// 保留多少份 Caddyfile 历史。按一周改动几次估算，五十份够翻很久了。
const CADDYFILE_HISTORY_KEEP: i64 = 50;
/// 审计日志保留条数。按每天几十次操作算，五千条够回溯几个月。
const AUDIT_KEEP: i64 = 5000;

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub password_hash: String,
}

/// A programmatic access token (MCP / skills). Only the SHA-256 hash of the
/// plaintext is stored — the secret itself is shown once at creation.
#[derive(Debug, Clone)]
pub struct ApiTokenRow {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub token_hash: String,
    pub scope: String,
    /// JSON array of permission ids granted to this token.
    pub permissions: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// 一条操作审计。
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditRow {
    pub id: i64,
    pub at: String,
    pub actor: String,
    /// user | agent
    pub actor_kind: String,
    pub ip: String,
    pub method: String,
    pub path: String,
    pub status: i64,
    pub summary: String,
    pub detail: String,
    pub duration_ms: i64,
}

/// 回收站里的一项。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrashRow {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub size: i64,
    pub kind: String,
    pub deleted_at: String,
}

pub struct Database {
    conn: Mutex<Connection>,
}

/// 历史版本的元信息（不含正文）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaddyfileVersionRow {
    pub id: i64,
    pub author: String,
    pub note: String,
    pub created_at: String,
    pub size: i64,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建数据目录失败: {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("打开 SQLite 失败: {}", path.display()))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'member',
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS user_permissions (
                user_id    INTEGER NOT NULL,
                permission TEXT NOT NULL,
                PRIMARY KEY (user_id, permission),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS config (
                key   TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS log_sources (
                id    TEXT PRIMARY KEY NOT NULL,
                path  TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS automation_tasks (
                id        TEXT PRIMARY KEY NOT NULL,
                name      TEXT NOT NULL,
                command   TEXT NOT NULL,
                cron_expr TEXT NOT NULL,
                enabled   INTEGER NOT NULL DEFAULT 1,
                last_run_at  TEXT,
                next_run_at  TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS task_executions (
                id          TEXT PRIMARY KEY NOT NULL,
                task_id     TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'running',
                output      TEXT NOT NULL DEFAULT '',
                started_at  TEXT NOT NULL DEFAULT (datetime('now')),
                finished_at TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (task_id) REFERENCES automation_tasks(id) ON DELETE CASCADE
            );

            -- ── 部署任务通道 ────────────────────────────────────────────────
            --
            -- 一个「部署任务」就是 /opt/docker-apps/<name>/ 这个目录、一段部署脚本、
            -- 外加若干上传的产物。手动部署（面板上三步走）和 agent 自动部署写的是
            -- 同一张表，source 区分是谁发起的。
            --
            -- 为什么不让 agent 直接 compose up：走这条通道才有**记录** —— 谁在什么
            -- 时候部署了什么、结果如何、绑到哪个容器上，事后能查。部署脚本和 compose
            -- 的写法习惯也就能固定下来。
            CREATE TABLE IF NOT EXISTS deploy_jobs (
                id             TEXT PRIMARY KEY NOT NULL,
                -- 同时是目录名、容器名、镜像名，所以唯一。
                name           TEXT NOT NULL UNIQUE,
                note           TEXT NOT NULL DEFAULT '',
                script         TEXT NOT NULL DEFAULT '',
                -- manual | agent
                source         TEXT NOT NULL DEFAULT 'manual',
                -- draft | running | success | failed
                status         TEXT NOT NULL DEFAULT 'draft',
                actor          TEXT NOT NULL DEFAULT '',
                actor_kind     TEXT NOT NULL DEFAULT 'user',
                -- 跑成功之后按名字对上的那个容器。
                container_name TEXT,
                container_id   TEXT,
                last_run_at    TEXT,
                last_exit_code INTEGER,
                last_duration_ms INTEGER,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 每次执行一条。部署记录就是按 job_id 排下来的这个列表。
            CREATE TABLE IF NOT EXISTS deploy_runs (
                id          TEXT PRIMARY KEY NOT NULL,
                job_id      TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'running',
                actor       TEXT NOT NULL DEFAULT '',
                actor_kind  TEXT NOT NULL DEFAULT 'user',
                -- 末尾输出（全量在 log_path 指向的文件里，边跑边追加）。
                output      TEXT NOT NULL DEFAULT '',
                log_path    TEXT NOT NULL DEFAULT '',
                exit_code   INTEGER,
                started_at  TEXT NOT NULL DEFAULT (datetime('now')),
                finished_at TEXT,
                duration_ms INTEGER,
                FOREIGN KEY (job_id) REFERENCES deploy_jobs(id) ON DELETE CASCADE
            );

            -- 上传过的产物。磁盘上丢了、多了一层目录，这里能看出来。
            CREATE TABLE IF NOT EXISTS deploy_files (
                id          TEXT PRIMARY KEY NOT NULL,
                job_id      TEXT NOT NULL,
                -- 部署目录内的相对路径。
                path        TEXT NOT NULL,
                size        INTEGER NOT NULL DEFAULT 0,
                uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
                uploaded_by TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (job_id) REFERENCES deploy_jobs(id) ON DELETE CASCADE,
                UNIQUE (job_id, path)
            );

            CREATE TABLE IF NOT EXISTS api_tokens (
                id           TEXT PRIMARY KEY NOT NULL,
                name         TEXT NOT NULL DEFAULT '',
                prefix       TEXT NOT NULL DEFAULT '',
                token_hash   TEXT NOT NULL UNIQUE,
                scope        TEXT NOT NULL DEFAULT 'read',
                permissions  TEXT NOT NULL DEFAULT '[]',
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                last_used_at TEXT
            );

            -- 每次改接入网关配置前的快照。配置改坏了就没法回退，是这个页面最要命
            -- 的地方，单独存一份原文比事后从日志里翻划算。
            CREATE TABLE IF NOT EXISTS caddyfile_versions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                content    TEXT NOT NULL,
                author     TEXT NOT NULL DEFAULT '',
                note       TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 回收站索引。文件本身被挪到 <数据目录>/trash/<id>，这里只记它原来在哪。
            -- 不做数据库和文件系统的双写事务：万一有一条对不上，宁可界面上少一项，
            -- 也不能因为记不上账就把用户的文件删掉。
            -- 操作审计。只记会改状态的动作（写接口和 agent 工具调用），GET 不记 ——
            -- 记了只会把日志淹掉，真出事时反而难找。
            CREATE TABLE IF NOT EXISTS audit_logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                actor       TEXT NOT NULL DEFAULT '',
                actor_kind  TEXT NOT NULL DEFAULT 'user',
                ip          TEXT NOT NULL DEFAULT '',
                method      TEXT NOT NULL DEFAULT '',
                path        TEXT NOT NULL DEFAULT '',
                status      INTEGER NOT NULL DEFAULT 0,
                summary     TEXT NOT NULL DEFAULT '',
                detail      TEXT NOT NULL DEFAULT '',
                duration_ms INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS trash_items (
                id            TEXT PRIMARY KEY NOT NULL,
                name          TEXT NOT NULL,
                original_path TEXT NOT NULL,
                size          INTEGER NOT NULL DEFAULT 0,
                kind          TEXT NOT NULL DEFAULT 'file',
                deleted_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 访问流水。从 Caddy 的访问日志里采过来，给数据大屏用。
            --
            -- 只存 IP，不存城市：归属地是查出来的、还可能要重查（换了查询源、
            -- 旧记录当时没查通），放在 geo_cache 里 join 出来，一次修正能覆盖
            -- 所有历史行。把城市冗余进每一行，改一次就得全表重写。
            CREATE TABLE IF NOT EXISTS access_events (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       REAL NOT NULL,
                ip       TEXT NOT NULL,
                host     TEXT NOT NULL DEFAULT '',
                method   TEXT NOT NULL DEFAULT '',
                uri      TEXT NOT NULL DEFAULT '',
                status   INTEGER NOT NULL DEFAULT 0,
                bytes    INTEGER NOT NULL DEFAULT 0,
                duration_ms REAL NOT NULL DEFAULT 0,
                ua       TEXT NOT NULL DEFAULT '',
                source   TEXT NOT NULL DEFAULT ''
            );

            -- ── 安全中心 ────────────────────────────────────────────────────
            --
            -- 预警：从接入日志里挑出来的可疑访问（被拦下的、扫描器、探测路径）。
            -- 按 (ip, kind, uri, 小时) 聚合 —— 同一个 IP 拿同一个路径扫一万次算一条，
            -- 记 hits / first_seen / last_seen。预警列表要的是「谁在干什么」，不是
            -- 把访问日志再抄一遍。
            CREATE TABLE IF NOT EXISTS security_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ip         TEXT NOT NULL,
                kind       TEXT NOT NULL,
                reason     TEXT NOT NULL DEFAULT '',
                host       TEXT NOT NULL DEFAULT '',
                method     TEXT NOT NULL DEFAULT '',
                uri        TEXT NOT NULL DEFAULT '',
                status     INTEGER NOT NULL DEFAULT 0,
                ua         TEXT NOT NULL DEFAULT '',
                bucket     INTEGER NOT NULL,
                hits       INTEGER NOT NULL DEFAULT 1,
                first_seen REAL NOT NULL,
                last_seen  REAL NOT NULL,
                UNIQUE(ip, kind, uri, bucket)
            );

            -- 端口访问记录。眼下就是 22 端口上的 sshd：谁从哪儿来、用什么身份、
            -- 成功还是失败。这些原本只躺在 /var/log/secure 里，翻起来全靠 grep。
            CREATE TABLE IF NOT EXISTS ssh_events (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                ts     REAL NOT NULL,
                ip     TEXT NOT NULL,
                user   TEXT NOT NULL DEFAULT '',
                result TEXT NOT NULL,
                method TEXT NOT NULL DEFAULT '',
                port   INTEGER NOT NULL DEFAULT 0,
                raw    TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS ssh_events_ts ON ssh_events(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_access_events_ts ON access_events(ts);
            CREATE INDEX IF NOT EXISTS idx_access_events_ip ON access_events(ip);

            -- IP → 归属地缓存。每个 IP 只问外网一次。
            CREATE TABLE IF NOT EXISTS geo_cache (
                ip         TEXT PRIMARY KEY NOT NULL,
                label      TEXT NOT NULL DEFAULT '',
                country    TEXT NOT NULL DEFAULT '',
                city       TEXT NOT NULL DEFAULT '',
                isp        TEXT NOT NULL DEFAULT '',
                lat        REAL NOT NULL DEFAULT 0,
                lon        REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 每个访问日志文件读到哪个字节了。按文件记而不是按行号：日志在长，
            -- 行号要重数，字节偏移是稳定的。
            CREATE TABLE IF NOT EXISTS ingest_cursor (
                source     TEXT PRIMARY KEY NOT NULL,
                offset     INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- 通知渠道。webhook 地址本身就是凭据（钉钉/飞书的机器人地址泄漏了谁都能
            -- 往群里发消息），所以这一页要权限，界面上也做打码。
            CREATE TABLE IF NOT EXISTS notify_channels (
                id         TEXT PRIMARY KEY NOT NULL,
                name       TEXT NOT NULL,
                kind       TEXT NOT NULL,
                url        TEXT NOT NULL,
                secret     TEXT NOT NULL DEFAULT '',
                events     TEXT NOT NULL DEFAULT '[]',
                enabled    INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                last_at    TEXT,
                last_ok    INTEGER,
                last_error TEXT NOT NULL DEFAULT ''
            );

            -- 投递记录。机器人静默失败过一次，没记录就只能靠猜。
            CREATE TABLE IF NOT EXISTS notify_log (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                channel TEXT NOT NULL DEFAULT '',
                kind    TEXT NOT NULL DEFAULT '',
                event   TEXT NOT NULL DEFAULT '',
                ok      INTEGER NOT NULL DEFAULT 0,
                status  INTEGER NOT NULL DEFAULT 0,
                detail  TEXT NOT NULL DEFAULT ''
            );
            ",
        )?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        // Older DBs created before `role` column
        let has_role: bool = {
            let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
            let cols: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .filter_map(|r| r.ok())
                .collect();
            cols.iter().any(|c| c == "role")
        };
        if !has_role {
            conn.execute(
                "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
                [],
            )?;
        }
        // geo_cache 是后加的，早先的库里没有经纬度列。
        let has_coords: bool = {
            let mut stmt = conn.prepare("PRAGMA table_info(geo_cache)")?;
            let cols: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .filter_map(|r| r.ok())
                .collect();
            cols.iter().any(|c| c == "lat")
        };
        if !has_coords {
            conn.execute("ALTER TABLE geo_cache ADD COLUMN lat REAL NOT NULL DEFAULT 0", [])?;
            conn.execute("ALTER TABLE geo_cache ADD COLUMN lon REAL NOT NULL DEFAULT 0", [])?;
        }
        // Promote earliest user to super_admin if none exists (upgrade path)
        let super_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM users WHERE role = ?1",
            params![ROLE_SUPER_ADMIN],
            |r| r.get(0),
        )?;
        if super_count == 0 {
            let _ = conn.execute(
                "UPDATE users SET role = ?1 WHERE id = (SELECT MIN(id) FROM users)",
                params![ROLE_SUPER_ADMIN],
            );
        }
        Ok(())
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn is_initialized(&self) -> Result<bool> {
        Ok(self.get_meta(META_INITIALIZED)?.as_deref() == Some("1"))
    }

    pub fn ensure_jwt_secret(&self) -> Result<String> {
        if let Some(s) = self.get_meta(META_JWT_SECRET)? {
            return Ok(s);
        }
        let secret = uuid::Uuid::new_v4().to_string();
        self.set_meta(META_JWT_SECRET, &secret)?;
        Ok(secret)
    }

    pub fn rotate_setup_secret(&self) -> Result<String> {
        let secret = format!(
            "{}-{}",
            &uuid::Uuid::new_v4().to_string()[..8],
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        let hash = hash_password(&secret)?;
        self.set_meta(META_SETUP_SECRET_HASH, &hash)?;
        self.set_meta(META_INITIALIZED, "0")?;
        Ok(secret)
    }

    pub fn verify_setup_secret(&self, secret: &str) -> Result<bool> {
        let Some(hash) = self.get_meta(META_SETUP_SECRET_HASH)? else {
            return Ok(false);
        };
        Ok(verify_password(secret, &hash))
    }

    /// Persist first super admin after domain validation.
    pub fn complete_setup(&self, secret: &str, username: &str, password: &str) -> Result<()> {
        if self.is_initialized()? {
            return Err(anyhow!("系统已完成初始化"));
        }
        if !self.verify_setup_secret(secret)? {
            return Err(anyhow!("初始化密钥错误"));
        }

        let password_hash = hash_password(password)?;
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM user_permissions", [])?;
        tx.execute("DELETE FROM users", [])?;
        tx.execute(
            "INSERT INTO users(username, password_hash, role) VALUES(?1, ?2, ?3)",
            params![username, password_hash, ROLE_SUPER_ADMIN],
        )?;
        tx.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![META_INITIALIZED, "1"],
        )?;
        tx.execute(
            "DELETE FROM meta WHERE key = ?1",
            params![META_SETUP_SECRET_HASH],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn find_user_by_username(&self, username: &str) -> Result<Option<UserRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.query_row(
            "SELECT id, username, role, password_hash FROM users WHERE username = ?1",
            params![username],
            |row| {
                Ok(UserRow {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    role: row.get(2)?,
                    password_hash: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// 用户加入时间。个人中心要显示"你什么时候来的"。
    pub fn user_created_at(&self, id: i64) -> Result<Option<String>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let row = conn
            .query_row(
                "SELECT created_at FROM users WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(row)
    }

    pub fn find_user_by_id(&self, id: i64) -> Result<Option<UserRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.query_row(
            "SELECT id, username, role, password_hash FROM users WHERE id = ?1",
            params![id],
            |row| {
                Ok(UserRow {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    role: row.get(2)?,
                    password_hash: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn verify_user(&self, username: &str, password: &str) -> Result<Option<UserRow>> {
        let user = self.find_user_by_username(username)?;
        let Some(user) = user else {
            return Ok(None);
        };
        if verify_password(password, &user.password_hash) {
            Ok(Some(user))
        } else {
            Ok(None)
        }
    }

    pub fn list_user_permissions(&self, user_id: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt =
            conn.prepare("SELECT permission FROM user_permissions WHERE user_id = ?1 ORDER BY permission")?;
        let rows = stmt.query_map(params![user_id], |row| row.get(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn set_user_permissions(&self, user_id: i64, permissions: &[String]) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM user_permissions WHERE user_id = ?1",
            params![user_id],
        )?;
        for p in permissions {
            tx.execute(
                "INSERT INTO user_permissions(user_id, permission) VALUES(?1, ?2)",
                params![user_id, p],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_members(&self) -> Result<Vec<MemberInfo>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, username, role, created_at FROM users ORDER BY id ASC",
        )?;
        let users: Vec<(i64, String, String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(conn);

        let mut out = Vec::with_capacity(users.len());
        for (id, username, role, created_at) in users {
            let permissions = if role == ROLE_SUPER_ADMIN {
                Vec::new()
            } else {
                self.list_user_permissions(id)?
            };
            out.push(MemberInfo {
                id,
                username,
                role,
                created_at,
                permissions,
            });
        }
        Ok(out)
    }

    pub fn create_member(
        &self,
        username: &str,
        password: &str,
        role: &str,
        permissions: &[String],
    ) -> Result<i64> {
        let password_hash = hash_password(password)?;
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO users(username, password_hash, role) VALUES(?1, ?2, ?3)",
            params![username, password_hash, role],
        )?;
        let id = tx.last_insert_rowid();
        if role != ROLE_SUPER_ADMIN {
            for p in permissions {
                tx.execute(
                    "INSERT INTO user_permissions(user_id, permission) VALUES(?1, ?2)",
                    params![id, p],
                )?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn update_member_password(&self, id: i64, password: &str) -> Result<()> {
        let password_hash = hash_password(password)?;
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute(
            "UPDATE users SET password_hash = ?1 WHERE id = ?2",
            params![password_hash, id],
        )?;
        if n == 0 {
            return Err(anyhow!("用户不存在"));
        }
        Ok(())
    }

    pub fn delete_member(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(anyhow!("用户不存在"));
        }
        Ok(())
    }

    pub fn count_super_admins(&self) -> Result<i64> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.query_row(
            "SELECT COUNT(*) FROM users WHERE role = ?1",
            params![ROLE_SUPER_ADMIN],
            |r| r.get(0),
        )
        .map_err(Into::into)
    }

    #[allow(dead_code)]
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare("SELECT value FROM config WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    #[allow(dead_code)]
    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO config(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ── Log Sources ──

    pub fn list_log_sources(&self) -> Result<Vec<LogSourceRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare("SELECT id, path, label, created_at FROM log_sources ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok(LogSourceRow {
                id: row.get(0)?,
                path: row.get(1)?,
                label: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn add_log_source(&self, id: &str, path: &str, label: &str) -> Result<LogSourceRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO log_sources(id, path, label) VALUES(?1, ?2, ?3)",
            params![id, path, label],
        )?;
        conn.query_row(
            "SELECT id, path, label, created_at FROM log_sources WHERE id = ?1",
            params![id],
            |row| {
                Ok(LogSourceRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    label: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn remove_log_source(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute("DELETE FROM log_sources WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ── Caddyfile 历史版本 ──

    /// 存一份快照。老版本顺手清掉，免得一份几 KB 的配置攒成大表。
    pub fn add_caddyfile_version(&self, content: &str, author: &str, note: &str) -> Result<i64> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO caddyfile_versions(content, author, note) VALUES(?1, ?2, ?3)",
            params![content, author, note],
        )?;
        let id = conn.last_insert_rowid();
        let _ = conn.execute(
            "DELETE FROM caddyfile_versions WHERE id NOT IN
             (SELECT id FROM caddyfile_versions ORDER BY id DESC LIMIT ?1)",
            params![CADDYFILE_HISTORY_KEEP],
        );
        Ok(id)
    }

    /// 列表不带正文：正文可能几 KB，列表页不背着它。
    pub fn list_caddyfile_versions(&self, limit: i64) -> Result<Vec<CaddyfileVersionRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, author, note, created_at, length(content)
             FROM caddyfile_versions ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(CaddyfileVersionRow {
                    id: row.get(0)?,
                    author: row.get(1)?,
                    note: row.get(2)?,
                    created_at: row.get(3)?,
                    size: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_caddyfile_version(&self, id: i64) -> Result<Option<String>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let row = conn
            .query_row(
                "SELECT content FROM caddyfile_versions WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(row)
    }

    // ── 操作审计 ──

    pub fn add_audit_log(&self, r: &AuditRow) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO audit_logs(at, actor, actor_kind, ip, method, path, status, summary, detail, duration_ms)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![r.at, r.actor, r.actor_kind, r.ip, r.method, r.path, r.status, r.summary, r.detail, r.duration_ms],
        )?;
        let _ = conn.execute(
            "DELETE FROM audit_logs WHERE id NOT IN
             (SELECT id FROM audit_logs ORDER BY id DESC LIMIT ?1)",
            params![AUDIT_KEEP],
        );
        Ok(())
    }

    /// 只看某个操作者自己的记录。个人中心用它 —— 不需要 audit.read 权限，
    /// 因为看的只是自己干过的事。
    pub fn list_audit_logs_for(&self, actor: &str, limit: i64) -> Result<Vec<AuditRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, at, actor, actor_kind, ip, method, path, status, summary, detail, duration_ms
             FROM audit_logs WHERE actor = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![actor, limit], |row| {
                Ok(AuditRow {
                    id: row.get(0)?,
                    at: row.get(1)?,
                    actor: row.get(2)?,
                    actor_kind: row.get(3)?,
                    ip: row.get(4)?,
                    method: row.get(5)?,
                    path: row.get(6)?,
                    status: row.get(7)?,
                    summary: row.get(8)?,
                    detail: row.get(9)?,
                    duration_ms: row.get(10)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_audit_logs(&self, limit: i64, kind: Option<&str>) -> Result<Vec<AuditRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, at, actor, actor_kind, ip, method, path, status, summary, detail, duration_ms
             FROM audit_logs
             WHERE (?1 IS NULL OR actor_kind = ?1)
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![kind, limit], |row| {
                Ok(AuditRow {
                    id: row.get(0)?,
                    at: row.get(1)?,
                    actor: row.get(2)?,
                    actor_kind: row.get(3)?,
                    ip: row.get(4)?,
                    method: row.get(5)?,
                    path: row.get(6)?,
                    status: row.get(7)?,
                    summary: row.get(8)?,
                    detail: row.get(9)?,
                    duration_ms: row.get(10)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ── 回收站 ──

    pub fn add_trash_item(
        &self,
        id: &str,
        name: &str,
        original_path: &str,
        size: i64,
        kind: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO trash_items(id, name, original_path, size, kind) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![id, name, original_path, size, kind],
        )?;
        Ok(())
    }

    pub fn list_trash(&self) -> Result<Vec<TrashRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, original_path, size, kind, deleted_at FROM trash_items ORDER BY deleted_at DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TrashRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    original_path: row.get(2)?,
                    size: row.get(3)?,
                    kind: row.get(4)?,
                    deleted_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_trash_item(&self, id: &str) -> Result<Option<TrashRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let row = conn
            .query_row(
                "SELECT id, name, original_path, size, kind, deleted_at FROM trash_items WHERE id = ?1",
                params![id],
                |row| {
                    Ok(TrashRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        original_path: row.get(2)?,
                        size: row.get(3)?,
                        kind: row.get(4)?,
                        deleted_at: row.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn remove_trash_items(&self, ids: &[String]) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        for id in ids {
            conn.execute("DELETE FROM trash_items WHERE id = ?1", params![id])?;
        }
        Ok(())
    }

    // ── API Tokens ──

    const TOKEN_COLS: &'static str =
        "id, name, prefix, token_hash, scope, permissions, created_at, last_used_at";

    fn map_token_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApiTokenRow> {
        Ok(ApiTokenRow {
            id: row.get(0)?,
            name: row.get(1)?,
            prefix: row.get(2)?,
            token_hash: row.get(3)?,
            scope: row.get(4)?,
            permissions: row.get(5)?,
            created_at: row.get(6)?,
            last_used_at: row.get(7)?,
        })
    }

    pub fn create_api_token(
        &self,
        id: &str,
        name: &str,
        prefix: &str,
        token_hash: &str,
        scope: &str,
        permissions_json: &str,
    ) -> Result<ApiTokenRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO api_tokens(id, name, prefix, token_hash, scope, permissions)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, prefix, token_hash, scope, permissions_json],
        )?;
        conn.query_row(
            &format!("SELECT {} FROM api_tokens WHERE id = ?1", Self::TOKEN_COLS),
            params![id],
            Self::map_token_row,
        )
        .map_err(Into::into)
    }

    pub fn list_api_tokens(&self) -> Result<Vec<ApiTokenRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM api_tokens ORDER BY created_at ASC",
            Self::TOKEN_COLS
        ))?;
        let rows = stmt.query_map([], Self::map_token_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Lookup is by hash, never by plaintext — the plaintext is not stored.
    pub fn find_api_token_by_hash(&self, token_hash: &str) -> Result<Option<ApiTokenRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM api_tokens WHERE token_hash = ?1",
            Self::TOKEN_COLS
        ))?;
        stmt.query_row(params![token_hash], Self::map_token_row)
            .optional()
            .map_err(Into::into)
    }

    /// Best-effort "last seen" stamp. Failure must never break a tool call,
    /// so callers ignore the result.
    pub fn touch_api_token(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn revoke_api_token(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute("DELETE FROM api_tokens WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ── Automation Tasks ──

    pub fn list_automation_tasks(&self) -> Result<Vec<TaskRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, command, cron_expr, enabled, last_run_at, next_run_at, created_at, updated_at FROM automation_tasks ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                cron_expr: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                last_run_at: row.get(5)?,
                next_run_at: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_automation_task(&self, id: &str) -> Result<Option<TaskRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, command, cron_expr, enabled, last_run_at, next_run_at, created_at, updated_at FROM automation_tasks WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(TaskRow {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                cron_expr: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                last_run_at: row.get(5)?,
                next_run_at: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn create_automation_task(
        &self,
        id: &str,
        name: &str,
        command: &str,
        cron_expr: &str,
    ) -> Result<TaskRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO automation_tasks(id, name, command, cron_expr) VALUES(?1, ?2, ?3, ?4)",
            params![id, name, command, cron_expr],
        )?;
        self.get_automation_task(id)?.ok_or_else(|| anyhow!("task not found after insert"))
    }

    pub fn update_automation_task(
        &self,
        id: &str,
        name: Option<&str>,
        command: Option<&str>,
        cron_expr: Option<&str>,
        enabled: Option<bool>,
        last_run_at: Option<&str>,
        next_run_at: Option<&str>,
    ) -> Result<TaskRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut set: Vec<String> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        set.push("updated_at = datetime('now')".into());

        if let Some(v) = name {
            vals.push(Box::new(v.to_string()));
            set.push(format!("name = ?{}", vals.len()));
        }
        if let Some(v) = command {
            vals.push(Box::new(v.to_string()));
            set.push(format!("command = ?{}", vals.len()));
        }
        if let Some(v) = cron_expr {
            vals.push(Box::new(v.to_string()));
            set.push(format!("cron_expr = ?{}", vals.len()));
        }
        if let Some(v) = enabled {
            vals.push(Box::new(v as i64));
            set.push(format!("enabled = ?{}", vals.len()));
        }
        if let Some(v) = last_run_at {
            vals.push(Box::new(v.to_string()));
            set.push(format!("last_run_at = ?{}", vals.len()));
        }
        if let Some(v) = next_run_at {
            vals.push(Box::new(v.to_string()));
            set.push(format!("next_run_at = ?{}", vals.len()));
        }

        if set.is_empty() {
            return self
                .get_automation_task(id)?
                .ok_or_else(|| anyhow!("task not found"));
        }

        let sql = format!(
            "UPDATE automation_tasks SET {} WHERE id = ?{}",
            set.join(", "),
            vals.len() + 1,
        );
        let mut params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
        let id_param: &dyn rusqlite::types::ToSql = &id;
        params.push(id_param);
        conn.execute(&sql, params.as_slice())?;

        self.get_automation_task(id)?
            .ok_or_else(|| anyhow!("task not found after update"))
    }

    pub fn delete_automation_task(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute("DELETE FROM automation_tasks WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn add_task_execution(
        &self,
        id: &str,
        task_id: &str,
        output: &str,
        status: &str,
        started_at: &str,
        finished_at: Option<&str>,
        retry_count: i64,
    ) -> Result<ExecutionRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let finished = finished_at.map(|s| s.to_string());
        conn.execute(
            "INSERT INTO task_executions(id, task_id, status, output, started_at, finished_at, retry_count) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, task_id, status, output, started_at, finished, retry_count],
        )?;
        conn.query_row(
            "SELECT id, task_id, status, output, started_at, finished_at, retry_count FROM task_executions WHERE id = ?1",
            params![id],
            |row| {
                Ok(ExecutionRow {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    status: row.get(2)?,
                    output: row.get(3)?,
                    started_at: row.get(4)?,
                    finished_at: row.get(5)?,
                    retry_count: row.get(6)?,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn update_execution_status(
        &self,
        id: &str,
        status: &str,
        output: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        if let Some(out) = output {
            conn.execute(
                "UPDATE task_executions SET status = ?1, output = ?2, finished_at = datetime('now') WHERE id = ?3",
                params![status, out, id],
            )?;
        } else {
            conn.execute(
                "UPDATE task_executions SET status = ?1 WHERE id = ?2",
                params![status, id],
            )?;
        }
        Ok(())
    }

    pub fn list_executions_for_task(&self, task_id: &str, limit: i64) -> Result<Vec<ExecutionRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, task_id, status, output, started_at, finished_at, retry_count FROM task_executions WHERE task_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![task_id, limit], |row| {
            Ok(ExecutionRow {
                id: row.get(0)?,
                task_id: row.get(1)?,
                status: row.get(2)?,
                output: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                retry_count: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ── 访问流水（数据大屏） ──

    /// 批量落库。一条一条 insert 在积压几百行时会明显卡住，用事务包起来。
    pub fn insert_access_events(&self, events: &[NewAccessEvent]) -> Result<usize> {
        if events.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO access_events (ts, ip, host, method, uri, status, bytes, duration_ms, ua, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for e in events {
                stmt.execute(params![
                    e.ts, e.ip, e.host, e.method, e.uri, e.status, e.bytes, e.duration_ms, e.ua,
                    e.source
                ])?;
            }
        }
        tx.commit()?;
        Ok(events.len())
    }

    /// 还没查过归属地的 IP。只取出现过的，别去查日志里那些扫描器的垃圾 IP。
    pub fn access_unknown_ips(&self, limit: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT e.ip FROM access_events e
             LEFT JOIN geo_cache g ON g.ip = e.ip
             WHERE g.ip IS NULL
             ORDER BY e.ts DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn upsert_geo(&self, rows: &[GeoRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO geo_cache (ip, label, country, city, isp, lat, lon, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
                 ON CONFLICT(ip) DO UPDATE SET
                    label = excluded.label, country = excluded.country,
                    city = excluded.city, isp = excluded.isp,
                    lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at",
            )?;
            for r in rows {
                stmt.execute(params![r.ip, r.label, r.country, r.city, r.isp, r.lat, r.lon])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn ingest_cursor(&self, source: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare("SELECT offset FROM ingest_cursor WHERE source = ?1")?;
        let mut rows = stmt.query(params![source])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn set_ingest_cursor(&self, source: &str, offset: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO ingest_cursor (source, offset, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(source) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at",
            params![source, offset],
        )?;
        Ok(())
    }

    /// 删掉太久以前的记录。访问流水会一直长，没有清理的统计表迟早把磁盘吃满。
    pub fn prune_access_events(&self, before_ts: f64) -> Result<usize> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.execute("DELETE FROM access_events WHERE ts < ?1", params![before_ts])?)
    }

    pub fn access_totals(&self, since: f64) -> Result<(i64, i64)> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let row = conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT ip) FROM access_events WHERE ts >= ?1",
            params![since],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(row)
    }

    /// 按归属地排名。没有归属地记录的算"未知"，不隐藏 —— 藏起来会让人以为
    /// 总数对得上。
    pub fn access_top_locations(&self, since: f64, limit: i64) -> Result<Vec<(String, i64)>> {
        self.group_count(
            "SELECT COALESCE(NULLIF(g.label, ''), '未知') k, COUNT(*) c
             FROM access_events e LEFT JOIN geo_cache g ON g.ip = e.ip
             WHERE e.ts >= ?1 GROUP BY k ORDER BY c DESC LIMIT ?2",
            since,
            limit,
        )
    }

    pub fn access_top_hosts(&self, since: f64, limit: i64) -> Result<Vec<(String, i64)>> {
        self.group_count(
            "SELECT host k, COUNT(*) c FROM access_events
             WHERE ts >= ?1 GROUP BY k ORDER BY c DESC LIMIT ?2",
            since,
            limit,
        )
    }

    pub fn access_top_uris(&self, since: f64, limit: i64) -> Result<Vec<(String, i64)>> {
        self.group_count(
            "SELECT uri k, COUNT(*) c FROM access_events
             WHERE ts >= ?1 GROUP BY k ORDER BY c DESC LIMIT ?2",
            since,
            limit,
        )
    }

    /// 状态码按百位分档：200/300/400/500 各多少，比逐个数好读。
    pub fn access_status_buckets(&self, since: f64) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT (status / 100) * 100 k, COUNT(*) c FROM access_events
             WHERE ts >= ?1 GROUP BY k ORDER BY k",
        )?;
        let rows = stmt.query_map(params![since], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows
            .filter_map(|r| r.ok())
            .map(|(code, count)| {
                let label = match code {
                    0 => "其他".to_string(),
                    c => format!("{c}"),
                };
                (label, count)
            })
            .collect())
    }

    /// 每小时的请求数，本地时区。空的小时由服务层补齐，SQL 里不造时间轴。
    pub fn access_hourly(&self, since: f64) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m-%d %H', datetime(ts, 'unixepoch', 'localtime')) k, COUNT(*) c
             FROM access_events WHERE ts >= ?1 GROUP BY k ORDER BY k",
        )?;
        let rows = stmt.query_map(params![since], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn group_count(&self, sql: &str, since: f64, limit: i64) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![since, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 最近的访问记录，带上归属地。
    ///
    /// `after_id` 给"实时递增"用：只取比它新的，界面上就是一条条往下加。
    pub fn access_recent(&self, after_id: i64, limit: i64) -> Result<Vec<AccessEventRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.ts, e.ip, e.host, e.method, e.uri, e.status, e.bytes,
                    e.duration_ms, e.ua, COALESCE(g.label, ''), COALESCE(g.isp, ''),
                    g.lat, g.lon
             FROM access_events e LEFT JOIN geo_cache g ON g.ip = e.ip
             WHERE e.id > ?1 ORDER BY e.id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![after_id, limit], |row| {
            Ok(AccessEventRow {
                id: row.get(0)?,
                ts: row.get(1)?,
                ip: row.get(2)?,
                host: row.get(3)?,
                method: row.get(4)?,
                uri: row.get(5)?,
                status: row.get(6)?,
                bytes: row.get(7)?,
                duration_ms: row.get(8)?,
                ua: row.get(9)?,
                label: row.get(10)?,
                isp: row.get(11)?,
                lat: row.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
                lon: row.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 最新一条的 id。首次加载时用它当游标，之后的轮询只取更新的。
    pub fn access_last_id(&self) -> Result<i64> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.query_row("SELECT COALESCE(MAX(id), 0) FROM access_events", [], |r| {
            r.get(0)
        })?)
    }

    // ── 通知渠道 ──

    pub fn list_notify_channels(&self) -> Result<Vec<NotifyChannelRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, url, secret, events, enabled, created_at, last_at, last_ok, last_error
             FROM notify_channels ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(NotifyChannelRow {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                url: row.get(3)?,
                secret: row.get(4)?,
                events: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                last_at: row.get(8)?,
                last_ok: row.get::<_, Option<i64>>(9)?.map(|v| v != 0),
                last_error: row.get(10)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn upsert_notify_channel(&self, c: &NotifyChannelRow) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO notify_channels (id, name, kind, url, secret, events, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, kind = excluded.kind, url = excluded.url,
                secret = excluded.secret, events = excluded.events, enabled = excluded.enabled",
            params![
                c.id,
                c.name,
                c.kind,
                c.url,
                c.secret,
                c.events,
                c.enabled as i64
            ],
        )?;
        Ok(())
    }

    pub fn set_notify_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.execute(
            "UPDATE notify_channels SET enabled = ?2 WHERE id = ?1",
            params![id, enabled as i64],
        )? > 0)
    }

    pub fn delete_notify_channel(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.execute("DELETE FROM notify_channels WHERE id = ?1", params![id])? > 0)
    }

    pub fn touch_notify_channel(&self, id: &str, ok: bool, error: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "UPDATE notify_channels SET last_at = datetime('now','localtime'), last_ok = ?2, last_error = ?3 WHERE id = ?1",
            params![id, ok as i64, error],
        )?;
        Ok(())
    }

    pub fn add_notify_log(
        &self,
        channel: &str,
        kind: &str,
        event: &str,
        ok: bool,
        status: i64,
        detail: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO notify_log (channel, kind, event, ok, status, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![channel, kind, event, ok as i64, status, detail],
        )?;
        // 只留最近 200 条：这是给人看"刚才发出去没有"，不是审计台账。
        conn.execute(
            "DELETE FROM notify_log WHERE id NOT IN (SELECT id FROM notify_log ORDER BY id DESC LIMIT 200)",
            [],
        )?;
        Ok(())
    }

    pub fn list_notify_log(&self, limit: i64) -> Result<Vec<NotifyLogRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, at, channel, kind, event, ok, status, detail FROM notify_log ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(NotifyLogRow {
                id: row.get(0)?,
                at: row.get(1)?,
                channel: row.get(2)?,
                kind: row.get(3)?,
                event: row.get(4)?,
                ok: row.get::<_, i64>(5)? != 0,
                status: row.get(6)?,
                detail: row.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── 安全面：攻击 / 机器人 ──

    /// UA 命中这批关键词的请求数。
    ///
    /// 关键词以 JSON 数组传进 SQL 用 `json_each` 展开，拼 SQL 字符串会让这段代码
    /// 离注入只有一步 —— 虽然这里是常量，但没有理由开这个口子。
    pub fn access_count_ua(&self, since: f64, hints: &[&str]) -> Result<i64> {
        let json = serde_json::to_string(hints).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM access_events e
             WHERE e.ts >= ?1 AND EXISTS (
                SELECT 1 FROM json_each(?2) h WHERE instr(lower(e.ua), h.value) > 0)",
            params![since, json],
            |r| r.get(0),
        )?)
    }

    /// 被接入网关规则拦下的请求数（403）。
    pub fn access_count_blocked(&self, since: f64) -> Result<i64> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM access_events WHERE ts >= ?1 AND status = 403",
            params![since],
            |r| r.get(0),
        )?)
    }

    /// 攻击来源 IP 排行：被拦下的，或者 UA 就是攻击工具的。
    pub fn access_top_attackers(
        &self,
        since: f64,
        tool_hints: &[&str],
        limit: i64,
    ) -> Result<Vec<(String, String, i64)>> {
        let json = serde_json::to_string(tool_hints).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT e.ip, COALESCE(NULLIF(g.label, ''), '未知') AS label, COUNT(*) c
             FROM access_events e LEFT JOIN geo_cache g ON g.ip = e.ip
             WHERE e.ts >= ?1 AND (
                e.status = 403 OR EXISTS (
                    SELECT 1 FROM json_each(?2) h WHERE instr(lower(e.ua), h.value) > 0))
                -- 回环地址不进榜。服务器自己调自己（健康检查、定时任务、面板里敲的
                -- curl）会带着工具类 UA 命中上面的条件，把它们排在第一行，这张攻击
                -- 来源榜就没法看了。内网地址保留：那可能是被拿下的机器。
                AND e.ip NOT LIKE '127.%' AND e.ip <> '::1'
             GROUP BY e.ip ORDER BY c DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![since, json, limit], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 被拦得最多的路径。
    pub fn access_blocked_paths(&self, since: f64, limit: i64) -> Result<Vec<(String, i64)>> {
        self.group_count(
            "SELECT uri k, COUNT(*) c FROM access_events
             WHERE ts >= ?1 AND status = 403 GROUP BY k ORDER BY c DESC LIMIT ?2",
            since,
            limit,
        )
    }

    /// 地球动画要的落点：有经纬度的地方 + 各来了多少请求。
    pub fn access_geo_points(&self, since: f64, limit: i64) -> Result<Vec<GeoPointRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(NULLIF(g.label, ''), '未知') AS label,
                    ROUND(g.lat, 2) AS lat, ROUND(g.lon, 2) AS lon, COUNT(*) c
             FROM access_events e JOIN geo_cache g ON g.ip = e.ip
             WHERE e.ts >= ?1 AND (g.lat != 0 OR g.lon != 0)
             GROUP BY lat, lon ORDER BY c DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit], |row| {
            Ok(GeoPointRow {
                label: row.get(0)?,
                lat: row.get(1)?,
                lon: row.get(2)?,
                count: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 最近 N 条，按时间正序返回（旧 → 新）。
    ///
    /// 先倒着取再翻过来，和增量查询的顺序一致；反过来写成
    /// `ORDER BY id ASC LIMIT n` 会拿到**最早**的 n 条，那是完全不同的一件事。
    pub fn access_latest(&self, limit: i64) -> Result<Vec<AccessEventRow>> {
        let mut rows = self.access_recent_desc(limit)?;
        rows.reverse();
        Ok(rows)
    }

    fn access_recent_desc(&self, limit: i64) -> Result<Vec<AccessEventRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.ts, e.ip, e.host, e.method, e.uri, e.status, e.bytes,
                    e.duration_ms, e.ua, COALESCE(g.label, ''), COALESCE(g.isp, ''),
                    g.lat, g.lon
             FROM access_events e LEFT JOIN geo_cache g ON g.ip = e.ip
             ORDER BY e.id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(AccessEventRow {
                id: row.get(0)?,
                ts: row.get(1)?,
                ip: row.get(2)?,
                host: row.get(3)?,
                method: row.get(4)?,
                uri: row.get(5)?,
                status: row.get(6)?,
                bytes: row.get(7)?,
                duration_ms: row.get(8)?,
                ua: row.get(9)?,
                label: row.get(10)?,
                isp: row.get(11)?,
                lat: row.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
                lon: row.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── 部署任务 ─────────────────────────────────────────────────────────

    const DEPLOY_JOB_COLS: &'static str = "id, name, note, script, source, status, actor, actor_kind, container_name, container_id, last_run_at, last_exit_code, last_duration_ms, created_at, updated_at";

    fn map_deploy_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeployJobRow> {
        Ok(DeployJobRow {
            id: row.get(0)?,
            name: row.get(1)?,
            note: row.get(2)?,
            script: row.get(3)?,
            source: row.get(4)?,
            status: row.get(5)?,
            actor: row.get(6)?,
            actor_kind: row.get(7)?,
            container_name: row.get(8)?,
            container_id: row.get(9)?,
            last_run_at: row.get(10)?,
            last_exit_code: row.get(11)?,
            last_duration_ms: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    }

    pub fn list_deploy_jobs(&self) -> Result<Vec<DeployJobRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM deploy_jobs ORDER BY created_at DESC",
            Self::DEPLOY_JOB_COLS
        ))?;
        let rows = stmt.query_map([], Self::map_deploy_job)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_deploy_job(&self, id: &str) -> Result<Option<DeployJobRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM deploy_jobs WHERE id = ?1",
            Self::DEPLOY_JOB_COLS
        ))?;
        stmt.query_row(params![id], Self::map_deploy_job)
            .optional()
            .map_err(Into::into)
    }

    pub fn find_deploy_job_by_name(&self, name: &str) -> Result<Option<DeployJobRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM deploy_jobs WHERE name = ?1",
            Self::DEPLOY_JOB_COLS
        ))?;
        stmt.query_row(params![name], Self::map_deploy_job)
            .optional()
            .map_err(Into::into)
    }

    pub fn create_deploy_job(
        &self,
        id: &str,
        name: &str,
        note: &str,
        source: &str,
        actor: &str,
        actor_kind: &str,
    ) -> Result<DeployJobRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO deploy_jobs(id, name, note, source, actor, actor_kind)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, note, source, actor, actor_kind],
        )?;
        drop(conn);
        self.get_deploy_job(id)?
            .ok_or_else(|| anyhow!("deploy job not found after insert"))
    }

    pub fn save_deploy_script(&self, id: &str, script: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "UPDATE deploy_jobs SET script = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![script, id],
        )?;
        Ok(())
    }

    /// 跑完一次之后回写任务状态。`container` 传 None 表示这一轮没对上容器
    /// （部署的是静态前端、或者起在别的机器上），不清掉上一次的记录。
    pub fn update_deploy_job_after_run(
        &self,
        id: &str,
        status: &str,
        exit_code: i64,
        duration_ms: i64,
        container: Option<(&str, &str)>,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        match container {
            Some((name, cid)) => conn.execute(
                "UPDATE deploy_jobs
                    SET status = ?1, last_exit_code = ?2, last_duration_ms = ?3,
                        last_run_at = datetime('now'), container_name = ?4, container_id = ?5,
                        updated_at = datetime('now')
                  WHERE id = ?6",
                params![status, exit_code, duration_ms, name, cid, id],
            )?,
            None => conn.execute(
                "UPDATE deploy_jobs
                    SET status = ?1, last_exit_code = ?2, last_duration_ms = ?3,
                        last_run_at = datetime('now'), updated_at = datetime('now')
                  WHERE id = ?4",
                params![status, exit_code, duration_ms, id],
            )?,
        };
        Ok(())
    }

    pub fn delete_deploy_job(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute("DELETE FROM deploy_jobs WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn create_deploy_run(
        &self,
        id: &str,
        job_id: &str,
        actor: &str,
        actor_kind: &str,
        log_path: &str,
    ) -> Result<DeployRunRow> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO deploy_runs(id, job_id, actor, actor_kind, log_path)
             VALUES(?1, ?2, ?3, ?4, ?5)",
            params![id, job_id, actor, actor_kind, log_path],
        )?;
        drop(conn);
        self.get_deploy_run(id)?
            .ok_or_else(|| anyhow!("deploy run not found after insert"))
    }

    pub fn finish_deploy_run(
        &self,
        id: &str,
        status: &str,
        exit_code: i64,
        output: &str,
        duration_ms: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "UPDATE deploy_runs
                SET status = ?1, exit_code = ?2, output = ?3, duration_ms = ?4,
                    finished_at = datetime('now')
              WHERE id = ?5",
            params![status, exit_code, output, duration_ms, id],
        )?;
        Ok(())
    }

    pub fn get_deploy_run(&self, id: &str) -> Result<Option<DeployRunRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, job_id, status, actor, actor_kind, output, log_path, exit_code,
                    started_at, finished_at, duration_ms
               FROM deploy_runs WHERE id = ?1",
        )?;
        stmt.query_row(params![id], Self::map_deploy_run)
            .optional()
            .map_err(Into::into)
    }

    pub fn list_deploy_runs(&self, job_id: &str, limit: i64) -> Result<Vec<DeployRunRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, job_id, status, actor, actor_kind, output, log_path, exit_code,
                    started_at, finished_at, duration_ms
               FROM deploy_runs WHERE job_id = ?1
              ORDER BY started_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![job_id, limit], Self::map_deploy_run)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    fn map_deploy_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeployRunRow> {
        Ok(DeployRunRow {
            id: row.get(0)?,
            job_id: row.get(1)?,
            status: row.get(2)?,
            actor: row.get(3)?,
            actor_kind: row.get(4)?,
            output: row.get(5)?,
            log_path: row.get(6)?,
            exit_code: row.get(7)?,
            started_at: row.get(8)?,
            finished_at: row.get(9)?,
            duration_ms: row.get(10)?,
        })
    }

    pub fn upsert_deploy_file(
        &self,
        id: &str,
        job_id: &str,
        path: &str,
        size: i64,
        uploaded_by: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "INSERT INTO deploy_files(id, job_id, path, size, uploaded_by)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(job_id, path) DO UPDATE SET
                size = excluded.size,
                uploaded_by = excluded.uploaded_by,
                uploaded_at = datetime('now')",
            params![id, job_id, path, size, uploaded_by],
        )?;
        Ok(())
    }

    pub fn list_deploy_files(&self, job_id: &str) -> Result<Vec<DeployFileRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, job_id, path, size, uploaded_at, uploaded_by
               FROM deploy_files WHERE job_id = ?1 ORDER BY path ASC",
        )?;
        let rows = stmt.query_map(params![job_id], |row| {
            Ok(DeployFileRow {
                id: row.get(0)?,
                job_id: row.get(1)?,
                path: row.get(2)?,
                size: row.get(3)?,
                uploaded_at: row.get(4)?,
                uploaded_by: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_deploy_file(&self, job_id: &str, path: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let n = conn.execute(
            "DELETE FROM deploy_files WHERE job_id = ?1 AND path = ?2",
            params![job_id, path],
        )?;
        Ok(n > 0)
    }

    // ── 安全中心 ─────────────────────────────────────────────────────────

    /// 记一条预警。同一个 IP 在同一个小时里打同一个路径算一条，只加次数。
    ///
    /// 聚合成这个粒度是刻意的：扫描器一分钟能打上千次，按条存下来预警列表就没法
    /// 看了；按小时聚，既不丢"谁在扫什么"，又保证列表是可读的。
    pub fn upsert_security_event(
        &self,
        ip: &str,
        kind: &str,
        reason: &str,
        host: &str,
        method: &str,
        uri: &str,
        status: i64,
        ua: &str,
        ts: f64,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let bucket = (ts / 3600.0).floor() as i64;
        conn.execute(
            "INSERT INTO security_events(ip, kind, reason, host, method, uri, status, ua, bucket, hits, first_seen, last_seen)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)
             ON CONFLICT(ip, kind, uri, bucket) DO UPDATE SET
                hits = hits + 1,
                last_seen = excluded.last_seen,
                status = excluded.status,
                ua = excluded.ua,
                reason = excluded.reason",
            params![ip, kind, reason, host, method, uri, status, ua, bucket, ts],
        )?;
        Ok(())
    }

    pub fn list_security_events(
        &self,
        kind: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<SecurityEventRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, ip, kind, reason, host, method, uri, status, ua, hits, first_seen, last_seen
               FROM security_events
              WHERE (?1 = '' OR kind = ?1)
              ORDER BY last_seen DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![kind.unwrap_or(""), limit, offset], |row| {
            Ok(SecurityEventRow {
                id: row.get(0)?,
                ip: row.get(1)?,
                kind: row.get(2)?,
                reason: row.get(3)?,
                host: row.get(4)?,
                method: row.get(5)?,
                uri: row.get(6)?,
                status: row.get(7)?,
                ua: row.get(8)?,
                hits: row.get(9)?,
                first_seen: row.get(10)?,
                last_seen: row.get(11)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 预警概览：三类各多少条、涉及多少个 IP。`since` 之前的只计数不列。
    pub fn security_counts(&self, since: f64) -> Result<(i64, i64, i64, i64)> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN kind = 'blocked' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'bot' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'probe' THEN 1 ELSE 0 END), 0),
                COUNT(DISTINCT ip)
             FROM security_events WHERE last_seen >= ?1",
            params![since],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    }

    pub fn prune_security_events(&self, cutoff: f64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute(
            "DELETE FROM security_events WHERE last_seen < ?1",
            params![cutoff],
        )?;
        Ok(())
    }

    pub fn insert_ssh_events(&self, rows: &[NewSshEvent]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let tx = conn.unchecked_transaction()?;
        let mut n = 0usize;
        for r in rows {
            n += tx.execute(
                "INSERT INTO ssh_events(ts, ip, user, result, method, port, raw)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![r.ts, r.ip, r.user, r.result, r.method, r.port, r.raw],
            )?;
        }
        tx.commit()?;
        Ok(n)
    }

    pub fn list_ssh_events(&self, result: Option<&str>, limit: i64) -> Result<Vec<SshEventRow>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT id, ts, ip, user, result, method, port, raw FROM ssh_events
              WHERE (?1 = '' OR result = ?1)
              ORDER BY ts DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![result.unwrap_or(""), limit], |row| {
            Ok(SshEventRow {
                id: row.get(0)?,
                ts: row.get(1)?,
                ip: row.get(2)?,
                user: row.get(3)?,
                result: row.get(4)?,
                method: row.get(5)?,
                port: row.get(6)?,
                raw: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 端口访问概览：成功 / 失败 / 无效用户各多少，涉及多少个来源 IP。
    pub fn ssh_counts(&self, since: f64) -> Result<(i64, i64, i64, i64)> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        Ok(conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN result = 'accepted' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN result = 'invalid' THEN 1 ELSE 0 END), 0),
                COUNT(DISTINCT ip)
             FROM ssh_events WHERE ts >= ?1",
            params![since],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    }

    /// 失败次数最多的来源 IP —— "谁在敲门"的第一眼答案。
    pub fn ssh_top_failed_ips(&self, since: f64, limit: i64) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        let mut stmt = conn.prepare(
            "SELECT ip, COUNT(*) c FROM ssh_events
              WHERE ts >= ?1 AND result <> 'accepted'
              GROUP BY ip ORDER BY c DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn prune_ssh_events(&self, cutoff: f64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("db lock"))?;
        conn.execute("DELETE FROM ssh_events WHERE ts < ?1", params![cutoff])?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct NewAccessEvent {
    pub ts: f64,
    pub ip: String,
    pub host: String,
    pub method: String,
    pub uri: String,
    pub status: i64,
    pub bytes: i64,
    pub duration_ms: f64,
    pub ua: String,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct NotifyChannelRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub secret: String,
    /// JSON 数组，订阅了哪些事件。
    pub events: String,
    pub enabled: bool,
    pub created_at: String,
    pub last_at: Option<String>,
    pub last_ok: Option<bool>,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyLogRow {
    pub id: i64,
    pub at: String,
    pub channel: String,
    pub kind: String,
    pub event: String,
    pub ok: bool,
    pub status: i64,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct GeoRow {
    pub ip: String,
    pub label: String,
    pub country: String,
    pub city: String,
    pub isp: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoPointRow {
    pub label: String,
    pub lat: f64,
    pub lon: f64,
    pub count: i64,
}

#[derive(Debug, Clone)]
pub struct AccessEventRow {
    pub id: i64,
    pub ts: f64,
    pub ip: String,
    pub host: String,
    pub method: String,
    pub uri: String,
    pub status: i64,
    pub bytes: i64,
    pub duration_ms: f64,
    pub ua: String,
    pub label: String,
    pub isp: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone)]
pub struct LogSourceRow {
    pub id: String,
    pub path: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct TaskRow {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cron_expr: String,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct ExecutionRow {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub output: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub retry_count: i64,
}

/// 一个部署任务。`name` 同时是 `/opt/docker-apps/<name>/` 目录名和容器名。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeployJobRow {
    pub id: String,
    pub name: String,
    pub note: String,
    pub script: String,
    pub source: String,
    pub status: String,
    pub actor: String,
    pub actor_kind: String,
    pub container_name: Option<String>,
    pub container_id: Option<String>,
    pub last_run_at: Option<String>,
    pub last_exit_code: Option<i64>,
    pub last_duration_ms: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// 一次部署执行。部署记录列表就是按 job 排下来的这些行。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeployRunRow {
    pub id: String,
    pub job_id: String,
    pub status: String,
    pub actor: String,
    pub actor_kind: String,
    pub output: String,
    pub log_path: String,
    pub exit_code: Option<i64>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeployFileRow {
    pub id: String,
    pub job_id: String,
    pub path: String,
    pub size: i64,
    pub uploaded_at: String,
    pub uploaded_by: String,
}

/// 一条安全预警（按 IP + 类型 + 路径 + 小时聚合过）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SecurityEventRow {
    pub id: i64,
    pub ip: String,
    /// blocked | bot | probe
    pub kind: String,
    pub reason: String,
    pub host: String,
    pub method: String,
    pub uri: String,
    pub status: i64,
    pub ua: String,
    pub hits: i64,
    pub first_seen: f64,
    pub last_seen: f64,
}

/// 一条端口（22）访问记录。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SshEventRow {
    pub id: i64,
    pub ts: f64,
    pub ip: String,
    pub user: String,
    /// accepted | failed | invalid
    pub result: String,
    pub method: String,
    pub port: i64,
    pub raw: String,
}

/// 待入库的 sshd 记录。
pub struct NewSshEvent {
    pub ts: f64,
    pub ip: String,
    pub user: String,
    pub result: String,
    pub method: String,
    pub port: i64,
    pub raw: String,
}
