//! 文件浏览。
//!
//! 只读：列目录、递归找名字、读文本内容。写操作（改名/删除/上传）不在这一版里 ——
//! 那些是不可逆的，得先想清楚怎么给用户确认和回滚。

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::infrastructure::db::{Database, TrashRow};
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

// ─────────────────────────── 写操作 ───────────────────────────

/// 文件夹的读写入口。回收站要落在数据目录里（跟数据库同级），所以服务需要知道它。
pub struct FilesService {
    db: Arc<Database>,
    /// 回收站的根：`<数据目录>/trash`。
    trash: PathBuf,
}

impl FilesService {
    pub fn new(db: Arc<Database>, data_dir: PathBuf) -> Self {
        Self {
            db,
            trash: data_dir.join("trash"),
        }
    }

    /// 不允许动手的地方。
    ///
    /// 三条都是真的踩过会出事的：删掉 `/` 等于删掉整台机器；把面板自己的数据目录
    /// 挪走，面板当场就挂了、连恢复的界面都没了；把目录移进它自己的子目录，文件
    /// 会在这个操作里消失。
    fn guard(&self, path: &Path, action: &str) -> Result<(), AppError> {
        if path == Path::new("/") {
            return Err(AppError::bad_request("不能对根目录执行这个操作"));
        }
        if path.starts_with(&self.trash) || self.trash.starts_with(path) {
            return Err(AppError::bad_request("不能对回收站目录执行这个操作"));
        }
        if !path.exists() {
            return Err(AppError::bad_request(format!("{} 不存在", path.display())));
        }
        let _ = action;
        Ok(())
    }

    /// 目标目录里没有重名时用原名字，有的话按访达的习惯叫「xxx 副本」「xxx 副本 2」。
    fn unique_target(dir: &Path, name: &str) -> PathBuf {
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        let (stem, ext) = match name.rsplit_once('.') {
            // 只有 `.bashrc` 这种才算"整名都是主干"，别把隐藏文件拆成 "" 和 "bashrc"。
            Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (name.to_string(), String::new()),
        };
        for n in 1..1000 {
            let suffix = if n == 1 {
                " 副本".to_string()
            } else {
                format!(" 副本 {n}")
            };
            let candidate = dir.join(format!("{stem}{suffix}{ext}"));
            if !candidate.exists() {
                return candidate;
            }
        }
        candidate
    }

    /// 递归复制。目录要手写递归：标准库的 `fs::copy` 只认文件。
    fn copy_recursive(from: &Path, to: &Path) -> Result<(), AppError> {
        let meta = std::fs::symlink_metadata(from)
            .map_err(|e| AppError::bad_request(format!("{} 无法读取：{e}", from.display())))?;
        if meta.is_dir() {
            std::fs::create_dir_all(to).map_err(|e| AppError::internal(e.to_string()))?;
            for entry in std::fs::read_dir(from)
                .map_err(|e| AppError::internal(e.to_string()))?
                .filter_map(|e| e.ok())
            {
                Self::copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
            }
        } else if meta.file_type().is_symlink() {
            // 复制链接本身，而不是它指向的东西 —— 后者会把链接悄悄变成实文件。
            #[cfg(unix)]
            {
                let target = std::fs::read_link(from).map_err(|e| AppError::internal(e.to_string()))?;
                std::os::unix::fs::symlink(target, to).map_err(|e| AppError::internal(e.to_string()))?;
            }
        } else {
            std::fs::copy(from, to).map_err(|e| AppError::internal(e.to_string()))?;
        }
        Ok(())
    }

    /// 搬到回收站：优先 rename（同一个文件系统上是瞬时的、也不占额外空间），
    /// 跨文件系统时退回"复制 + 删除"。
    fn move_to_trash(&self, from: &Path, id: &str) -> Result<(), AppError> {
        std::fs::create_dir_all(&self.trash).map_err(|e| AppError::internal(e.to_string()))?;
        let dest = self.trash.join(id);
        match std::fs::rename(from, &dest) {
            Ok(()) => Ok(()),
            Err(_) => {
                Self::copy_recursive(from, &dest)?;
                Self::remove_recursive(from)
            }
        }
    }

    fn remove_recursive(path: &Path) -> Result<(), AppError> {
        let meta = std::fs::symlink_metadata(path)
            .map_err(|e| AppError::bad_request(format!("{} 无法读取：{e}", path.display())))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| AppError::internal(e.to_string()))
        } else {
            std::fs::remove_file(path).map_err(|e| AppError::internal(e.to_string()))
        }
    }

    /// 目录大小。回收站列表要显示"删掉了多少"，不然用户没法判断该不该清。
    fn dir_size(path: &Path) -> i64 {
        let Ok(read) = std::fs::read_dir(path) else {
            return 0;
        };
        read.filter_map(|e| e.ok())
            .map(|e| match std::fs::symlink_metadata(e.path()) {
                Ok(m) if m.is_dir() => Self::dir_size(&e.path()),
                Ok(m) => m.len() as i64,
                Err(_) => 0,
            })
            .sum()
    }

    pub fn move_into(&self, paths: &[String], to: &str) -> Result<(), AppError> {
        let dest = resolve(to);
        if !dest.is_dir() {
            return Err(AppError::bad_request(format!("{} 不是目录", dest.display())));
        }
        for p in paths {
            let from = resolve(p);
            self.guard(&from, "移动")?;
            // 把目录移进它自己的子树：rename 会先成功、然后文件凭空消失。
            if from.is_dir() && dest.starts_with(&from) {
                return Err(AppError::bad_request("不能把目录移动到它自己里面"));
            }
            let name = from
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let target = Self::unique_target(&dest, &name);
            if std::fs::rename(&from, &target).is_err() {
                Self::copy_recursive(&from, &target)?;
                Self::remove_recursive(&from)?;
            }
        }
        Ok(())
    }

    pub fn copy_into(&self, paths: &[String], to: &str) -> Result<(), AppError> {
        let dest = resolve(to);
        if !dest.is_dir() {
            return Err(AppError::bad_request(format!("{} 不是目录", dest.display())));
        }
        for p in paths {
            let from = resolve(p);
            self.guard(&from, "复制")?;
            if from.is_dir() && dest.starts_with(&from) {
                return Err(AppError::bad_request("不能把目录复制到它自己里面"));
            }
            let name = from
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            Self::copy_recursive(&from, &Self::unique_target(&dest, &name))?;
        }
        Ok(())
    }

    /// 删除 = 进回收站，不是真的删掉。所以这个接口不会让人后悔。
    pub fn trash_items(&self, paths: &[String]) -> Result<usize, AppError> {
        let mut n = 0;
        for p in paths {
            let from = resolve(p);
            self.guard(&from, "删除")?;
            let meta = std::fs::symlink_metadata(&from)
                .map_err(|e| AppError::bad_request(format!("{} 无法读取：{e}", from.display())))?;
            let name = from
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let size = if meta.is_dir() { Self::dir_size(&from) } else { meta.len() as i64 };
            let kind = if meta.is_dir() { "dir" } else { "file" };

            let id = uuid::Uuid::new_v4().to_string();
            // 先挪文件再记账：反过来的话，挪失败就在回收站里留下一条指向空气的记录。
            self.move_to_trash(&from, &id)?;
            self.db
                .add_trash_item(&id, &name, &from.to_string_lossy(), size, kind)
                .map_err(|e| AppError::internal(e.to_string()))?;
            n += 1;
        }
        Ok(n)
    }

    pub fn trash_list(&self) -> Result<Vec<TrashRow>, AppError> {
        self.db.list_trash().map_err(|e| AppError::internal(e.to_string()))
    }

    /// 恢复。原位置可能已经被别的东西占了，那就按同样的规则改名放回去，
    /// 而不是报错让用户自己处理。
    pub fn trash_restore(&self, ids: &[String]) -> Result<usize, AppError> {
        let mut n = 0;
        for id in ids {
            let Some(row) = self
                .db
                .get_trash_item(id)
                .map_err(|e| AppError::internal(e.to_string()))?
            else {
                continue;
            };
            let src = self.trash.join(id);
            if !src.exists() {
                // 文件没了但索引还在：清掉索引，别让界面上留一条永远恢复不了的记录。
                let _ = self.db.remove_trash_items(&[id.clone()]);
                continue;
            }
            let original = PathBuf::from(&row.original_path);
            let parent = original.parent().unwrap_or(Path::new("/"));
            std::fs::create_dir_all(parent).map_err(|e| AppError::internal(e.to_string()))?;
            let target = Self::unique_target(parent, &row.name);
            if std::fs::rename(&src, &target).is_err() {
                Self::copy_recursive(&src, &target)?;
                Self::remove_recursive(&src)?;
            }
            self.db
                .remove_trash_items(&[id.clone()])
                .map_err(|e| AppError::internal(e.to_string()))?;
            n += 1;
        }
        Ok(n)
    }

    /// 彻底删除。到这一步就没有后悔药了 —— 界面上必须是单独的、说清楚的确认。
    pub fn trash_purge(&self, ids: &[String]) -> Result<usize, AppError> {
        let mut n = 0;
        for id in ids {
            let src = self.trash.join(id);
            if src.exists() {
                Self::remove_recursive(&src)?;
            }
            self.db
                .remove_trash_items(&[id.clone()])
                .map_err(|e| AppError::internal(e.to_string()))?;
            n += 1;
        }
        Ok(n)
    }

    pub fn trash_empty(&self) -> Result<usize, AppError> {
        let ids: Vec<String> = self
            .db
            .list_trash()
            .map_err(|e| AppError::internal(e.to_string()))?
            .into_iter()
            .map(|r| r.id)
            .collect();
        self.trash_purge(&ids)
    }

    pub fn list_stores(&self) -> Result<Vec<crate::infrastructure::db::ObjectStoreRow>, AppError> {
        self.db
            .list_object_stores()
            .map_err(|e| AppError::internal(e.to_string()))
    }

    pub fn save_store(&self, row: &crate::infrastructure::db::ObjectStoreRow) -> Result<(), AppError> {
        self.db
            .insert_object_store(row)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    pub fn delete_store(&self, id: &str) -> Result<(), AppError> {
        let ok = self
            .db
            .delete_object_store(id)
            .map_err(|e| AppError::internal(e.to_string()))?;
        if ok {
            Ok(())
        } else {
            Err(AppError::bad_request("没有这个对象存储"))
        }
    }

    /// 把本机上的一个文件 PUT 到已保存的桶。密钥不出这台机器。
    pub fn upload_store(&self, id: &str, path: &str) -> Result<String, AppError> {
        let store = self
            .db
            .get_object_store(id)
            .map_err(|e| AppError::internal(e.to_string()))?
            .ok_or_else(|| AppError::bad_request("没有这个对象存储"))?;
        let abs = resolve(path);
        let meta = std::fs::metadata(&abs).map_err(|_| AppError::bad_request("文件不存在"))?;
        if !meta.is_file() {
            return Err(AppError::bad_request("只能上传单个文件"));
        }
        const MAX: u64 = 512 * 1024 * 1024;
        if meta.len() > MAX {
            return Err(AppError::bad_request("文件超过 512MB，这一期不传"));
        }
        let bytes = std::fs::read(&abs).map_err(|e| AppError::internal(e.to_string()))?;
        let name = abs
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::bad_request("文件名不合法"))?;
        let prefix = store.prefix.trim().trim_matches('/');
        let key = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        crate::infrastructure::s3::put_object(
            &crate::infrastructure::s3::PutTarget {
                endpoint: store.endpoint,
                region: store.region,
                bucket: store.bucket,
                access_key: store.access_key,
                secret_key: store.secret_key,
                path_style: store.path_style,
                key: key.clone(),
            },
            bytes,
        )
        .map_err(AppError::bad_request)?;
        Ok(key)
    }
}
