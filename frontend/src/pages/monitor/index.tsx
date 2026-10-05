import { useTranslation } from 'react-i18next';
import { HardDrive, Network } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { cn } from '../../lib/utils';
import useUserStore from '../../stores/user.store';
import { formatBytes, formatUptime, useMonitor } from './_hooks/use-monitor';
import { Ring } from './_components/ring';
import { SectionTitle } from './_components/section-title';

/** Skip loopback / virtual / Apple private interfaces that bloat the list. */
function isPrimaryNetIface(name: string) {
  const n = name.toLowerCase();
  if (n === 'lo' || n.startsWith('lo')) return false;
  if (
    /^(utun|awdl|llw|bridge|veth|docker|br-|virbr|vmnet|vnic|ap\d|gif|stf|p2p)/.test(
      n,
    )
  ) {
    return false;
  }
  return true;
}

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
 * 而这一页想达到的效果是——进来就知道这台机器过得怎么样。所以第一屏是
 * 一句问候 + 四个粗环，具体明细收进下面的折叠区。
 */
export default function MonitorPage() {
  const { t } = useTranslation();
  const user = useUserStore((s) => s.user);
  const { sys, containers, dockerSt, loading } = useMonitor();

  if (loading || !sys) {
    return (
      <div className="space-y-16 pt-10 sm:pt-16">
        <Skeleton className="h-12 w-96 max-w-full" />
        <div className="grid grid-cols-2 justify-items-center gap-y-10 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="size-[164px] rounded-full" />
          ))}
        </div>
      </div>
    );
  }

  const rootDisk =
    sys.disks.find((d) => d.mount === '/') ??
    sys.disks.filter((d) => d.total >= 1 << 30).sort((a, b) => b.total - a.total)[0];
  const diskPct = rootDisk?.percent ?? 0;
  const swapPct = sys.swap_total > 0 ? (sys.swap_used / sys.swap_total) * 100 : 0;
  const worst = Math.max(sys.cpu_usage, sys.memory_percent, diskPct, swapPct);
  const status = worst >= 90 ? 'critical' : worst >= 75 ? 'busy' : 'ok';

  return (
    <div className="space-y-16">
      <section className="pt-10 sm:pt-14">
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

      <section className="grid grid-cols-2 justify-items-center gap-x-6 gap-y-12 sm:grid-cols-4">
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
          sub={rootDisk ? `${rootDisk.mount} · ${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}` : '—'}
        />
        <Ring
          value={swapPct}
          label={t('monitor.swap')}
          sub={sys.swap_total > 0 ? `${formatBytes(sys.swap_used)} / ${formatBytes(sys.swap_total)}` : '—'}
        />
      </section>

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

      <details className="group rounded-2xl border border-border/60 px-5 py-4">
        <summary className="cursor-pointer select-none text-sm text-muted-foreground transition-colors hover:text-foreground group-open:mb-6">
          {t('home.more')}
        </summary>

        <div className="space-y-8">
          <section className="space-y-3">
            <SectionTitle icon={HardDrive} title={t('monitor.disk')} />
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {sys.disks
                  .filter((d) => d.total >= 1 << 30)
                  .map((d) => (
                    <div key={d.mount} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                          <span className="truncate font-medium">{d.mount}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatBytes(d.used)} / {formatBytes(d.total)}
                            <span className="ml-1.5 tabular-nums text-foreground/70">
                              {d.percent.toFixed(0)}%
                            </span>
                          </span>
                        </div>
                        <div className="h-1 w-full rounded-full bg-secondary">
                          <div
                            className={cn(
                              'h-1 rounded-full transition-all',
                              d.percent > 90
                                ? 'bg-destructive'
                                : d.percent > 75
                                  ? 'bg-orange-500'
                                  : 'bg-primary',
                            )}
                            style={{ width: `${Math.min(d.percent, 100)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3">
            <SectionTitle icon={Network} title={t('monitor.network')} />
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9">{t('monitor.iface')}</TableHead>
                    <TableHead className="h-9 text-right">↓ RX</TableHead>
                    <TableHead className="h-9 text-right">↑ TX</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sys.network
                    .filter((n) => isPrimaryNetIface(n.name))
                    .map((n) => (
                      <TableRow key={n.name}>
                        <TableCell className="py-2 font-medium">{n.name}</TableCell>
                        <TableCell className="py-2 text-right text-muted-foreground tabular-nums">
                          {formatBytes(n.rx_bytes)}
                        </TableCell>
                        <TableCell className="py-2 text-right text-muted-foreground tabular-nums">
                          {formatBytes(n.tx_bytes)}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </Card>
          </section>

          {dockerSt && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <SectionTitle icon={HardDrive} title="Docker" />
                <Badge variant={dockerSt.available ? 'default' : 'secondary'}>
                  {dockerSt.available ? `v${dockerSt.version}` : t('docker.not_installed')}
                </Badge>
              </div>
              {dockerSt.available && containers.length > 0 && (
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('docker.name')}</TableHead>
                        <TableHead>{t('docker.image')}</TableHead>
                        <TableHead>{t('docker.status')}</TableHead>
                        <TableHead>{t('docker.ports')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {containers.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-medium">{c.name}</TableCell>
                          <TableCell className="max-w-xs truncate text-muted-foreground">
                            {c.image}
                          </TableCell>
                          <TableCell>
                            <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>
                              {c.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {c.ports || '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              )}
            </section>
          )}
        </div>
      </details>
    </div>
  );
}
