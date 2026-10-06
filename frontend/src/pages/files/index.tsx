import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Activity,
  Check,
  ClipboardCopy,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Link2,
  ListChecks,
  Copy,
  ClipboardPaste,
  CloudUpload,
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
import { Label } from '../../components/ui/label';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/sonner';
import { cn } from '../../lib/utils';
import { copyText } from '../../lib/clipboard';
import { RowMenu, type RowAction } from './_components/row-menu';
import { ObjectStorageDialog, UploadStoreDialog } from './_components/object-storage-dialog';
import { addLogSource } from '../logs/_api';
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

/** 等着二次确认的那个动作。删除类操作没有后悔药（或只有一层），一律先问。 */
type Pending =
  | { kind: 'trash'; paths: string[] }
  | { kind: 'purge'; ids: string[] }
  | { kind: 'empty' };

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

/** 选择模式里的复选框。只是显示，真正的点击处理在整行上。 */
function SelectBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}

/**
 * 文件管理。
 *
 * 照访达的样子来：顶部是"前进/后退/上一级 + 地址栏 + 搜索"，左边常用位置，
 * 右边列表（名称/大小/修改时间/权限）。点文件夹进去，点文件弹预览 —— 也就是
 * 访达里双击和空格键那两件事。
 *
 * 操作分两档，别再混在一起：
 * - **单个**：行尾的「⋯」下拉菜单。常驻一排按钮会把每行都弄得很吵，也让人看不出
 *   自己点的是哪一行。
 * - **批量**：先按「选择」进选择模式，才出现多选和批量按钮。这样不会出现"以为在
 *   浏览，结果顺手删了一片"。
 * 删除一律先二次确认：进回收站还能捞回来，彻底删除和清空回收站真的回不来。
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
  /** 选择模式。批量按钮只在这个模式下出现，见文件头的说明。 */
  const [selectMode, setSelectMode] = useState(false);

  const [view, setView] = useState<'browse' | 'trash'>('browse');
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  /** 点了「创建日志监控」的那个文件。 */
  const [logTarget, setLogTarget] = useState<FileEntry | null>(null);
  const [logName, setLogName] = useState('');
  const [logBusy, setLogBusy] = useState(false);
  const [storesOpen, setStoresOpen] = useState(false);
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  const navigate = useNavigate();

  // 前进/后退栈。用下标而不是两个数组，来回切换时才不会越走越乱。
  const [history, setHistory] = useState<string[]>([path]);
  const [cursor, setCursor] = useState(0);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);

  const go = useCallback(
    (next: string) => {
      if (!next) return;
      setPath(next);
      setAddress(next);
      setQuery('');
      setResults(null);
      setSelected(new Set());
      setAnchor(null);
      setSelectMode(false);
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

  // Esc 退出选择模式。选中一片之后想"算了"是很自然的动作，不该逼人去找按钮。
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode, exitSelect]);

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
      // 选择模式里点一下就是勾上/取消；普通模式里点一下是"选中这一个"。
      if (selectMode || e.metaKey || e.ctrlKey) {
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        setAnchor(entry.path);
        return next;
      }
      setAnchor(entry.path);
      return new Set([entry.path]);
    });
  };

  const clickTrashRow = (e: React.MouseEvent, item: TrashItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (selectMode || e.metaKey || e.ctrlKey) {
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      }
      return new Set([item.id]);
    });
  };

  /** 双击才算"打开"：单击是选中 —— 这是访达的规矩，也免得手一抖就跳进别的目录。 */
  const openRow = (entry: FileEntry) => {
    if (selectMode) return;
    if (entry.kind === 'dir') go(entry.path);
    else void previewFile(entry.path).then(setPreview).catch((e) => toast.error(String(e.message)));
  };

  const selectedPaths = useMemo(
    () => rows.filter((r) => selected.has(r.path)).map((r) => r.path),
    [rows, selected],
  );
  const selectedIds = useMemo(
    () => trash.filter((item) => selected.has(item.id)).map((item) => item.id),
    [trash, selected],
  );
  const selectedCount = view === 'trash' ? selectedIds.length : selectedPaths.length;
  const allSelected =
    view === 'trash'
      ? trash.length > 0 && selectedIds.length === trash.length
      : rows.length > 0 && selectedPaths.length === rows.length;

  // ── 操作 ──

  const copyToClipboard = (paths: string[]) => {
    if (paths.length === 0) return;
    setClipboard({ paths, mode: 'copy' });
    toast.success(t('files.copied_n', { count: paths.length }));
  };

  const cutToClipboard = (paths: string[]) => {
    if (paths.length === 0) return;
    setClipboard({ paths, mode: 'cut' });
    toast.success(t('files.cut_n', { count: paths.length }));
  };

  /** 复制单个文件的绝对路径 —— 贴进终端或配置里都用得上。 */
  const copyOnePath = async (target: string) => {
    if (await copyText(target)) toast.success(t('files.path_copied'));
    else toast.error(t('files.copy_failed'));
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
      toast.error(e instanceof Error ? e.message : t('files.paste_failed'));
    }
  };

  const openTrash = async () => {
    setView('trash');
    setSelectMode(false);
    setSelected(new Set());
    setAnchor(null);
    setQuery('');
    setResults(null);
    try {
      setTrash(await listTrash());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('files.trash_failed'));
    }
  };

  const restore = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await restoreTrash(ids);
      toast.success(t('files.restored_n', { count: ids.length }));
      setSelected(new Set());
      setTrash(await listTrash());
      void reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('files.restore_failed'));
    }
  };

  /**
   * 执行那个等确认的动作。
   *
   * 所有"删"都从这里出去：确认框、toast、刷新只写一遍，也就不会出现某个入口
   * 忘了确认这种漏网之鱼。
   */
  const runPending = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'trash') {
        await trashPaths(pending.paths);
        toast.success(t('files.moved_to_trash', { count: pending.paths.length }));
        setSelected(new Set());
        setAnchor(null);
        await reload();
      } else if (pending.kind === 'purge') {
        await purgeTrash(pending.ids);
        toast.success(t('files.purged_n', { count: pending.ids.length }));
        setSelected(new Set());
        setTrash(await listTrash());
      } else {
        await emptyTrash();
        setTrash([]);
        setSelected(new Set());
        toast.success(t('files.trash_emptied'));
      }
      setPending(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('files.action_failed'));
    }
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(
      view === 'trash'
        ? new Set(trash.map((item) => item.id))
        : new Set(rows.map((r) => r.path)),
    );
  };

  /** 把当前这个文件登记成日志卡片，建完直接把人领到日志页。 */
  const createLogMonitor = async () => {
    if (!logTarget) return;
    setLogBusy(true);
    try {
      const res = await addLogSource(logTarget.path, logName.trim());
      if (!res.success) throw new Error(res.message || t('logs.add_failed'));
      setLogTarget(null);
      toast.success(t('logs.create_monitor_done'), {
        action: { label: t('logs.view_logs'), onClick: () => navigate('/logs') },
      });
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setLogBusy(false);
    }
  };

  /** 一行能做什么。菜单和批量按钮共用同一份定义，不会两边对不上。 */
  const entryActions = (entry: FileEntry): RowAction[] => [
    {
      label: t('files.open'),
      icon: entry.kind === 'dir' ? FolderOpen : FileText,
      onSelect: () => openRow(entry),
    },
    // 文件多给一条捷径：不用再跑到日志页手动敲一遍路径。
    ...(entry.kind !== 'dir' && canMonitor(entry.name)
      ? [
          {
            label: t('logs.create_monitor'),
            icon: Activity,
            onSelect: () => {
              setLogName(suggestLogName(entry));
              setLogTarget(entry);
            },
          },
        ]
      : []),
    ...(entry.kind !== 'dir'
      ? [
          {
            label: t('files.upload_object'),
            icon: CloudUpload,
            onSelect: () => setUploadPath(entry.path),
          },
        ]
      : []),
    { label: t('files.copy_path'), icon: ClipboardCopy, separated: true, onSelect: () => void copyOnePath(entry.path) },
    { label: t('files.copy'), icon: Copy, onSelect: () => copyToClipboard([entry.path]) },
    { label: t('files.cut'), icon: Scissors, onSelect: () => cutToClipboard([entry.path]) },
    {
      label: t('files.delete'),
      icon: Trash2,
      variant: 'destructive',
      separated: true,
      onSelect: () => setPending({ kind: 'trash', paths: [entry.path] }),
    },
  ];

  const trashActions = (item: TrashItem): RowAction[] => [
    { label: t('files.restore'), icon: Undo2, onSelect: () => void restore([item.id]) },
    {
      label: t('files.purge'),
      icon: Trash2,
      variant: 'destructive',
      separated: true,
      onSelect: () => setPending({ kind: 'purge', ids: [item.id] }),
    },
  ];

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

      {/* 操作栏。批量按钮只在选择模式里出现 —— 没进选择模式时这一栏只剩"粘贴"
          和"选择"，位置固定，不会因为选中了东西就突然长出一排能删文件的按钮。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {view === 'browse' ? (
          selectMode ? (
            <>
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                <ListChecks />
                {allSelected ? t('files.select_none') : t('files.select_all')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={selectedPaths.length === 0}
                onClick={() => copyToClipboard(selectedPaths)}
              >
                <Copy />
                {t('files.copy')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={selectedPaths.length === 0}
                onClick={() => cutToClipboard(selectedPaths)}
              >
                <Scissors />
                {t('files.cut')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={selectedPaths.length === 0}
                className="text-destructive hover:text-destructive"
                onClick={() => setPending({ kind: 'trash', paths: selectedPaths })}
              >
                <Trash2 />
                {t('files.delete')}
              </Button>
              <span className="ml-1 text-xs text-muted-foreground">
                {t('files.selected_n', { count: selectedCount })}
              </span>
              <Button size="sm" variant="secondary" className="ml-auto" onClick={exitSelect}>
                {t('files.select_done')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" disabled={!clipboard} onClick={paste}>
                <ClipboardPaste />
                {t('files.paste')}
              </Button>
              <span className="ml-1 text-xs text-muted-foreground">
                {clipboard
                  ? clipboard.mode === 'cut'
                    ? t('files.clip_cut', { count: clipboard.paths.length })
                    : t('files.clip_copy', { count: clipboard.paths.length })
                  : t('files.hint_row_menu')}
              </span>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setStoresOpen(true)}>
                  <CloudUpload />
                  {t('files.object_storage')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectMode(true);
                    setSelected(new Set());
                    setAnchor(null);
                  }}
                >
                  <ListChecks />
                  {t('files.select')}
                </Button>
              </div>
            </>
          )
        ) : selectMode ? (
          <>
            <Button variant="ghost" size="sm" onClick={toggleAll}>
              <ListChecks />
              {allSelected ? t('files.select_none') : t('files.select_all')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedIds.length === 0}
              onClick={() => void restore(selectedIds)}
            >
              <Undo2 />
              {t('files.restore')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedIds.length === 0}
              className="text-destructive hover:text-destructive"
              onClick={() => setPending({ kind: 'purge', ids: selectedIds })}
            >
              <Trash2 />
              {t('files.purge')}
            </Button>
            <span className="ml-1 text-xs text-muted-foreground">
              {t('files.selected_n', { count: selectedCount })}
            </span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={exitSelect}>
              {t('files.select_done')}
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">{t('files.hint_row_menu')}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={trash.length === 0}
              className="ml-auto text-destructive hover:text-destructive"
              onClick={() => setPending({ kind: 'empty' })}
            >
              {t('files.empty_trash')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={trash.length === 0}
              onClick={() => setSelectMode(true)}
            >
              <ListChecks />
              {t('files.select')}
            </Button>
          </>
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
            {/* 给行尾的「⋯」留出固定宽度，否则鼠标移上去整行会跳一下。 */}
            {!selectMode && <span className="w-7 shrink-0" />}
          </div>

          {view === 'trash' ? (
            <div className="max-h-[62vh] overflow-y-auto py-1">
              {trash.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.trash_empty')}</p>
              ) : (
                trash.map((item) => {
                  const Icon = iconFor(item.kind);
                  const isSelected = selected.has(item.id);
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => clickTrashRow(e, item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void restore([item.id]);
                        }
                      }}
                      className={cn(
                        'flex w-full cursor-default items-center gap-2 px-3.5 py-1.5 text-left transition-colors',
                        isSelected ? 'bg-primary/15' : 'hover:bg-muted/50',
                      )}
                    >
                      {selectMode && <SelectBox checked={isSelected} />}
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
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
                      {!selectMode && (
                        <RowMenu actions={trashActions(item)} label={t('files.more_actions')} />
                      )}
                    </div>
                  );
                })
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
                  <div
                    key={e.path}
                    role="button"
                    tabIndex={0}
                    onClick={(ev) => clickRow(ev, e)}
                    onDoubleClick={() => openRow(e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') openRow(e);
                      // 空格在访达里是"预览"，这里也留给预览；要勾选就用回车之外
                      // 的方式 —— 选择模式下点行本身就是勾选。
                    }}
                    className={cn(
                      'flex w-full cursor-default items-center gap-2 px-3.5 py-1.5 text-left transition-colors',
                      isSelected ? 'bg-primary/15' : 'hover:bg-muted/50',
                    )}
                  >
                    {selectMode && <SelectBox checked={isSelected} />}
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
                    {!selectMode && (
                      <RowMenu actions={entryActions(e)} label={t('files.more_actions')} />
                    )}
                  </div>
                );
              })}
              {results === null && listing?.truncated && (
                <p className="px-4 py-2 text-center text-xs text-muted-foreground">{t('files.truncated')}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 一个确认框管所有删除动作：进回收站还能捞回来，彻底删除和清空回收站真的
          回不来 —— 文案分开写，别让"删"和"永久删"看起来一样。 */}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === 'trash'
                ? t('files.trash_confirm_title')
                : pending?.kind === 'purge'
                  ? t('files.purge_confirm_title')
                  : t('files.empty_confirm_title')}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'trash'
                ? t('files.trash_confirm_desc', { count: pending.paths.length })
                : pending?.kind === 'purge'
                  ? t('files.purge_confirm_desc', { count: pending.ids.length })
                  : t('files.empty_confirm_desc', { count: trash.length })}
            </DialogDescription>
            {pending?.kind === 'trash' && pending.paths.length === 1 && (
              <p className="truncate font-mono text-xs text-muted-foreground" title={pending.paths[0]}>
                {pending.paths[0]}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t('sites.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runPending()}
            >
              {pending?.kind === 'trash'
                ? t('files.delete')
                : pending?.kind === 'purge'
                  ? t('files.purge')
                  : t('files.empty_trash')}
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
            <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-all rounded-xl border border-border/60 bg-muted/20 p-3 font-mono text-xs leading-relaxed">
              {preview?.content || ''}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      <ObjectStorageDialog open={storesOpen} onOpenChange={setStoresOpen} />
      <UploadStoreDialog
        open={uploadPath !== null}
        path={uploadPath ?? ''}
        onOpenChange={(o) => !o && setUploadPath(null)}
        onNeedSetup={() => setStoresOpen(true)}
      />

      {/* 从文件直接建一张日志卡片。路径已经在手上，别再让人跑过去敲一遍。 */}
      <Dialog open={!!logTarget} onOpenChange={(o) => !o && setLogTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('logs.create_monitor')}</DialogTitle>
            <DialogDescription>{t('logs.create_monitor_desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('logs.path')}</Label>
              <p className="truncate rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-xs">
                {logTarget?.path}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-card-name">{t('logs.name')}</Label>
              <Input
                id="log-card-name"
                value={logName}
                autoFocus
                onChange={(e) => setLogName(e.target.value)}
                placeholder={t('logs.name_placeholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLogTarget(null)}>
              {t('deploy.cancel')}
            </Button>
            <Button onClick={createLogMonitor} disabled={logBusy}>
              {logBusy ? t('logs.creating') : t('logs.create_monitor')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 文件名 → 卡片名：`front-server.json.log` → `front-server`，`access.txt` → `access`。 */
function suggestLogName(entry: FileEntry): string {
  const base = entry.name
    .replace(/\.log(\.\d+)?$/i, '')
    .replace(/\.(json|txt|out|err|ndjson|jsonl|text)$/i, '');
  return base || entry.name;
}

/**
 * 明显是二进制的才藏起"创建日志监控"，其余都给。
 *
 * 之前只认 `*.log`，于是 `.txt`、`.json`、`.out`、没有扩展名的都被挡了 ——
 * 靠"猜这是不是日志"来决定给不给入口，只会一直有人问"txt 为什么没有"。
 * 反过来按黑名单排掉明显看不了的（图片、压缩包、字体、可执行文件），
 * 一条 `tail` 能看的东西就都留着了。
 */
const NOT_LOGGABLE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'heic',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'pkg', 'deb',
  'rpm', 'apk', 'jar', 'war',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'so', 'dll', 'dylib', 'exe', 'bin', 'class', 'wasm', 'o', 'a',
  'db', 'sqlite', 'sqlite3', 'mdb', 'dat',
]);

function canMonitor(name: string): boolean {
  const dot = name.lastIndexOf('.');
  // 没有扩展名的（Dockerfile、Makefile、bin/server…）一律允许。
  if (dot <= 0) return true;
  return !NOT_LOGGABLE.has(name.slice(dot + 1).toLowerCase());
}
