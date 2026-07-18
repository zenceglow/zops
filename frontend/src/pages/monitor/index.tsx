import { useTranslation } from 'react-i18next';
import {
  Cpu,
  MemoryStick,
  Activity,
  Clock,
  HardDrive,
  Network,
  Container,
  Server,
} from 'lucide-react';
import { cn } from '../../lib/utils';
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
import { formatBytes, formatUptime, useMonitor } from './_hooks/use-monitor';
import { SectionTitle } from './_components/section-title';
import { StatCard } from './_components/stat-card';

export default function MonitorPage() {
  const { t } = useTranslation();
  const { sys, containers, dockerSt, loading } = useMonitor();

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t('monitor.title')}</h1>
        {sys && (
          <p className="text-sm text-muted-foreground mt-1">
            {sys.hostname} · {sys.os} · {sys.kernel}
          </p>
        )}
      </div>

      {sys && (
        <>
          <section className="space-y-4">
            <SectionTitle icon={Activity} title={t('monitor.overview')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard
                icon={Cpu}
                label={t('monitor.cpu')}
                value={`${sys.cpu_usage.toFixed(1)}%`}
                sub={`${sys.cpu_cores} ${t('monitor.cores')} · ${t('monitor.load')} ${sys.load_avg.map((n) => n.toFixed(1)).join(' / ')}`}
              />
              <StatCard
                icon={MemoryStick}
                label={t('monitor.memory')}
                value={`${sys.memory_percent.toFixed(1)}%`}
                sub={`${formatBytes(sys.memory_used)} / ${formatBytes(sys.memory_total)}`}
              />
              <StatCard
                icon={Activity}
                label={t('monitor.processes')}
                value={String(sys.processes)}
                sub={t('monitor.running')}
              />
              <StatCard
                icon={Clock}
                label={t('monitor.uptime')}
                value={formatUptime(sys.uptime_secs)}
                sub="uptime"
              />
            </div>
          </section>

          <section className="space-y-4">
            <SectionTitle icon={HardDrive} title={t('monitor.disk')} />
            <div className="space-y-3">
              {sys.disks.map((d) => (
                <Card key={d.mount}>
                  <CardContent className="pt-4">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="font-medium">{d.mount}</span>
                      <span className="text-muted-foreground">
                        {formatBytes(d.used)} / {formatBytes(d.total)}
                      </span>
                    </div>
                    <div className="w-full bg-secondary rounded-full h-2">
                      <div
                        className={cn(
                          'h-2 rounded-full transition-all',
                          d.percent > 90
                            ? 'bg-destructive'
                            : d.percent > 75
                              ? 'bg-orange-500'
                              : 'bg-primary',
                        )}
                        style={{ width: `${Math.min(d.percent, 100)}%` }}
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {sys.swap_total > 0 && (
            <section className="space-y-4">
              <SectionTitle icon={MemoryStick} title={t('monitor.swap')} />
              <Card>
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="w-full bg-secondary rounded-full h-2">
                      <div
                        className="h-2 rounded-full bg-orange-500 transition-all"
                        style={{
                          width: `${Math.min((sys.swap_used / sys.swap_total) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatBytes(sys.swap_used)} / {formatBytes(sys.swap_total)}
                  </span>
                </CardContent>
              </Card>
            </section>
          )}

          <section className="space-y-4">
            <SectionTitle icon={Network} title={t('monitor.network')} />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sys.network.map((n) => (
                <Card key={n.name}>
                  <CardContent className="pt-4">
                    <div className="text-sm font-medium mb-1">{n.name}</div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>↓ {formatBytes(n.rx_bytes)}</span>
                      <span>↑ {formatBytes(n.tx_bytes)}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <SectionTitle icon={Container} title="Docker" />
          {dockerSt ? (
            <Badge variant={dockerSt.available ? 'default' : 'secondary'}>
              {dockerSt.available ? `v${dockerSt.version}` : t('docker.not_installed')}
            </Badge>
          ) : (
            <Skeleton className="h-5 w-16" />
          )}
        </div>

        {dockerSt && !dockerSt.available && (
          <Card>
            <CardContent className="py-8 text-center">
              <Server className="size-8 mx-auto mb-3 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground mb-1">{t('docker.not_installed')}</p>
              <p className="text-xs text-muted-foreground/70">{t('docker.install_hint')}</p>
            </CardContent>
          </Card>
        )}

        {dockerSt?.available && containers.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center">
              <Container className="size-8 mx-auto mb-3 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">{t('docker.no_containers')}</p>
            </CardContent>
          </Card>
        )}

        {dockerSt?.available && containers.length > 0 && (
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
                    <TableCell className="text-muted-foreground max-w-xs truncate">
                      {c.image}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {c.ports || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
