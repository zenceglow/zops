use crate::shared::AppError;

/// 拿一段配置去跑 `caddy <子命令> --config - --adapter caddyfile`，读回结果。
///
/// 两个子命令共用同一套 stdin/超时处理：`fmt` 要它的 stdout（排版后的配置），
/// `validate` 只关心退出码和报错。
async fn run_caddy(
    bin: &str,
    subcommand: &str,
    raw: &str,
    with_adapter: bool,
) -> Result<std::process::Output, String> {
    use tokio::io::AsyncWriteExt;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg(subcommand).arg("--config").arg("-");
    if with_adapter {
        // 不给 adapter 的话 caddy 会把输入当成 JSON，直接报
        // "config is not valid JSON" —— 那句提示会让人以为配置坏了。
        cmd.arg("--adapter").arg("caddyfile");
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("caddy {subcommand} 启动失败: {e}"))?;
    {
        let mut stdin = child.stdin.take().ok_or("无法写入 stdin")?;
        stdin
            .write_all(raw.as_bytes())
            .await
            .map_err(|e| format!("写入 stdin 失败: {e}"))?;
        // 显式关掉：不关的话 caddy 会一直等着 stdin 结束。
        let _ = stdin.shutdown().await;
    }

    // 校验会真的去 adapt 一遍配置；卡住的配置不该把面板一起拖住。
    match tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output()).await {
        Err(_) => Err(format!("caddy {subcommand} 超时")),
        Ok(Err(e)) => Err(format!("caddy {subcommand} 执行失败: {e}")),
        Ok(Ok(out)) => Ok(out),
    }
}

pub async fn fmt_caddyfile(bin: &str, raw: String) -> Result<String, AppError> {
    let bin = bin.to_string();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut child = std::process::Command::new(&bin)
            .arg("fmt")
            // 从 stdin 读、结果打到 stdout。`--parser` 这个参数并不存在（那是当初
            // 想当然写的），caddy 会直接以 "unknown flag: --parser" 退出，于是
            // 「保存配置」永远失败；而且读 stdin 必须显式给一个 `-` 当路径，
            // 否则 caddy 会去找默认的 Caddyfile。
            .arg("-")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("caddy fmt 启动失败: {e}"))?;

        {
            use std::io::Write;
            let mut stdin = child.stdin.take().unwrap();
            stdin
                .write_all(raw.as_bytes())
                .map_err(|e| format!("写入 stdin 失败: {e}"))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("caddy fmt 执行失败: {e}"))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if err.is_empty() {
                "Caddyfile 语法错误".into()
            } else {
                err
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })
    .await
    .map_err(|_| AppError::internal("内部错误"))?
    .map_err(AppError::bad_request)
}

/// 让 Caddy 自己判断这份配置能不能加载。
///
/// 失败时把 Caddy 的原话带回去（它会指出第几行、哪个指令不认），比我们猜一句话
/// 有用得多 —— 用户对着 "unrecognized directive: reverse_prox" 一眼就知道错在哪。
pub async fn validate_caddyfile(bin: &str, raw: &str) -> Result<(), String> {
    let bin = bin.to_string();
    let raw = raw.to_string();
    let out = run_caddy(&bin, "validate", &raw, true).await?;
    if out.status.success() {
        return Ok(());
    }

    let msg = last_error_line(&String::from_utf8_lossy(&out.stderr))
        .or_else(|| last_error_line(&String::from_utf8_lossy(&out.stdout)))
        // Caddy 会先把默认日志重定向到 Caddyfile 里配的日志文件，之后再出错 ——
        // 那种情况下 stderr 里干干净净，错误其实写进了那个文件。不把它捞出来的话，
        // 用户只看到一句"校验失败"，而真正的原因（比如日志目录不存在）明明就在手边。
        .or_else(|| last_error_from_log_file(&raw))
        .unwrap_or_else(|| "Caddyfile 校验不通过（Caddy 没有说明原因）".to_string());

    Err(with_hint(msg))
}

/// 从一堆日志行里挑出最后一条 error 级别的消息。
fn last_error_line(text: &str) -> Option<String> {
    text.lines().rev().find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        (v.get("level")?.as_str()? == "error")
            .then(|| v.get("msg")?.as_str().map(String::from))
            .flatten()
    })
}

/// 去 Caddyfile 里写的日志文件里找最后一条报错。
fn last_error_from_log_file(raw: &str) -> Option<String> {
    use super::logs::{log_paths_from_caddyfile, strip_ansi};

    for path in log_paths_from_caddyfile(raw) {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        // 只看尾部一小段：这是个几十兆的访问日志也不该把内存吃掉。
        let tail = if content.len() > 64 * 1024 {
            &content[content.len() - 64 * 1024..]
        } else {
            &content
        };
        if let Some(line) = tail
            .lines()
            .rev()
            .find(|l| l.contains("ERROR") || l.contains("\"level\":\"error\""))
        {
            return Some(strip_ansi(line).trim().to_string());
        }
    }
    None
}

/// 给常见的失败补一句能照做的话。
///
/// Caddy 的原话是 `setting up custom log 'log1': opening log writer using
/// &logging.FileWriter{Filename:"/var/log/caddy/x_access.log"...` —— 信息是够的，
/// 但一眼看不出该干什么。站点模板默认把访问日志写到 `/var/log/caddy/`，
/// 而这个目录在没装 Caddy 容器的机器上通常不存在，所以这是最常见的一种。
fn with_hint(msg: String) -> String {
    if let Some(idx) = msg.find("Filename:\"") {
        let rest = &msg[idx + "Filename:\"".len()..];
        if let Some(end) = rest.find('"') {
            let file = &rest[..end];
            let dir = file.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            if !dir.is_empty() {
                return format!(
                    "{msg}\n\n（多半是日志目录不存在或没有写权限。可以先在服务器上执行：mkdir -p {dir}）"
                );
            }
        }
    }
    msg
}
