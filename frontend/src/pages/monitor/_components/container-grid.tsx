import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  Box,
  Database,
  Globe,
  Package,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { ContainerInfo } from '../_api';

/**
 * 按镜像/名字猜一个"应用图标"。
 *
 * 后端不提供容器图标，也不值得为此加接口：容器名和镜像名本身就带着足够的
 * 线索（mysql / caddy / node），按关键词归类比统一画一个方块更像桌面。
 */
const ICON_RULES: [RegExp, LucideIcon][] = [
  [/mysql|maria|postgres|mongo|redis|memcache|database|\bdb\b/i, Database],
  [/caddy|nginx|traefik|apache|httpd|\bweb\b/i, Globe],
  [/node|bun|deno|next|vite|\bapp\b|webapp/i, AppWindow],
  [/ssh|git|runner|agent|worker|jenkins|ci\b/i, Terminal],
  [/docker|containerd|registry|kube/i, Box],
];

function iconFor(c: ContainerInfo): LucideIcon {
  const hay = `${c.name} ${c.image}`;
  for (const [re, Icon] of ICON_RULES) {
    if (re.test(hay)) return Icon;
  }
  return Package;
}

/**
 * 只取宿主端口。
 *
 * Docker 给的是 `0.0.0.0:80->80/tcp, [::]:80->80/tcp` 这种全量映射，直接铺在
 * 卡片上会长到折行；这里收敛成 `80 443`，点进 /docker/containers 能看完整的。
 */
function shortPorts(ports: string): string {
  if (!ports.trim()) return '—';
  const found = new Set<string>();
  for (const part of ports.split(',')) {
    const mapped = part.match(/:(\d+)->/);
    const exposed = part.match(/(\d+)\/(tcp|udp)/);
    const port = mapped?.[1] ?? exposed?.[1];
    if (port) found.add(port);
  }
  return found.size > 0 ? Array.from(found).join(' ') : '—';
}

function ContainerTile({ c }: { c: ContainerInfo }) {
  const { t } = useTranslation();
  const Icon = iconFor(c);
  const running = c.state === 'running';

  return (
    <div className="flex w-[132px] flex-col items-center text-center">
      <span
        className={cn(
          'flex size-14 items-center justify-center rounded-2xl bg-muted/60 ring-1 ring-border/50',
          'transition-transform duration-150 hover:-translate-y-0.5',
          !running && 'opacity-50',
        )}
      >
        <Icon className="size-6 text-foreground/80" />
      </span>
      <span className="mt-3 w-full truncate text-sm font-medium" title={c.name}>
        {c.name}
      </span>
      <span className="mt-1 w-full truncate font-mono text-[11px] text-muted-foreground">
        {shortPorts(c.ports)}
      </span>
      <span
        className={cn(
          'mt-0.5 w-full truncate text-[11px]',
          running ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        )}
        title={c.status}
      >
        {c.status}
      </span>
      <span
        className="mt-0.5 w-full truncate text-[10px] text-muted-foreground/70"
        title={`${c.image}\n${t('docker.status')}: ${c.status}`}
      >
        {c.image}
      </span>
    </div>
  );
}

/** 容器网格：有多少个显示多少个，最后一行也左右居中。 */
export function ContainerGrid({ containers }: { containers: ContainerInfo[] }) {
  if (containers.length === 0) return null;
  return (
    <section className="mx-auto flex max-w-4xl flex-wrap justify-center gap-x-4 gap-y-8">
      {containers.map((c) => (
        <ContainerTile key={c.id} c={c} />
      ))}
    </section>
  );
}
