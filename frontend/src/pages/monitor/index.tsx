import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../components/ui/skeleton';
import { cn } from '../../lib/utils';
import useUserStore from '../../stores/user.store';
import { formatBytes, formatUptime, useMonitor } from './_hooks/use-monitor';
import { NetworkWidget } from './_components/network-widget';
import { Ring } from './_components/ring';

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

  if (loading || !sys) {
    return (
      <div className="space-y-12 pt-6 sm:pt-10">
        <Skeleton className="h-12 w-96 max-w-full" />
        <div className="grid grid-cols-2 justify-items-center gap-y-10 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="size-[148px] rounded-full" />
          ))}
        </div>
        <Skeleton className="mx-auto h-40 w-full max-w-2xl rounded-2xl" />
      </div>
    );
  }

  // 环只放得下一个磁盘，那就放最告急的那个 —— 比固定显示 / 更有用，
  // 挂载点写在下面一行，用户仍然知道是哪个分区在告急。
  const disks = sys.disks.filter((d) => d.total >= 1 << 30);
  const worstDisk = disks.slice().sort((a, b) => b.percent - a.percent)[0];
  const diskPct = worstDisk?.percent ?? 0;
  const swapPct = sys.swap_total > 0 ? (sys.swap_used / sys.swap_total) * 100 : 0;
  const worst = Math.max(sys.cpu_usage, sys.memory_percent, diskPct, swapPct);
  const status = worst >= 90 ? 'critical' : worst >= 75 ? 'busy' : 'ok';

  return (
    <div className="space-y-9">
      <section className="pt-6 sm:pt-10">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
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
      </section>

      <section className="grid grid-cols-2 justify-items-center gap-x-6 gap-y-10 sm:grid-cols-4">
        <Ring
          value={sys.cpu_usage}
          label={t('monitor.cpu')}
          sub={`${sys.cpu_cores} ${t('monitor.cores')} · ${sys.load_avg.map((n) => n.toFixed(1)).join(' / ')}`}
        />
        <Ring
          value={sys.memory_percent}
          label={t('monitor.memory')}
          sub={`${formatBytes(sys.memory_used)} / ${formatBytes(sys.memory_total)}`}
        />
        <Ring
          value={diskPct}
          label={t('monitor.disk')}
          sub={
            worstDisk
              ? `${worstDisk.mount} · ${formatBytes(worstDisk.used)} / ${formatBytes(worstDisk.total)}`
              : '—'
          }
        />
        <Ring
          value={swapPct}
          label={t('monitor.swap')}
          sub={
            sys.swap_total > 0
              ? `${formatBytes(sys.swap_used)} / ${formatBytes(sys.swap_total)}`
              : '—'
          }
        />
      </section>

      <NetworkWidget />

      {dockerSt?.available && containers.length > 0 && (
        <section className="flex flex-wrap items-center justify-center gap-2">
          {containers.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/50 px-3 py-1.5 text-xs"
              title={c.image}
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  c.state === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
              />
              <span className="text-foreground/90">{c.name}</span>
            </span>
          ))}
        </section>
      )}
    </div>
  );
}
