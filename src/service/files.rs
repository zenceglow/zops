//! 文件浏览。
//!
//! 只读：列目录、递归找名字、读文本内容。写操作（改名/删除/上传）不在这一版里 ——
//! 那些是不可逆的，得先想清楚怎么给用户确认和回滚。

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::shared::AppError;

/// 单个目录最多列这么多，再多就靠搜索；`/usr/lib` 这类目录能到几万条。
const MAX_ENTRIES: usize = 2000;
/// 递归搜索的上限：结果数、深度。
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_DEPTH: usize = 8;
/// 预览最多读这么多字节。
const MAX_PREVIEW_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// dir | file | symlink | other
    pub kind: String,
    pub size: i64,
    pub modified: String,
    /// rwxr-xr-x 这种，给运维看权限用。
    pub mode: String,
    /// 搜索时带上相对搜索根的位置，列表里就能看出文件在哪一层。
    pub rel: String,
}

#[derive(Debug, Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct FilePreview {
    pub path: String,
    pub size: i64,
    pub binary: bool,
    pub truncated: bool,
    pub content: String,
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/root"))
}

/// 把用户输入的路径整理成绝对路径。
///
/// 刻意不用 `canonicalize`：它在路径不存在时直接失败，而"输错一个目录名"应该得到
/// 一句"没有这个目录"，不是一句"找不到路径"。这里只做词法上的展开与去 `..`。
fn resolve(input: &str) -> PathBuf {
    let trimmed = input.trim();
    let raw = if trimmed.is_empty() {
        home_dir()
    } else if let Some(rest) = trimmed.strip_prefix('~') {
        home_dir().join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(trimmed)
    };

    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    if out.as_os_str().is_empty() {
        out.push("/");
    }
    out
}

fn mode_string(meta: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = meta.permissions().mode();
        let rwx = |shift: u32| {
            let bits = (m >> shift) & 0b111;
            format!(
                "{}{}{}",
                if bits & 0b100 != 0 { 'r' } else { '-' },
                if bits & 0b010 != 0 { 'w' } else { '-' },
                if bits & 0b001 != 0 { 'x' } else { '-' },
            )
        };
        format!("{}{}{}", rwx(6), rwx(3), rwx(0))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        String::new()
    }
}

fn kind_of(ft: &std::fs::FileType) -> &'static str {
    if ft.is_dir() {
        "dir"
    } else if ft.is_symlink() {
        "symlink"
    } else if ft.is_file() {
        "file"
    } else {
        "other"
    }
}

fn stat(path: &Path, rel: &str) -> Option<FileEntry> {
    // 用 symlink_metadata：符号链接本身也是一种信息，跟着解析会把"链接指向哪"藏起来。
    let meta = std::fs::symlink_metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d %H:%M").to_string()
        })
        .unwrap_or_default();
    Some(FileEntry {
        name: path.file_name()?.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        kind: kind_of(&meta.file_type()).to_string(),
        size: if meta.is_dir() { 0 } else { meta.len() as i64 },
        modified,
        mode: mode_string(&meta),
        rel: rel.to_string(),
    })
}

pub fn list(input: &str) -> Result<DirListing, AppError> {
    let path = resolve(input);
    let read = std::fs::read_dir(&path)
        .map_err(|e| AppError::bad_request(format!("{} 无法读取：{e}", path.display())))?;

    let mut entries: Vec<FileEntry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| stat(&e.path(), ""))
        .collect();

    let truncated = entries.len() > MAX_ENTRIES;
    // 目录在前、同类按名字排 —— 访达的默认顺序，用户不用重新找节奏。
    entries.sort_by(|a, b| {
        let kind = |k: &str| if k == "dir" { 0 } else { 1 };
        kind(&a.kind)
            .cmp(&kind(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(MAX_ENTRIES);

    Ok(DirListing {
        parent: path.parent().map(|p| p.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
        entries,
        truncated,
    })
}

/// 在这些目录下不做递归搜索：`/proc`、`/sys` 是内核的虚拟文件系统，遍历它们既慢
/// 又没意义（里面还有自引用）；`/dev`、`/run` 同理。
fn search_denied(root: &Path) -> bool {
    matches!(root.to_string_lossy().as_ref(), "/proc" | "/sys" | "/dev" | "/run")
}

pub fn search(root: &str, query: &str) -> Result<Vec<FileEntry>, AppError> {
    let root = resolve(root);
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    if search_denied(&root) {
        return Err(AppError::bad_request("这个目录不支持递归搜索"));
    }

    let mut out = Vec::new();
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_SEARCH_RESULTS || depth > MAX_SEARCH_DEPTH {
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = path
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| name.clone());

            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            // 只按名字匹配：内容检索是另一件事（要索引、要限流），不混在这里。
            if name.to_lowercase().contains(&q) {
                if let Some(mut e) = stat(&path, &rel) {
                    e.rel = rel.clone();
                    out.push(e);
                }
                if out.len() >= MAX_SEARCH_RESULTS {
                    break;
                }
            }
            // 不进符号链接指向的目录：可能指回上层，直接变成环。
            if meta.is_dir() && !meta.file_type().is_symlink() {
                stack.push((path, depth + 1));
            }
        }
    }

    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    Ok(out)
}

/// 读文件开头一段，给预览用。
///
/// 二进制文件（含 NUL 字节）不返回内容：把二进制塞进 JSON 再塞进 `<pre>`，除了
/// 让浏览器卡住没有任何用处。这种情况只回元信息。
pub fn preview(input: &str) -> Result<FilePreview, AppError> {
    use std::io::Read;

    let path = resolve(input);
    let meta =
        std::fs::metadata(&path).map_err(|e| AppError::bad_request(format!("{} 无法读取：{e}", path.display())))?;
    if meta.is_dir() {
        return Err(AppError::bad_request("这是一个目录"));
    }

    let size = meta.len();
    let mut buf = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| AppError::bad_request(format!("{} 无法打开：{e}", path.display())))?
        .take(MAX_PREVIEW_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| AppError::internal(e.to_string()))?;

    let binary = buf.iter().take(8192).any(|b| *b == 0);
    Ok(FilePreview {
        path: path.to_string_lossy().to_string(),
        size: size as i64,
        binary,
        truncated: size > MAX_PREVIEW_BYTES,
        content: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&buf).into_owned()
        },
    })
}
