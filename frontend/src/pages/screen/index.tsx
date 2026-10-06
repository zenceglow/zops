import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Bot, ScanLine, ShieldAlert, X } from 'lucide-react';
import { BrandLogo } from '../../components/brand-logo';
import { RollingNumber } from '../../components/rolling-number';
import { cn } from '../../lib/utils';
import { Globe } from './_components/globe';
import { Legend, LiveFeed } from './_components/live-feed';
import { PressurePanel, type PressureMetric } from './_components/pressure';
import { reloadOverview, startScreenPolling, useScreenStore } from './_store';
import type { GeoPoint, HourPoint } from './_api';

const RANGES = [24, 168, 720] as const;

/** 空数组提出来当常量：每次渲染传一个新 `[]`，地球会以为数据变了。 */
const EMPTY_POINTS: GeoPoint[] = [];

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

/** 字节按十进制读起来更顺（GB 就是 GB，不是 GiB 那个绕一圈的数）。 */
function gb(bytes: number): string {
  return `${(bytes / (1 << 30)).toFixed(bytes >= 10 << 30 ? 0 : 1)} GB`;
}

/**
 * 数据大屏 —— 全屏，不套应用外壳。
 *
 * 这块屏是**挂在墙上的**，一开就是一整天，所以性能不是"优化项"而是前提。三条规矩：
 *
 * 1. **谁的数据谁重绘**。数据放在 `_store` 里，每个面板用选择器只订阅自己那一份，
 *    系统指标变了只重画压力仪，新日志来了只动流水 —— 不再有"时钟跳一秒，整个
 *    页面连地球带四十行日志一起重画"这种事。
 * 2. **时钟独立**。它每秒都在变，是全页唯一的高频来源；关在一个组件里就出不去。
 * 3. **关掉就停**。轮询挂在页面生命周期上，退出即卸载；标签页切到后台也停 ——
 *    没人在看的时候还每 3 秒查一次库是白烧资源。
 */
export default function ScreenPage() {
  const navigate = useNavigate();

  // 轮询的控制放在最外层：它不属于任何一块 UI，也不该因为任何一块重绘而重启。
  useEffect(() => startScreenPolling(), []);

  // Esc 退出。全屏界面没有浏览器地址栏可退，给一个键盘出口。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/monitor');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    // 固定深色：这是"机房里那块屏"，不跟随面板的浅色主题 —— 浅底上做发光效果
    // 怎么做都是脏的。
    <div className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-[#05070d] text-zinc-100">
      {/* 背景网格 + 顶部冷光。全是静态的，一次画好就不再参与重绘。 */}
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

      <Header onClose={() => navigate('/monitor')} />
      <ErrorBar />

      {/* 中间行吃掉剩下的高度。整页 `overflow-hidden`，所以每一段都必须自己
          管住自己的高度 —— 让内容撑，撑出去的部分不会滚，只会把别人挤掉。 */}
      <div className="relative z-10 grid min-h-0 flex-1 gap-4 px-6 xl:grid-cols-[240px_1fr_290px]">
        <StatsColumn />
        <div className="flex min-h-[300px] flex-col gap-3">
          <GlobeBlock />
          <PressureBlock />
        </div>
        <SecurityColumn />
      </div>

      <LiveFeed />
    </div>
  );
}

/**
 * 走秒的时钟。
 *
 * 单独一个组件、单独一份 state：它是全页唯一每秒都在变的东西。放在页面顶层的话，
 * 那一秒一次的重绘会波及地球和四十行日志；关在这里，代价就只剩这一个 span。
 */
const Clock = memo(function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
      {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
    </span>
  );
});

/** 顶栏。只订阅"主机名"和"时间范围"两个小字段。 */
const Header = memo(function Header({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const hostname = useScreenStore((s) => s.sys?.hostname);
  const hours = useScreenStore((s) => s.hours);
  const setHours = useScreenStore((s) => s.setHours);

  return (
    <header className="relative z-10 flex items-center gap-3 px-6 py-3">
      <BrandLogo className="size-7" />
      {/* 标题只留品牌，再挂一个主机名。
          "ZOPS · 数据大屏 / Caddy 访问日志实时统计" 那种写法是给自己壮胆的：
          用户点进来的本来就是这一页，不需要再被介绍一遍；而"这台是哪台"
          才是没有别处可看的信息。没有系统读权限时主机名就空着。 */}
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base leading-none font-semibold tracking-wide">ZOPS</h1>
        {hostname && <span className="font-mono text-[11px] text-zinc-500">{hostname}</span>}
      </div>

      <span className="ml-3 flex items-center gap-1.5 text-[11px] text-emerald-400">
        <span className="relative flex size-2 items-center justify-center">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        {t('screen.live_badge')}
      </span>
      <Clock />

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-white/5 p-0.5">
          {RANGES.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                setHours(h);
                reloadOverview();
              }}
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
          onClick={onClose}
          title={t('screen.close')}
          className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
        >
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
});

/** 拉数据失败时的提示条。单独订阅，免得错误一变就重画整页。 */
const ErrorBar = memo(function ErrorBar() {
  const error = useScreenStore((s) => s.error);
  if (!error) return null;
  return (
    <p className="relative z-10 mx-6 mb-1 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
      {error}
    </p>
  );
});

/** 左栏：总量与趋势。只订阅 overview。 */
const StatsColumn = memo(function StatsColumn() {
  const { t } = useTranslation();
  const overview = useScreenStore((s) => s.overview);
  const bars = overview ? toBars(overview.hourly, overview.hours) : [];
  const barMax = Math.max(1, ...bars);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <BigStat label={t('screen.total')} value={overview?.total ?? 0} />
      <div className="grid grid-cols-3 gap-2 xl:grid-cols-1 xl:gap-3">
        <SmallStat label={t('screen.visitors')} value={overview?.unique_ips ?? 0} />
        <SmallStat label={t('screen.cities')} value={overview?.points.length ?? 0} />
        <SmallStat label={t('screen.per_minute')} value={overview?.per_minute ?? 0} decimals={1} />
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
  );
});

/**
 * 地球。只订阅"落点、服务器位置、最新一条流水" —— 流水列表里其它三十几条怎么变
 * 都跟它无关，系统指标怎么变更跟它无关。
 */
const GlobeBlock = memo(function GlobeBlock() {
  const { t } = useTranslation();
  // 选择器返回的是对象引用：数据没换就是同一个引用，zustand 直接跳过重绘。
  const points = useScreenStore((s) => s.overview?.points);
  const self = useScreenStore((s) => s.overview?.self_location);
  const latest = useScreenStore((s) => s.events[0] ?? null);
  const geoEnabled = useScreenStore((s) => s.overview?.geo.enabled);
  const hasPoints = (points?.length ?? 0) > 0;

  return (
    <div className="relative min-h-0 flex-1">
      <Globe points={points ?? EMPTY_POINTS} self={self ?? null} latest={latest} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-2 px-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-3">
          <Legend className="bg-emerald-400" label={t('screen.legend_visitor')} />
          <Legend className="bg-zinc-100" label={t('screen.legend_server')} square />
          <Legend className="bg-sky-400" label={t('screen.legend_link')} />
        </span>
        <span className="text-right">
          {self ? t('screen.server_at', { place: self.label }) : t('screen.server_unknown')}
        </span>
      </div>
      {points !== undefined && !hasPoints && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-xs text-zinc-600">
          {geoEnabled ? t('screen.no_points') : t('screen.geo_off')}
        </p>
      )}
    </div>
  );
});

/** 压力仪。只订阅系统指标 —— 这块每 3 秒都在动，但它动的时候别人不该跟着动。 */
const PressureBlock = memo(function PressureBlock() {
  const { t } = useTranslation();
  const sys = useScreenStore((s) => s.sys);
  const denied = useScreenStore((s) => s.sysDenied);
  if (denied || !sys) return null;

  // 磁盘只算 1GB 以上的分区：容器会挂一堆几百兆的 overlay，它们动辄 90% 往上，
  // 混进来会让"磁盘告急"永远为真。
  const disks = sys.disks.filter((d) => d.total >= 1 << 30);
  const worstDisk = [...disks].sort((a, b) => b.percent - a.percent)[0];
  const swapPct = sys.swap_total > 0 ? (sys.swap_used / sys.swap_total) * 100 : 0;
  const load1 = sys.load_avg[0] ?? 0;
  // 负载折成"占满几核"：8 核上 load=8 就是刚好跑满，比裸数字直观。
  const loadPct = sys.cpu_cores > 0 ? (load1 / sys.cpu_cores) * 100 : 0;

  const metrics: PressureMetric[] = [
    { key: 'cpu', value: sys.cpu_usage, detail: `${sys.cpu_cores} ${t('screen.cores')}` },
    {
      key: 'memory',
      value: sys.memory_percent,
      detail: `${gb(sys.memory_used)} / ${gb(sys.memory_total)}`,
    },
    { key: 'disk', value: worstDisk?.percent ?? 0, detail: worstDisk?.mount },
    {
      key: 'swap',
      value: swapPct,
      detail:
        sys.swap_total > 0 ? `${gb(sys.swap_used)} / ${gb(sys.swap_total)}` : t('screen.swap_off'),
    },
    {
      key: 'load',
      value: loadPct,
      detail: sys.load_avg
        .slice(0, 3)
        .map((n) => n.toFixed(2))
        .join(' / '),
    },
  ];

  return (
    <div className="shrink-0">
      <PressurePanel metrics={metrics} processes={sys.processes} />
    </div>
  );
});

/** 右栏：安全面。只订阅 overview.security。 */
const SecurityColumn = memo(function SecurityColumn() {
  const { t } = useTranslation();
  const security = useScreenStore((s) => s.overview?.security);

  return (
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
  );
});

const BigStat = memo(function BigStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-sky-500/[0.08] px-4 py-3 ring-1 ring-sky-400/20">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <RollingNumber value={value} className="mt-0.5 text-4xl tracking-tight text-sky-300" />
    </div>
  );
});

const SmallStat = memo(function SmallStat({
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
});

const SecStat = memo(function SecStat({
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
});
