import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, RefreshCw, Terminal } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { cn } from '../../../lib/utils';
import { fetchGatewayLogs, type GatewayLog } from '../_api';

const POLL_MS = 5000;
const TAIL_CHOICES = [100, 300, 1000, 5000];

/**
 * 给每一行上色。
 *
 * 日志里真正要被一眼看见的只有异常那几行，而它们淹没在 INFO 里。Caddy 两种格式都
 * 认：console 是制表符分隔的 `…\tWARN\t…`，JSON 是 `"level":"warn"`。
 */
function lineClass(line: string): string {
  if (/\t(FATAL|ERROR)\t/.test(line) || /"level":"(fatal|error)"/.test(line)) {
    return 'text-red-400';
  }
  if (/\tWARN\t/.test(line) || /"level":"warn"/.test(line)) {
    return 'text-amber-300';
  }
  return 'text-zinc-300';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 网关日志。
 *
 * 站点挂了（502、证书签不下来、上游连不上）时，答案基本都在 Caddy 自己的输出里，
 * 但以前面板只给状态、不给日志 —— 用户得自己 SSH 上去敲 `docker logs caddy`。
 *
 * 日志默认跟着滚：盯日志的人都是在等它冒出新行。手往下翻看历史时会自动停止跟随，
 * 免得每 5 秒把人的阅读位置顶回底部。
 */
export function GatewayLogDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [log, setLog] = useState<GatewayLog | null>(null);
  const [tail, setTail] = useState(300);
  const [auto, setAuto] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  /** 用户是不是还在看最新的一行。往下翻历史了就别再自动滚。 */
  const followingRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchGatewayLogs(tail);
      setLog(data);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setLog({
        source: '',
        lines: [],
        available: false,
        hint: e instanceof Error ? e.message : t('sites.logs_fail'),
      });
    } finally {
      setLoading(false);
    }
  }, [tail, t]);

  // 打开时取一次；改了行数也要立刻重取，否则要等到下一次轮询才变。
  useEffect(() => {
    if (!open) return;
    followingRef.current = true;
    load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !auto) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [open, auto, load]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el || !followingRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [log]);

  const onScroll = () => {
    const el = panelRef.current;
    if (!el) return;
    followingRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('sites.logs_title')}</DialogTitle>
          <DialogDescription>{t('sites.logs_desc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-xl bg-muted p-0.5">
            {TAIL_CHOICES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setTail(n)}
                className={cn(
                  'rounded-[10px] px-2.5 py-1 font-mono text-xs transition-colors',
                  tail === n
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {n}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAuto((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs transition-colors',
                auto ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  auto ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
              />
              {t('sites.logs_auto')}
            </button>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={cn(loading && 'animate-spin')} />
              {t('sites.logs_refresh')}
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl bg-zinc-950 ring-1 ring-black/40">
          <div className="flex items-center gap-2 border-b border-white/10 px-3.5 py-2">
            <Terminal className="size-3.5 shrink-0 text-zinc-500" />
            <span
              className="truncate font-mono text-[11px] text-zinc-400"
              title={log?.source}
            >
              {log?.source || t('sites.logs_source_unknown')}
            </span>
            {updatedAt && (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-500">
                {t('sites.logs_updated', { time: updatedAt })}
              </span>
            )}
          </div>

          {log && !log.available ? (
            <div className="flex items-start gap-2.5 px-3.5 py-4 text-zinc-300">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
              <div className="space-y-1 text-xs leading-5">
                <p className="font-medium text-amber-300">{t('sites.logs_unavailable')}</p>
                <p className="text-zinc-400">{log.hint}</p>
              </div>
            </div>
          ) : (
            <div
              ref={panelRef}
              onScroll={onScroll}
              className="h-[52vh] overflow-auto py-3 font-mono text-[11px] leading-5"
            >
              {log && log.lines.length > 0 ? (
                <div className="w-max min-w-full">
                  {log.lines.map((line, i) => (
                    <div
                      // 日志行没有稳定 id，行号就是最自然的 key；尾部和行数变化时
                      // React 会重建，代价可以忽略。
                      key={i}
                      className={cn('px-3.5 whitespace-pre-wrap break-all', lineClass(line))}
                    >
                      {line || ' '}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-3.5 text-zinc-500">{t('sites.logs_empty')}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('sites.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
