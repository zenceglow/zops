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
  Search,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Skeleton } from '../../components/ui/skeleton';
import { cn } from '../../lib/utils';
import { listDir, previewFile, searchFiles, type DirListing, type FileEntry, type FilePreview } from './_api';

/** 访达侧栏那种"常用位置"。写死几个运维天天要去的，比让人从 / 开始翻强。 */
const FAVORITES = [
  { label: '家目录', path: '~', icon: Home },
  { label: '根目录', path: '/', icon: HardDrive },
  { label: '日志', path: '/var/log', icon: FileText },
  { label: 'Caddy', path: '/etc/caddy', icon: FileText },
  { label: '临时', path: '/tmp', icon: FileText },
  { label: '应用', path: '/opt', icon: FileText },
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

  // 列目录
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    listDir(path)
      .then((d) => alive && setListing(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path]);

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
              <span className="truncate">{f.label}</span>
            </button>
          ))}
        </aside>

        {/* 列表 */}
        <div className="min-w-0 flex-1 rounded-2xl border border-border/60">
          <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate font-mono">
              {results ? t('files.search_result', { count: results.length }) : crumbs.join(' / ')}
            </span>
            <span className="hidden w-20 text-right sm:block">{t('files.col_size')}</span>
            <span className="hidden w-32 text-right sm:block">{t('files.col_modified')}</span>
            <span className="hidden w-24 text-right md:block">{t('files.col_mode')}</span>
          </div>

          {loading ? (
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
                return (
                  <button
                    key={e.path}
                    type="button"
                    onClick={() => (e.kind === 'dir' ? go(e.path) : void previewFile(e.path).then(setPreview))}
                    className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors hover:bg-muted/50"
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
