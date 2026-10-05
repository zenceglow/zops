import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  File as FileIcon,
  FileText,
  Folder,
  HardDrive,
  Home,
  Link2,
  Loader2,
  Copy,
  ClipboardPaste,
  Scissors,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/sonner';
import { cn } from '../../lib/utils';
import {
  copyPaths,
  emptyTrash,
  listDir,
  listTrash,
  movePaths,
  previewFile,
  purgeTrash,
  restoreTrash,
  searchFiles,
  trashPaths,
  type DirListing,
  type FileEntry,
  type FilePreview,
  type TrashItem,
} from './_api';

/**
 * 访达侧栏那种"常用位置"。写死几个运维天天要去的，比让人从 / 开始翻强。
 *
 * 侧栏直接写路径本身，不翻译成"家目录/日志/临时"：这是运维面板，路径就是它的
 * 名字，翻译一遍反而要人在脑子里再对一次。
 */
const FAVORITES = [
  { path: '~', icon: Home },
  { path: '/', icon: HardDrive },
  { path: '/var/log', icon: FileText },
  { path: '/etc/caddy', icon: FileText },
  { path: '/tmp', icon: FileText },
  { path: '/opt', icon: FileText },
];

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

function iconFor(kind: string) {
  if (kind === 'dir') return Folder;
  if (kind === 'symlink') return Link2;
  return FileIcon;
}

/**
 * 文件管理。
 *
 * 照访达的样子来：顶部是"前进/后退/上一级 + 地址栏 + 搜索"，左边常用位置，
 * 右边列表（名称/大小/修改时间/权限）。点文件夹进去，点文件弹预览 —— 也就是
 * 访达里双击和空格键那两件事。
 *
 * 只读。改名、删除、上传这些没做：它们不可逆，得先想清楚确认和回滚长什么样，
 * 不能顺手挂个按钮了事。
 */
export default function FilesPage() {
  const { t } = useTranslation();
  const [path, setPath] = useState(() => localStorage.getItem('zops.files.path') || '~');
  const [address, setAddress] = useState(path);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);

  // 多选与剪贴板。剪贴板只记"哪些路径 + 是复制还是剪切"，真正的动作在粘贴那一刻
  // 发生 —— 这也正是访达的行为：剪切了不粘贴，什么都不会变。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{ paths: string[]; mode: 'copy' | 'cut' } | null>(null);

  const [view, setView] = useState<'browse' | 'trash'>('browse');
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  // 前进/后退栈。用下标而不是两个数组，来回切换时才不会越走越乱。
  const [history, setHistory] = useState<string[]>([path]);
  const [cursor, setCursor] = useState(0);

  const go = useCallback(
    (next: string) => {
      if (!next) return;
      setPath(next);
      setAddress(next);
      setQuery('');
      setResults(null);
      setSelected(new Set());
      setAnchor(null);
      setView('browse');
      setHistory((h) => [...h.slice(0, cursor + 1), next]);
      setCursor((c) => c + 1);
      localStorage.setItem('zops.files.path', next);
    },
    [cursor],
  );

  const back = () => {
    if (cursor === 0) return;
    const next = history[cursor - 1];
    setCursor(cursor - 1);
    setPath(next);
    setAddress(next);
    setQuery('');
    setResults(null);
  };
  const forward = () => {
    if (cursor >= history.length - 1) return;
    const next = history[cursor + 1];
    setCursor(cursor + 1);
    setPath(next);
    setAddress(next);
    setQuery('');
    setResults(null);
  };

  // 列目录。抽成 reload 是因为粘贴/删除之后要立刻重读，不能等用户手动刷新。
  const reload = useCallback(async () => {
    try {
      setListing(await listDir(path));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  // 搜索（输入停顿 300ms 再发，别每敲一个字就递归扫盘）
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults(null);
      return;
    }
    timer.current = window.setTimeout(() => {
      searchFiles(path, query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, path]);

  const rows = results ?? listing?.entries ?? [];
  const parent = listing?.parent ?? null;
  const crumbs = useMemo(() => (path === '~' ? ['~'] : path.split('/').filter(Boolean)), [path]);

  // ── 选择 ──

  /** 按住 Shift 选一段，按住 ⌘/Ctrl 逐个加，普通点击就是单选。 */
  const clickRow = (e: React.MouseEvent, entry: FileEntry) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && anchor) {
        const from = rows.findIndex((r) => r.path === anchor);
        const to = rows.findIndex((r) => r.path === entry.path);
        if (from >= 0 && to >= 0) {
          for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(rows[i].path);
          return next;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        setAnchor(entry.path);
        return next;
      }
      setAnchor(entry.path);
      return new Set([entry.path]);
    });
  };

  /** 双击才算"打开"：单击是选中 —— 这是访达的规矩，也免得手一抖就跳进别的目录。 */
  const openRow = (entry: FileEntry) => {
    if (entry.kind === 'dir') go(entry.path);
    else void previewFile(entry.path).then(setPreview).catch((e) => toast.error(String(e.message)));
  };

  const selectedPaths = useMemo(
    () => rows.filter((r) => selected.has(r.path)).map((r) => r.path),
    [rows, selected],
  );

  // ── 操作 ──

  const runTrash = async () => {
    if (selectedPaths.length === 0) return;
    try {
      await trashPaths(selectedPaths);
      toast.success(t('files.moved_to_trash', { count: selectedPaths.length }));
      setSelected(new Set());
      setAnchor(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const paste = async () => {
    if (!clipboard) return;
    try {
      if (clipboard.mode === 'cut') await movePaths(clipboard.paths, path);
      else await copyPaths(clipboard.paths, path);
      toast.success(
        clipboard.mode === 'cut'
          ? t('files.moved_n', { count: clipboard.paths.length })
          : t('files.copied_n', { count: clipboard.paths.length }),
      );
      // 剪切粘贴之后再粘一次是没有意义的，清掉；复制可以连着粘到多个地方。
      if (clipboard.mode === 'cut') setClipboard(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '粘贴失败');
    }
  };

  const openTrash = async () => {
    setView('trash');
    setSelected(new Set());
    setQuery('');
    setResults(null);
    try {
      setTrash(await listTrash());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取回收站失败');
    }
  };

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={back}
            disabled={cursor === 0}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-30"
          >
            <ArrowLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={forward}
            disabled={cursor >= history.length - 1}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-30"
          >
            <ArrowRight className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => parent && go(parent)}
            disabled={!parent}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-30"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>

        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go(address.trim())}
          spellCheck={false}
          className="h-9 min-w-[220px] flex-1 font-mono text-xs"
          placeholder={t('files.path_placeholder')}
        />

        <div className="relative w-full sm:w-64">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('files.search_placeholder')}
            className="h-9 pr-8 pl-8 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 操作栏：选中了东西才点亮。没选中时按钮是灰的，但位置一直在 ——
          工具的位置老在变，用户就得每次重新找。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {view === 'browse' ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedPaths.length === 0}
              onClick={() => {
                setClipboard({ paths: selectedPaths, mode: 'copy' });
                toast.success(t('files.copied_n', { count: selectedPaths.length }));
              }}
            >
              <Copy />
              {t('files.copy')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedPaths.length === 0}
              onClick={() => {
                setClipboard({ paths: selectedPaths, mode: 'cut' });
                toast.success(t('files.cut_n', { count: selectedPaths.length }));
              }}
            >
              <Scissors />
              {t('files.cut')}
            </Button>
            <Button variant="ghost" size="sm" disabled={!clipboard} onClick={paste}>
              <ClipboardPaste />
              {t('files.paste')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedPaths.length === 0}
              className="text-destructive hover:text-destructive"
              onClick={runTrash}
            >
              <Trash2 />
              {t('files.delete')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={selected.size === 0}
              onClick={async () => {
                try {
                  await restoreTrash([...selected]);
                  toast.success(t('files.restored_n', { count: selected.size }));
                  setSelected(new Set());
                  setTrash(await listTrash());
                  void reload();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : '恢复失败');
                }
              }}
            >
              <Undo2 />
              {t('files.restore')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selected.size === 0}
              className="text-destructive hover:text-destructive"
              onClick={async () => {
                try {
                  await purgeTrash([...selected]);
                  toast.success(t('files.purged_n', { count: selected.size }));
                  setSelected(new Set());
                  setTrash(await listTrash());
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : '删除失败');
                }
              }}
            >
              <Trash2 />
              {t('files.purge')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={trash.length === 0}
              className="ml-auto text-destructive hover:text-destructive"
              onClick={() => setConfirmEmpty(true)}
            >
              {t('files.empty_trash')}
            </Button>
          </>
        )}

        {view === 'browse' && (
          <span className="ml-1 text-xs text-muted-foreground">
            {selectedPaths.length > 0
              ? t('files.selected_n', { count: selectedPaths.length })
              : clipboard
                ? clipboard.mode === 'cut'
                  ? t('files.clip_cut', { count: clipboard.paths.length })
                  : t('files.clip_copy', { count: clipboard.paths.length })
                : ''}
          </span>
        )}
      </div>

      <div className="flex gap-4">
        {/* 常用位置 */}
        <aside className="hidden w-40 shrink-0 space-y-0.5 sm:block">
          {FAVORITES.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => go(f.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                path === f.path
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <f.icon className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">{f.path}</span>
            </button>
          ))}

          <div className="pt-1.5">
            <button
              type="button"
              onClick={() => void openTrash()}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                view === 'trash'
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <Trash2 className="size-3.5 shrink-0" />
              <span className="truncate">{t('files.trash')}</span>
              {trash.length > 0 && (
                <span className="ml-auto rounded-md bg-muted px-1.5 text-[10px]">{trash.length}</span>
              )}
            </button>
          </div>
        </aside>

        {/* 列表 / 回收站 */}
        <div className="min-w-0 flex-1 rounded-2xl border border-border/60">
          <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate font-mono">
              {view === 'trash'
                ? `${t('files.trash')} · ${trash.length}`
                : results
                  ? t('files.search_result', { count: results.length })
                  : crumbs.join(' / ')}
            </span>
            {view === 'trash' ? (
              <>
                <span className="hidden w-40 text-right sm:block">{t('files.col_origin')}</span>
                <span className="hidden w-20 text-right sm:block">{t('files.col_size')}</span>
                <span className="w-32 text-right">{t('files.col_deleted')}</span>
              </>
            ) : (
              <>
                <span className="hidden w-20 text-right sm:block">{t('files.col_size')}</span>
                <span className="hidden w-32 text-right sm:block">{t('files.col_modified')}</span>
                <span className="hidden w-24 text-right md:block">{t('files.col_mode')}</span>
              </>
            )}
          </div>

          {view === 'trash' ? (
            <div className="max-h-[62vh] overflow-y-auto py-1">
              {trash.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.trash_empty')}</p>
              ) : (
                trash.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.metaKey || e.ctrlKey) {
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                        } else {
                          return new Set([item.id]);
                        }
                        return next;
                      });
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors',
                      selected.has(item.id) ? 'bg-primary/15' : 'hover:bg-muted/50',
                    )}
                  >
                    {(() => {
                      const Icon = iconFor(item.kind);
                      return <Icon className="size-4 shrink-0 text-muted-foreground" />;
                    })()}
                    <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                    <span className="hidden w-40 shrink-0 truncate text-right font-mono text-xs text-muted-foreground sm:block">
                      {item.original_path}
                    </span>
                    <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                      {item.kind === 'dir' ? '—' : human(item.size)}
                    </span>
                    <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
                      {item.deleted_at}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : loading ? (
            <div className="space-y-1 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full rounded-lg" />
              ))}
            </div>
          ) : error ? (
            <p className="px-4 py-10 text-center text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {results ? t('files.search_empty') : t('files.empty')}
            </p>
          ) : (
            <div className="max-h-[62vh] overflow-y-auto py-1">
              {rows.map((e) => {
                const Icon = iconFor(e.kind);
                const isSelected = selected.has(e.path);
                return (
                  <button
                    key={e.path}
                    type="button"
                    onClick={(ev) => clickRow(ev, e)}
                    onDoubleClick={() => openRow(e)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors',
                      isSelected ? 'bg-primary/15' : 'hover:bg-muted/50',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4 shrink-0',
                        e.kind === 'dir' ? 'text-sky-500' : 'text-muted-foreground',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {results ? <span className="font-mono text-xs">{e.rel}</span> : e.name}
                    </span>
                    <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                      {e.kind === 'dir' ? '—' : human(e.size)}
                    </span>
                    <span className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground sm:block">
                      {e.modified}
                    </span>
                    <span className="hidden w-24 shrink-0 text-right font-mono text-xs text-muted-foreground/80 md:block">
                      {e.mode}
                    </span>
                  </button>
                );
              })}
              {results === null && listing?.truncated && (
                <p className="px-4 py-2 text-center text-xs text-muted-foreground">{t('files.truncated')}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 清空回收站：这是唯一一个没有后悔药的动作，所以单独确认。 */}
      <Dialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.empty_confirm_title')}</DialogTitle>
            <DialogDescription>{t('files.empty_confirm_desc', { count: trash.length })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmEmpty(false)}>
              {t('sites.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await emptyTrash();
                  setTrash([]);
                  setSelected(new Set());
                  setConfirmEmpty(false);
                  toast.success(t('files.trash_emptied'));
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : '清空失败');
                }
              }}
            >
              {t('files.empty_trash')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 文件预览（访达的空格键那一下） */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{preview?.path}</DialogTitle>
            <DialogDescription>
              {preview && `${human(preview.size)}${preview.truncated ? ` · ${t('files.preview_truncated')}` : ''}`}
            </DialogDescription>
          </DialogHeader>
          {preview?.binary ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('files.preview_binary')}</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-xl border border-border/60 bg-muted/20 p-3 font-mono text-xs leading-relaxed">
              {preview?.content || ''}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
