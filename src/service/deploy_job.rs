//! 部署任务通道。
//!
//! 手动（面板上三步走：传产物 → 写脚本 → 执行）和 agent 自动部署走的是同一套：
//! 一个任务 = 一个部署目录（`/opt/docker-apps/<name>/`）+ 若干上传的产物 + 一段
//! 部署脚本；每次执行写一条 `deploy_runs`，谁在什么时候部署了什么、结果如何，
//! 事后都能查。
//!
//! 为什么不省掉这一层让 agent 直接 `docker compose up`：那样没有记录，脚本和
//! compose 的写法也固定不下来 —— 这台机器上跑了二十来个服务，端口、网络、日志
//! 轮转、反代的习惯全靠这条通道统一。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::domain::deploy_job::{DeployFile, DeployJob, DeployRun, RunLog};
use crate::infrastructure::db::sqlite::{Database, DeployJobRow, DeployRunRow};
use crate::shared::AppError;

/// 部署脚本本身的大小上限。脚本是文本，64KB 已经离谱地长了。
const MAX_SCRIPT: usize = 64 * 1024;
/// 单个产物上限。DMG / tgz 常见十几 MB，"256MB 还传不上来"基本是传错东西了。
const MAX_FILE: usize = 256 * 1024 * 1024;
/// 一次构建可能很久（拉依赖、编译），但不能无限挂着。
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// 记录里留的末尾输出。
const OUTPUT_TAIL: usize = 8 * 1024;
/// 单次增量读日志的上限，别让前端一次拉走几百 MB。
const MAX_LOG_CHUNK: u64 = 512 * 1024;

const STATUS_RUNNING: &str = "running";
const STATUS_SUCCESS: &str = "success";
const STATUS_FAILED: &str = "failed";

pub struct DeployJobService {
    db: Arc<Database>,
    root: PathBuf,
    /// 正在跑的任务名。同一个任务不允许两路同时部署 —— 两次 compose 撞在一起
    /// 是那种"排查一晚上发现是并发"的问题。
    busy: Mutex<HashSet<String>>,
}

impl Clone for DeployJobService {
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            root: self.root.clone(),
            busy: Mutex::new(HashSet::new()),
        }
    }
}

impl DeployJobService {
    pub fn new(db: Arc<Database>, root: PathBuf) -> Self {
        Self {
            db,
            root,
            busy: Mutex::new(HashSet::new()),
        }
    }

    pub fn dir_of(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    // ── 任务 ──

    pub fn list(&self) -> Result<Vec<DeployJob>, AppError> {
        let rows = self.db.list_deploy_jobs().map_err(AppError::from)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(self.hydrate(row)?);
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<DeployJob, AppError> {
        let row = self
            .db
            .get_deploy_job(id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::not_found("部署任务不存在"))?;
        self.hydrate(row)
    }

    /// agent 习惯用服务名说话（`zenceglow-shop-server`），面板用 id。两个都收。
    pub fn get_by_ref(&self, key: &str) -> Result<DeployJob, AppError> {
        let row = self
            .db
            .get_deploy_job(key)
            .map_err(AppError::from)?
            .or(self
                .db
                .find_deploy_job_by_name(key)
                .map_err(AppError::from)?)
            .ok_or_else(|| AppError::not_found(format!("部署任务不存在：{key}")))?;
        self.hydrate(row)
    }

    fn hydrate(&self, row: DeployJobRow) -> Result<DeployJob, AppError> {
        let files = self
            .db
            .list_deploy_files(&row.id)
            .map_err(AppError::from)?
            .into_iter()
            .map(|f| DeployFile {
                path: f.path,
                size: f.size,
                uploaded_at: f.uploaded_at,
                uploaded_by: f.uploaded_by,
            })
            .collect();
        Ok(DeployJob {
            dir: self.dir_of(&row.name).display().to_string(),
            id: row.id,
            name: row.name,
            note: row.note,
            script: row.script,
            source: row.source,
            status: row.status,
            actor: row.actor,
            actor_kind: row.actor_kind,
            container_name: row.container_name,
            container_id: row.container_id,
            last_run_at: row.last_run_at,
            last_exit_code: row.last_exit_code,
            last_duration_ms: row.last_duration_ms,
            created_at: row.created_at,
            updated_at: row.updated_at,
            files,
        })
    }

    /// 建任务 = 建目录 + 落一条记录。目录先建出来，用户下一步就能往里传东西。
    pub fn create(
        &self,
        name: &str,
        note: &str,
        source: &str,
        actor: &str,
        actor_kind: &str,
    ) -> Result<DeployJob, AppError> {
        let name = name.trim();
        if !valid_name(name) {
            return Err(AppError::bad_request(
                "服务名只能用 a-z 0-9 - _，且以字母数字开头（它同时是目录名和容器名）",
            ));
        }
        if self
            .db
            .find_deploy_job_by_name(name)
            .map_err(AppError::from)?
            .is_some()
        {
            return Err(AppError::bad_request(format!("已经有一个叫 {name} 的部署任务了")));
        }
        let source = if source == "agent" { "agent" } else { "manual" };
        let dir = self.dir_of(name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::internal(format!("创建 {} 失败：{e}", dir.display())))?;

        let id = uuid::Uuid::new_v4().to_string();
        let row = self
            .db
            .create_deploy_job(&id, name, note.trim(), source, actor, actor_kind)
            .map_err(AppError::from)?;
        self.hydrate(row)
    }

    pub fn save_script(&self, id: &str, script: &str) -> Result<DeployJob, AppError> {
        if script.len() > MAX_SCRIPT {
            return Err(AppError::bad_request("部署脚本太长了"));
        }
        let job = self.get(id)?;
        if job.status == STATUS_RUNNING {
            return Err(AppError::bad_request("正在部署，等这一次跑完再改脚本"));
        }
        self.db
            .save_deploy_script(id, script)
            .map_err(AppError::from)?;
        self.get(id)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let job = self.get(id)?;
        if job.status == STATUS_RUNNING {
            return Err(AppError::bad_request("正在部署，不能删"));
        }
        self.db.delete_deploy_job(id).map_err(AppError::from)?;
        // 目录留着：里面是用户传上去的产物，删记录不该顺手删文件。
        Ok(())
    }

    // ── 产物 ──

    /// 把一坨字节写到部署目录里的某个相对路径。
    pub fn upload(
        &self,
        id: &str,
        rel_path: &str,
        bytes: &[u8],
        actor: &str,
    ) -> Result<DeployJob, AppError> {
        if bytes.len() > MAX_FILE {
            return Err(AppError::bad_request(format!(
                "单个文件上限 {} MB",
                MAX_FILE / 1024 / 1024
            )));
        }
        let job = self.get(id)?;
        let rel = safe_rel_path(rel_path)?;
        let dir = self.dir_of(&job.name);
        let target = dir.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal(format!("创建目录失败：{e}")))?;
        }
        std::fs::write(&target, bytes).map_err(|e| AppError::internal(format!("写入失败：{e}")))?;

        self.db
            .upsert_deploy_file(
                &uuid::Uuid::new_v4().to_string(),
                id,
                &rel,
                bytes.len() as i64,
                actor,
            )
            .map_err(AppError::from)?;
        self.get(id)
    }

    pub fn delete_file(&self, id: &str, rel_path: &str) -> Result<DeployJob, AppError> {
        let job = self.get(id)?;
        let rel = safe_rel_path(rel_path)?;
        let target = self.dir_of(&job.name).join(&rel);
        let _ = std::fs::remove_file(&target);
        self.db
            .delete_deploy_file(id, &rel)
            .map_err(AppError::from)?;
        self.get(id)
    }

    // ── 执行 ──

    pub fn runs(&self, id: &str, limit: i64) -> Result<Vec<DeployRun>, AppError> {
        let limit = limit.clamp(1, 200);
        let rows = self
            .db
            .list_deploy_runs(id, limit)
            .map_err(AppError::from)?;
        Ok(rows.into_iter().map(to_run).collect())
    }

    /// 执行部署。脚本在部署目录里跑，输出边跑边追加进日志文件，前端按 offset 拉。
    pub async fn run(
        &self,
        id: &str,
        actor: &str,
        actor_kind: &str,
    ) -> Result<DeployRun, AppError> {
        let job = self.get(id)?;
        if job.script.trim().is_empty() {
            return Err(AppError::bad_request("还没写部署脚本"));
        }
        {
            let mut busy = self.busy.lock().await;
            if !busy.insert(job.name.clone()) {
                return Err(AppError::bad_request("这个任务正在部署，等它跑完"));
            }
        }

        let run_id = uuid::Uuid::new_v4().to_string();
        let log_dir = self.dir_of(&job.name).join(".zops-deploy");
        std::fs::create_dir_all(&log_dir)
            .map_err(|e| AppError::internal(format!("创建日志目录失败：{e}")))?;
        let log_path = log_dir.join(format!("{run_id}.log"));

        let row = self
            .db
            .create_deploy_run(
                &run_id,
                id,
                actor,
                actor_kind,
                &log_path.display().to_string(),
            )
            .map_err(AppError::from)?;

        let this = self.clone();
        let job_name = job.name.clone();
        let job_id = job.id.clone();
        let script = job.script.clone();
        let dir = self.dir_of(&job.name);
        let log_for_task = log_path.clone();
        let run_id_task = run_id.clone();

        tokio::spawn(async move {
            let started = Instant::now();
            let exit = run_script(&script, &dir, &log_for_task).await;
            let duration = started.elapsed().as_millis() as i64;
            let (status, code) = match &exit {
                Ok(code) => (
                    if *code == 0 { STATUS_SUCCESS } else { STATUS_FAILED },
                    *code,
                ),
                Err(_) => (STATUS_FAILED, -1),
            };
            let output = read_tail(&log_for_task).await;

            if let Err(e) = this
                .db
                .finish_deploy_run(&run_id_task, status, code, &output, duration)
            {
                eprintln!("[deploy] 回写执行记录失败：{e}");
            }

            // 起来了才去对容器 —— 没起来去对，只会把一个旧的同名容器绑上去。
            let container = if status == STATUS_SUCCESS {
                bind_container(&job_name)
            } else {
                None
            };
            let bound = container
                .as_ref()
                .map(|(name, cid)| (name.as_str(), cid.as_str()));
            if let Err(e) = this
                .db
                .update_deploy_job_after_run(&job_id, status, code, duration, bound)
            {
                eprintln!("[deploy] 回写任务状态失败：{e}");
            }
            this.busy.lock().await.remove(&job_name);
        });

        Ok(to_run(row))
    }

    /// 增量读某次执行的日志。`offset` 是上一次返回的位置，重复调用就是实时进度。
    pub async fn run_log(&self, run_id: &str, offset: u64) -> Result<RunLog, AppError> {
        let row = self
            .db
            .get_deploy_run(run_id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::not_found("找不到这次部署"))?;
        let finished = row.status != STATUS_RUNNING;

        let path = PathBuf::from(&row.log_path);
        let mut output = String::new();
        let mut next = offset;
        if let Ok(mut file) = tokio::fs::File::open(&path).await {
            let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
            if offset < size {
                let start = offset;
                let take = (size - start).min(MAX_LOG_CHUNK);
                if file.seek(std::io::SeekFrom::Start(start)).await.is_ok() {
                    let mut buf = vec![0u8; take as usize];
                    if let Ok(n) = file.read(&mut buf).await {
                        output = String::from_utf8_lossy(&buf[..n]).to_string();
                        next = start + n as u64;
                    }
                }
            }
        }

        Ok(RunLog {
            status: row.status,
            output,
            offset: next,
            finished,
            exit_code: row.exit_code,
        })
    }
}

fn to_run(row: DeployRunRow) -> DeployRun {
    DeployRun {
        id: row.id,
        job_id: row.job_id,
        status: row.status,
        actor: row.actor,
        actor_kind: row.actor_kind,
        output: row.output,
        exit_code: row.exit_code,
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_ms: row.duration_ms,
    }
}

/// 服务名/目录名。字符集卡死是安全边界：允许 `/` 或 `..` 就等于允许写到别处去。
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 41
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
}

/// 上传路径：必须是部署目录内的相对路径。
fn safe_rel_path(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim().trim_start_matches("./");
    if raw.is_empty() {
        return Err(AppError::bad_request("文件名不能为空"));
    }
    let p = Path::new(raw);
    let bad = p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || raw.contains('\0');
    if bad {
        return Err(AppError::bad_request(
            "路径必须是部署目录内的相对路径（不许 .. 或绝对路径）",
        ));
    }
    Ok(raw.to_string())
}

/// 跑脚本：`sh -c`，工作目录是部署目录，stdout/stderr 都追加进日志文件。
///
/// 以面板进程的身份跑（systemd 里是 root）—— 和 SSH 上去敲是同一档权限。
/// 这是这台机器的既有前提：能进面板的人本来就能改服务器。
async fn run_script(script: &str, dir: &Path, log_path: &Path) -> Result<i64, AppError> {
    let mut child = Command::new("sh")
        .arg("-c")
        // 部署脚本的默认期待：中间一步失败就停下来，别接着往下跑。
        .arg(format!("set -e\n{script}"))
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::internal(format!("起不了部署脚本：{e}")))?;

    let out = child.stdout.take();
    let err = child.stderr.take();
    let log_a = log_path.to_path_buf();
    let log_b = log_path.to_path_buf();
    let t_out = tokio::spawn(async move { pump(out, log_a).await });
    let t_err = tokio::spawn(async move { pump(err, log_b).await });

    let status = match tokio::time::timeout(RUN_TIMEOUT, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(AppError::internal(format!("等待部署脚本失败：{e}"))),
        Err(_) => {
            let _ = child.kill().await;
            append_log(log_path, "\n[zops] 超过 30 分钟没跑完，已终止\n").await;
            return Ok(-1);
        }
    };
    let _ = t_out.await;
    let _ = t_err.await;
    Ok(status.code().unwrap_or(-1) as i64)
}

async fn pump(
    stream: Option<impl tokio::io::AsyncRead + Unpin>,
    log_path: PathBuf,
) -> std::io::Result<()> {
    let Some(stream) = stream else { return Ok(()) };
    let mut lines = BufReader::new(stream).lines();
    while let Some(line) = lines.next_line().await? {
        append_log(&log_path, &format!("{line}\n")).await;
    }
    Ok(())
}

async fn append_log(path: &Path, text: &str) {
    if let Ok(mut f) = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        let _ = tokio::io::AsyncWriteExt::write_all(&mut f, text.as_bytes()).await;
    }
}

async fn read_tail(path: &Path) -> String {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return String::new();
    };
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(OUTPUT_TAIL as u64);
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).await.is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// 部署完了把容器对上：名字或镜像名等于服务名的那一个。
///
/// 这只是把记录和容器绑起来 —— 对不上不算失败（静态站可能另有容器在服务，
/// 或者这轮只是重新构建）。
fn bind_container(name: &str) -> Option<(String, String)> {
    let out = std::process::Command::new("docker")
        .args(["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut parts = line.split('\t');
        let id = parts.next().unwrap_or_default();
        let cname = parts.next().unwrap_or_default();
        let image = parts.next().unwrap_or_default();
        if cname == name || image == name {
            return Some((cname.to_string(), id.to_string()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 服务名挡得住路径穿越() {
        for bad in ["../etc", "UPPER", "a b", "", "оплата", "-x"] {
            assert!(!valid_name(bad), "{bad} 不该通过");
        }
        for good in ["zenceglow-web", "shop_2", "a"] {
            assert!(valid_name(good), "{good} 应该通过");
        }
    }

    #[test]
    fn 上传路径必须是目录内的相对路径() {
        assert_eq!(safe_rel_path("package.tgz").unwrap(), "package.tgz");
        assert_eq!(safe_rel_path("./conf/app.yaml").unwrap(), "conf/app.yaml");
        for bad in ["/etc/passwd", "../x", "a/../../b"] {
            assert!(safe_rel_path(bad).is_err(), "{bad} 不该通过");
        }
    }

    /// 部署记录要能落库、能按 job 查回来 —— 这是"谁什么时候部署了什么"的底账。
    #[tokio::test]
    async fn 建任务传产物写脚本跑一次都留痕() {
        let db = Arc::new(Database::open(Path::new(":memory:")).unwrap());
        let root = std::env::temp_dir().join(format!("zops-deploy-{}", std::process::id()));
        let svc = DeployJobService::new(db, root.clone());

        let job = svc
            .create("zops-test-app", "测试", "manual", "tester", "user")
            .unwrap();
        assert!(svc.dir_of("zops-test-app").is_dir(), "目录应该建出来");

        svc.upload(&job.id, "hello.txt", b"hi", "tester").unwrap();
        let job = svc.get(&job.id).unwrap();
        assert_eq!(job.files.len(), 1);
        assert_eq!(job.files[0].path, "hello.txt");

        svc.save_script(&job.id, "echo deploying\ncat hello.txt")
            .unwrap();
        let run = svc.run(&job.id, "tester", "user").await.unwrap();
        assert_eq!(run.status, "running");

        // 脚本是异步跑的，等它落地。
        let mut done = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let r = svc.runs(&job.id, 10).unwrap();
            if r[0].status != "running" {
                done = Some(r[0].clone());
                break;
            }
        }
        let done = done.expect("部署应该跑完");
        assert_eq!(done.status, "success", "输出：{}", done.output);
        assert!(done.output.contains("deploying"));

        let log = svc.run_log(&run.id, 0).await.unwrap();
        assert!(log.finished);
        assert!(log.output.contains("hi"));

        svc.delete(&job.id).unwrap();
        assert!(svc.list().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
