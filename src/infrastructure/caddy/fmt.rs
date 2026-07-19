use crate::shared::AppError;

pub async fn fmt_caddyfile(bin: &str, raw: String) -> Result<String, AppError> {
    let bin = bin.to_string();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut child = std::process::Command::new(&bin)
            .arg("fmt")
            .arg("--parser")
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
