import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Loader2,
  MoreVertical,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { toast } from '../../components/ui/sonner';
import { copyText } from '../../lib/clipboard';
import { cn } from '../../lib/utils';
import {
  addLogSource,
  listLogSources,
  logStreamUrl,
  removeLogSource,
  tailCommand,
  tailLog,
  type LogSource,
} from './_api';

/** 一次读末尾多少行，也就是 `tail -n 200 -f` 里的 200。 */
const TAIL_N = 200;
/** 界面上留多少行。再多浏览器就开始卡了。 */
const MAX_LINES = 5000;

type Level = 'error' | 'warn' | 'info' | 'debug' | 'plain';

/**
 * 从一行里判断严重程度 —— 高亮就是为了让 ERROR 自己跳出来。
 *
 * JSON 日志先看 `"status":5xx`：网关/前端日志里那条 500 往往比 `"level":"info"`
 * 更说明问题。判断不出来就当普通行，不要瞎染色 —— 满屏红等于没有红。
 */
function lineLevel(line: string): Level {
  const lower = line.toLowerCase();
  const status = lower.match(/"status"\s*:\s*(\d{3})/);
  if (status) {
    const code = Number(status[1]);
    if (code >= 500) return 'error';
    if (code >= 400) return 'warn';
  }
  if (/(^|[^a-z])(fatal|panic|exception|error|failed|failure|refused)([^a-z]|$)/.test(lower)) {
    return 'error';
  }
  if (/(^|[^a-z])(warn|warning|timeout|deprecated)([^a-z]|$)/.test(lower)) return 'warn';
  if (/(^|[^a-z])(info|notice)([^a-z]|$)/.test(lower)) return 'info';
  if (/(^|[^a-z])(debug|trace)([^a-z]|$)/.test(lower)) return 'debug';
  return 'plain';
}

const LEVEL_ROW: Record<Level, string> = {
  error: 'border-l-destructive bg-destructive/10 text-red-300',
  warn: 'border-l-amber-500 bg-amber-500/10 text-amber-200',
  info: 'border-l-sky-500/70 text-neutral-300',
  debug: 'border-l-border text-neutral-500',
  plain: 'border-l-transparent text-neutral-300',
};

/** 把搜索词在图里标出来；没有搜索词就原样返回。 */
function renderLine(line: string, query: string) {
  const q = query.trim();
  if (!q) return line;
  let re: RegExp;
  try {
    re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  } catch {
    return line;
  }
  return line.split(re).map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="rounded bg-yellow-400/40 px-0.5 text-yellow-100">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export default function LogsPage() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<LogSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPath, setNewPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState<LogSource | null>(null);

  const refresh = useCallback(async () => {
    const res = await listLogSources();
    if (res.success && res.data) setSources(res.data);
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => toast.error(t('logs.load_failed')))
      .finally(() => setLoading(false));
  }, [refresh]);

  const onAdd = async () => {
    if (!newPath.trim()) return;
    setBusy(true);
    try {
      const res = await addLogSource(newPath.trim(), newLabel.trim());
      if (!res.success) throw new Error(res.message || t('logs.add_failed'));
      setAdding(false);
      setNewLabel('');
      setNewPath('');
      await refresh();
      toast.success(t('logs.saved'));
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (source: LogSource) => {
    if (
      !window.confirm(
        t('logs.delete_confirm', { name: source.label || baseName(source.path) }),
      )
    )
      return;
    try {
      const res = await removeLogSource(source.id);
      if (!res.success) throw new Error(res.message || t('logs.delete_failed'));
      await refresh();
      toast.success(t('logs.deleted'));
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const copy = async (text: string) => {
    if (await copyText(text)) toast.success(t('logs.copied'));
    else toast.error(t('mcp.copy_failed'));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('logs.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('logs.subtitle')}</p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          {t('logs.add_source')}
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FileText className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('logs.empty')}</p>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              {t('logs.add_source')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((source) => (
            <div
              key={source.id}
              role="button"
              tabIndex={0}
              onClick={() => setWatching(source)}
              onKeyDown={(e) => e.key === 'Enter' && setWatching(source)}
              className="group cursor-pointer rounded-2xl border border-border/60 p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {source.label || baseName(source.path)}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {source.path}
                  </p>
                </div>
                {/* 删除收在 more 菜单里，卡片本身点开就是看日志 —— 别让误删和
                    "我就想看一眼"共用一个位置。 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('logs.more')}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <MoreVertical className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onClick={() => setWatching(source)}>
                      {t('logs.view')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void copy(tailCommand(source.path))}
                    >
                      {t('logs.copy_cmd')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void copy(source.path)}>
                      {t('logs.copy_path')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => void onRemove(source)}
                    >
                      <Trash2 className="size-3.5" />
                      {t('logs.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p className="mt-3 truncate rounded-lg bg-muted/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                {tailCommand(source.path)}
              </p>
            </div>
          ))}
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('logs.add_source')}</DialogTitle>
            <DialogDescription>{t('logs.add_hint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-path">{t('logs.path')}</Label>
              <Input
                id="log-path"
                value={newPath}
                autoFocus
                onChange={(e) => setNewPath(e.target.value)}
                placeholder={t('logs.path_placeholder')}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-label">{t('logs.name')}</Label>
              <Input
                id="log-label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t('logs.name_placeholder')}
              />
            </div>
            {newPath.trim() && (
              <p className="truncate rounded-lg bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {tailCommand(newPath.trim())}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {t('deploy.cancel')}
            </Button>
            <Button onClick={onAdd} disabled={busy || !newPath.trim()}>
              {t('deploy.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {watching && <LogMonitor source={watching} onClose={() => setWatching(null)} />}
    </div>
  );
}

/**
 * 日志监控弹窗：先进来读末尾 200 行（tail），再接上实时流（-f）。
 *
 * 为什么不是只开 WebSocket：服务端那条流只送"连上之后新追加的行"，光开它屏幕上
 * 是一片空白，得等下一个请求进来才有东西 —— 排障的人第一眼看到空白只会以为坏了。
 */
function LogMonitor({ source, onClose }: { source: LogSource; onClose: () => void }) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [seeded, setSeeded] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;

    const push = (line: string) =>
      setLines((prev) => {
        const next = [...prev, line];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });

    void (async () => {
      try {
        const res = await tailLog(source.path, TAIL_N);
        if (!closed && res.success && res.data) setLines(res.data.lines);
      } catch {
        /* 文件不在、没权限 —— 下面实时流会继续试，界面上给一行提示就够了 */
      } finally {
        if (!closed) setSeeded(true);
      }
      if (closed) return;

      ws = new WebSocket(logStreamUrl([source.id]));
      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { line?: string };
          const line = payload.line;
          if (!line) return;
          if (line.startsWith('[connected] watching:')) return;
          if (pausedRef.current) return;
          push(line);
        } catch {
          /* 不是 JSON 就丢掉 */
        }
      };
    })();

    return () => {
      closed = true;
      ws?.close();
    };
  }, [source.id, source.path]);

  const visible = useMemo(() => {
    let out = lines;
    if (onlyProblems) {
      out = out.filter((l) => {
        const lv = lineLevel(l);
        return lv === 'error' || lv === 'warn';
      });
    }
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((l) => l.toLowerCase().includes(q));
    return out;
  }, [lines, onlyProblems, query]);

  // 只有"本来就贴着底"时才自动跟到底部 —— 用户往上翻是在看历史，不该被拽回去。
  useEffect(() => {
    if (!autoScroll) return;
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  const problems = useMemo(
    () => lines.filter((l) => ['error', 'warn'].includes(lineLevel(l))).length,
    [lines],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  connected ? 'bg-emerald-500' : 'bg-muted-foreground',
                )}
              />
              <p className="truncate text-sm font-medium">
                {source.label || baseName(source.path)}
              </p>
              {problems > 0 && (
                <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                  {t('logs.problems', { n: problems })}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {tailCommand(source.path, TAIL_N)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('logs.close')}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('logs.search_placeholder')}
            className="h-8 w-48 text-xs"
          />
          <Button
            size="sm"
            variant={onlyProblems ? 'default' : 'outline'}
            onClick={() => setOnlyProblems((v) => !v)}
          >
            {t('logs.only_problems')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPaused((v) => !v)}>
            {paused ? <Play /> : <Pause />}
            {paused ? t('logs.resume') : t('logs.pause')}
          </Button>
          <Button
            size="sm"
            variant={autoScroll ? 'default' : 'outline'}
            onClick={() => setAutoScroll((v) => !v)}
          >
            {t('logs.auto_scroll')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLines([])}>
            {t('logs.clear')}
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {t('logs.rows', { visible: visible.length, total: lines.length })}
          </span>
        </div>

        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (atBottom !== autoScroll) setAutoScroll(atBottom);
          }}
          className="flex-1 overflow-auto bg-neutral-950 font-mono text-[11px] leading-[1.6]"
        >
          {!seeded ? (
            <div className="flex items-center gap-2 p-4 text-neutral-400">
              <Loader2 className="size-3.5 animate-spin" />
              {t('logs.reading')}
            </div>
          ) : visible.length === 0 ? (
            <p className="p-4 text-neutral-500">
              {lines.length === 0 ? t('logs.no_content') : t('logs.no_match')}
            </p>
          ) : (
            visible.map((line, i) => {
              const level = lineLevel(line);
              return (
                <div
                  key={i}
                  className={cn('border-l-2 px-3 py-px whitespace-pre-wrap', LEVEL_ROW[level])}
                >
                  {renderLine(line, query)}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
