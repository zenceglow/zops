//! 面板自己有没有新版本。
//
// 版本清单是发布时一起传到 CDN 的一个小 JSON（deploy.sh 生成）。面板定期去拉
// 一次，比自己版本新就在界面上弹一下。
//
// 为什么由**服务端**去拉，而不是让浏览器直连 CDN：面板常常装在内网机器上，
// 只有服务器自己能出网；而且"有没有新版本"是这台机器的事，不该跟着谁的浏览器走。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::shared::AppError;
use serde::{Deserialize, Serialize};

use crate::infrastructure::db::Database;

/// 安装脚本把二进制装在这里。
const DEFAULT_BIN: &str = "/usr/local/bin/zenceglow-ops";
/// systemd 单元名（= 服务名）。重启就是重启它。
const SERVICE: &str = "zenceglow-ops";

/// 缓存键：最近一次拉到的清单 + 拉取时间。
const CACHE_KEY: &str = "selfupdate.latest";
const CHECKED_KEY: &str = "selfupdate.checked_at";

/// 多久查一次。发布是周级别的事，查太勤只是白费流量。
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// "正在升级"这个标记的最长寿命。到了就当成上一次已经死了。
///
/// 没有这一条，任何一个环节卡住（下载挂在慢线路上、校验时子进程不返回），界面上
/// 就永远是"正在升级"，接口还一直回"已经在升级了，等一下" —— 用户唯一的出路
/// 是 ssh 上去重启面板。升级流程里最不该有这种状态。
const STUCK_AFTER: Duration = Duration::from_secs(20 * 60);
/// 上一次升级的结果。失败只写进 journald 的话，用户看到的就是"点了没反应"。
const LAST_ERROR_KEY: &str = "selfupdate.last_error";
const LAST_APPLIED_KEY: &str = "selfupdate.last_applied";
const LAST_MESSAGE_KEY: &str = "selfupdate.last_message";
/// 缓存多久算过期（打开面板时用来决定要不要顺手刷一次）。
///
/// 比后台那 6 小时短得多：后台的周期是"没人看的时候也要兜底"，而这里只发生在
/// **有人正开着面板**的时候 —— 刚发完版的人最想立刻看到提示，让他等六小时没有
/// 道理。代价是每小时一个几百字节的 JSON 请求。
const STALE_AFTER: i64 = 3600;

/// 版本清单。发布脚本写什么就读什么，字段都给了默认值 —— 少一个字段不该让
/// "有新版本"这件事整个丢掉。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub current: String,
    /// 拉不到清单时是 null —— 界面据此显示"检查不了"，而不是"已是最新"。
    pub latest: Option<String>,
    pub has_update: bool,
    /// 能不能在面板里点一下就升级。
    ///
    /// 只有"这个进程就是安装脚本装的那个二进制"时才为真 —— 本地开发跑
    /// `./target/debug/zenceglow-ops` 的时候，面板**绝不**该去替换自己旁边那个
    /// 文件，那是在改别人的东西。这种时候界面退回"复制命令"。
    pub can_apply: bool,
    /// 正在下载/替换中。界面据此显示进度而不是重复触发。
    pub applying: bool,
    pub notes: String,
    pub published_at: String,
    pub checked_at: Option<String>,
    /// 一行升级命令，弹窗里直接给用户复制。
    pub install_command: String,
    /// 上一次升级失败的原因（空串 = 没失败过）。界面直接把它显示出来 ——
    /// "点了没反应"和"下载失败：xxx"对用户是天壤之别。
    pub last_error: String,
    /// 上一次成功换上的版本号。
    pub last_applied: Option<String>,
    /// 新版本已经落在磁盘上、但当前进程还是旧的 —— 这种时候只差一次重启。
    /// 界面据此说"已就位，重启即生效"，而不是含糊的"再等等"。
    pub pending_restart: bool,
}

/// 升级的结果。前端拿到 `restarting` 之后就该去轮询，等面板重新站起来。
#[derive(Debug, Clone, Serialize)]
pub struct ApplyOutcome {
    pub version: String,
    pub restarting: bool,
    pub message: String,
}

pub struct SelfUpdateService {
    db: Arc<Database>,
    manifest_url: String,
    install_url: String,
    current: String,
    /// 正在升级。防止连点两下装两次 —— 两个下载写同一个临时文件会互相踩。
    ///
    /// 存的是**开始时间**而不是 bool：见 `STUCK_AFTER`。
    applying: std::sync::Mutex<Option<std::time::Instant>>,
}

impl SelfUpdateService {
    pub fn new(db: Arc<Database>, manifest_url: String, install_url: String) -> Self {
        Self {
            db,
            manifest_url,
            install_url,
            current: env!("CARGO_PKG_VERSION").to_string(),
            applying: std::sync::Mutex::new(None),
        }
    }

    pub fn is_applying(&self) -> bool {
        self.applying
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|t| t.elapsed() < STUCK_AFTER)
            .unwrap_or(false)
    }

    pub fn status(&self) -> UpdateStatus {
        let release = self.cached();
        let checked_at = self.db.get_config(CHECKED_KEY).ok().flatten();
        let has_update = release
            .as_ref()
            .map(|r| version_gt(&r.version, &self.current))
            .unwrap_or(false);
        UpdateStatus {
            current: self.current.clone(),
            latest: release.as_ref().map(|r| r.version.clone()),
            has_update,
            can_apply: has_update && self.managed_bin().is_some(),
            applying: self.is_applying(),
            notes: release.as_ref().map(|r| r.notes.clone()).unwrap_or_default(),
            published_at: release
                .as_ref()
                .map(|r| r.published_at.clone())
                .unwrap_or_default(),
            checked_at,
            install_command: format!("curl -fsSL {} | bash", self.install_url),
            last_error: self
                .db
                .get_config(LAST_ERROR_KEY)
                .ok()
                .flatten()
                .unwrap_or_default(),
            last_applied: self.db.get_config(LAST_APPLIED_KEY).ok().flatten(),
            pending_restart: self.pending_restart(),
        }
    }

    /// 磁盘上那份程序已经是新版本、但**当前进程**还是旧的。
    ///
    /// 判据是"跑一下磁盘上那份问版本" —— 和校验用的是同一个探针。只有在上一次
    /// 换过、且换的版本不是现在跑的版本时才去问，避免每次轮询都起一个进程。
    fn pending_restart(&self) -> bool {
        let Some(applied) = self.db.get_config(LAST_APPLIED_KEY).ok().flatten() else {
            return false;
        };
        if applied == self.current {
            return false;
        }
        self.managed_bin()
            .and_then(|p| probe_version(&p).ok())
            .map(|v| v == applied)
            .unwrap_or(false)
    }

    /// 就地升级：下载 → 校验 → 换掉自己 → 重启服务。
    ///
    /// 顺序上最要紧的是"任何一个环节不放心就不换"。半截的下载、arm 机器上误装
    /// 的 amd64、清单和程序对不上版本 —— 这几种情况下换上去 = 面板直接起不来，
    /// 而面板起不来时用户手上就只剩一个 SSH。所以每一步都验，验不过就保持原样。
    pub async fn apply(&self) -> Result<ApplyOutcome, AppError> {
        // 连点两下会同时开两个下载，写同一个临时文件，互相踩。
        // 超过 STUCK_AFTER 的上一次，当作已经死了，允许重来。
        {
            let mut guard = self.applying.lock().unwrap_or_else(|e| e.into_inner());
            if guard.map(|t| t.elapsed() < STUCK_AFTER).unwrap_or(false) {
                return Err(AppError::bad_request("已经在升级了，等一下"));
            }
            *guard = Some(std::time::Instant::now());
        }
        let result = self.apply_inner().await;
        *self.applying.lock().unwrap_or_else(|e| e.into_inner()) = None;

        // 成败都落一条：成功记下"换上的是哪一版"，失败记下原因。
        // 界面靠这两条把"点了没反应"变成一句能读的话。
        match &result {
            Ok(out) => {
                let _ = self.db.set_config(LAST_APPLIED_KEY, &out.version);
                let _ = self.db.set_config(LAST_MESSAGE_KEY, &out.message);
                let _ = self.db.set_config(LAST_ERROR_KEY, "");
            }
            Err(e) => {
                let _ = self.db.set_config(LAST_ERROR_KEY, &e.message);
            }
        }
        result
    }

    async fn apply_inner(&self) -> Result<ApplyOutcome, AppError> {
        self.preflight()?;
        let bin = self
            .managed_bin()
            .ok_or_else(|| AppError::bad_request("这个实例不是安装脚本部署的"))?;
        let release = self
            .cached()
            .ok_or_else(|| AppError::bad_request("还没拿到版本清单，稍后再试"))?;

        // 先落到同目录的临时文件：同一分区才能最后一步用 rename 原子替换，
        // 跨设备 rename 会退化成"先删后拷"，中间那一瞬间面板就没了。
        let tmp = bin.with_extension("new");
        if let Err(e) = download(&release.url, &tmp).await {
            // 半截文件一定要清掉：留着既占十几兆，又容易让人以为"已经下好了"。
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        if let Err(e) = verify(&tmp, &release.version) {
            // 校验没过就把半截文件删掉：留着只会让下一次升级多一个误导人的残骸。
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }

        // 留一份上一个能用的版本。换成新的之后如果起不来，用户还能拿它救回来。
        let _ = std::fs::copy(&bin, bin.with_extension("bak"));

        std::fs::rename(&tmp, &bin)
            .map_err(|e| AppError::internal(format!("替换二进制失败：{e}")))?;

        let restarting = schedule_restart(&bin);
        Ok(ApplyOutcome {
            version: release.version.clone(),
            restarting,
            message: if restarting {
                format!("已换成 {}，正在重启面板", release.version)
            } else {
                format!(
                    "已换成 {}，请手动重启面板（systemctl restart {SERVICE}）",
                    release.version
                )
            },
        })
    }

    /// 能不能升级 —— 所有"立刻就能判断"的条件都在这儿。
    ///
    /// 放在进入后台任务之前跑：不然用户点了升级，接口回一句"已开始"，
    /// 转头任务在日志里默默失败，界面上什么都不显示。
    pub fn preflight(&self) -> Result<(), AppError> {
        if self.managed_bin().is_none() {
            return Err(AppError::bad_request(
                "这个实例不是安装脚本部署的，自动升级不适用，请用命令行升级",
            ));
        }
        let release = self
            .cached()
            .ok_or_else(|| AppError::bad_request("还没拿到版本清单，稍后再试"))?;
        if !version_gt(&release.version, &self.current) {
            return Err(AppError::bad_request(format!(
                "当前已经是最新的 {}",
                self.current
            )));
        }
        if release.url.is_empty() {
            return Err(AppError::bad_request("清单里没有下载地址"));
        }
        Ok(())
    }

    /// 当前进程是不是"安装脚本装的那个二进制"。不是就别动它。
    fn managed_bin(&self) -> Option<PathBuf> {
        let path = std::env::var("OPS_BIN_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(DEFAULT_BIN));
        let exe = std::env::current_exe().ok()?;
        // 比 realpath：/usr/local/bin 在某些发行版上是个软链，直接比字符串会误判。
        let same = match (exe.canonicalize(), path.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => exe == path,
        };
        if !same || !path.is_file() {
            return None;
        }
        Some(path)
    }

    /// 缓存是不是该刷新了。界面每次打开都会问一次，但真正出门拉清单要隔 6 小时。
    pub fn is_stale(&self) -> bool {
        let Ok(Some(checked)) = self.db.get_config(CHECKED_KEY) else {
            return true;
        };
        chrono::NaiveDateTime::parse_from_str(&checked, "%Y-%m-%d %H:%M:%S")
            .map(|t| {
                (chrono::Local::now().naive_local() - t).num_seconds() > STALE_AFTER
            })
            .unwrap_or(true)
    }

    /// 拉一次清单并缓存。失败就保留上一次的结果 —— 网络抖一下不该让"有新版本"
    /// 的提示消失。
    pub async fn check(&self) -> Option<Release> {
        let release = fetch(&self.manifest_url).await?;
        if let Ok(json) = serde_json::to_string(&release) {
            let _ = self.db.set_config(CACHE_KEY, &json);
        }
        let _ = self.db.set_config(
            CHECKED_KEY,
            &chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        );
        Some(release)
    }

    fn cached(&self) -> Option<Release> {
        self.db
            .get_config(CACHE_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
    }
}

/// 拉清单。走 curl 而不是 hyper：这个地址是 https，而 hyper 的纯 HTTP 连接器
/// 不会 TLS 握手（图标那边踩过同一个坑）。
async fn fetch(url: &str) -> Option<Release> {
    let url = url.to_string();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("curl")
            .args(["-fsSL", "--max-time", "8", "-A", "ZOPS/self-update", &url])
            .output()
            .ok()
    })
    .await
    .ok()??;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// 下载到指定路径。走 curl 而不是在进程里做 HTTP：要跟证书、重定向、代理设置
/// 这些打交道的场合，curl 比我们自己写一遍靠谱得多。
async fn download(url: &str, dest: &Path) -> Result<(), AppError> {
    match curl_download(url, dest, true).await {
        Ok(()) => Ok(()),
        Err(first) => {
            // 续传失败最常见的一种：目的文件其实已经**完整**了，服务端对 `Range`
            // 回 416，curl 直接判失败 —— 于是"上次已经下好了"反而变成"再也下不动"，
            // 而且每次都失败、每次都清不掉。删掉重来一次，这次不带 `-C`。
            if !dest.exists() {
                return Err(first);
            }
            let _ = std::fs::remove_file(dest);
            curl_download(url, dest, false).await
        }
    }
}

async fn curl_download(url: &str, dest: &Path, resume: bool) -> Result<(), AppError> {
    match run_curl(url, dest, resume, true).await {
        Ok(()) => Ok(()),
        // 老 curl 不认识新选项就整套降级再试一次。
        //
        // 这台机器就踩过：RHEL8 / 阿里云 Linux 带的是 curl 7.61，没有
        // `--retry-all-errors`（7.71 才有）—— 整个自动升级就卡在一个**可选参数**上，
        // 而且报错只进 journald，界面上看起来就是"点了没反应"。
        // 参数是"让下载更稳"的，不是"能不能下载"的前提，缺了它也得能升上去。
        Err(e) if is_unknown_option(&e.message) => run_curl(url, dest, resume, false).await,
        Err(e) => Err(e),
    }
}

/// `curl: option --retry-all-errors: is unknown` 这类报错。
fn is_unknown_option(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    let unknown = ["unknown", "unrecognized", "unrecognised", "not recognized", "not recognised"]
        .iter()
        .any(|k| s.contains(k));
    unknown && s.contains("option")
}

/// 跑一次 curl。`fancy` = 带上"更稳但不是所有版本都有"的选项。
async fn run_curl(
    url: &str,
    dest: &Path,
    resume: bool,
    fancy: bool,
) -> Result<(), AppError> {
    let (url, dest) = (url.to_string(), dest.to_path_buf());
    let out = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("curl");
        // `-fsSL`：失败要报错、跟着重定向、安静模式、出错时别把错误页写进文件。
        cmd.args(["-fsSL"]);
        if fancy {
            // 这几个 2013 年前后的 curl 就有，正常发行版都带得动。
            cmd.args([
                "--retry",
                "3",
                "--retry-delay",
                "2",
                // 慢到 30 秒都跑不满 10KB/s 就判死，不必干等十分钟；
                // 但正常慢速（比如跨境线路只有几十 KB/s）仍然给足 10 分钟。
                "--speed-limit",
                "10240",
                "--speed-time",
                "30",
            ]);
        }
        cmd.args(["--max-time", "600", "-A", "ZOPS/self-update"]);
        // 断点续传：十几兆的东西，中间抖一下不该从头再来。
        if resume {
            cmd.args(["-C", "-"]);
        }
        cmd.arg("-o").arg(&dest).arg(&url).output()
    })
    .await
    .map_err(|e| AppError::internal(format!("下载任务没能启动：{e}")))?
    .map_err(|e| AppError::internal(format!("调不动 curl：{e}")))?;

    if !out.status.success() {
        return Err(AppError::bad_gateway(format!(
            "下载失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// 校验下载回来的东西到底是不是"我们要的那一版程序"。
///
/// CDN 抽风时可能返回一个 HTML 错误页，磁盘写满时可能只剩半截文件 —— 这两种
/// 都会让面板下一次启动直接失败。所以三层都查：大小、ELF 魔数、以及**真的把它
/// 跑起来问一句版本**。最后一条同时挡住了"在 arm64 机器上装了 amd64 二进制"。
fn verify(path: &Path, expect: &str) -> Result<(), AppError> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::bad_request(format!("下载的文件不见了：{e}")))?;
    if meta.len() < 1_000_000 {
        return Err(AppError::bad_request(format!(
            "下载回来的只有 {} 字节，不像是个程序，已放弃升级",
            meta.len()
        )));
    }

    let mut head = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| AppError::bad_request(format!("读不了下载的文件：{e}")))?;
    if &head != b"\x7fELF" {
        return Err(AppError::bad_request(
            "下载回来的不是 Linux 可执行文件，已放弃升级",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| AppError::internal(format!("设置可执行权限失败：{e}")))?;
    }

    let said = probe_version(path)?;
    if said != expect {
        return Err(AppError::bad_request(format!(
            "下载的程序报的是「{}」，清单说的是 {expect}，对不上，已放弃升级",
            said
        )));
    }
    Ok(())
}

/// 跑一下这份程序问它的版本，**带超时**。返回版本号本身（`ZOPS 0.2.17` → `0.2.17`）。
///
/// 这是整条升级链路里唯一"跑一个刚下载下来的东西"的地方 —— 没有超时的话，一个
/// 卡住的二进制会让 apply 永远不返回，"正在升级"就永远清不掉。超时后那个线程可能
/// 还挂着，但我们已经拿到了要的结论，不再等它。
fn probe_version(path: &Path) -> Result<String, AppError> {
    let path = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(&path).arg("--version").output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(out)) => Ok(String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .last()
            .unwrap_or_default()
            .to_string()),
        Ok(Err(e)) => Err(AppError::bad_request(format!(
            "下载的程序跑不起来：{e}（架构对不对？）"
        ))),
        Err(_) => Err(AppError::bad_request("下载的程序 15 秒没响应，已放弃升级")),
    }
}

/// 安排一次重启。
///
/// 麻烦在于**我们就是被重启的那个进程**：直接 `systemctl restart` 等于在处理
/// 请求的过程中把自己杀了，前端只会看到一个连接被掐断。所以扔给 systemd 一个
/// 延时任务（独立单元，不受本服务 cgroup 牵连），让它两秒后再动手 —— 那时响应
/// 早就发出去了。
///
/// 返回 false 表示两条路都没走通，此时界面应该提示用户手动重启。
/// 换完二进制之后的重启脚本。
///
/// 「重启成功」不等于「新版本能起来」：启动时 panic（比如路由表写错）会让 systemd
/// 一直重启、端口永远起不来 —— 而这时候人已经连不上面板了，只能上机器手动救
/// （2026-10-07 就是这么挂的：一个 `route("")` 让两台面板同时崩）。
/// 所以重启交给一段小脚本：起来就完事；20 秒还没起来就把上一版 `.bak` 换回去再重启，
/// 并把这件事写进 journal —— 坏版本最坏也只是"这次升级没生效"，不会把面板关在门外。
fn restart_script(bin: &std::path::Path) -> String {
    let bak = bin.with_extension("bak");
    let bin = bin.display();
    let bak = bak.display();
    format!(
        r#"BIN="{bin}"; BAK="{bak}"
PORT="$(systemctl show {SERVICE} -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^OPS_PORT=//p' | head -1)"
systemctl restart {SERVICE}
systemctl is-active --quiet {SERVICE} || true
if [ -n "$PORT" ]; then
  ok=0
  i=0
  while [ "$i" -lt 20 ]; do
    sleep 1
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/ops/version" >/dev/null 2>&1; then ok=1; break; fi
    i=$((i+1))
  done
  if [ "$ok" != "1" ] && [ -f "$BAK" ]; then
    logger -t zops "self-update: 新版本 20 秒内没起来，回滚到上一版（$BAK）"
    cp -f "$BAK" "$BIN" && systemctl restart {SERVICE}
  fi
fi"#
    )
}

fn schedule_restart(bin: &std::path::Path) -> bool {
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S");
    let unit = format!("zops-selfupdate-{stamp}");
    let script = restart_script(bin);

    // 首选：瞬时单元，和我们彻底解耦。
    let via_systemd_run = std::process::Command::new("systemd-run")
        .args([
            "--collect",
            "--on-active=2",
            &format!("--unit={unit}"),
            "sh",
            "-c",
            &script,
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if via_systemd_run {
        return true;
    }

    // 兜底：普通子进程。它跟着本服务的 cgroup 一起被杀，但重启指令在那之前
    // 就已经送到 PID 1 了，所以照样能重启起来。
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("sleep 2; {script} >/dev/null 2>&1"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

/// 版本比大小：按点分段逐段比数字。跟安装脚本里那段保持一致 —— 同一件事
/// 在两个地方给出不同答案，比不支持预发布后缀糟糕得多。
pub fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| {
                // `1-rc2` 这种，数字部分照收，后缀忽略。
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let (xi, yi) = (
            x.get(i).copied().unwrap_or(0),
            y.get(i).copied().unwrap_or(0),
        );
        if xi != yi {
            return xi > yi;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 老 curl 的报错长得就是这几种，别漏判 —— 漏一个就是"升级永远失败"。
    #[test]
    fn 认得出老_curl_的_unknown_option() {
        for msg in [
            "curl: option --retry-all-errors: is unknown\ncurl: try 'curl --help' or 'curl --manual' for more information",
            "curl: option --retry-all-errors: is unrecognized",
            "download failed：curl: option --speed-time: is not recognized",
            "curl: option -Z: is not recognised",
        ] {
            assert!(is_unknown_option(msg), "应该认得：{msg}");
        }
        // 正常的下载失败（连不上、404）不该被当成"参数不支持"，否则会白降级重试一次，
        // 而且把真正的错误藏起来。
        for msg in [
            "curl: (6) Could not resolve host: cdn.zenceglow.com",
            "curl: (22) The requested URL returned error: 404",
            "curl: (28) Operation timed out after 600001 milliseconds",
        ] {
            assert!(!is_unknown_option(msg), "不该误判：{msg}");
        }
    }

    #[test]
    fn 版本比较按段比数字() {
        assert!(version_gt("0.3.0", "0.2.0"));
        assert!(version_gt("0.2.1", "0.2.0"));
        assert!(version_gt("1.0.0", "0.99.99"));
        // 段数不同时短的按 0 补齐：0.2 和 0.2.0 是同一个版本，谁都不比谁大。
        assert!(!version_gt("0.2.0", "0.2"));
        assert!(!version_gt("0.2", "0.2.0"));
        assert!(!version_gt("0.2.0", "0.2.0"));
        assert!(!version_gt("0.1.9", "0.2.0"));
        // 预发布后缀按它前面的数字算，不当成字符串比
        assert!(version_gt("0.3.0-rc1", "0.2.0"));
    }

    /// 校验这一关是"面板能不能活下来"的全部保障，所以它拦的东西要写清楚。
    #[test]
    fn 校验拦得下不像程序的东西() {
        let dir = std::env::temp_dir().join(format!("zops-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // CDN 抽风时返回的 HTML 错误页
        let html = dir.join("error.html");
        std::fs::write(&html, b"<!doctype html><h1>404</h1>").unwrap();
        assert!(verify(&html, "0.2.3").is_err());

        // 够大、但根本不是可执行文件（磁盘写满时的半截文件也是这一类）
        let junk = dir.join("junk.bin");
        std::fs::write(&junk, vec![0u8; 2_000_000]).unwrap();
        assert!(verify(&junk, "0.2.3").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
