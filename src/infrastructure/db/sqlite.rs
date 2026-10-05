use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::password::{hash_password, verify_password};
use crate::domain::auth::MemberInfo;
use crate::domain::permission::ROLE_SUPER_ADMIN;

const META_INITIALIZED: &str = "initialized";
const META_SETUP_SECRET_HASH: &str = "setup_secret_hash";
const META_JWT_SECRET: &str = "jwt_secret";
/// 保留多少份 Caddyfile 历史。按一周改动几次估算，五十份够翻很久了。
const CADDYFILE_HISTORY_KEEP: i64 = 50;

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
