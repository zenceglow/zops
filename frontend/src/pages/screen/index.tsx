import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Gauge, MapPin, RefreshCw, Users } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { RollingNumber } from '../../components/rolling-number';
import { cn } from '../../lib/utils';
import {
  fetchEvents,
  fetchOverview,
  refreshNow,
  type AccessEvent,
  type AnalyticsOverview,
  type HourPoint,
} from './_api';

/** 日志轮询间隔。访问量不大，3 秒足够"看着像实时"，也不会把 SQLite 压出压力。 */
const EVENT_POLL_MS = 3000;
/** 大屏上保留多少条。再多就没人看了，滚动还费劲。 */
const MAX_ROWS = 60;
/** 概览比日志慢得多地刷新：数字跳太频反而看不出趋势。 */
const OVERVIEW_EVERY = 5;

const RANGES = [24, 168, 720] as const;

/**
 * 把"每小时"的点折成固定 24 根柱子。
 *
 * 后端只返回**有记录**的小时，缺口得在这儿补 —— 否则夜里没人访问的那几个小时
 * 会直接消失，看起来像时间被压缩了。
 */
function toBars(points: HourPoint[], hours: number): number[] {
  const per = Math.max(1, Math.ceil(hours / 24));
  const bars = Array.from({ length: 24 }, () => 0);
  const now = Date.now();
  for (const p of points) {
    const [date, hour] = p.hour.split(' ');
    const [y, m, d] = date.split('-').map(Number);
    const at = new Date(y, m - 1, d, Number(hour)).getTime();
    const agoHours = Math.floor((now - at) / 3_600_000);
    if (agoHours < 0) continue;
    const idx = 23 - Math.floor(agoHours / per);
    if (idx >= 0 && idx < 24) bars[idx] += p.count;
  }
  return bars;
}

function statusTone(status: number): string {
  if (status >= 500) return 'text-red-400';
  if (status >= 400) return 'text-amber-400';
  if (status >= 300) return 'text-sky-400';
  if (status >= 200) return 'text-emerald-400';
  return 'text-muted-foreground';
}

function Stat({
  icon: Icon,
  label,
  value,
  decimals,
  suffix,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
  decimals?: number;
  suffix?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <RollingNumber value={value} decimals={decimals} className="text-3xl tracking-tight" />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

/** 横条排行。数字本身没意义，比出来的长短才有。 */
function Ranked({ title, rows }: { title: string; rows: { key: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="rounded-2xl border border-border/60 p-4">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-3 space-y-2">
        {rows.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2.5">
            <span className="w-40 shrink-0 truncate text-xs" title={r.key}>
              {r.key}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-foreground/70"
                style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
              />
            </span>
            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {r.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 数据大屏。
 *
 * 数据来自 Caddy 的访问日志：后台每 15 秒采一次增量进 SQLite，这一页只读库。
 * 日志列表按 id 游标增量取，新记录插在**最上面** —— 大屏是给人瞄一眼的，
 * 让人为了看最新一条去滚到底部没有道理。
 */
export default function ScreenPage() {
  const { t } = useTranslation();
  const [hours, setHours] = useState<number>(24);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 游标放 ref：轮询回调里要读最新值，放进 state 会让 effect 反复重启。 */
  const cursor = useRef(0);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await fetchOverview(hours));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hours]);

  /** 首次铺满列表；之后只追加新到的。 */
  const loadEvents = useCallback(async (seed: boolean) => {
    try {
      const page = await fetchEvents(seed ? 0 : cursor.current, 40);
      cursor.current = page.cursor;
      if (page.events.length === 0) return;
      // 后端按旧→新返回，翻过来让最新的落在最上面。
      const newestFirst = [...page.events].reverse();
      setEvents((prev) => (seed ? newestFirst : [...newestFirst, ...prev]).slice(0, MAX_ROWS));
    } catch {
      // 轮询失败不打扰用户：下一次大概率就好了，弹 toast 只会刷屏。
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadEvents(true);
  }, [loadOverview, loadEvents]);

  useEffect(() => {
    let tick = 0;
    const id = setInterval(() => {
      void loadEvents(false);
      if (++tick % OVERVIEW_EVERY === 0) void loadOverview();
    }, EVENT_POLL_MS);
    return () => clearInterval(id);
  }, [loadEvents, loadOverview]);

  const manualRefresh = async () => {
    setBusy(true);
    try {
      // 先催一次采集，再读 —— 不然"刷新"只是把同一份旧数据再读一遍。
      await refreshNow();
      await Promise.all([loadOverview(), loadEvents(true)]);
    } finally {
      setBusy(false);
    }
  };

  const bars = overview ? toBars(overview.hourly, hours) : [];
  const barMax = Math.max(1, ...bars);
  const cityCount = overview?.locations.filter((l) => l.key !== '内网' && l.key !== '本机').length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t('screen.title')}</h1>
        <div className="flex items-center gap-0.5 rounded-xl bg-muted p-0.5">
          {RANGES.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHours(h)}
              className={cn(
                'rounded-[10px] px-2.5 py-1 text-xs transition-colors',
                hours === h
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {h === 24 ? t('screen.range_24h') : h === 168 ? t('screen.range_7d') : t('screen.range_30d')}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={manualRefresh} disabled={busy}>
          <RefreshCw className={cn(busy && 'animate-spin')} />
          {t('screen.refresh')}
        </Button>
      </div>

      {error && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Activity} label={t('screen.total')} value={overview?.total ?? 0} />
        <Stat icon={Users} label={t('screen.visitors')} value={overview?.unique_ips ?? 0} />
        <Stat icon={MapPin} label={t('screen.cities')} value={cityCount} />
        <Stat
          icon={Gauge}
          label={t('screen.per_minute')}
          value={overview?.per_minute ?? 0}
          decimals={1}
          suffix={t('screen.per_minute_unit')}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-border/60 p-4">
          <p className="text-sm font-medium">{t('screen.hourly')}</p>
          <div className="mt-4 flex h-32 items-end gap-1">
            {bars.map((v, i) => (
              <span
                key={i}
                className="flex-1 rounded-t bg-foreground/25 transition-[height] duration-500"
                style={{ height: `${Math.max(2, (v / barMax) * 100)}%` }}
                title={`${v}`}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>-{hours}h</span>
            <span>{t('screen.now')}</span>
          </div>
        </div>

        <Ranked title={t('screen.top_cities')} rows={overview?.locations ?? []} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Ranked title={t('screen.top_hosts')} rows={overview?.hosts ?? []} />
        <Ranked title={t('screen.top_paths')} rows={overview?.paths ?? []} />
      </div>

      {/* 实时访问 */}
      <div className="overflow-hidden rounded-2xl border border-border/60">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
          <span className="relative flex size-2 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          <span className="text-sm font-medium text-foreground">{t('screen.live_title')}</span>
          <span className="text-muted-foreground">{t('screen.live_hint')}</span>
          {overview && (
            <span
              className="ml-auto hidden truncate font-mono text-muted-foreground sm:block"
              title={overview.sources.join('\n')}
            >
              {t('screen.watching', { count: overview.sources.length })}
            </span>
          )}
        </div>

        <div className="grid grid-cols-[64px_1fr] items-center gap-2 bg-muted/30 px-4 py-1.5 text-[10px] tracking-wider text-muted-foreground uppercase sm:grid-cols-[64px_120px_1fr_1.6fr_56px_44px]">
          <span>{t('screen.col_time')}</span>
          <span className="hidden sm:block">{t('screen.col_location')}</span>
          <span className="hidden sm:block">{t('screen.col_host')}</span>
          <span>{t('screen.col_uri')}</span>
          <span className="hidden text-right sm:block">{t('screen.col_method')}</span>
          <span className="text-right">{t('screen.col_status')}</span>
        </div>

        <div className="max-h-[46vh] overflow-y-auto bg-zinc-950/95">
          {events.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs leading-6 text-zinc-400">
              <p>{t('screen.live_empty')}</p>
              <p className="mt-1 text-zinc-500">{t('screen.live_empty_hint')}</p>
            </div>
          ) : (
            events.map((e) => (
              <div
                key={e.id}
                // 新到的行从上方滑进来：一眼能看出刚才发生了什么。
                className="grid animate-in fade-in-0 slide-in-from-top-1 grid-cols-[64px_1fr] items-center gap-2 border-b border-white/5 px-4 py-1.5 font-mono text-[11px] duration-300 hover:bg-white/5 sm:grid-cols-[64px_120px_1fr_1.6fr_56px_44px]"
              >
                <span className="text-zinc-500 tabular-nums">{e.time}</span>
                <span className="hidden truncate text-zinc-300 sm:block" title={`${e.location} ${e.isp} ${e.ip}`}>
                  {e.location}
                </span>
                <span className="hidden truncate text-zinc-400 sm:block" title={e.host}>
                  {e.host}
                </span>
                <span className="min-w-0 truncate text-zinc-200" title={`${e.uri}  —  ${e.ua}`}>
                  {e.uri}
                </span>
                <span className="hidden text-right text-zinc-400 sm:block">{e.method}</span>
                <span className={cn('text-right tabular-nums', statusTone(e.status))}>{e.status}</span>
              </div>
            ))
          )}
        </div>

        <p className="border-t border-border/60 px-4 py-2 text-[11px] leading-5 text-muted-foreground">
          {overview?.geo.note}
        </p>
      </div>
    </div>
  );
}
