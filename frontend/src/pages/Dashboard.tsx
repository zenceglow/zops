import React, { useEffect, useState } from 'react';
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
import { apiGet } from '../lib/api';
import { cn } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';

interface SysInfo {
  hostname: string;
  os: string;
  cpu_usage: number;
  cpu_cores: number;
  memory_total: number;
  memory_used: number;
  memory_percent: number;
  swap_total: number;
  swap_used: number;
  uptime_secs: number;
  load_avg: number[];
  processes: number;
  kernel: string;
  disks: { mount: string; total: number; used: number; percent: number }[];
  network: { name: string; rx_bytes: number; tx_bytes: number }[];
}

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
}

interface DockerStatus {
  available: boolean;
  version: string;
}

export default function Dashboard() {
  const { t } = useTranslation();
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [dockerSt, setDockerSt] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet<SysInfo>('/system/overview'),
      apiGet<{ containers: ContainerInfo[] }>('/services'),
      apiGet<DockerStatus>('/services/status'),
    ])
      .then(([s, svc, ds]) => {
        setSys(s);
        setContainers(svc.containers);
        setDockerSt(ds);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const bytes = (b: number) => {
    if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
    if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
    if (b >= 1 << 10) return (b / (1 << 10)).toFixed(1) + ' KB';
    return b + ' B';
  };

  const uptime = (s: number) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    return `${h}h ${m}m`;
  };

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
                sub={`${bytes(sys.memory_used)} / ${bytes(sys.memory_total)}`}
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
                value={uptime(sys.uptime_secs)}
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
                        {bytes(d.used)} / {bytes(d.total)}
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
                    {bytes(sys.swap_used)} / {bytes(sys.swap_total)}
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
                      <span>↓ {bytes(n.rx_bytes)}</span>
                      <span>↑ {bytes(n.tx_bytes)}</span>
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

function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <h2 className="flex items-center gap-2 text-base font-semibold">
      <Icon className="size-4 text-muted-foreground" />
      {title}
    </h2>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="size-4 text-primary" />
        </div>
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}
