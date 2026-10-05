import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, HardDrive, Layers, Network, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../components/ui/dialog';
import { cn } from '../../../lib/utils';
import { fetchJunk, pruneJunk, type JunkSummary } from '../../docker/containers/_api';

type Choice = 'images' | 'containers' | 'networks';
type Phase = 'scan' | 'review' | 'confirm' | 'running' | 'done';

const OPTIONS: { key: Choice; icon: typeof Layers; labelKey: string }[] = [
  { key: 'images', icon: Layers, labelKey: 'junk_images' },
  { key: 'containers', icon: HardDrive, labelKey: 'junk_containers' },
  { key: 'networks', icon: Network, labelKey: 'junk_networks' },
];

/** 扫描至少演这么久：接口在本机几十毫秒就回来了，动画一闪而过反而像没做检查。 */
const MIN_SCAN_MS = 1100;

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

/**
 * 垃圾清理。
 *
 * 四步走：扫描 → 复核 → **二次确认** → 执行。中间那步确认不是为了多点一下鼠标，
 * 是因为这个动作删掉的东西没有回收站；把"要删几项、放多少空间"写在按钮旁边，
 * 人才是在知情的情况下按下去的。
 *
 * 清什么由用户勾。卷完全不在这份清单里 —— 卷里是数据，"没在使用"和"可以删"是
 * 两回事。
 */
export function CleanupDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('scan');
  const [junk, setJunk] = useState<JunkSummary | null>(null);
  const [picked, setPicked] = useState<Record<Choice, boolean>>({
    images: true,
    containers: true,
    networks: false,
  });
  const [freed, setFreed] = useState({ bytes: 0, count: 0 });
  const [error, setError] = useState('');

  // 每次打开都重新扫：上次的数字早就过期了。
  const scan = useCallback(() => {
    setPhase('scan');
    setError('');
    const startedAt = Date.now();
    fetchJunk()
      .then((data) => {
        setJunk(data);
        // 扫描结果里没有可清项的类别，默认不勾 —— 勾一个 0 项的没意义。
        setPicked((p) => ({
          images: p.images && data.images.count > 0,
          containers: p.containers && data.containers.count > 0,
          networks: data.networks.count > 0,
        }));
      })
      .catch(() => setError(t('cleanup.scan_fail')))
      .finally(() => {
        const wait = Math.max(0, MIN_SCAN_MS - (Date.now() - startedAt));
        setTimeout(() => setPhase('review'), wait);
      });
  }, [t]);

  useEffect(() => {
    if (open) scan();
  }, [open, scan]);

  const chosen = OPTIONS.filter((o) => picked[o.key]);
  const chosenCount = junk
    ? chosen.reduce((sum, o) => sum + (junk[o.key]?.count ?? 0), 0)
    : 0;
  const chosenBytes = junk ? chosen.reduce((sum, o) => sum + (junk[o.key]?.bytes ?? 0), 0) : 0;

  const run = async () => {
    setPhase('running');
    try {
      const r = await pruneJunk(picked);
      setFreed({ bytes: r.bytes, count: r.images + r.containers + r.networks });
    } catch (e) {
      setError(`${t('cleanup.fail')}: ${e instanceof Error ? e.message : ''}`);
    } finally {
      // 清理很快，让它至少转一会儿，否则和"没反应"分不出来。
      setTimeout(() => setPhase('done'), 900);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
          {t('home.cleanup')}
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl" showCloseButton={phase !== 'running'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-lg">
            <span className="relative flex size-9 items-center justify-center overflow-hidden rounded-xl bg-muted">
              <Trash2 className="size-4" />
              {(phase === 'scan' || phase === 'running') && (
                <span
                  aria-hidden
                  className="scan-sweep absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-foreground/25 to-transparent"
                />
              )}
            </span>
            {phase === 'done' ? t('cleanup.done_title') : t('cleanup.title')}
          </DialogTitle>
          <DialogDescription>
            {phase === 'scan'
              ? t('cleanup.scanning')
              : phase === 'running'
                ? t('cleanup.running')
                : phase === 'done'
                  ? t('cleanup.done_desc')
                  : phase === 'confirm'
                    ? t('cleanup.confirm_desc')
                    : t('cleanup.desc')}
          </DialogDescription>
        </DialogHeader>

        {/* 扫描：先用骨架占住高度，扫完再换成真数据，弹窗不会跳。 */}
        {phase === 'scan' && (
          <div className="space-y-2 py-1">
            {OPTIONS.map((o, i) => (
              <div
                key={o.key}
                className="relative h-[58px] overflow-hidden rounded-xl border border-border/60"
                style={{ opacity: 1 - i * 0.25 }}
              >
                <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
              </div>
            ))}
          </div>
        )}

        {(phase === 'review' || phase === 'confirm') && junk && (
          <div className="space-y-2 py-1">
            {OPTIONS.map(({ key, icon: Icon, labelKey }) => {
              const item = junk[key];
              const empty = item.count === 0;
              const active = picked[key];
              return (
                <button
                  key={key}
                  type="button"
                  disabled={empty || phase === 'confirm'}
                  onClick={() => setPicked((p) => ({ ...p, [key]: !p[key] }))}
                  className={cn(
                    'flex w-full items-center gap-3.5 rounded-xl border px-4 py-3 text-left transition-colors',
                    empty
                      ? 'border-border/40 opacity-45'
                      : active
                        ? 'border-foreground/25 bg-muted/40'
                        : 'border-border/60 hover:border-border',
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{t(`cleanup.${labelKey}`)}</span>
                  <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                    {item.count} {t('cleanup.items')}
                  </span>
                  <span
                    className={cn(
                      'w-20 shrink-0 text-right tabular-nums text-sm',
                      empty && 'text-muted-foreground/60',
                    )}
                  >
                    {empty ? '—' : human(item.bytes)}
                  </span>
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                      active && !empty
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border',
                    )}
                  >
                    {active && !empty && <Check className="size-3.5" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {phase === 'confirm' && (
          <div className="pop-in flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm">
              <p className="font-medium text-amber-700 dark:text-amber-300">
                {t('cleanup.confirm_title')}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t('cleanup.confirm_body', { count: chosenCount, size: human(chosenBytes) })}
              </p>
            </div>
          </div>
        )}

        {phase === 'running' && (
          <div className="py-6">
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              <span className="bar-slide absolute inset-y-0 w-1/3 rounded-full bg-foreground" />
            </div>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              {t('cleanup.running_hint')}
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div className="pop-in flex flex-col items-center gap-2 py-6">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
              <Check className="size-7" />
            </span>
            {freed.count > 0 ? (
              <>
                <p className="text-2xl font-semibold tabular-nums">{human(freed.bytes)}</p>
                <p className="text-sm text-muted-foreground">
                  {t('cleanup.done_body', { count: freed.count })}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('cleanup.nothing')}</p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3 pt-1">
          <p className="mr-auto text-xs text-muted-foreground">{t('cleanup.volume_note')}</p>

          {phase === 'review' && (
            <Button onClick={() => setPhase('confirm')} disabled={chosenCount === 0 || !!error}>
              <Trash2 />
              {t('cleanup.run')}
            </Button>
          )}
          {phase === 'confirm' && (
            <>
              <Button variant="secondary" onClick={() => setPhase('review')}>
                {t('cleanup.back')}
              </Button>
              <Button variant="destructive" onClick={run}>
                {t('cleanup.confirm_yes')}
              </Button>
            </>
          )}
          {phase === 'done' && <Button onClick={() => setOpen(false)}>{t('cleanup.close')}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
