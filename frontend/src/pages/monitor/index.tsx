import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../components/ui/skeleton';
import useUserStore from '../../stores/user.store';
import { formatBytes, formatUptime, useMonitor } from './_hooks/use-monitor';
import { ContainerGrid } from './_components/container-grid';
import { GatewayEntry } from './_components/gateway-entry';
import { NetworkWidget } from './_components/network-widget';
import { Ring } from './_components/ring';
import { Stats } from './_components/stats';
import { Topology } from './_components/topology';
import { useGatewayEntries } from './_hooks/use-gateway';

function greetingKey(hour: number) {
  if (hour < 5) return 'home.night';
  if (hour < 11) return 'home.morning';
  if (hour < 18) return 'home.afternoon';
  return 'home.evening';
}

/**
 * 首页 = 服务器桌面。
 *
 * 刻意不出现"监控"这个标题：告诉用户"这里是监控页"是后台系统的写法，
 * 而这一页要的效果是——进来就知道这台机器过得怎么样。
 *
 * 只留三样东西：问候语、四个粗环、网络挂件。明细各归各的页面
 * （网络 → /system/network，容器 → /docker/containers），
 * 首页不再用"更多详情"折叠区兜底 —— 那是把没想清楚的信息架构藏起来。
 */
export default function MonitorPage() {
  const { t } = useTranslation();
  const user = useUserStore((s) => s.user);
  const { sys, containers, dockerSt, loading } = useMonitor();
  const gateway = useGatewayEntries();

  if (loading || !sys) {
    return (
      // 骨架要照抄真实布局的骨架尺寸，否则数据一到、元素一换，整页会跳一下 ——
      // 那比多等两百毫秒更让人以为是"加载出错又好了"。
      <div className="space-y-8">
        <section className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-4">
            <Skeleton className="h-10 w-72 max-w-full" />
            <Skeleton className="h-5 w-96 max-w-full" />
          </div>
          <div className="w-full space-y-3 sm:w-[400px]">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-4 w-52 max-w-full" />
          </div>
        </section>

        <GatewayEntry {...gateway} />

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <Skeleton className="h-[220px] rounded-2xl" />
          <Skeleton className="h-[220px] rounded-2xl" />
        </section>

        <Skeleton className="h-[360px] rounded-2xl" />

        <section className="grid grid-cols-2 justify-items-center gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-5">
              <Skeleton className="size-[116px] rounded-full" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </section>

        <section className="space-y-6">
          <Skeleton className="h-5 w-24" />
          <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-2xl" />
            ))}
          </div>
        </section>
      </div>
    );
  }

  // 环只放得下一个磁盘，那就放最告急的那个 —— 比固定显示 / 更有用，
  // 挂载点写在下面一行，用户仍然知道是哪个分区在告急。
  const disks = sys.disks.filter((d) => d.total >= 1 << 30);
  const worstDisk = disks.slice().sort((a, b) => b.percent - a.percent)[0];
  const diskPct = worstDisk?.percent ?? 0;
  const swapPct = sys.swap_total > 0 ? (sys.swap_used / sys.swap_total) * 100 : 0;
  const load1 = sys.load_avg[0] ?? 0;
  // 负载按"占满几核"折算成百分比：8 核上 load=8 就是刚好跑满，这个口径比裸数字直观。
  const loadPct = sys.cpu_cores > 0 ? (load1 / sys.cpu_cores) * 100 : 0;
  const worst = Math.max(sys.cpu_usage, sys.memory_percent, diskPct, swapPct);
  const status = worst >= 90 ? 'critical' : worst >= 75 ? 'busy' : 'ok';

  const rings = [
    { value: sys.cpu_usage, label: t('monitor.cpu'), sub: `${sys.cpu_cores} ${t('monitor.cores')}` },
    {
      value: loadPct,
      label: t('monitor.load'),
      sub: sys.load_avg.map((n) => n.toFixed(1)).join(' / '),
    },
    {
      value: sys.memory_percent,
      label: t('monitor.memory'),
      sub: `${formatBytes(sys.memory_used)} / ${formatBytes(sys.memory_total)}`,
    },
    {
      value: diskPct,
      label: t('monitor.disk'),
      sub: worstDisk
        ? `${worstDisk.mount} · ${formatBytes(worstDisk.used)} / ${formatBytes(worstDisk.total)}`
        : '—',
    },
    {
      value: swapPct,
      label: t('monitor.swap'),
      sub:
        sys.swap_total > 0
          ? `${formatBytes(sys.swap_used)} / ${formatBytes(sys.swap_total)}`
          : '—',
    },
  ];

  return (
    <div className="space-y-8">
      {/* 顶部一行：左边问候，右边网络。网络固定 188px 高，跟左列同排对齐。 */}
      <section className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t(greetingKey(new Date().getHours()))}
            {user?.username ? `${t('home.name_sep')}${user.username}` : ''}
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            {t(`home.status_${status}`)}
            <span className="mx-2 opacity-40">·</span>
            {sys.hostname}
            <span className="mx-2 opacity-40">·</span>
            {t('home.uptime_prefix')} {formatUptime(sys.uptime_secs)}
          </p>
        </div>
        <NetworkWidget />
      </section>

      {/* 站点入口放在最上面：它是"外面的人从哪儿进来"，比机器自己的负载更该先被看到。 */}
      <GatewayEntry {...gateway} />

      {/* 待办是预留位（还没定要放什么），右边是横向柱状的占用对比。 */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="flex flex-col rounded-2xl border border-dashed border-border/70 px-4 py-4">
          <p className="text-sm font-medium">{t('home.todo')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('home.todo_empty')}</p>
        </div>
        <div className="flex flex-col rounded-2xl border border-border/60 px-4 py-4">
          <p className="mb-3 text-sm font-medium">{t('home.monitor')}</p>
          <Stats
            sys={sys}
            diskPct={diskPct}
            diskSub={worstDisk ? `${worstDisk.mount} · ${formatBytes(worstDisk.used)} / ${formatBytes(worstDisk.total)}` : '—'}
            loadPct={loadPct}
            swapPct={swapPct}
          />
        </div>
      </section>

      <Topology entries={gateway.sites} containers={containers} />

      {/* 五个环均分整行：内容只有这么点，再挤在左边就只剩一大片空。等宽列让它们
          像一排仪表铺开，右边缘也对齐了。 */}
      <section className="grid grid-cols-2 justify-items-center gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
        {rings.map((r) => (
          <Ring key={r.label} value={r.value} label={r.label} sub={r.sub} />
        ))}
      </section>

      {dockerSt?.available && <ContainerGrid containers={containers} />}
    </div>
  );
}
