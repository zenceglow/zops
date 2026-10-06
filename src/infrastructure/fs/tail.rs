use std::time::Duration;

use tokio::sync::mpsc;

use crate::shared::AppError;

/// 只从文件末尾读这么多字节。tail 上限是 2000 行，512KB 足够覆盖；把整个文件读进
/// 内存在这台机器上是真事故 —— 一个没轮转的 access.log 就能吃掉整机内存。
const TAIL_MAX_BYTES: u64 = 512 * 1024;

pub async fn read_tail(path: &str, tail: usize) -> Result<(Vec<String>, bool), AppError> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let map_err = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::not_found(format!("文件不存在：{path}")),
        std::io::ErrorKind::PermissionDenied => {
            AppError::forbidden(format!("没有权限读取：{path}"))
        }
        _ => AppError::internal(format!("读取文件失败：{e}")),
    };

    let mut file = tokio::fs::File::open(path).await.map_err(map_err)?;
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(TAIL_MAX_BYTES);
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(map_err)?;
    }

    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await.map_err(map_err)?;
    // 日志里混进非 UTF-8 字节是常事，别让它变成一句"读取文件失败"。
    let text = String::from_utf8_lossy(&buf);

    let mut all_lines: Vec<String> = text.lines().map(str::to_string).collect();
    // 从文件中间开始读时，第一行多半是被砍掉一半的残行，丢掉。
    if start > 0 && !all_lines.is_empty() {
        all_lines.remove(0);
    }

    let truncated = start > 0 || all_lines.len() > tail;
    let from = all_lines.len().saturating_sub(tail);
    Ok((all_lines.split_off(from), truncated))
}

/// Stream new lines appended to a file using a polling approach.
/// Sends each new line through the channel. Returns when the sender is dropped.
pub async fn follow_file(path: String, tx: mpsc::Sender<String>) {
    let file_path = std::path::PathBuf::from(&path);
    let mut last_size = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m.len(),
        Err(_) => {
            let _ = tx.send(format!("[error] cannot read file: {path}")).await;
            return;
        }
    };

    loop {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if tx.is_closed() {
            return;
        }

        let Ok(meta) = tokio::fs::metadata(&file_path).await else {
            let _ = tx.send(format!("[error] file disappeared: {path}")).await;
            return;
        };

        let current_size = meta.len();

        if current_size < last_size {
            // File truncated — reset
            last_size = 0;
        }

        if current_size > last_size {
            // Read new content
            let file = tokio::fs::File::open(&file_path).await.ok();
            drop(file);

            // Use std for seek
            let file = match std::fs::File::open(&file_path) {
                Ok(f) => f,
                Err(_) => {
                    last_size = current_size;
                    continue;
                }
            };
            use std::io::{BufRead, Seek, SeekFrom};
            let mut reader = std::io::BufReader::new(file);
            if let Err(_) = reader.seek(SeekFrom::Start(last_size)) {
                last_size = current_size;
                continue;
            };

            let mut buf = Vec::new();
            if let Err(_) = reader.read_until(b'\n', &mut buf) {
                last_size = current_size;
                continue;
            }

            let total_read = buf.len() as u64;
            if total_read > 0 {
                let line = String::from_utf8_lossy(&buf).trim_end_matches('\n').trim_end_matches('\r').to_string();
                if !line.is_empty() {
                    if tx.send(line).await.is_err() {
                        return;
                    }
                }
            }
            last_size += total_read;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 尾部读取只取最后几行并容忍非_utf8() {
        let dir = std::env::temp_dir().join(format!("zops-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app.log");
        let body: String = (1..=50).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&path, body).unwrap();
        let path = path.to_str().unwrap();

        let (lines, truncated) = read_tail(path, 10).await.unwrap();
        assert_eq!(lines.len(), 10);
        assert_eq!(lines[0], "line 41");
        assert_eq!(lines[9], "line 50");
        assert!(truncated);

        let (all, truncated) = read_tail(path, 100).await.unwrap();
        assert_eq!(all.len(), 50);
        assert!(!truncated);

        // 日志里混进非 UTF-8 字节是常事，不该变成"读取文件失败"。
        let raw = dir.join("raw.log");
        std::fs::write(&raw, b"ok\n\xff\xfe bad\n").unwrap();
        let (lines, _) = read_tail(raw.to_str().unwrap(), 10).await.unwrap();
        assert_eq!(lines.len(), 2);

        // 文件不存在时要说清楚，不要笼统地报"读取文件失败"。
        let missing = dir.join("nope.log");
        let err = read_tail(missing.to_str().unwrap(), 10).await.unwrap_err();
        assert!(err.message.contains("文件不存在"), "{}", err.message);

        std::fs::remove_dir_all(&dir).ok();
    }
}
