import { useTranslation } from 'react-i18next';
import type { ComponentType } from 'react';
import { Database, Globe, Package, Server, Terminal } from 'lucide-react';
import {
  SiCaddy,
  SiClickhouse,
  SiDocker,
  SiElasticsearch,
  SiGitea,
  SiGhost,
  SiGrafana,
  SiHomeassistant,
  SiInfluxdb,
  SiJenkins,
  SiMariadb,
  SiMinio,
  SiMongodb,
  SiMysql,
  SiNextcloud,
  SiNginx,
  SiNodedotjs,
  SiPortainer,
  SiPostgresql,
  SiPrometheus,
  SiPython,
  SiRabbitmq,
  SiRedis,
  SiSupabase,
  SiTraefikproxy,
  SiVault,
} from 'react-icons/si';
import { cn } from '../../../lib/utils';
import type { ContainerInfo } from '../_api';
import { SectionTitle } from './section-title';

/**
 * 按镜像/名字猜一个"应用图标"。
 *
 * 后端不提供容器图标，也不值得为此加接口：容器名和镜像名本身就带着足够的
 * 线索（mysql / caddy / node），按关键词归类比统一画一个方块更像桌面。
 *
 * 认得出的产品直接给品牌图标 —— 一排容器全是同一个"数据库"图标等于没给信息，
 * 而 mysql 和 redis 在运维眼里根本是两回事。认不出的才退回按形状归类。
 */
type Glyph = ComponentType<{ className?: string }>;

const ICON_RULES: [RegExp, Glyph][] = [
  [/mariadb/i, SiMariadb],
  [/mysql/i, SiMysql],
  [/postgres|pgsql/i, SiPostgresql],
  [/mongo/i, SiMongodb],
  [/redis/i, SiRedis],
  [/clickhouse/i, SiClickhouse],
  [/influx/i, SiInfluxdb],
  [/elastic|opensearch/i, SiElasticsearch],
  [/rabbitmq/i, SiRabbitmq],
  [/minio/i, SiMinio],
  [/supabase/i, SiSupabase],
  [/grafana/i, SiGrafana],
  [/prometheus/i, SiPrometheus],
  [/jenkins/i, SiJenkins],
  [/gitea|forgejo/i, SiGitea],
  [/nextcloud/i, SiNextcloud],
  [/ghost/i, SiGhost],
  [/home-?assistant/i, SiHomeassistant],
  [/vault/i, SiVault],
  [/portainer/i, SiPortainer],
  [/traefik/i, SiTraefikproxy],
  [/caddy/i, SiCaddy],
  [/nginx/i, SiNginx],
  [/node|bun|deno|next\.?js|vite/i, SiNodedotjs],
  [/python|django|flask|uvicorn|gunicorn|celery/i, SiPython],
  [/registry|docker/i, SiDocker],
  // 兜底：至少区分出"数据库 / 站点 / 任务"这几类形状。
  [/mysql|data|database|\bdb\b|sql/i, Database],
  [/web|http|proxy|gateway/i, Globe],
  [/ssh|git|runner|agent|worker|job|ci\b/i, Terminal],
];

function iconFor(c: ContainerInfo): Glyph {
  // 镜像名在前：名字是用户自己起的（"myserver-1"），镜像才是这个容器到底跑了什么。
  const hay = `${c.image} ${c.name}`;
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
          // 反色块：深色主题下白底黑图标，浅色主题下黑底白图标。品牌图标本身
          // 细节密（mysql 的海豚、redis 的字标），贴在 muted 灰底上远看就是一团
          // 模糊；反色之后轮廓才立得住，一排容器也像一排应用图标。
          'flex size-12 items-center justify-center rounded-2xl bg-foreground text-background',
          'transition-transform duration-150 hover:-translate-y-0.5',
          !running && 'opacity-50',
        )}
      >
        {/* 品牌图标（mysql 的海豚、redis 的字标）细节比线性图标密，给大一号才认得出来。 */}
        <Icon className="size-6" />
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

/** 容器网格：有多少个显示多少个，贴着左边排，跟上面的环、标题对齐。 */
export function ContainerGrid({ containers }: { containers: ContainerInfo[] }) {
  if (containers.length === 0) return null;
  return (
    <section>
      {/* 不做多语言：用户点名要 "Servers" 这个词，中英环境下都保持原样。 */}
      <SectionTitle icon={Server} title="Servers" />
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-6">
        {containers.map((c) => (
          <ContainerTile key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}
