use std::time::Duration;

use tokio::sync::mpsc;

use crate::shared::AppError;

pub async fn read_tail(path: &str, tail: usize) -> Result<(Vec<String>, bool), AppError> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| AppError::not_found("读取文件失败"))?;

    let all_lines: Vec<&str> = content.lines().collect();
    let total = all_lines.len();
    let lines: Vec<String> = all_lines
        .into_iter()
        .skip(total.saturating_sub(tail))
        .map(|s| s.to_string())
        .collect();

    Ok((lines, total > tail))
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
