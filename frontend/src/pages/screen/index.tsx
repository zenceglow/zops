import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Activity, Bot, ScanLine, ShieldAlert, X } from 'lucide-react';
import { BrandLogo } from '../../components/brand-logo';
import { RollingNumber } from '../../components/rolling-number';
import { cn } from '../../lib/utils';
import { Globe } from './_components/globe';
import {
  fetchEvents,
  fetchOverview,
  type AccessEvent,
  type AnalyticsOverview,
  type HourPoint,
} from './_api';

/** 实时流水轮询间隔。 */
const EVENT_POLL_MS = 3000;
/** 底部流水保留多少条。 */
const MAX_ROWS = 40;
/** 概览刷新比流水慢：数字跳太频反而看不出趋势。 */
const OVERVIEW_EVERY = 5;

const RANGES = [24, 168, 720] as const;

/**
 * 把"每小时"的点折成固定 24 根柱子。后端只返回有记录的小时，缺口得在这儿补 ——
 * 否则夜里没人访问的那几个小时会直接消失，看起来像时间被压缩了。
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
  if (status >= 400) return 'text-amber-300';
  if (status >= 300) return 'text-sky-300';
  if (status >= 200) return 'text-emerald-300';
  return 'text-zinc-500';
}

/**
 * 数据大屏 —— 全屏，不套应用外壳。
 *
 * 三个刻意的选择：
 * 1. **全屏独立**。它不是在页面里放几个图表，是"投在墙上的那一块"。所以关掉
 *    菜单栏和 Dock，右上角一个关闭按钮回桌面。
 * 2. **关掉就停**。轮询挂在组件生命周期里，退出即卸载；标签页切到后台也停 ——
 *    大屏常常挂一整天，没人在看的时候还每 3 秒查一次库是白烧资源。
 * 3. **数字是滚的**。24 跳到 42 时人眼抓不住变了多少，滚一下才有方向感。
 */
export default function ScreenPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [hours, setHours] = useState<number>(24);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(() => new Date());
  const cursor = useRef(0);
  /** 页面不可见时暂停轮询。 */
  const hidden = useRef(false);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await fetchOverview(hours));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hours]);

  const loadEvents = useCallback(async (seed: boolean) => {
    try {
      const page = await fetchEvents(seed ? 0 : cursor.current, 40);
      cursor.current = page.cursor;
      if (page.events.length === 0) return;
      const newestFirst = [...page.events].reverse();
      setEvents((prev) => (seed ? newestFirst : [...newestFirst, ...prev]).slice(0, MAX_ROWS));
    } catch {
      // 轮询失败不弹窗：大屏上顶个红色提示比数据晚 3 秒更难看。
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadEvents(true);
  }, [loadOverview, loadEvents]);

  useEffect(() => {
    let tick = 0;
    const id = setInterval(() => {
      if (hidden.current) return;
      void loadEvents(false);
      if (++tick % OVERVIEW_EVERY === 0) void loadOverview();
    }, EVENT_POLL_MS);
    const onVisibility = () => {
      hidden.current = document.hidden;
      // 切回来立刻补一次，不用干等下一个周期。
      if (!document.hidden) void loadEvents(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadEvents, loadOverview]);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Esc 退出。全屏界面没有浏览器地址栏可退，给一个键盘出口。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/monitor');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const bars = overview ? toBars(overview.hourly, hours) : [];
  const barMax = Math.max(1, ...bars);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`;
  const security = overview?.security;

  return (
    // 固定深色：这是"机房里那块屏"，不跟随面板的浅色主题 —— 浅底上做发光效果
    // 怎么做都是脏的。
    <div className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-[#05070d] text-zinc-100">
      {/* 背景网格 + 顶部冷光 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(56,189,248,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,.06) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[46rem] -translate-x-1/2 rounded-full bg-sky-500/10 blur-3xl"
      />

      <header className="relative z-10 flex items-center gap-3 px-6 py-3">
        <BrandLogo className="size-7" />
        <div>
          <h1 className="text-base leading-none font-semibold tracking-wide">
            ZOPS <span className="text-zinc-500">·</span> {t('screen.title')}
          </h1>
          <p className="mt-1 text-[11px] text-zinc-500">{t('screen.subtitle')}</p>
        </div>

        <span className="ml-3 flex items-center gap-1.5 text-[11px] text-emerald-400">
          <span className="relative flex size-2 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          {t('screen.live_badge')}
        </span>
        <span className="font-mono text-[11px] text-zinc-500 tabular-nums">{time}</span>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5">
            {RANGES.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHours(h)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] transition-colors',
                  hours === h
                    ? 'bg-white/10 font-medium text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {h === 24 ? '24h' : h === 168 ? '7d' : '30d'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => navigate('/monitor')}
            title={t('screen.close')}
            className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      {error && (
        <p className="relative z-10 mx-6 mb-1 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* 中间行吃掉剩下的高度。整页 `overflow-hidden`，所以每一段都必须自己
          管住自己的高度 —— 让内容撑，撑出去的部分不会滚，只会把别人挤掉。 */}
      <div className="relative z-10 grid min-h-0 flex-1 gap-4 px-6 xl:grid-cols-[240px_1fr_290px]">
        {/* 左：总量与趋势 */}
        <div className="flex min-h-0 flex-col gap-3">
          <BigStat label={t('screen.total')} value={overview?.total ?? 0} />
          <div className="grid grid-cols-3 gap-2 xl:grid-cols-1 xl:gap-3">
            <SmallStat label={t('screen.visitors')} value={overview?.unique_ips ?? 0} />
            <SmallStat label={t('screen.cities')} value={overview?.points.length ?? 0} />
            <SmallStat
              label={t('screen.per_minute')}
              value={overview?.per_minute ?? 0}
              decimals={1}
            />
          </div>

          {/* 趋势：细柱子，只当形状看，不标刻度 */}
          <div className="mt-auto rounded-xl bg-white/[0.03] p-3">
            <p className="text-[11px] text-zinc-500">{t('screen.hourly')}</p>
            <div className="mt-2 flex h-14 items-end gap-[3px]">
              {bars.map((v, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-sm bg-sky-400/40 transition-[height] duration-500"
                  style={{ height: `${Math.max(3, (v / barMax) * 100)}%` }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* 中：地球 */}
        <div className="relative min-h-[300px]">
          <Globe
            points={overview?.points ?? []}
            self={overview?.self_location ?? null}
            latest={events[0] ?? null}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-2 px-1 pb-1 text-[11px] text-zinc-500">
            <span className="flex items-center gap-3">
              <Legend className="bg-emerald-400" label={t('screen.legend_visitor')} />
              <Legend className="bg-zinc-100" label={t('screen.legend_server')} square />
              <Legend className="bg-sky-400" label={t('screen.legend_link')} />
            </span>
            <span className="text-right">
              {overview?.self_location
                ? t('screen.server_at', { place: overview.self_location.label })
                : t('screen.server_unknown')}
            </span>
          </div>
          {overview && overview.points.length === 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-xs text-zinc-600">
              {overview.geo.enabled ? t('screen.no_points') : t('screen.geo_off')}
            </p>
          )}
        </div>

        {/* 右：安全面 */}
        <div className="flex min-h-0 flex-col gap-2.5">
          <SecStat
            icon={ShieldAlert}
            label={t('screen.blocked')}
            value={security?.blocked ?? 0}
            tone="text-red-400"
          />
          <SecStat
            icon={Bot}
            label={t('screen.bots')}
            value={security?.bots ?? 0}
            tone="text-amber-300"
          />
          <SecStat
            icon={ScanLine}
            label={t('screen.tools')}
            value={security?.tools ?? 0}
            tone="text-violet-300"
          />

          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-white/[0.03] p-3">
            <p className="text-[11px] text-zinc-500">{t('screen.attackers')}</p>
            <div className="mt-2 space-y-1.5">
              {(security?.attackers ?? []).length === 0 && (
                <p className="text-[11px] text-zinc-600">—</p>
              )}
              {(security?.attackers ?? []).map((a) => (
                <div key={a.ip} className="flex items-center gap-2 text-[11px]">
                  <span className="truncate text-zinc-300" title={a.ip}>
                    {a.location}
                  </span>
                  <span className="hidden truncate font-mono text-zinc-600 sm:block">{a.ip}</span>
                  <span className="ml-auto font-mono text-red-400 tabular-nums">{a.count}</span>
                </div>
              ))}
            </div>

            {(security?.blocked_paths ?? []).length > 0 && (
              <>
                <p className="mt-4 text-[11px] text-zinc-500">{t('screen.blocked_paths')}</p>
                <div className="mt-2 space-y-1">
                  {(security?.blocked_paths ?? []).map((p) => (
                    <div key={p.key} className="flex items-center gap-2 text-[11px]">
                      <span className="truncate font-mono text-zinc-400" title={p.key}>
                        {p.key}
                      </span>
                      <span className="ml-auto font-mono text-zinc-500 tabular-nums">{p.count}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <p className="shrink-0 text-[10px] leading-4 text-zinc-600">{t('screen.sec_note')}</p>
        </div>
      </div>

      {/* 底部：实时流水 */}
      <div className="relative z-10 mt-3 flex h-[30vh] min-h-[168px] shrink-0 flex-col border-t border-white/5 px-6 pt-2 pb-3">
        <div className="flex items-center gap-2 text-[11px]">
          <Activity className="size-3.5 text-emerald-400" />
          <span className="font-medium text-zinc-200">{t('screen.live_title')}</span>
          <span className="text-zinc-600">{t('screen.live_hint')}</span>
          <span className="ml-auto flex items-center gap-3 text-zinc-600">
            <Legend className="bg-amber-300" label={t('screen.legend_bot')} />
            <Legend className="bg-red-400" label={t('screen.legend_blocked')} />
          </span>
        </div>

        <div className="mt-1.5 grid shrink-0 grid-cols-[64px_108px_1fr_1.5fr_52px_44px] gap-2 pb-1 text-[10px] tracking-wider text-zinc-600 uppercase">
          <span>{t('screen.col_time')}</span>
          <span>{t('screen.col_location')}</span>
          <span>{t('screen.col_host')}</span>
          <span>{t('screen.col_uri')}</span>
          <span className="text-right">{t('screen.col_method')}</span>
          <span className="text-right">{t('screen.col_status')}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {events.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-zinc-600">{t('screen.live_empty')}</p>
          ) : (
            events.map((e) => (
              <div
                key={e.id}
                className={cn(
                  'grid animate-in fade-in-0 slide-in-from-top-1 grid-cols-[64px_108px_1fr_1.5fr_52px_44px] gap-2 border-b border-white/[0.04] py-[3px] font-mono text-[11px] duration-300',
                  e.blocked ? 'bg-red-500/[0.07]' : e.bot && 'bg-amber-400/[0.05]',
                )}
              >
                <span className="text-zinc-500 tabular-nums">{e.time}</span>
                <span className="truncate text-zinc-300" title={`${e.location} ${e.isp} ${e.ip}`}>
                  {e.location}
                </span>
                <span className="truncate text-zinc-500" title={e.host}>
                  {e.host}
                </span>
                <span className="truncate text-zinc-200" title={`${e.uri}  —  ${e.ua}`}>
                  {e.uri}
                </span>
                <span className="text-right text-zinc-500">{e.method}</span>
                <span className={cn('text-right tabular-nums', statusTone(e.status))}>{e.status}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function BigStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-sky-500/[0.08] px-4 py-3 ring-1 ring-sky-400/20">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <RollingNumber value={value} className="mt-0.5 text-4xl tracking-tight text-sky-300" />
    </div>
  );
}

function SmallStat({
  label,
  value,
  decimals,
}: {
  label: string;
  value: number;
  decimals?: number;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-white/[0.03] px-3 py-2.5">
      <p className="truncate text-[11px] text-zinc-500">{label}</p>
      <RollingNumber value={value} decimals={decimals} className="mt-0.5 text-2xl text-zinc-100" />
    </div>
  );
}

function SecStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Bot;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3.5 py-2.5">
      <Icon className={cn('size-4 shrink-0', tone)} />
      <p className="text-[11px] text-zinc-500">{label}</p>
      <RollingNumber value={value} className={cn('ml-auto text-2xl', tone)} />
    </div>
  );
}

function Legend({
  className,
  label,
  square,
}: {
  className: string;
  label: string;
  square?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-1.5', square ? 'rounded-[1px]' : 'rounded-full', className)} />
      {label}
    </span>
  );
}
