import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Boxes,
  Gauge,
  HardDrive,
  Network,
  Package,
  ScrollText,
} from 'lucide-react';
import { Skeleton } from '../../components/ui/skeleton';
import { cn } from '../../lib/utils';
import { SectionTitle } from '../monitor/_components/section-title';
import { CleanupDialog } from '../monitor/_components/cleanup-dialog';
import {
  fetchContainers,
  fetchDockerInfo,
  fetchImages,
  fetchNetworks,
  type ContainerInfo,
  type DockerInfo,
  type DockerNetwork,
  type DockerStatus,
  type DockerImage,
} from './_api';

/** 占用每 3 秒刷一次：这是"现在谁在吃 CPU"，不是历史趋势。 */
const STATS_POLL_MS = 3000;

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

function ago(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}h`;
  return `${Math.floor(seconds / 60)}m`;
}

/**
 * Docker 一页看全。
 *
 * 以前点 Dock 上的 Docker 是个下拉，里面三项还是占位页 —— 想看"这台机器上的容器
 * 到底什么情况"得在四五个页面之间跳。这一页把和 Docker 有关的六件事摆在一起：
 * 容器、镜像、垃圾、网络、占用、引擎配置。
 */
export default function DockerPage() {
  const { t } = useTranslation();
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [danglingSize, setDanglingSize] = useState(0);
  const [networks, setNetworks] = useState<DockerNetwork[]>([]);
  const [info, setInfo] = useState<DockerInfo | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(async () => {
    const [c, i, n, d] = await Promise.allSettled([
      fetchContainers(),
      fetchImages(),
      fetchNetworks(),
      fetchDockerInfo(),
    ]);
    if (c.status === 'fulfilled') {
      setContainers(c.value.containers);
      setStatus(c.value.status);
    } else {
      setContainers([]);
    }
    if (i.status === 'fulfilled') {
      setImages(i.value.images);
      setDanglingSize(i.value.dangling_size);
    }
    if (n.status === 'fulfilled') setNetworks(n.value.networks);
    if (d.status === 'fulfilled') setInfo(d.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 占用自己滚：这一块的意义就是"现在"。
  useEffect(() => {
    const id = setInterval(() => {
      void fetchContainers()
        .then((d) => {
          setContainers(d.containers);
          setStatus(d.status);
        })
        .catch(() => {});
    }, STATS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (!containers) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('docker.title')}</h1>
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  const running = containers.filter((c) => c.state === 'running');
  const engine = (info?.info ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof engine[k] === 'string' ? (engine[k] as string) : '—');
  const num = (k: string) => (typeof engine[k] === 'number' ? (engine[k] as number) : 0);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('docker.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {status?.available
              ? t('docker.engine_line', {
                  version: str('ServerVersion'),
                  driver: str('Driver'),
                })
              : t('docker.not_installed')}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Chip label={t('docker.running')} value={`${running.length}/${containers.length}`} />
          <Chip label={t('docker.images')} value={String(images.length)} />
          <Chip label={t('docker.networks')} value={String(networks.length)} />
        </div>
      </div>

      {/* 占用：横向条，和首页那套一致 */}
      <section>
        <SectionTitle icon={Gauge} title={t('docker.stats')} hint={t('docker.stats_hint')} />
        <div className="mt-3 space-y-2">
          {containers.length === 0 && <Empty text={t('docker.no_containers')} />}
          {containers.map((c) => (
            <StatRow key={c.id} c={c} t={t} />
          ))}
        </div>
      </section>

      {/* 容器 */}
      <section>
        <div className="flex items-center justify-between gap-3">
          <SectionTitle icon={Boxes} title={t('docker.containers')} />
          <Link
            to="/docker/containers"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('docker.view_all')}
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {running.length === 0 && <Empty text={t('docker.no_containers')} />}
          {running.map((c) => (
            <Link
              key={c.id}
              to={`/docker/containers/${c.id}`}
              className="flex items-center gap-3 rounded-xl border border-border/60 px-3.5 py-2.5 transition-colors hover:border-border hover:bg-muted/40"
            >
              <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{c.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {c.image}
                </span>
              </span>
              {/* 端口串可能很长（一个容器映射七八个端口），必须能截断 —— 不然它会
                  顶出卡片、压到旁边那一格上。完整内容放进 title。 */}
              <span
                className="ml-auto max-w-[42%] shrink truncate text-right font-mono text-[11px] text-muted-foreground"
                title={c.ports}
              >
                {c.ports || '—'}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* 镜像 + 网络 */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border/60 p-4">
          <div className="flex items-center gap-2">
            <Package className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{t('docker.images')}</p>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {t('docker.images_count', { count: images.length })}
            </span>
          </div>
          <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
            {images.map((i) => (
              <div key={i.id} className="flex items-center gap-3 py-1 text-xs">
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono',
                    i.dangling && 'text-muted-foreground',
                  )}
                  title={i.id}
                >
                  {i.tags[0] ?? t('docker.dangling')}
                </span>
                {i.containers > 0 && (
                  <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                    {t('docker.in_use', { count: i.containers })}
                  </span>
                )}
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {human(i.size)}
                </span>
                <span className="w-10 shrink-0 text-right text-muted-foreground">
                  {i.created > 0 ? ago(Math.floor(Date.now() / 1000) - i.created) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border/60 p-4">
          <div className="flex items-center gap-2">
            <Network className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{t('docker.networks')}</p>
          </div>
          <div className="mt-3 space-y-1.5">
            {networks.map((n) => (
              <div key={n.id} className="flex items-center gap-3 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{n.name}</span>
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {n.driver}
                </span>
                <span className="w-28 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground">
                  {n.subnet || '—'}
                </span>
                <span className="w-14 shrink-0 text-right text-muted-foreground">
                  {t('docker.attached', { count: n.containers })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 垃圾 + 引擎配置 */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border/60 p-4">
          <div className="flex items-center gap-2">
            <HardDrive className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{t('docker.junk')}</p>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('docker.junk_line', {
              size: human(danglingSize),
              count: images.filter((i) => i.dangling).length,
            })}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <CleanupDialog />
            <span className="text-[11px] text-muted-foreground">{t('docker.junk_hint')}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-border/60 p-4">
          <div className="flex items-center gap-2">
            <ScrollText className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{t('docker.config_json')}</p>
            <button
              type="button"
              onClick={() => setShowConfig((v) => !v)}
              className="ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {showConfig ? t('docker.hide') : t('docker.show')}
            </button>
          </div>
          {showConfig ? (
            <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-5">
              {JSON.stringify(info?.info ?? {}, null, 2)}
            </pre>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              {[
                ['ServerVersion', str('ServerVersion')],
                ['StorageDriver', str('Driver')],
                ['DockerRootDir', str('DockerRootDir')],
                ['OperatingSystem', str('OperatingSystem')],
                ['NCPU', String(num('NCPU'))],
                ['MemTotal', human(num('MemTotal'))],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0 rounded-lg bg-muted/40 px-2.5 py-1.5">
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{k}</p>
                  <p className="truncate font-mono" title={v}>
                    {v}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5 rounded-xl border border-border/60 px-3 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums">{value}</span>
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="col-span-full py-6 text-center text-xs text-muted-foreground">{text}</p>;
}

/** 一条占用：名字 + CPU/内存横向条。停掉的容器画成灰的，不占视线。 */
function StatRow({
  c,
  t,
}: {
  c: ContainerInfo;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const running = c.state === 'running';
  const cpu = c.cpu_percent ?? 0;
  const mem = c.mem_used ?? 0;
  const memPct = c.mem_limit ? (mem / c.mem_limit) * 100 : 0;
  const tone = (v: number) =>
    v >= 90 ? 'bg-red-500' : v >= 75 ? 'bg-amber-400' : 'bg-emerald-400';

  return (
    <div className={cn('flex items-center gap-3', !running && 'opacity-45')}>
      <span className="w-40 shrink-0 truncate text-xs" title={c.image}>
        {c.name}
      </span>
      <span className="hidden w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground sm:block">
        {t('docker.cpu_short')}
      </span>
      <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted sm:w-32">
        <span
          className={cn('block h-full rounded-full transition-[width] duration-500', tone(cpu))}
          style={{ width: `${Math.min(100, cpu)}%` }}
        />
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums">
        {running ? `${cpu.toFixed(0)}%` : '—'}
      </span>
      <span className="hidden w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground sm:block">
        {t('docker.mem_short')}
      </span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full transition-[width] duration-500', tone(memPct))}
          style={{ width: `${Math.min(100, memPct)}%` }}
        />
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
        {running && mem > 0 ? human(mem) : '—'}
      </span>
    </div>
  );
}
